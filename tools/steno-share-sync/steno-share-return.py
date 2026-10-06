#!/usr/bin/env python3
"""팀 폴더에서 고친 사본을 Steno "팀 공유" 노트로 되돌려 넣는다.

Usage: steno-share-return.py <팀 폴더 안 파일 이름> --as <팀원 이름>

- 도우미(steno-share-sync)를 한 번 돌려 지금 원본 해시를 manifest 에 받는다.
- 사본을 만든 뒤 원본이 그대로면 steno-mcp edit_note 로 원본 자리에 쓴다.
  Steno 가 "<이름>이 고침 ✦" 표시와 ⌘⌥Z 되돌리기를 붙인다.
- 원본이 바뀌었거나 확인이 안 되면 덮지 않고 create_note 로 "AAA (<이름> 수정).md" 를 만든다.
Documents 에 직접 쓰지 않는다. 쓰기는 전부 steno-mcp 가 한다.
"""
import hashlib
import json
import os
import subprocess
import sys
import time

SHARED = os.path.expanduser("~/Library/Application Support/b3os/steno-shared")
MANIFEST = os.path.join(SHARED, ".manifest.json")
FOLDER = "팀 공유"
MCP = os.environ.get("STENO_MCP", "/Applications/Steno.app/Contents/MacOS/steno-mcp")


def die(message):
    print(f"steno-share-return: {message}", file=sys.stderr)
    sys.exit(1)


def refresh_manifest():
    """도우미를 한 번 돌리고 manifest 가 새로 쓰였는지 본다. 못 보면 False."""
    if os.environ.get("STENO_SHARE_NO_KICK") == "1":
        return True
    before = os.stat(MANIFEST).st_mtime if os.path.exists(MANIFEST) else 0
    subprocess.run(["launchctl", "kickstart", f"gui/{os.getuid()}/com.b3os.steno-share-sync"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(20):
        if os.path.exists(MANIFEST) and os.stat(MANIFEST).st_mtime > before:
            return True
        time.sleep(0.5)
    return False


def call_mcp(member, tool, arguments):
    args = [MCP]
    library = os.environ.get("STENO_LIBRARY", "")
    if library.startswith("/"):
        args += ["--library", library]
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": member, "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": arguments}},
    ]
    stdin = "".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages)
    try:
        out = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=120).stdout
    except (OSError, subprocess.TimeoutExpired) as error:
        die(f"steno-mcp 실행 실패: {error}")
    for line in out.splitlines():
        try:
            reply = json.loads(line)
        except ValueError:
            continue
        if reply.get("id") == 2:
            result = reply.get("result") or {}
            text = " ".join(c.get("text", "") for c in result.get("content", []))
            if reply.get("error") or result.get("isError"):
                die(f"{tool} 거절: {text or reply.get('error')}")
            return text
    die(f"{tool} 응답 없음")


def main():
    argv = sys.argv[1:]
    if len(argv) != 3 or argv[1] != "--as":
        die("사용법: steno-share-return.py <파일 이름> --as <팀원 이름>")
    name, member = argv[0], argv[2].strip()
    if not name or "/" in name or name.startswith(".") or "\0" in name:
        die("파일 이름이 올바르지 않음")
    # 팀원 이름은 새 노트 이름에 들어간다. 경로 조각·제어 문자·긴 이름을 막는다.
    if not member or len(member) > 24 or any(c in member for c in "/\\:") or member.startswith(".") \
            or any(ord(c) < 32 or ord(c) == 127 for c in member):
        die("팀원 이름이 올바르지 않음(24자 이하, / \\ : 제어 문자 금지)")
    path = os.path.join(SHARED, name)
    if os.path.islink(path) or not os.path.isfile(path):
        die(f"팀 폴더에 그 파일이 없음: {name}")
    with open(path, "rb") as f:
        data = f.read()
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError:
        die("글 파일만 되돌려 넣을 수 있음(UTF-8)")

    fresh = refresh_manifest()
    try:
        with open(MANIFEST, encoding="utf-8") as f:
            entry = json.load(f).get(name) or {}
    except (OSError, ValueError):
        entry = {}
    base, source = entry.get("base"), entry.get("source")
    if source and hashlib.sha256(data).hexdigest() == source:
        print("이미 원본과 같음, 할 일 없음")
        return

    if fresh and base and base == source:
        text = call_mcp(member, "edit_note", {"path": f"{FOLDER}/{name}", "content": content})
        print(f"원본 자리에 반영함: {FOLDER}/{name} {text}")
    else:
        stem, ext = os.path.splitext(name)
        why = "원본도 바뀌어" if fresh else "원본 상태를 확인하지 못해"
        arguments = {"content": content, "name": f"{stem} ({member} 수정){ext}", "folder": FOLDER}
        if ext:
            arguments["format"] = ext.lstrip(".")
        text = call_mcp(member, "create_note", arguments)
        print(f"{why} 덮지 않고 따로 만듦: {stem} ({member} 수정){ext} {text}")


if __name__ == "__main__":
    main()

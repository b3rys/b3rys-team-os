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
import unicodedata

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
        hook = os.environ.get("STENO_SHARE_TEST_REFRESH")  # 시험 전용: 도우미 한 번 돈 것을 흉내
        if hook:
            subprocess.run(["/bin/sh", "-c", hook], check=True)
        return True
    before = os.stat(MANIFEST).st_mtime if os.path.exists(MANIFEST) else 0
    subprocess.run(["launchctl", "kickstart", f"gui/{os.getuid()}/com.b3os.steno-share-sync"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(20):
        if os.path.exists(MANIFEST) and os.stat(MANIFEST).st_mtime > before:
            return True
        time.sleep(0.5)
    return False


class Refused(Exception):
    pass


def mcp_request(member, method, params):
    """steno-mcp 를 띄워 initialize 뒤 요청 하나를 보내고 그 응답(dict)을 돌려준다."""
    args = [MCP]
    library = os.environ.get("STENO_LIBRARY", "")
    if library.startswith("/"):
        args += ["--library", library]
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": member, "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": method, "params": params},
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
            return reply
    die(f"{method} 응답 없음")


def call_mcp(member, tool, arguments):
    reply = mcp_request(member, "tools/call", {"name": tool, "arguments": arguments})
    result = reply.get("result") or {}
    text = " ".join(c.get("text", "") for c in result.get("content", []))
    if reply.get("error") or result.get("isError"):
        raise Refused(f"{tool} 거절: {text or reply.get('error')}")
    return text


def edit_checks_hash(member):
    """edit_note 가 expected_sha256 을 아는지 tools/list 스키마로 본다.
    모르는 인자는 서버가 조용히 무시하므로, 모르면 원본 자리에 쓰면 안 된다."""
    tools = (mcp_request(member, "tools/list", {}).get("result") or {}).get("tools") or []
    for tool in tools:
        if tool.get("name") == "edit_note":
            return "expected_sha256" in ((tool.get("inputSchema") or {}).get("properties") or {})
    return False


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
        die("팀원 이름이 올바르지 않음(24자 이하, / \\ : 제어 문자·점 시작 금지)")
    path = os.path.join(SHARED, name)
    if os.path.islink(path) or not os.path.isfile(path):
        die(f"팀 폴더에 그 파일이 없음: {name}")
    # 도우미를 먼저 돌리고 그 뒤에 사본을 읽는다. 먼저 읽으면 도우미가 사본·기준을 새 원본으로
    # 바꾼 뒤에도 옛 내용을 새 기준 해시와 함께 보내 원본을 옛 판으로 되돌릴 수 있다.
    fresh = refresh_manifest()
    with open(path, "rb") as f:
        data = f.read()
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError:
        die("글 파일만 되돌려 넣을 수 있음(UTF-8)")
    try:
        with open(MANIFEST, encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError):
        manifest = {}
    key = unicodedata.normalize("NFC", name)
    entry = manifest.get(key) or {}
    file = entry.get("file") or name  # Steno 쪽 실제 파일 이름(NFD 일 수 있다)
    base, source = entry.get("base"), entry.get("source")
    copy_hash = hashlib.sha256(data).hexdigest()
    if source and copy_hash == source:
        print("이미 원본과 같음, 할 일 없음")
        return
    if base and copy_hash == base:
        # 사본이 기준 판 그대로다 = 팀원이 고친 것이 없다. 보내면 원본을 옛 판으로 되돌릴 뿐이다.
        print("사본에 고친 것이 없음, 할 일 없음")
        return

    stem, ext = os.path.splitext(file)
    fmt = {".md": "md", ".markdown": "md", ".html": "html", ".htm": "html"}.get(ext.lower())
    reason = None
    if not fresh:
        reason = "원본 상태를 확인하지 못해"
    elif not base or base != source:
        reason = "원본도 바뀌었거나 지금 원본을 읽지 못해"
    elif not edit_checks_hash(member):
        reason = "이 Steno 는 원본 해시 확인(expected_sha256)을 지원하지 않아"
    else:
        try:
            # expected_sha256: 그사이 원본이 바뀌었으면 steno-mcp 가 거절한다(Steno 쪽 지원 후 유효).
            text = call_mcp(member, "edit_note", {"path": f"{FOLDER}/{file}", "content": content,
                                                  "expected_sha256": base})
            print(f"원본 자리에 반영함: {FOLDER}/{file} {text}")
            return
        except Refused as error:
            reason = f"원본 자리에 쓰지 못해({error})"
    if not fmt:
        die(f"{reason} 따로 만들어야 하는데, 1단계는 md·html 만 따로 만들 수 있음: {file}")
    new_name = f"{stem} ({member} 수정)"
    try:
        text = call_mcp(member, "create_note", {"content": content, "name": new_name, "format": fmt, "folder": FOLDER})
    except Refused as error:
        die(str(error))
    print(f"{reason} 덮지 않고 따로 만듦: {new_name}.{fmt} {text}")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""팀 폴더에서 고친 사본을 Steno "팀 공유" 노트로 되돌려 넣는다.

Usage: steno-share-return.py <팀 폴더 안 파일 이름> --as <팀원 이름>

- Steno 도우미(steno-helper)를 한 번 돌려 지금 원본 해시를 manifest 에 받는다.
- 고친 사본과 본문 해시를 steno-share-outbox 에 두고 도우미에게 되돌리기를 요청한다.
- 도우미는 원본을 읽거나 바꾸지 않고 "AAA (<이름> 수정).md" 새 사본만 만든다.
Documents 에 직접 쓰지 않으며 Steno MCP 를 실행하지 않는다.
"""
import hashlib
import json
import os
import subprocess
import sys
import time
import unicodedata
import uuid

SHARED = os.path.expanduser("~/Library/Application Support/b3os/steno-shared")
MANIFEST = os.path.join(SHARED, ".manifest.json")
FOLDER = "팀 공유"
OUTBOX = os.path.expanduser("~/Library/Application Support/b3os/steno-share-outbox")


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
    subprocess.run(["launchctl", "kickstart", f"gui/{os.getuid()}/com.b3os.steno-helper"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(20):
        if os.path.exists(MANIFEST) and os.stat(MANIFEST).st_mtime > before:
            return True
        time.sleep(0.5)
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
    refresh_manifest()
    import stat
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 20 * 1024 * 1024:
            die("사본은 링크 없는 20MB 이하 일반 파일이어야 함")
        data = f.read(20 * 1024 * 1024 + 1)
    try:
        data.decode("utf-8")
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

    if not file or "/" in file or file.startswith(".") or "\0" in file:
        die("manifest 의 파일 이름이 올바르지 않음")
    if len(data) > 20 * 1024 * 1024:
        die("20MB 초과는 보낼 수 없음")
    # Only the helper can access Documents. Publish payload first, request last.
    os.makedirs(OUTBOX, mode=0o700, exist_ok=True)
    if os.path.realpath(OUTBOX) != OUTBOX or os.path.islink(OUTBOX):
        die("팀 공유 보낼 칸이 링크임")
    identifier = str(uuid.uuid4())
    payload = os.path.join(OUTBOX, ".return-" + identifier + ".data")
    request = os.path.join(OUTBOX, ".return-" + identifier + ".json")
    values = [(payload, data)]
    metadata = {"file": file, "member": member, "sha256": copy_hash}
    values.append((request, json.dumps(metadata, ensure_ascii=False).encode("utf-8")))
    for target, value in values:
        temporary = target + ".tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(value)
            f.flush()
            os.fsync(f.fileno())
        os.rename(temporary, target)
    print(f"팀 공유 도우미에 되돌리기 요청함: {file} ({identifier})")

if __name__ == "__main__":
    main()

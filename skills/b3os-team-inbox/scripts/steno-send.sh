#!/bin/bash
# Steno 지원 파일을 권한 분리된 로컬 outbox에 넣는다.
#
# Usage: steno-send.sh <file> [--name <받는 쪽 파일 이름>] [--folder <하위 폴더 이름>] [--to-received]
#
#   · Steno 폴더 목록 지원 확장자와 그림·zip만 받는다.
#   · --name 을 안 주면 파일 이름 그대로 쓴다. 경로가 포함된 이름은 거절한다.
#   · --folder 를 주면 팀 공유(또는 받은 파일) 아래 그 폴더에 넣는다. "A" 또는 "A/B"(두 단계까지, 앱 폴더 깊이와 같다). 없으면 도우미가 만든다.
#   · 크기 상한은 20 MB다.
#   · 보낸 것은 덮어쓰거나 지울 수 없다. 고친 판은 새로 보낸다.
# 성공하면 outbox 파일 이름을 stdout 에 찍고 0 으로 끝난다. 실패하면 이유를 stderr 에 찍고 1.
set -uo pipefail
OUTBOX="$HOME/Library/Application Support/b3os/steno-share-outbox"
MAX_BYTES=20971520
ALLOWED="md markdown txt text log csv tsv json yml yaml toml ini conf cfg properties env py rb go rs swift sh bash zsh sql js jsx mjs cjs ts tsx mts cts html htm css xml svg java kt kts scala cs c h cpp cc cxx hpp hh m png jpg jpeg gif webp heic zip"

FILE=""; NAME=""; FOLDER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --to-received) OUTBOX="$HOME/Library/Application Support/b3os/steno-outbox"; shift ;;
    --folder) [ $# -ge 2 ] || { echo "✖ --folder 뒤에 이름이 없다" >&2; exit 1; }; FOLDER="$2"; shift 2 ;;
    --name) [ $# -ge 2 ] || { echo "✖ --name 뒤에 이름이 없다" >&2; exit 1; }; NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    -*) echo "✖ 모르는 옵션: $1" >&2; exit 1 ;;
    *) [ -z "$FILE" ] || { echo "✖ 파일은 하나만 보낸다" >&2; exit 1; }; FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] || { echo "✖ 보낼 파일을 주세요: steno-send.sh <file> [--name <이름>]" >&2; exit 1; }
[ ! -L "$FILE" ] && [ -f "$FILE" ] || { echo "✖ 파일이 없다: $FILE" >&2; exit 1; }
[ -s "$FILE" ] || { echo "✖ 빈 파일이다: $FILE" >&2; exit 1; }
[ "$(stat -f %z "$FILE")" -le "$MAX_BYTES" ] || { echo "✖ 20MB 이하만 보낼 수 있다: $FILE" >&2; exit 1; }
SOURCE_EXT="$(printf '%s' "${FILE##*.}" | tr '[:upper:]' '[:lower:]')"
case " $ALLOWED " in
  *" $SOURCE_EXT "*) ;;
  *) echo "✖ Steno 지원 파일·그림·zip만 보낼 수 있다: $FILE" >&2; exit 1 ;;
esac

[ -n "$NAME" ] || NAME="$(basename "$FILE")"
case "$NAME" in ""|.|..|*/*) echo "✖ 파일 이름에 경로를 쓸 수 없다: $NAME" >&2; exit 1;; esac
LOWER_NAME="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')"
case "$LOWER_NAME" in
  .env|*secret*|*credential*|*token*)
    echo "✖ 비밀값이 들어갈 수 있는 파일 이름은 보낼 수 없다: $NAME" >&2
    exit 1
    ;;
esac
EXT="$(printf '%s' "${NAME##*.}" | tr '[:upper:]' '[:lower:]')"
case " $ALLOWED " in
  *" $EXT "*) ;;
  *) echo "✖ Steno 지원 파일·그림·zip만 보낼 수 있다: $NAME" >&2; exit 1 ;;
esac

if [ -n "$FOLDER" ]; then
  case "$FOLDER" in .*|*/.*|*//*|/*|*/|*/*/*|*\\*) echo "✖ 폴더는 \"A\" 또는 \"A/B\" 만(점 시작·빈 칸·세 단계 금지): $FOLDER" >&2; exit 1;; esac
  case "$(printf '%s' "$FOLDER" | tr '[:upper:]' '[:lower:]')" in
    *secret*|*credential*|*token*|*password*) echo "✖ 비밀값이 들어갈 수 있는 폴더 이름은 쓸 수 없다: $FOLDER" >&2; exit 1;;
  esac
fi

umask 077
mkdir -p "$OUTBOX"
chmod 700 "$OUTBOX"
TMP="$(mktemp "$OUTBOX/.steno-send.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
cp "$FILE" "$TMP"
chmod 600 "$TMP"

[ ! -L "$OUTBOX" ] || { echo "✖ outbox 가 링크다: $OUTBOX" >&2; exit 1; }
if [ -n "$FOLDER" ]; then
  # 하위 폴더: 경로 문자열로 확인한 뒤 옮기면 그 사이 폴더를 링크로 바꿔치기할 수 있다(리뷰 #575).
  # outbox 폴더 fd 에서 한 단계씩 O_NOFOLLOW 로 내려가 그 fd 에 바로 놓는다 — 경로를 다시 풀지 않는다.
  # 이름이 겹치면 " 2" … 를 붙인다(link 는 있는 이름을 덮지 않는다).
  SHOWN="$(/usr/bin/python3 -I - "$OUTBOX" "$(basename "$TMP")" "$FOLDER" "$NAME" <<'PYEOF'
import errno, os, sys
outbox, temp, folder, name = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
root = os.open(outbox, flags)
current = os.dup(root)
for part in folder.split("/"):
    try:
        os.mkdir(part, 0o700, dir_fd=current)
    except FileExistsError:
        pass
    child = os.open(part, flags, dir_fd=current)  # 링크면 ELOOP/ENOTDIR 로 실패
    os.close(current); current = child
hook = os.environ.get("STENO_SEND_TEST_AFTER_DESCEND")
if hook:
    os.system(hook)  # 시험 전용: 내려간 뒤 폴더를 바꿔치기해 본다
stem, dot, ext = name.rpartition(".")
for n in range(1, 10001):
    candidate = name if n == 1 else f"{stem} {n}.{ext}"
    try:
        os.link(temp, candidate, src_dir_fd=root, dst_dir_fd=current, follow_symlinks=False)
    except FileExistsError:
        continue
    os.unlink(temp, dir_fd=root)
    print(f"{folder}/{candidate}")
    sys.exit(0)
sys.exit(1)
PYEOF
)" || { echo "✖ 하위 폴더에 넣지 못했다(링크·권한): $FOLDER" >&2; exit 1; }
else
  DEST="$OUTBOX/$NAME"
  n=2
  while :; do
    mv -n "$TMP" "$DEST" 2>/dev/null || true
    [ ! -e "$TMP" ] && break
    stem="${NAME%.*}"; ext="${NAME##*.}"
    DEST="$OUTBOX/$stem $n.$ext"
    n=$((n + 1))
  done
  SHOWN="$(basename "$DEST")"
fi
trap - EXIT
echo "$SHOWN"
echo "✓ Steno outbox에 넣음 — $SHOWN" >&2

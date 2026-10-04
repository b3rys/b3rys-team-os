#!/bin/bash
# 보고서 파일(md·html)을 권한 분리된 로컬 outbox에 넣는다.
#
# Usage: steno-send.sh <file.md|file.html> [--name <받는 쪽 파일 이름>]
#
#   · 형식은 확장자로 정한다: .md·.markdown → md, .html·.htm → html. 그 밖은 거절.
#   · --name 을 안 주면 파일 이름 그대로 쓴다. 경로가 포함된 이름은 거절한다.
#   · 크기 상한은 1 MB다.
#   · 보낸 것은 덮어쓰거나 지울 수 없다. 고친 판은 새로 보낸다.
# 성공하면 outbox 파일 이름을 stdout 에 찍고 0 으로 끝난다. 실패하면 이유를 stderr 에 찍고 1.
set -uo pipefail
OUTBOX="$HOME/Library/Application Support/b3os/steno-outbox"
MAX_BYTES=1048576

FILE=""; NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) [ $# -ge 2 ] || { echo "✖ --name 뒤에 이름이 없다" >&2; exit 1; }; NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    -*) echo "✖ 모르는 옵션: $1" >&2; exit 1 ;;
    *) [ -z "$FILE" ] || { echo "✖ 파일은 하나만 보낸다" >&2; exit 1; }; FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] || { echo "✖ 보낼 파일을 주세요: steno-send.sh <file.md|file.html> [--name <이름>]" >&2; exit 1; }
[ -f "$FILE" ] || { echo "✖ 파일이 없다: $FILE" >&2; exit 1; }
[ -s "$FILE" ] || { echo "✖ 빈 파일이다: $FILE" >&2; exit 1; }
[ "$(stat -f %z "$FILE")" -le "$MAX_BYTES" ] || { echo "✖ 1MB 이하만 보낼 수 있다: $FILE" >&2; exit 1; }

case "$(printf '%s' "$FILE" | tr '[:upper:]' '[:lower:]')" in
  *.md|*.markdown) FORMAT="md" ;;
  *.html|*.htm) FORMAT="html" ;;
  *) echo "✖ md·html 만 보낼 수 있다: $FILE" >&2; exit 1 ;;
esac
[ -n "$NAME" ] || NAME="$(basename "$FILE")"
case "$NAME" in ""|.|..|*/*) echo "✖ 파일 이름에 경로를 쓸 수 없다: $NAME" >&2; exit 1;; esac
case "$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')" in
  *.md|*.html) ;;
  *) NAME="${NAME%.*}.$FORMAT" ;;
esac

umask 077
mkdir -p "$OUTBOX"
chmod 700 "$OUTBOX"
TMP="$(mktemp "$OUTBOX/.steno-send.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
cp "$FILE" "$TMP"
chmod 600 "$TMP"

DEST="$OUTBOX/$NAME"
n=2
while :; do
  mv -n "$TMP" "$DEST" 2>/dev/null || true
  [ ! -e "$TMP" ] && break
  stem="${NAME%.*}"; ext="${NAME##*.}"
  DEST="$OUTBOX/$stem $n.$ext"
  n=$((n + 1))
done
trap - EXIT
echo "$(basename "$DEST")"
echo "✓ Steno outbox에 넣음 — $(basename "$DEST")" >&2

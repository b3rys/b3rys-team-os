#!/bin/bash
# 보고서 파일(md·html)을 팀장 편집기(Steno)의 "받은 파일/" 로 보낸다.
#
# Usage: steno-send.sh <file.md|file.html> [--name <받는 쪽 파일 이름>]
#
#   · 보낸 이는 워크스페이스에서 자동으로 정해진다(_me.sh). --from 은 없다.
#   · 형식은 확장자로 정한다: .md·.markdown → md, .html·.htm → html. 그 밖은 거절.
#   · --name 을 안 주면 파일 이름 그대로 보낸다. 서버가 경로 문자를 걷어낸다.
#   · 크기 상한은 서버 설정(B3OS_NOTES_MAX_BYTES, 기본 1 MB). 넘으면 서버가 413 으로 거절한다.
#   · 보낸 것은 덮어쓰거나 지울 수 없다. 고친 판은 새로 보낸다.
# 성공하면 받은 id 를 stdout 에 한 줄로 찍고 0 으로 끝난다. 실패하면 이유를 stderr 에 찍고 1.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"

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

case "$(printf '%s' "$FILE" | tr '[:upper:]' '[:lower:]')" in
  *.md|*.markdown) FORMAT="md" ;;
  *.html|*.htm) FORMAT="html" ;;
  *) echo "✖ md·html 만 보낼 수 있다: $FILE" >&2; exit 1 ;;
esac
[ -n "$NAME" ] || NAME="$(basename "$FILE")"

FROM="$("$HERE/_me.sh")" || exit 1

# 본문은 셸 인자로 넘기지 않는다 — 파일에서 바로 JSON 을 만든다(백틱·$ 가 사라지지 않게).
PAYLOAD_FILE="$(mktemp)"
trap 'rm -f "$PAYLOAD_FILE"' EXIT
FILE="$FILE" FROM="$FROM" NAME="$NAME" FORMAT="$FORMAT" python3 - > "$PAYLOAD_FILE" <<'PY' || { echo "✖ 파일을 UTF-8 로 읽지 못했다" >&2; exit 1; }
import json, os
with open(os.environ["FILE"], encoding="utf-8") as f:
    content = f.read()
json.dump({"from_agent_id": os.environ["FROM"], "name": os.environ["NAME"],
           "format": os.environ["FORMAT"], "content": content}, __import__("sys").stdout, ensure_ascii=False)
PY

RESP="$(curl -sS -w '\n%{http_code}' -X POST -H "Content-Type: application/json" --data-binary "@$PAYLOAD_FILE" "$BASE/api/notes")" || {
  echo "✖ 팀 서버에 닿지 못했다: $BASE" >&2; exit 1; }
CODE="$(printf '%s' "$RESP" | tail -n1)"
BODY="$(printf '%s' "$RESP" | sed '$d')"
if [ "$CODE" != "201" ]; then
  echo "✖ 거절됨 (HTTP $CODE): $BODY" >&2
  exit 1
fi
printf '%s' "$BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["id"])'
echo "✓ Steno 로 보냄 — id $(printf '%s' "$BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["id"], "·", d.get("name") or "(이름 없음)")')" >&2

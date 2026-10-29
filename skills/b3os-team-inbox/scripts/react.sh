#!/bin/bash
# 내가 받은 cogs 메시지에 리액션을 붙인다(내 봇으로). 다시 부르면 바뀌고, --emoji "" 면 지운다.
# Usage: react.sh --msg <버스 message_id> --emoji <이모지 하나>
#   msg 는 cogs 메시지가 들어올 때 함께 온 버스 id(in-reply-to 에 쓰는 값)다. 토큰은 서버가 쓴다.
set -u
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MSG=""; EMOJI=""; HAVE_EMOJI=""
while [ $# -gt 0 ]; do
  case "$1" in
    --msg) MSG="${2:-}"; shift 2 ;;
    --emoji) EMOJI="${2-}"; HAVE_EMOJI=1; shift 2 ;;
    *) echo "✖ 모르는 옵션: $1 (react.sh --msg <id> --emoji <이모지>)" >&2; exit 2 ;;
  esac
done
[ -n "$MSG" ] && [ -n "$HAVE_EMOJI" ] || { echo "✖ --msg 와 --emoji 가 필요합니다 (지우려면 --emoji \"\")" >&2; exit 2; }
# 신원은 워크스페이스에서 정한다(send.sh·ack.sh 와 같다). 모르면 멈춘다.
ME="$("$DIR/_me.sh")" || { echo "✖ 리액션 중단: 내가 누군지 해석하지 못했다." >&2; exit 1; }
PAYLOAD=$(ME="$ME" MSG="$MSG" EMOJI="$EMOJI" python3 -c '
import json, os
print(json.dumps({"agent_id": os.environ["ME"], "message_id": os.environ["MSG"], "emoji": os.environ["EMOJI"]}))')
RESP=$(curl -sS -m 15 -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$BASE/api/cogs/react") || { echo "✖ 서버에 닿지 못했습니다 ($BASE)" >&2; exit 1; }
RESP="$RESP" python3 -c '
import json, os, sys
try: d = json.loads(os.environ["RESP"])
except Exception: print("✖ 서버 응답이 JSON 이 아닙니다", file=sys.stderr); sys.exit(1)
if d.get("ok"):
    print("✓ 리액션 지움" if d.get("cleared") else "✓ 리액션 붙임", file=sys.stderr); sys.exit(0)
print("✖ 리액션 실패: " + str(d.get("error")), file=sys.stderr); sys.exit(1)'

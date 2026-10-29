#!/bin/bash
# 내가 받은 cogs 메시지에 리액션을 붙인다(내 봇으로). 다시 부르면 바뀌고, --emoji "" 면 지운다.
# Usage: react.sh --msg <버스 message_id> [--emoji <이모지 하나>] [--no-reply]
#   --no-reply: 글 답 없이 끝낸다고 cogs 에 알린다(앱의 '입력 중'을 끈다). 리액션과 같이 써도, 혼자 써도 된다.
#   msg 는 cogs 메시지가 들어올 때 함께 온 버스 id(in-reply-to 에 쓰는 값)다. 토큰은 서버가 쓴다.
set -u
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MSG=""; EMOJI=""; HAVE_EMOJI=""; NO_REPLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    # 값이 빠지면 shift 2 가 실패해 끝없이 돈다 — 값 개수를 먼저 본다. --emoji "" (지우기)는 값이 있는 것이다.
    --msg) [ $# -ge 2 ] || { echo "✖ --msg 에 값이 없습니다" >&2; exit 2; }; MSG="$2"; shift 2 ;;
    --emoji) [ $# -ge 2 ] || { echo "✖ --emoji 에 값이 없습니다 (지우려면 --emoji \"\")" >&2; exit 2; }; EMOJI="$2"; HAVE_EMOJI=1; shift 2 ;;
    --no-reply) NO_REPLY=1; shift ;;
    *) echo "✖ 모르는 옵션: $1 (react.sh --msg <id> --emoji <이모지>)" >&2; exit 2 ;;
  esac
done
[ -n "$MSG" ] && { [ -n "$HAVE_EMOJI" ] || [ -n "$NO_REPLY" ]; } || { echo "✖ --msg 와 --emoji(또는 --no-reply) 가 필요합니다 (지우려면 --emoji \"\")" >&2; exit 2; }
# 신원은 워크스페이스에서 정한다(send.sh·ack.sh 와 같다). 모르면 멈춘다.
#   ★서버 인증이 아니다★ — send.sh 처럼 이 기계의 b3os API(127.0.0.1)를 부를 수 있는 쪽은 다 믿는 모델이다.
ME="$("$DIR/_me.sh")" || { echo "✖ 리액션 중단: 내가 누군지 해석하지 못했다." >&2; exit 1; }
PAYLOAD=$(ME="$ME" MSG="$MSG" EMOJI="$EMOJI" HAVE_EMOJI="$HAVE_EMOJI" NO_REPLY="$NO_REPLY" python3 -c '
import json, os
d = {"agent_id": os.environ["ME"], "message_id": os.environ["MSG"]}
if os.environ["HAVE_EMOJI"]: d["emoji"] = os.environ["EMOJI"]
if os.environ["NO_REPLY"]: d["no_reply"] = True
print(json.dumps(d))')
RESP=$(curl -sS -m 15 -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$BASE/api/cogs/react") || { echo "✖ 서버에 닿지 못했습니다 ($BASE)" >&2; exit 1; }
RESP="$RESP" HAVE_EMOJI="$HAVE_EMOJI" python3 -c '
import json, os, sys
try: d = json.loads(os.environ["RESP"])
except Exception: print("✖ 서버 응답이 JSON 이 아닙니다", file=sys.stderr); sys.exit(1)
if d.get("ok"):
    if os.environ["HAVE_EMOJI"]: print("✓ 리액션 지움" if d.get("cleared") else "✓ 리액션 붙임", file=sys.stderr)
    if "declined" in d: print("✓ 답 없이 끝냄 알림" if d["declined"] else "✓ 기다리는 응답 없음(이미 답했거나 만료)", file=sys.stderr)
    sys.exit(0)
print("✖ 리액션 실패: " + str(d.get("error")), file=sys.stderr); sys.exit(1)'

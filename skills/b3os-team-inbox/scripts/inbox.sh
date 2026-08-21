#!/bin/bash
# Show my unread inbox messages.
# Usage: inbox.sh [--limit N] [--as agent_id]
#        inbox.sh --delivery <msg_id>      내가 보낸 메시지가 어느 채널로 나갔는지 본다
#
# ★--delivery 와 send.sh --confirm 은 보는 곳이 다르다★
#   --confirm  : ★버스 안★ 수신자의 처리 상태(message_recipient).
#   --delivery : ★버스 밖★ 으로 나간 결과(telegram DM·팀방).
#   `--direct-to-gd` 처럼 목적지가 버스 밖이면 --confirm 으로는 그 구간이 안 보인다.
#   ★둘 다 '발송' 까지다. 받는 사람이 읽었는지는 어느 쪽도 알려주지 않는다.★
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"
LIMIT=20
AS=""
DELIVERY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --as) AS="$2"; shift 2 ;;
    --delivery) DELIVERY="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -n "$DELIVERY" ]; then
  curl -sS "$BASE/api/messages/$DELIVERY" | MSG_ID="$DELIVERY" python3 -c '
import sys, json, os
mid = os.environ["MSG_ID"]
try:
    d = json.load(sys.stdin)
except Exception:
    print(mid + " — 서버 응답을 읽을 수 없습니다")
    sys.exit(1)
if d.get("error"):
    print(mid + " — 그런 메시지가 없습니다")
    sys.exit(0)
# ★키가 없는 것과 빈 배열은 다르다★ — 키가 없으면 서버가 아직 옛 버전이다(재시작 필요).
if "deliveries" not in d:
    print(mid + " — 이 서버는 배달 기록을 주지 않습니다(서버 재시작 필요)")
    sys.exit(0)
ds = d["deliveries"]
if not ds:
    print(mid + " — 배달 기록 없음 (아직 처리 전이거나 발송 경로를 안 탄 메시지)")
    sys.exit(0)
LABEL = {"bus": "버스", "telegram_dm": "텔레그램 팀장 DM", "telegram_group": "텔레그램 팀방"}
print(mid)
for x in ds:
    ch = x.get("channel") or "?"
    label = LABEL.get(ch, ch)
    if ch == "bus" and x.get("to"):
        label = "버스 → " + str(x["to"])
    state = "성공" if x.get("ok") else "★실패★"
    line = "  " + str(x.get("at", "?")) + "  " + label + "  " + state
    if not x.get("ok") and x.get("error"):
        line += "  (" + str(x["error"]) + ")"
    print(line)
print("  ※ 발송까지만 확인됩니다. 받는 사람이 읽었는지는 알 수 없습니다.")
'
  exit 0
fi

ME="${AS:-$($HERE/_me.sh)}"
curl -sS "$BASE/api/inbox/$ME?limit=$LIMIT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'inbox for [{d[\"agent_id\"]}] — {d[\"count\"]} unread')
for m in d['messages']:
    src = m['source']
    src_tag = '[agent]' if src == 'agent' else '[user]' if src == 'user' else '[sys]'
    print(f'  {m[\"id\"]} thread={m[\"thread_id\"]} hop={m[\"hop_count\"]} from={m[\"from_agent_id\"]} {src_tag}')
    print(f'    {m[\"body\"][:200]}')
"

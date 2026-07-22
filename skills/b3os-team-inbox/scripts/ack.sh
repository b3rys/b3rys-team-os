#!/bin/bash
# Mark a message as read. For a broadcast this acks it for THIS agent only (per-agent read).
# Usage: ack.sh <message_id> [--as agent_id]
set -e
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"
MID="${1:?message_id required}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ★신원을 추측하지 않는다. 모르면 실패한다.★
#   예전엔 `|| echo unknown` 이었다 → 해석 실패 시 ★'unknown' 이라는 없는 팀원 이름으로 ack 을 찍었다.★
#   ack 은 "내가 읽었다"는 기록이다. 남의 이름(또는 유령 이름)으로 찍히면
#   ★진짜 수신자는 영영 안 읽은 상태로 남고, 서버는 읽었다고 믿는다.★
#   2026-07-13: 같은 계열(신원 추측)이 hermes 발신을 온종일 bill 로 위장시켰다. ★틀린 답보다 멈추는 게 낫다.★
if [ "${2:-}" = "--as" ]; then
  ME="$3"
else
  ME="$("$DIR/_me.sh")" || {
    echo "✖ ack 중단: 내가 누군지 해석하지 못했다. (--as <agent id> 로 명시하라)" >&2
    exit 1
  }
fi
curl -sS -X PATCH "$BASE/api/inbox/$MID/read?agent_id=$ME" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('✓ ack' if d.get('ok') else f'✗ {d}')
"

#!/bin/bash
# Single-agent polling loop. Polls its inbox every 2s. If unread message from `partner`, replies + marks read.
# Stops after `iters` iterations.
#
# Usage: mock-poll.sh <me_agent_id> <partner_agent_id> <iters>
set -e
ME="${1:?me agent id required}"
PARTNER="${2:?partner agent id required}"
ITERS="${3:-15}"
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"
MAX_HOPS="${TEAM_MAX_HOPS:-5}"

log() { echo "[mock:$ME] $*"; }

for i in $(seq 1 "$ITERS"); do
  RESP=$(curl -sS "$BASE/api/inbox/$ME?limit=10")
  COUNT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])")
  if [ "$COUNT" -gt 0 ]; then
    # Pick first unread from partner
    PICK=$(echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for m in d['messages']:
    if m['from_agent_id'] == '$PARTNER':
        print(m['id'], m.get('thread_id'), m.get('hop_count', 0), m.get('body','')[:60])
        break
")
    if [ -n "$PICK" ]; then
      MID=$(echo "$PICK" | awk '{print $1}')
      TID=$(echo "$PICK" | awk '{print $2}')
      HOP=$(echo "$PICK" | awk '{print $3}')
      NEXT_HOP=$((HOP + 1))
      BODY="$ME ack #$i (received hop=$HOP)"
      if [ "$NEXT_HOP" -ge "$MAX_HOPS" ]; then
        log "hop limit ($NEXT_HOP) — not replying, just ack-read"
      else
        REPLY_PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'thread_id': '$TID',
    'from_agent_id': '$ME',
    'to_agent_id': '$PARTNER',
    'body': '$BODY',
    'type': 'reply',
    'in_reply_to': '$MID',
    'hop_count': $NEXT_HOP,
    'source': 'agent'
}))
")
        REPLY=$(curl -sS -X POST -H "Content-Type: application/json" -d "$REPLY_PAYLOAD" "$BASE/api/inbox")
        REPLY_ID=$(echo "$REPLY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',{}).get('id','?'))")
        log "replied $MID(hop=$HOP) → $REPLY_ID(hop=$NEXT_HOP)"
      fi
      curl -sS -X PATCH "$BASE/api/inbox/$MID/read" > /dev/null
    fi
  fi
  sleep 2
done
log "loop done"

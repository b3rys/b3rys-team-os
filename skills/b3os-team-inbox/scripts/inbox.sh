#!/bin/bash
# Show my unread inbox messages.
# Usage: inbox.sh [--limit N] [--as agent_id]
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"
LIMIT=20
AS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --as) AS="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

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

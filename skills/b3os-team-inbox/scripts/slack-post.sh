#!/bin/bash
# Post a top-level message to a Slack channel as the current agent.
# (Not a thread reply — for proactive announcements, weekly meeting starters, daily briefs, etc.)
# Usage:
#   slack-post.sh --channel <C...> --text "..."
#   slack-post.sh --channel <C...> --text "..." --as <agent>     # impersonate (admin)
#   slack-post.sh --channel <C...> --text "..." --thread <ts>    # reply in thread instead
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"

CHANNEL=""; TEXT=""; AS=""; THREAD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --text)    TEXT="$2"; shift 2 ;;
    --as)      AS="$2"; shift 2 ;;
    --thread)  THREAD="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -z "$CHANNEL" ] && { echo "ERROR: --channel required (Slack channel id, starts with C)" >&2; exit 1; }
[ -z "$TEXT" ]    && { echo "ERROR: --text required" >&2; exit 1; }

AGENT="${AS:-$($HERE/_me.sh)}"

PAYLOAD=$(AGENT="$AGENT" CHANNEL="$CHANNEL" TEXT="$TEXT" THREAD="$THREAD" python3 -c "
import json, os
p = {
  'agent_id': os.environ['AGENT'],
  'channel':  os.environ['CHANNEL'],
  'text':     os.environ['TEXT'],
}
if os.environ.get('THREAD'): p['thread_ts'] = os.environ['THREAD']
print(json.dumps(p, ensure_ascii=False))
")

RESP=$(curl -sS -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$BASE/api/slack/post")
echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'):
    print(f'✓ posted ts={d[\"ts\"]} channel=$CHANNEL as=$AGENT')
else:
    print(f'✗ {json.dumps(d, ensure_ascii=False)}')
    sys.exit(1)
"

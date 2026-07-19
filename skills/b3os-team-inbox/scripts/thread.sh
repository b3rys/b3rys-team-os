#!/bin/bash
# Show ALL messages in a thread — 위임/요청 회신 추적 정본.
#   inbox.sh 는 "나에게 directed 로 온 unread" 만 보여줘서, thread 에는 올라왔지만 나를
#   수신자로 지정하지 않은 답(broadcast/무지정)이나 이미 read 된 답은 누락된다.
#   특정 작업의 회신을 확인할 땐 그 작업 thread 를 이 스크립트로 통째로 조회한다.
# Usage: thread.sh <thread_id> [--limit N]
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"

TID="${1:-}"
[ -z "$TID" ] && { echo "usage: thread.sh <thread_id> [--limit N]" >&2; exit 1; }
shift
LIMIT=50
while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

curl -sS "$BASE/api/threads/$TID" | LIMIT="$LIMIT" python3 -c "
import sys, os, json
d = json.load(sys.stdin)
if 'error' in d:
    print('thread error:', d.get('error'), d.get('id') or '')
    sys.exit(0)
msgs = d.get('messages', [])
limit = int(os.environ.get('LIMIT', '50'))
th = d.get('thread') or {}
tid = th.get('id') if isinstance(th, dict) else d.get('id', '?')
print(f'thread [{tid}] — {len(msgs)} messages (showing last {min(limit, len(msgs))})')
for m in msgs[-limit:]:
    src = m.get('source')
    tag = '[agent]' if src == 'agent' else '[user]' if src == 'user' else '[sys]'
    to = m.get('to_agent_id') or '-'
    when = (m.get('created_at') or '')[:19]
    rd = 'read' if m.get('read_at') else 'unread'
    print(f\"  {when} {m.get('id')} from={m.get('from_agent_id')}->{to} {tag} hop={m.get('hop_count')} {rd}\")
    body = (m.get('body') or '').replace('\n', ' ')
    print(f'    {body[:240]}')
"

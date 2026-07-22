#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STORE="${B3OS_TASK_LOOP_STORE:-$ROOT/var/task-loop-waits.json}"
OWNER=""; TASK=""; CARD_REF=""; THREAD=""; IN_REPLY_TO=""; MSG_ID=""; WAITING_ON=""; RECHECK=""; FALLBACK=""; NEXT=""; STOP_RULE=""; ESCALATION_AFTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2;;
    --task) TASK="$2"; shift 2;;
    --card-ref|--card_ref|--task-id|--task_id) CARD_REF="$2"; shift 2;;
    --thread|--thread-id) THREAD="$2"; shift 2;;
    --in-reply-to|--in_reply_to) IN_REPLY_TO="$2"; shift 2;;
    --msg-id|--msg_id) MSG_ID="$2"; shift 2;;
    --waiting-on|--waiting_on) WAITING_ON="$2"; shift 2;;
    --recheck|--recheck-at|--recheck_at) RECHECK="$2"; shift 2;;
    --fallback) FALLBACK="$2"; shift 2;;
    --next|--next-safe-action|--next_safe_action) NEXT="$2"; shift 2;;
    --stop-rule|--stop_rule) STOP_RULE="$2"; shift 2;;
    --escalation-after|--escalation_after) ESCALATION_AFTER="$2"; shift 2;;
    -h|--help) sed -n '1,110p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
python3 - "$STORE" "$OWNER" "$TASK" "$CARD_REF" "$THREAD" "$IN_REPLY_TO" "$MSG_ID" "$WAITING_ON" "$RECHECK" "$FALLBACK" "$NEXT" "$STOP_RULE" "$ESCALATION_AFTER" <<'PY'
import json, os, sys, tempfile, uuid
from datetime import datetime, timedelta, timezone
(store, owner, task, card_ref, thread, in_reply_to, msg_id, waiting_on, recheck, fallback, next_action, stop_rule, escalation_after) = sys.argv[1:]
missing=[name for name,val in [('owner',owner),('task',task),('card_ref',card_ref),('thread_id',thread),('waiting_on',waiting_on),('recheck_at',recheck),('fallback',fallback),('next_safe_action',next_action),('stop_rule',stop_rule)] if not val]
if missing:
    print('missing required: '+', '.join(missing), file=sys.stderr); sys.exit(2)
def parse_recheck(s):
    now=datetime.now(timezone.utc)
    s=s.strip()
    if s.endswith('m') and s[:-1].isdigit(): return now+timedelta(minutes=int(s[:-1]))
    if s.endswith('h') and s[:-1].isdigit(): return now+timedelta(hours=int(s[:-1]))
    if s.endswith('d') and s[:-1].isdigit(): return now+timedelta(days=int(s[:-1]))
    try: return datetime.fromisoformat(s.replace('Z','+00:00'))
    except Exception:
        print('invalid --recheck; use 10m, 2h, 1d, or ISO timestamp', file=sys.stderr); sys.exit(2)
def atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.task-loop-', suffix='.tmp', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(data,f,ensure_ascii=False,indent=2)
            f.write('\n')
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
try:
    with open(store) as f: data=json.load(f)
except FileNotFoundError:
    data=[]
except json.JSONDecodeError:
    print(f'invalid JSON store: {store}', file=sys.stderr); sys.exit(1)
now=datetime.now(timezone.utc).isoformat(); recheck_at=parse_recheck(recheck).isoformat()
key={'card_ref': card_ref, 'thread_id': thread, 'waiting_on': waiting_on}
for r in data:
    if r.get('status') in ('waiting','waiting_with_recheck') and all(r.get(k)==v for k,v in key.items()):
        r.update(status='superseded', closed_at=now, updated_at=now, close_note='replaced by newer wait record')
rec={
  'id':'wait_'+uuid.uuid4().hex[:12], 'owner':owner, 'task':task, 'card_ref':card_ref,
  'thread_id':thread, 'in_reply_to':in_reply_to or None, 'msg_id':msg_id or None,
  'waiting_on':waiting_on, 'status':'waiting_with_recheck', 'asked_at':now,
  'recheck_at':recheck_at, 'fallback':fallback, 'next_safe_action':next_action,
  'stop_rule':stop_rule, 'escalation_after': int(escalation_after) if escalation_after.isdigit() else None,
  'attempt_count':0, 'last_checked_at':None, 'created_at':now, 'updated_at':now, 'checks':[]
}
data.append(rec); atomic_write(store,data)
print(json.dumps({'ok':True,'id':rec['id'],'owner':owner,'card_ref':card_ref,'thread_id':thread,'recheck_at':recheck_at,'next_safe_action':next_action,'fallback':fallback},ensure_ascii=False))
PY

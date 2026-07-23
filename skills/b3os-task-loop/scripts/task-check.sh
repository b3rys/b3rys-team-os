#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STORE="${B3OS_TASK_LOOP_STORE:-$ROOT/var/task-loop-waits.json}"
TEAM_BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"
THREAD=""; CARD_REF=""; WAITING_ON=""; ALL=0; DUE=0; MARK=0; NO_THREAD_FETCH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --thread|--thread-id) THREAD="$2"; shift 2;;
    --card-ref|--card_ref|--task-id|--task_id) CARD_REF="$2"; shift 2;;
    --waiting-on|--waiting_on) WAITING_ON="$2"; shift 2;;
    --all) ALL=1; shift;;
    --due) DUE=1; shift;;
    --mark-check|--mark_check) MARK=1; shift;;
    --no-thread-fetch) NO_THREAD_FETCH=1; shift;;
    -h|--help) sed -n '1,120p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
python3 - "$STORE" "$THREAD" "$CARD_REF" "$WAITING_ON" "$ALL" "$DUE" "$MARK" "$NO_THREAD_FETCH" "$TEAM_BASE" <<'PY'
import json, os, sys, tempfile, urllib.request, urllib.error
from datetime import datetime, timezone
store, thread, card_ref, waiting_on, all_flag, due_flag, mark, no_thread_fetch, team_base = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]=='1', sys.argv[6]=='1', sys.argv[7]=='1', sys.argv[8]=='1', sys.argv[9]
def atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.task-loop-',suffix='.tmp',dir=os.path.dirname(path))
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(data,f,ensure_ascii=False,indent=2); f.write('\n')
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
def fetch_thread(tid):
    if not tid or no_thread_fetch: return None
    url=f"{team_base.rstrip('/')}/api/threads/{tid}"
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            d=json.loads(r.read().decode('utf-8'))
        msgs=d.get('messages') or d.get('items') or []
        return {'ok': True, 'thread_id': tid, 'message_count': len(msgs), 'last_messages': [
            {'id':m.get('id'), 'created_at':m.get('created_at'), 'from':m.get('from_agent_id'), 'to':m.get('to_agent_id'), 'snippet':(m.get('body') or '').replace('\n',' ')[:240]} for m in msgs[-5:]
        ]}
    except Exception as e:
        return {'ok': False, 'thread_id': tid, 'error': str(e)}
try:
    with open(store) as f: data=json.load(f)
except FileNotFoundError:
    data=[]
now=datetime.now(timezone.utc)
def is_open(r): return r.get('status') in ('waiting','waiting_with_recheck')
def is_due(r):
    try: return datetime.fromisoformat(r.get('recheck_at','').replace('Z','+00:00')) <= now
    except Exception: return False
records=[]; changed=False
for r in data:
    if thread and r.get('thread_id') != thread: continue
    if card_ref and r.get('card_ref') != card_ref: continue
    if waiting_on and r.get('waiting_on') != waiting_on: continue
    if not all_flag and not is_open(r): continue
    if due_flag and not is_due(r): continue
    if mark and is_open(r):
        r['attempt_count']=int(r.get('attempt_count') or 0)+1
        r['last_checked_at']=now.isoformat(); r['updated_at']=now.isoformat()
        r.setdefault('checks',[]).append({'checked_at':now.isoformat(),'due':is_due(r),'thread_fetch': bool(thread and not no_thread_fetch)})
        changed=True
    item={k:r.get(k) for k in ['id','owner','task','card_ref','thread_id','in_reply_to','msg_id','waiting_on','status','asked_at','recheck_at','fallback','next_safe_action','stop_rule','escalation_after','attempt_count','last_checked_at','updated_at']}
    item['due']=is_due(r)
    records.append(item)
if changed: atomic_write(store,data)
print(json.dumps({'ok':True,'now':now.isoformat(),'records':records,'thread':fetch_thread(thread)},ensure_ascii=False,indent=2))
PY

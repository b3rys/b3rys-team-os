#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STORE="${B3OS_TASK_LOOP_STORE:-$ROOT/var/task-loop-waits.json}"
THREAD=""; ID=""; CARD_REF=""; WAITING_ON=""; STATUS="completed"; NOTE=""; ALL_MATCHING=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --thread|--thread-id) THREAD="$2"; shift 2;;
    --card-ref|--card_ref|--task-id|--task_id) CARD_REF="$2"; shift 2;;
    --waiting-on|--waiting_on) WAITING_ON="$2"; shift 2;;
    --id) ID="$2"; shift 2;;
    --status) STATUS="$2"; shift 2;;
    --note) NOTE="$2"; shift 2;;
    --all-matching) ALL_MATCHING=1; shift;;
    -h|--help) sed -n '1,120p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
python3 - "$STORE" "$THREAD" "$CARD_REF" "$WAITING_ON" "$ID" "$STATUS" "$NOTE" "$ALL_MATCHING" <<'PY'
import json, os, sys, tempfile
from datetime import datetime, timezone
store, thread, card_ref, waiting_on, rec_id, status, note, all_matching = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7], sys.argv[8]=='1'
allowed={'completed','blocked','awaiting_approval','cancelled','superseded','next_wake_scheduled'}
if status not in allowed:
    print('invalid --status: '+status, file=sys.stderr); sys.exit(2)
if not rec_id and not (card_ref and waiting_on) and not (thread and waiting_on) and not all_matching:
    print('safe close requires --id, or --card-ref + --waiting-on, or --thread + --waiting-on. Use --all-matching for explicit bulk close.', file=sys.stderr); sys.exit(2)
def atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.task-loop-',suffix='.tmp',dir=os.path.dirname(path))
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(data,f,ensure_ascii=False,indent=2); f.write('\n')
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
try:
    with open(store) as f: data=json.load(f)
except FileNotFoundError:
    print('no wait store', file=sys.stderr); sys.exit(1)
open_matches=[]
for r in data:
    if r.get('status') not in ('waiting','waiting_with_recheck'): continue
    if rec_id and r.get('id') != rec_id: continue
    if thread and r.get('thread_id') != thread: continue
    if card_ref and r.get('card_ref') != card_ref: continue
    if waiting_on and r.get('waiting_on') != waiting_on: continue
    open_matches.append(r)
if not open_matches:
    print(json.dumps({'ok':False,'closed':[],'message':'no matching open wait record'},ensure_ascii=False)); sys.exit(1)
if len(open_matches) > 1 and not all_matching:
    print(json.dumps({'ok':False,'closed':[],'message':'multiple matching open wait records; use --id or add --waiting-on/--card-ref, or pass --all-matching','matches':[{'id':r.get('id'),'card_ref':r.get('card_ref'),'thread_id':r.get('thread_id'),'waiting_on':r.get('waiting_on')} for r in open_matches]},ensure_ascii=False)); sys.exit(2)
now=datetime.now(timezone.utc).isoformat(); closed=[]
for r in open_matches:
    r['status']=status; r['closed_at']=now; r['updated_at']=now; r['close_note']=note
    closed.append(r.get('id'))
atomic_write(store,data)
print(json.dumps({'ok':True,'closed':closed,'status':status,'note':note},ensure_ascii=False))
PY

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export B3OS_TASK_LOOP_STORE="$TMP/task-loop-waits.json"
WAIT="$ROOT/skills/b3os-task-loop/scripts/task-wait.sh"
CHECK="$ROOT/skills/b3os-task-loop/scripts/task-check.sh"
CLOSE="$ROOT/skills/b3os-task-loop/scripts/task-close.sh"

echo "[1] create wait record with required fields"
OUT="$($WAIT --owner ames --task "review wait selftest" --card-ref task-123 --thread test-thread --in-reply-to msg-1 --msg-id msg-2 --waiting-on steve --recheck 1m --fallback "provisional report" --next "continue schema review" --stop-rule "2 misses => blocked" --escalation-after 2)"
echo "$OUT" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["ok"] and d["thread_id"]=="test-thread" and d["card_ref"]=="task-123"'

echo "[2] check wait record and mark attempt"
$CHECK --thread test-thread --mark-check --no-thread-fetch | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["ok"] and len(d["records"])==1 and d["records"][0]["attempt_count"]==1 and d["records"][0]["last_checked_at"]'

echo "[3] duplicate key supersedes previous open record"
$WAIT --owner ames --task "review wait selftest" --card-ref task-123 --thread test-thread --waiting-on steve --recheck 1m --fallback "fallback2" --next "next2" --stop-rule "stop2" >/dev/null
$CHECK --thread test-thread --no-thread-fetch | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["ok"] and len(d["records"])==1 and d["records"][0]["next_safe_action"]=="next2"'

echo "[4] close requires single selector"
$WAIT --owner ames --task "bill wait" --card-ref task-456 --thread shared-thread --waiting-on bill --recheck 1m --fallback f --next n --stop-rule s >/dev/null
$WAIT --owner ames --task "codex wait" --card-ref task-789 --thread shared-thread --waiting-on codex --recheck 1m --fallback f --next n --stop-rule s >/dev/null
if $CLOSE --thread shared-thread --status completed >/tmp/close.out 2>/tmp/close.err; then
  echo "expected ambiguous close failure" >&2; exit 1
fi
$CLOSE --thread shared-thread --waiting-on bill --status completed --note "bill done" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["ok"] and len(d["closed"])==1'
$CHECK --thread shared-thread --no-thread-fetch | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["ok"] and len(d["records"])==1 and d["records"][0]["waiting_on"]=="codex"'

echo "[5] close wait record by card_ref+waiting_on"
$CLOSE --card-ref task-123 --waiting-on steve --status completed --note "selftest done" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["ok"] and d["status"]=="completed"'

echo "[6] check no open records for test-thread"
$CHECK --thread test-thread --no-thread-fetch | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["ok"] and len(d["records"])==0'

echo "[7] malformed time fails"
if $WAIT --owner ames --task bad --card-ref bad --thread bad --waiting-on steve --recheck soon --fallback f --next n --stop-rule s >/tmp/bad.out 2>/tmp/bad.err; then
  echo "expected malformed time failure" >&2; exit 1
fi

echo "[8] thread fetch returns explicit thread field when enabled"
$CHECK --thread nonexistent-thread-for-selftest | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["ok"] and "thread" in d'

echo "b3os-task-loop selftest ok"

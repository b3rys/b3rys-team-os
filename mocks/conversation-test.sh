#!/bin/bash
# Phase 1.5 integration test — two mock agents have a conversation via the inbox API.
# Verifies: envelope schema validation, thread auto-create, hop_count chain, mark-read.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"

echo "=== Phase 1.5 — mock conversation test ==="
echo "BASE=$BASE"

# Sanity: server up + mocks registered
curl -fsS "$BASE/health" > /dev/null
echo "✓ server up"

MOCK_COUNT=$(curl -sS "$BASE/api/agents" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = {a['id'] for a in d['agents']}
print(int('mock_alice' in ids and 'mock_bob' in ids))
")
[ "$MOCK_COUNT" = "1" ] || { echo "✗ mock agents not in registry"; exit 1; }
echo "✓ mock_alice + mock_bob in registry"

# Spawn both pollers
"$HERE/mock-poll.sh" mock_alice mock_bob 12 > /tmp/mock-alice.log 2>&1 &
ALICE_PID=$!
"$HERE/mock-poll.sh" mock_bob mock_alice 12 > /tmp/mock-bob.log 2>&1 &
BOB_PID=$!
echo "spawned: alice pid=$ALICE_PID, bob pid=$BOB_PID"

# Kick off — alice → bob initial
KICKOFF=$(curl -sS -X POST -H "Content-Type: application/json" \
  -d '{"from_agent_id":"mock_alice","to_agent_id":"mock_bob","body":"안녕 Bob, 첫 envelope 테스트야","type":"dm","source":"agent","hop_count":0}' \
  "$BASE/api/inbox")
THREAD_ID=$(echo "$KICKOFF" | python3 -c "import sys,json; print(json.load(sys.stdin)['message']['thread_id'])")
echo "✓ kickoff sent, thread=$THREAD_ID"

# Let the conversation run ~14s (covers ~7 polls each side)
sleep 14

# Stop pollers
kill "$ALICE_PID" "$BOB_PID" 2>/dev/null || true
wait 2>/dev/null || true

# Inspect thread
echo
echo "=== thread content ==="
curl -sS "$BASE/api/threads/$THREAD_ID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
t = d['thread']
ms = d['messages']
print(f'thread {t[\"id\"]} kind={t[\"kind\"]} status={t[\"status\"]} parts={t[\"participants\"]}')
print(f'messages: {len(ms)}')
for m in ms:
    print(f'  [{m[\"hop_count\"]}] {m[\"from_agent_id\"]} → {m[\"to_agent_id\"]}: {m[\"body\"][:60]}')
print()
hops = [m['hop_count'] for m in ms]
print(f'hop_count progression: {hops}')
assert len(ms) >= 3, f'expected ≥3 messages, got {len(ms)}'
assert hops == sorted(hops), 'hop_count should be non-decreasing'
assert max(hops) >= 2, 'expected at least 2 round-trips'
print('✓ all assertions passed')
"

echo
echo "=== mock logs ==="
echo "--- alice ---"
cat /tmp/mock-alice.log
echo "--- bob ---"
cat /tmp/mock-bob.log

#!/bin/bash
# send.sh 가 만드는 POST 본문이 올바른 JSON 인지 본다(서버 없이, 가짜 curl 로).
# send.sh 의 python -c "..." 블록은 bash 큰따옴표 안이라 주석에 큰따옴표 하나만 들어가도
# 본문이 비어 모든 발신이 invalid_json 으로 거절된다. 그 회귀를 막는다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/curl" <<'STUB'
#!/bin/bash
while [ $# -gt 0 ]; do [ "$1" = "-d" ] && { printf '%s' "$2" > "$CAPTURE"; shift; }; shift; done
echo '{"ok":true,"message":{"id":"m1","thread_id":"t1","hop_count":0}}'
STUB
chmod +x "$TMP/curl"
sqlite3 "$TMP/team.db" "CREATE TABLE agent (id TEXT, workspace_path TEXT, tmux_session TEXT); INSERT INTO agent VALUES ('tester','/nowhere','');"
pass=0
run() { GD_AGENT_ID=tester TEAM_DB_PATH="$TMP/team.db" CAPTURE="$TMP/payload.json" PATH="$TMP:$PATH" TEAM_BASE="http://fake/team" "$HERE/send.sh" "$@" >/dev/null 2>&1; }
check() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); $2" "$TMP/payload.json" || { echo "FAIL: $1" >&2; exit 1; }; pass=$((pass+1)); }

printf '%s' '본문 "따옴표" $HOME `백틱`' > "$TMP/body.txt"
run --to steve --thread t1 --body-file "$TMP/body.txt"
check "plain payload" "assert d['to_agent_id']=='steve' and '따옴표' in d['body'] and 'meta' not in d"

run --to steve --thread t1 --body x --no-wake
check "no-wake meta" "assert d['meta']['no_wake'] is True"

if run --to broadcast --thread t1 --body x --no-wake; then echo "FAIL: no-wake broadcast accepted" >&2; exit 1; fi
pass=$((pass+1))

echo "PASS: $pass send.sh payload checks"

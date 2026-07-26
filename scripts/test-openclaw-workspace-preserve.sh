#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/b3os-openclaw-preserve-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

TEST_HOME="$TMP/home"
TEST_BIN="$TMP/bin"
WS="$TMP/workspace"
mkdir -p "$TEST_HOME/.openclaw/credentials" "$TEST_HOME/.openclaw/agents" "$TEST_BIN" "$WS"
printf '{"auth":{"profiles":{"shared":{"provider":"test"}}}}\n' > "$TEST_HOME/.openclaw/openclaw.json"
printf 'fake-token\n' > "$TEST_HOME/.openclaw/credentials/telegram-clo-token.txt"
printf 'b3os agents identity\n' > "$WS/AGENTS.md"
printf 'custom soul persona\n' > "$WS/SOUL.md"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'state="${HOME}/.openclaw/test-agent-added"' \
  'case "${1:-} ${2:-}" in' \
  '  "agents list")' \
  '    if [ "${3:-}" = "--json" ]; then' \
  '      [ -f "$state" ] && printf '\''[{"id":"clo"}]\n'\'' || printf '\''[]\n'\''' \
  '    else' \
  '      [ -f "$state" ] && printf '\''clo\n'\''' \
  '    fi' \
  '    ;;' \
  '  "agents add")' \
  '    ws=""' \
  '    shift 2' \
  '    while [ "$#" -gt 0 ]; do' \
  '      if [ "$1" = "--workspace" ]; then ws="$2"; shift 2; else shift; fi' \
  '    done' \
  '    printf '\''openclaw default agents\n'\'' > "$ws/AGENTS.md"' \
  '    printf '\''openclaw default soul\n'\'' > "$ws/SOUL.md"' \
  '    touch "$state"' \
  '    ;;' \
  '  "gateway restart") ;;' \
  '  *) exit 0 ;;' \
  'esac' > "$TEST_BIN/openclaw"
chmod +x "$TEST_BIN/openclaw"

HOME="$TEST_HOME" PATH="$TEST_BIN:$PATH" AGENT_ID=clo DISPLAY=Clo WS="$WS" \
  bash "$ROOT/src/server/runtimes/openclaw/activate-openclaw-agent.sh" >/dev/null

[ "$(cat "$WS/AGENTS.md")" = "b3os agents identity" ] || {
  echo "FAIL: OpenClaw scaffold overwrote b3os AGENTS.md" >&2
  exit 1
}
[ "$(cat "$WS/SOUL.md")" = "custom soul persona" ] || {
  echo "FAIL: OpenClaw scaffold overwrote b3os SOUL.md" >&2
  exit 1
}

echo "PASS: OpenClaw workspace persona preservation"

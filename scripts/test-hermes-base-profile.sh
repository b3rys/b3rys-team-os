#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/b3os-hermes-base-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# activate: configured base wins; when absent, another authenticated profile remains the fallback.
ACT_HOME="$TMP/activate-home"
mkdir -p "$ACT_HOME/.local/bin" "$ACT_HOME/.hermes/credentials" \
  "$ACT_HOME/.hermes/profiles/configured-base" "$ACT_HOME/.hermes/profiles/fallback"
touch "$ACT_HOME/.hermes/profiles/configured-base/auth.json" "$ACT_HOME/.hermes/profiles/fallback/auth.json"
printf 'test-token\n' > "$ACT_HOME/.hermes/credentials/new-agent-token.txt"
printf '#!/usr/bin/env bash\nexit 42\n' > "$ACT_HOME/.local/bin/hermes"
chmod +x "$ACT_HOME/.local/bin/hermes"

set +e
out="$(HOME="$ACT_HOME" HERMES_BASE_PROFILE=configured-base AGENT_ID=new-agent \
  bash "$ROOT/src/server/runtimes/hermes/activate-hermes-agent.sh" 2>&1)"
set -e
grep -q "복제 원본 프로필: configured-base" <<< "$out" || fail "configured base was not selected"

rm "$ACT_HOME/.hermes/profiles/configured-base/auth.json"
set +e
out="$(HOME="$ACT_HOME" HERMES_BASE_PROFILE=missing-base AGENT_ID=new-agent \
  bash "$ROOT/src/server/runtimes/hermes/activate-hermes-agent.sh" 2>&1)"
set -e
grep -q "복제 원본 프로필: fallback" <<< "$out" || fail "authenticated-profile fallback did not run"

# Invalid names fail closed before any activation or uninstall cleanup.
set +e
HOME="$ACT_HOME" HERMES_BASE_PROFILE='../unsafe' AGENT_ID=new-agent \
  bash "$ROOT/src/server/runtimes/hermes/activate-hermes-agent.sh" >/dev/null 2>&1
status=$?
set -e
[ "$status" -ne 0 ] || fail "activate accepted an unsafe base profile"

# The server must also fail closed before destructive TypeScript cleanup paths can run.
set +e
HERMES_BASE_PROFILE='../unsafe' bun -e "await import('$ROOT/src/server/lib/paths.ts')" >/dev/null 2>&1
status=$?
set -e
[ "$status" -ne 0 ] || fail "server config accepted an unsafe base profile"

# uninstall: .env-configured base survives while a non-base Hermes profile is removed.
UN_ROOT="$TMP/uninstall-repo"
UN_HOME="$TMP/uninstall-home"
mkdir -p "$UN_ROOT" "$UN_HOME/.hermes/profiles/configured-base" "$UN_HOME/.hermes/profiles/worker" \
  "$UN_HOME/.hermes/credentials" "$UN_HOME/Library/LaunchAgents"
cp "$ROOT/uninstall.sh" "$UN_ROOT/uninstall.sh"
printf 'HERMES_BASE_PROFILE=configured-base\n' > "$UN_ROOT/.env"
printf '[{"id":"base","runtime":"hermes_agent","hermes_profile":"configured-base"},{"id":"worker","runtime":"hermes_agent","hermes_profile":"worker"}]\n' > "$UN_ROOT/agents.json"
touch "$UN_HOME/.hermes/credentials/base-token.txt" "$UN_HOME/.hermes/credentials/worker-token.txt"
touch "$UN_HOME/Library/LaunchAgents/ai.hermes.gateway-configured-base.plist"
touch "$UN_HOME/Library/LaunchAgents/ai.hermes.gateway-worker.plist"

HOME="$UN_HOME" USER="b3os-test" bash "$UN_ROOT/uninstall.sh" --yes --keep-data >/dev/null
[ -d "$UN_HOME/.hermes/profiles/configured-base" ] || fail "configured base profile was deleted"
[ -f "$UN_HOME/Library/LaunchAgents/ai.hermes.gateway-configured-base.plist" ] || fail "configured base plist was deleted"
[ -f "$UN_HOME/.hermes/credentials/base-token.txt" ] || fail "configured base credential was deleted"
[ ! -e "$UN_HOME/.hermes/profiles/worker" ] || fail "non-base profile was preserved"
[ ! -e "$UN_HOME/Library/LaunchAgents/ai.hermes.gateway-worker.plist" ] || fail "non-base plist was preserved"
[ ! -e "$UN_HOME/.hermes/credentials/worker-token.txt" ] || fail "non-base credential was preserved"

printf 'HERMES_BASE_PROFILE=../unsafe\n' > "$UN_ROOT/.env"
set +e
HOME="$UN_HOME" USER="b3os-test" bash "$UN_ROOT/uninstall.sh" --yes --keep-data >/dev/null 2>&1
status=$?
set -e
[ "$status" -ne 0 ] || fail "uninstall accepted an unsafe base profile"

echo "PASS: Hermes base profile configuration"

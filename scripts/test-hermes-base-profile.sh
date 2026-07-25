#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/b3os-hermes-base-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# install migration detector: cloned auth symlinks identify the old shared source without a branded literal.
DETECT_ROOT="$TMP/detect/profiles"
mkdir -p "$DETECT_ROOT/old-base" "$DETECT_ROOT/member-a" "$DETECT_ROOT/member-b"
touch "$DETECT_ROOT/old-base/auth.json"
ln -s "$DETECT_ROOT/old-base/auth.json" "$DETECT_ROOT/member-a/auth.json"
ln -s "$DETECT_ROOT/old-base/auth.json" "$DETECT_ROOT/member-b/auth.json"
detected="$(bash "$ROOT/src/server/runtimes/hermes/detect-base-profile.sh" "$DETECT_ROOT")"
[ "$detected" = "old-base" ] || fail "existing-install base detection failed"

rm "$DETECT_ROOT/member-a/auth.json" "$DETECT_ROOT/member-b/auth.json"
touch "$DETECT_ROOT/member-a/auth.json"
set +e
bash "$ROOT/src/server/runtimes/hermes/detect-base-profile.sh" "$DETECT_ROOT" >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 2 ] || fail "ambiguous existing auth profiles did not fail closed"

# install.sh backfills an existing .env from the detected shared auth source.
INSTALL_ROOT="$TMP/install-repo"
INSTALL_HOME="$TMP/install-home"
INSTALL_BIN="$TMP/install-bin"
mkdir -p "$INSTALL_ROOT/src/server/runtimes/hermes" "$INSTALL_ROOT/skills/b3os" "$INSTALL_HOME/.hermes/profiles/old-base" \
  "$INSTALL_HOME/.hermes/profiles/member" "$INSTALL_BIN"
cp "$ROOT/install.sh" "$INSTALL_ROOT/install.sh"
cp "$ROOT/.env.example" "$INSTALL_ROOT/.env.example"
cp "$ROOT/src/server/runtimes/hermes/detect-base-profile.sh" "$INSTALL_ROOT/src/server/runtimes/hermes/detect-base-profile.sh"
touch "$INSTALL_ROOT/skills/b3os/SKILL.md" "$INSTALL_HOME/.hermes/profiles/old-base/auth.json"
ln -s "$INSTALL_HOME/.hermes/profiles/old-base/auth.json" "$INSTALL_HOME/.hermes/profiles/member/auth.json"
printf 'TEAM_HTTP_PORT=7878\n' > "$INSTALL_ROOT/.env"
printf '#!/usr/bin/env bash\n[ "${1:-}" = "--version" ] && echo test\nexit 0\n' > "$INSTALL_BIN/bun"
printf '#!/usr/bin/env bash\necho Linux\n' > "$INSTALL_BIN/uname"
chmod +x "$INSTALL_BIN/bun" "$INSTALL_BIN/uname"
HOME="$INSTALL_HOME" PATH="$INSTALL_BIN:/usr/bin:/bin" bash "$INSTALL_ROOT/install.sh" >/dev/null
grep -q '^HERMES_BASE_PROFILE=old-base$' "$INSTALL_ROOT/.env" || fail "existing .env was not backfilled"

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
printf 'HERMES_BASE_PROFILE=configured-base # preserved base\n' > "$UN_ROOT/.env"
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

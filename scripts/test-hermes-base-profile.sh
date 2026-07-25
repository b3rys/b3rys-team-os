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

# Atomic replacement must preserve restrictive permissions because .env contains bot tokens.
chmod 600 "$INSTALL_ROOT/.env"
HOME="$INSTALL_HOME" PATH="$INSTALL_BIN:/usr/bin:/bin" bash "$INSTALL_ROOT/install.sh" >/dev/null
[ "$(stat -f '%Lp' "$INSTALL_ROOT/.env" 2>/dev/null || stat -c '%a' "$INSTALL_ROOT/.env")" = "600" ] \
  || fail "install weakened .env permissions"

# A newly created .env also uses detection before .env.example's neutral default is copied.
rm "$INSTALL_ROOT/.env"
HOME="$INSTALL_HOME" PATH="$INSTALL_BIN:/usr/bin:/bin" bash "$INSTALL_ROOT/install.sh" >/dev/null
grep -q '^HERMES_BASE_PROFILE=old-base$' "$INSTALL_ROOT/.env" || fail "new .env skipped existing base detection"

# Ambiguous auth fails before changing an invalid/empty existing setting.
rm "$INSTALL_HOME/.hermes/profiles/member/auth.json"
touch "$INSTALL_HOME/.hermes/profiles/member/auth.json"
printf 'TEAM_HTTP_PORT=7878\nHERMES_BASE_PROFILE=\n' > "$INSTALL_ROOT/.env"
cp "$INSTALL_ROOT/.env" "$INSTALL_ROOT/.env.before"
set +e
HOME="$INSTALL_HOME" PATH="$INSTALL_BIN:/usr/bin:/bin" bash "$INSTALL_ROOT/install.sh" >/dev/null 2>&1
status=$?
set -e
[ "$status" -ne 0 ] || fail "ambiguous install did not fail closed"
cmp -s "$INSTALL_ROOT/.env.before" "$INSTALL_ROOT/.env" || fail "failed migration modified existing config"

# Quoted/exported valid settings are preserved and normalized only after selection.
printf 'TEAM_HTTP_PORT=7878\n  export HERMES_BASE_PROFILE=\"old-base\"\n' > "$INSTALL_ROOT/.env"
HOME="$INSTALL_HOME" PATH="$INSTALL_BIN:/usr/bin:/bin" bash "$INSTALL_ROOT/install.sh" >/dev/null
grep -q '^HERMES_BASE_PROFILE=old-base$' "$INSTALL_ROOT/.env" || fail "quoted/exported valid setting was not preserved"

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
mkdir -p "$UN_ROOT/src/server/runtimes/hermes" "$UN_HOME/.hermes/profiles/configured-base" "$UN_HOME/.hermes/profiles/worker" "$UN_HOME/.hermes/profiles/configured-base-2" \
  "$UN_HOME/.hermes/credentials" "$UN_HOME/Library/LaunchAgents"
cp "$ROOT/uninstall.sh" "$UN_ROOT/uninstall.sh"
cp "$ROOT/src/server/runtimes/hermes/detect-base-profile.sh" "$UN_ROOT/src/server/runtimes/hermes/detect-base-profile.sh"
printf 'HERMES_BASE_PROFILE=CONFIGURED-BASE # case-insensitive APFS guard\n' > "$UN_ROOT/.env"
printf '[{"id":"base","runtime":"hermes_agent","hermes_profile":"configured-base"},{"id":"worker","runtime":"hermes_agent","hermes_profile":"worker"},{"id":"similar","runtime":"hermes_agent","hermes_profile":"configured-base-2"}]\n' > "$UN_ROOT/agents.json"
touch "$UN_HOME/.hermes/profiles/configured-base/auth.json"
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

# uninstall uses the same permissive env syntax as install.
PARSE_ROOT="$TMP/parser-uninstall-repo"
PARSE_HOME="$TMP/parser-uninstall-home"
mkdir -p "$PARSE_ROOT/src/server/runtimes/hermes" \
  "$PARSE_HOME/.hermes/profiles/export-base" "$PARSE_HOME/.hermes/profiles/export-worker"
cp "$ROOT/uninstall.sh" "$PARSE_ROOT/uninstall.sh"
cp "$ROOT/src/server/runtimes/hermes/detect-base-profile.sh" "$PARSE_ROOT/src/server/runtimes/hermes/detect-base-profile.sh"
printf '  export HERMES_BASE_PROFILE = "export-base" # comment\n' > "$PARSE_ROOT/.env"
printf '[{"id":"base","runtime":"hermes_agent","hermes_profile":"export-base"},{"id":"worker","runtime":"hermes_agent","hermes_profile":"export-worker"}]\n' > "$PARSE_ROOT/agents.json"
HOME="$PARSE_HOME" USER="b3os-test" bash "$PARSE_ROOT/uninstall.sh" --yes --keep-data >/dev/null
[ -d "$PARSE_HOME/.hermes/profiles/export-base" ] || fail "uninstall parser missed export/spaced/quoted base setting"
[ ! -e "$PARSE_HOME/.hermes/profiles/export-worker" ] || fail "uninstall parser test did not remove worker"

# Missing config on a retry still preserves the detected base; a similar name is not over-protected.
rm "$UN_ROOT/.env"
HOME="$UN_HOME" USER="b3os-test" bash "$UN_ROOT/uninstall.sh" --yes --keep-data >/dev/null
[ -d "$UN_HOME/.hermes/profiles/configured-base" ] || fail "retry without .env deleted detected base"
[ ! -e "$UN_HOME/.hermes/profiles/configured-base-2" ] || fail "similar non-base name was preserved"

printf 'HERMES_BASE_PROFILE=../unsafe\n' > "$UN_ROOT/.env"
set +e
HOME="$UN_HOME" USER="b3os-test" bash "$UN_ROOT/uninstall.sh" --yes --keep-data >/dev/null 2>&1
status=$?
set -e
[ "$status" -ne 0 ] || fail "uninstall accepted an unsafe base profile"

# A full uninstall removes registry/config so a best-effort retry cannot replay stale members.
printf 'HERMES_BASE_PROFILE=configured-base\n' > "$UN_ROOT/.env"
HOME="$UN_HOME" USER="b3os-test" bash "$UN_ROOT/uninstall.sh" --yes >/dev/null
[ ! -e "$UN_ROOT/.env" ] || fail "full uninstall preserved .env"
[ ! -e "$UN_ROOT/agents.json" ] || fail "full uninstall preserved stale registry"
[ -d "$UN_HOME/.hermes/profiles/configured-base" ] || fail "full uninstall deleted detected base"

# M9/M4: two distinct shared targets are ambiguous. No Hermes profile or recovery data may be deleted.
AMB_ROOT="$TMP/ambiguous-uninstall-repo"
AMB_HOME="$TMP/ambiguous-uninstall-home"
mkdir -p "$AMB_ROOT/src/server/runtimes/hermes" \
  "$AMB_HOME/.hermes/profiles/base-a" "$AMB_HOME/.hermes/profiles/base-b" \
  "$AMB_HOME/.hermes/profiles/member-a" "$AMB_HOME/.hermes/profiles/member-b"
cp "$ROOT/uninstall.sh" "$AMB_ROOT/uninstall.sh"
cp "$ROOT/src/server/runtimes/hermes/detect-base-profile.sh" "$AMB_ROOT/src/server/runtimes/hermes/detect-base-profile.sh"
touch "$AMB_HOME/.hermes/profiles/base-a/auth.json" "$AMB_HOME/.hermes/profiles/base-b/auth.json"
ln -s "$AMB_HOME/.hermes/profiles/base-a/auth.json" "$AMB_HOME/.hermes/profiles/member-a/auth.json"
ln -s "$AMB_HOME/.hermes/profiles/base-b/auth.json" "$AMB_HOME/.hermes/profiles/member-b/auth.json"
printf 'HERMES_BASE_PROFILE=\n' > "$AMB_ROOT/.env"
printf '[{"id":"member-a","runtime":"hermes_agent","hermes_profile":"member-a"},{"id":"member-b","runtime":"hermes_agent","hermes_profile":"member-b"}]\n' > "$AMB_ROOT/agents.json"
touch "$AMB_ROOT/team.db"
set +e
amb_out="$(HOME="$AMB_HOME" USER="b3os-test" bash "$AMB_ROOT/uninstall.sh" --yes 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "ambiguous uninstall reported success"
grep -q '미완료' <<< "$amb_out" || fail "ambiguous uninstall did not clearly report incomplete cleanup"
for p in base-a base-b member-a member-b; do
  [ -e "$AMB_HOME/.hermes/profiles/$p" ] || fail "ambiguous uninstall deleted profile $p"
done
[ -f "$AMB_ROOT/.env" ] && [ -f "$AMB_ROOT/agents.json" ] && [ -f "$AMB_ROOT/team.db" ] \
  || fail "ambiguous uninstall deleted recovery data"

# M7: with one resolvable shared target, activation must prefer it over an alphabetically earlier auth profile.
RES_HOME="$TMP/resolved-activate-home"
mkdir -p "$RES_HOME/.local/bin" "$RES_HOME/.hermes/credentials" \
  "$RES_HOME/.hermes/profiles/aaa" "$RES_HOME/.hermes/profiles/real-base" "$RES_HOME/.hermes/profiles/existing-member"
touch "$RES_HOME/.hermes/profiles/aaa/auth.json" "$RES_HOME/.hermes/profiles/real-base/auth.json"
ln -s "$RES_HOME/.hermes/profiles/real-base/auth.json" "$RES_HOME/.hermes/profiles/existing-member/auth.json"
printf 'test-token\n' > "$RES_HOME/.hermes/credentials/new-member-token.txt"
printf '#!/usr/bin/env bash\nexit 42\n' > "$RES_HOME/.local/bin/hermes"
chmod +x "$RES_HOME/.local/bin/hermes"
set +e
resolved_out="$(HOME="$RES_HOME" HERMES_BASE_PROFILE=missing AGENT_ID=new-member \
  bash "$ROOT/src/server/runtimes/hermes/activate-hermes-agent.sh" 2>&1)"
set -e
grep -q '복제 원본 프로필: real-base' <<< "$resolved_out" || fail "activate did not prefer detected shared base"

echo "PASS: Hermes base profile configuration"

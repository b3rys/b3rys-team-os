#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CORE="$ROOT/scripts/auto-heal-core.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
MOCK="$TMP/mock"
mkdir -p "$MOCK"
CALLS="$TMP/calls"
: > "$CALLS"

cat > "$MOCK/recover" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$AUTO_HEAL_TEST_CALLS"
EOF

cat > "$MOCK/kill" <<'EOF'
#!/usr/bin/env bash
case "${2:-}" in
  111) exit 0 ;;
  *) exit 1 ;;
esac
EOF

cat > "$MOCK/ps" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *111*) echo " 111"; exit 0 ;;
  *333*) echo " 333"; exit 0 ;;
  *) exit 1 ;;
esac
EOF

cat > "$MOCK/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$MOCK/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  list-sessions)
    if [ "${MOCK_TMUX_NO_SERVER:-0}" = 1 ]; then
      echo "no server running on /tmp/tmux-test/default" >&2
      exit 1
    fi
    [ "${MOCK_TMUX_FAIL:-0}" = 1 ] && exit 2
    printf '%s\n' "${MOCK_SESSIONS:-alive}"
    ;;
  capture-pane)
    count_file="${AUTO_HEAL_TEST_TMP}/capture-count"
    count=$(cat "$count_file" 2>/dev/null || echo 0)
    count=$((count + 1))
    echo "$count" > "$count_file"
    if [ "$count" -eq 1 ]; then
      printf '%s\n' "${MOCK_PANE_BEFORE:-normal}"
    else
      printf '%s\n' "${MOCK_PANE_AFTER:-normal}"
    fi
    ;;
  send-keys)
    echo "send-keys:${*:2}" >> "$AUTO_HEAL_TEST_CALLS"
    ;;
  *) exit 2 ;;
esac
EOF

cat > "$MOCK/launchctl" <<'EOF'
#!/usr/bin/env bash
[ "${MOCK_LAUNCHCTL_FAIL:-0}" = 1 ] && exit 2
printf '%s\n' "${MOCK_LAUNCHD_LIST:-}"
EOF

chmod +x "$MOCK"/*

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_calls() {
  local expected=$1
  local actual
  actual=$(grep -vc '^send-keys:' "$CALLS" || true)
  [ "$actual" -eq "$expected" ] || fail "expected $expected recovery calls, got $actual: $(cat "$CALLS")"
}

run_case() {
  : > "$CALLS"
  rm -f "$TMP/capture-count"
  PATH="$MOCK:/usr/bin:/bin" \
    AUTO_HEAL_KILL_BIN="$MOCK/kill" \
    AUTO_HEAL_PS_BIN="$MOCK/ps" \
    AUTO_HEAL_TEST_CALLS="$CALLS" \
    AUTO_HEAL_TEST_TMP="$TMP" \
    AUTO_HEAL_SURVEY_WAIT_SECONDS=0 \
    "$CORE" --config "$1"
}

run_dry_case() {
  : > "$CALLS"
  rm -f "$TMP/capture-count"
  PATH="$MOCK:/usr/bin:/bin" \
    AUTO_HEAL_KILL_BIN="$MOCK/kill" \
    AUTO_HEAL_PS_BIN="$MOCK/ps" \
    AUTO_HEAL_TEST_CALLS="$CALLS" \
    AUTO_HEAL_TEST_TMP="$TMP" \
    AUTO_HEAL_SURVEY_WAIT_SECONDS=0 \
    "$CORE" --config "$1" --dry-run
}

pid_alive="$TMP/pid-alive"
pid_dead="$TMP/pid-dead"
pid_ambiguous="$TMP/pid-ambiguous"
pid_malformed="$TMP/pid-malformed"
pid_multiline="$TMP/pid-multiline"
printf '111\n' > "$pid_alive"
printf '222\n' > "$pid_dead"
printf '333\n' > "$pid_ambiguous"
printf 'not-a-pid\n' > "$pid_malformed"
printf '222\n223\n' > "$pid_multiline"

config="$TMP/config"

printf 'bot|missing-tmux|gone|%s|on|%s/recover|bot-down\n' "$pid_alive" "$MOCK" > "$config"
MOCK_SESSIONS=alive run_case "$config" >/dev/null
assert_calls 1

MOCK_TMUX_NO_SERVER=1 run_case "$config" >/dev/null
assert_calls 1

MOCK_SESSIONS=alive run_dry_case "$config" >/dev/null
assert_calls 0

MOCK_TMUX_FAIL=1 run_case "$config" >/dev/null
assert_calls 0

AUTO_HEAL_TMUX_BIN="$TMP/no-such-tmux" run_case "$config" >/dev/null
assert_calls 0

printf 'bot|dead-poller|alive|%s|on|%s/recover|poller-dead\n' "$pid_dead" "$MOCK" > "$config"
MOCK_SESSIONS=alive run_case "$config" >/dev/null
assert_calls 1

printf 'bot|missing-pid|alive|%s/no-file|on|%s/recover|must-not-run\n' "$TMP" "$MOCK" > "$config"
MOCK_SESSIONS=alive run_case "$config" >/dev/null
assert_calls 0

printf 'bot|malformed-pid|alive|%s|on|%s/recover|must-not-run\n' "$pid_malformed" "$MOCK" > "$config"
MOCK_SESSIONS=alive run_case "$config" >/dev/null
assert_calls 0

printf 'bot|multiline-pid|alive|%s|on|%s/recover|must-not-run\n' "$pid_multiline" "$MOCK" > "$config"
MOCK_SESSIONS=alive run_case "$config" >/dev/null
assert_calls 0

printf 'bot|ambiguous-pid|alive|%s|on|%s/recover|must-not-run\n' "$pid_ambiguous" "$MOCK" > "$config"
MOCK_SESSIONS=alive run_case "$config" >/dev/null
assert_calls 0

printf 'bot|disabled|gone|%s|off|%s/recover|must-not-run\n' "$pid_dead" "$MOCK" > "$config"
MOCK_SESSIONS=alive run_case "$config" >/dev/null
assert_calls 0

printf 'gateway|unregistered|configured.label|-|on|%s/recover|gateway-up\n' "$MOCK" > "$config"
MOCK_LAUNCHD_LIST="" run_case "$config" >/dev/null
assert_calls 1

printf 'gateway|dead|configured.label|-|on|%s/recover|gateway-dead\n' "$MOCK" > "$config"
MOCK_LAUNCHD_LIST=$'222\t0\tconfigured.label' run_case "$config" >/dev/null
assert_calls 1

printf 'gateway|stopped|configured.label|-|on|%s/recover|gateway-stopped\n' "$MOCK" > "$config"
MOCK_LAUNCHD_LIST=$'-\t0\tconfigured.label' run_case "$config" >/dev/null
assert_calls 1

printf 'gateway|alive|configured.label|-|on|%s/recover|must-not-run\n' "$MOCK" > "$config"
MOCK_LAUNCHD_LIST=$'111\t0\tconfigured.label' run_case "$config" >/dev/null
assert_calls 0

printf 'gateway|ambiguous|configured.label|-|on|%s/recover|must-not-run\n' "$MOCK" > "$config"
MOCK_LAUNCHD_LIST=$'111\t0\tconfigured.label\n222\t0\tconfigured.label' run_case "$config" >/dev/null
assert_calls 0

printf 'gateway|unknown|configured.label|-|on|%s/recover|must-not-run\n' "$MOCK" > "$config"
MOCK_LAUNCHCTL_FAIL=1 run_case "$config" >/dev/null
assert_calls 0

cat > "$config" <<EOF
bot|too-few|fields
bot||alive|$pid_alive|on|$MOCK/recover|must-not-run
bot|bad-mode|alive|$pid_alive|maybe|$MOCK/recover|must-not-run
EOF
MOCK_SESSIONS=alive run_case "$config" >/dev/null
assert_calls 0

printf 'bot|survey|alive|%s|on|%s/recover|must-not-run\n' "$pid_alive" "$MOCK" > "$config"
MOCK_SESSIONS=alive \
MOCK_PANE_BEFORE=$'How is Claude doing this session\n❯ preserved input' \
MOCK_PANE_AFTER=$'normal\n❯ preserved input' \
run_case "$config" >/dev/null
assert_calls 0
grep -q '^send-keys:.* 0$' "$CALLS" || fail "survey did not send literal 0"

MOCK_SESSIONS=alive \
MOCK_PANE_BEFORE=$'How is Claude doing this session\n❯ preserved input' \
MOCK_PANE_AFTER=$'normal\n❯ changed input' \
run_case "$config" > "$TMP/survey-failed.out"
assert_calls 0
[ "$(grep -c '^send-keys:' "$CALLS")" -eq 1 ] || fail "survey failure sent additional keys"
grep -q 'no restore attempted' "$TMP/survey-failed.out" || fail "survey failure was not reported"

echo "PASS auto-heal core harness"

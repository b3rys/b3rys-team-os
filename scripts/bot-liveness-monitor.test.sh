#!/usr/bin/env bash
set -euo pipefail

SCRIPT="${1:-$(cd "$(dirname "$0")" && pwd)/bot-liveness-monitor.sh}"
T="$(mktemp -d "${TMPDIR:-/tmp}/bot-liveness-monitor-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT

HOME="$T/home"
export HOME
mkdir -p "$HOME/Library/LaunchAgents" "$T/bin"
for member in bill steve ghost; do
  : > "$HOME/Library/LaunchAgents/com.gdmini.claude-telegram-$member.plist"
done
: > "$HOME/Library/LaunchAgents/com.gdmini.team-collab.plist"

cat > "$T/agents.json" <<'JSON'
{"agents":[
  {"id":"bill","runtime":"claude_channel"},
  {"id":"steve","runtime":"claude_channel"},
  {"id":"codex","runtime":"openclaw"}
]}
JSON
printf 'steve\n' > "$T/agent-off.txt"

cat > "$T/bin/launchctl" <<'SH'
#!/usr/bin/env bash
if [ "$1" = print ]; then exit 1; fi
if [ "$1" = bootstrap ]; then printf '%s\n' "$3" >> "$LAUNCHCTL_CALLS"; exit 0; fi
exit 2
SH
chmod +x "$T/bin/launchctl"
export PATH="$T/bin:$PATH"
export LAUNCHCTL_CALLS="$T/launchctl.calls"
export TEAM_AGENT_REGISTRY="$T/agents.json"
export TEAMOS_AGENT_OFF_FILE="$T/agent-off.txt"
export DRY_RUN=0

run_registration_section() {
  local autoheal="$1"
  : > "$LAUNCHCTL_CALLS"
  LIVENESS_LA_AUTOHEAL="$autoheal" bash -c '
    set -uo pipefail
    DRY_RUN=0
    eval "$(sed -n "/^# ─── 설정 ─/,/^BOOT_GRACE_SECS=/p" "$1" | sed "\$d")"
  ' bash "$SCRIPT"
}

# 기본값은 등록부에 있는 대상도 alert-only다.
run_registration_section 0
[ ! -s "$LAUNCHCTL_CALLS" ] || {
  echo "FAIL: alert-only default bootstrapped a LaunchAgent" >&2
  cat "$LAUNCHCTL_CALLS" >&2
  exit 1
}

# 자동복구를 명시해도 등록부+runtime+enabled+off 판정을 모두 통과한 bill만 허용한다.
run_registration_section 1
call_count="$(wc -l < "$LAUNCHCTL_CALLS" | tr -d ' ')"
[ "$call_count" -eq 1 ] || {
  echo "FAIL: expected exactly one whitelisted bootstrap, got $call_count" >&2
  cat "$LAUNCHCTL_CALLS" >&2
  exit 1
}
only_call="$(cat "$LAUNCHCTL_CALLS")"
case "$only_call" in
  *com.gdmini.claude-telegram-bill.plist) ;;
  *) echo "FAIL: wrong LaunchAgent bootstrapped: $only_call" >&2; exit 1 ;;
esac

if grep -Eq 'steve|ghost|team-collab' "$LAUNCHCTL_CALLS"; then
  echo "FAIL: off, unregistered, or non-agent plist was bootstrapped" >&2
  cat "$LAUNCHCTL_CALLS" >&2
  exit 1
fi

# 정본을 읽을 수 없으면 디스크 plist를 기대값으로 추정하지 않는다.
TEAM_AGENT_REGISTRY="$T/missing-agents.json" run_registration_section 1
[ ! -s "$LAUNCHCTL_CALLS" ] || {
  echo "FAIL: unreadable registry must fail closed" >&2
  cat "$LAUNCHCTL_CALLS" >&2
  exit 1
}

echo "PASS: LaunchAgent recovery is registry-backed, off-aware, and alert-only by default"

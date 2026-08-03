#!/usr/bin/env bash
# 전체 진입점 회귀 테스트 — 실제 스크립트를 temp HOME + mock 명령으로 실행한다.
#
# 시나리오 = ★GD 가 실제로 한 일★:
#   로그인 항목에서 팀원 LaunchAgent 를 뺐다. agents.json 에는 그대로 있고, agent-off 파일에는 없다.
#   (GD 는 off 파일을 편집한 적이 없다 — 로그인 항목만 건드렸다)
#
# 묻는 것: 이 상태에서 감시기가 그 팀원을 ★되살리는가?★
#   PR#259 는 LaunchAgent bootstrap 은 막았다. 그런데 tmux 세션이 없으면
#   restart-agent.sh 를 ★직접★ 부르는 경로(스크립트 386행)가 따로 있다.
#
# 실 파일시스템·실 launchctl·실 tmux 미접촉 (전부 temp HOME + mock).
set -uo pipefail
SCRIPT="${1:?스크립트 경로}"

T="$(mktemp -d "${TMPDIR:-/tmp}/probe-restart.XXXXXX")"
export HOME="$T/home"
mkdir -p "$HOME/Library/LaunchAgents" "$T/bin" \
         "$HOME/Development/b3rys-team-collab/scripts" \
         "$HOME/.claude/channels/telegram-bill" "$T/b3os"
: > "$HOME/Library/LaunchAgents/com.gdmini.claude-telegram-bill.plist"

# 등록부: bill 은 ★활성 팀원★ (GD 가 지운 건 로그인 항목뿐)
cat > "$T/agents.json" <<'JSON'
{"agents":[{"id":"bill","runtime":"claude_channel"}]}
JSON
: > "$T/agent-off.txt"          # ★비어있다★ — GD 는 off 목록을 안 건드렸다

# mock: tmux — 세션이 하나도 없다 (로그인 항목에서 빠져 안 떴다)
cat > "$T/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 1 ;;                 # 세션 없음
  list-sessions) exit 0 ;;               # 목록 비어있음
  capture-pane|send-keys|load-buffer|paste-buffer|delete-buffer) exit 0 ;;
esac
exit 0
SH

# mock: launchctl — bootstrap 호출을 기록
cat > "$T/bin/launchctl" <<'SH'
#!/usr/bin/env bash
[ "$1" = print ] && { case "$2" in *"com.gdmini.claude-telegram-${LOADED_AGENT:-__none__}") exit 0 ;; *) exit 1 ;; esac; }
[ "$1" = bootstrap ] && { printf '%s\n' "$3" >> "$LAUNCHCTL_CALLS"; exit 0; }
exit 2
SH

# mock: restart-agent.sh — ★이게 불리면 팀원이 되살아난 것★
cat > "$HOME/Development/b3rys-team-collab/scripts/restart-agent.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$RESTART_CALLS"
SH

# mock: 알림 전송 — 실제 텔레그램 안 나가게
cat > "$T/bin/curl" <<'SH'
#!/usr/bin/env bash
printf 'curl\n' >> "$CURL_CALLS"
printf '200'
exit 0
SH

chmod +x "$T/bin/"* "$HOME/Development/b3rys-team-collab/scripts/restart-agent.sh"
export PATH="$T/bin:$PATH"
export LAUNCHCTL_CALLS="$T/launchctl.calls"; : > "$LAUNCHCTL_CALLS"
export RESTART_CALLS="$T/restart.calls";     : > "$RESTART_CALLS"
export CURL_CALLS="$T/curl.calls";           : > "$CURL_CALLS"
export TEAM_AGENT_REGISTRY="$T/agents.json"
export TEAMOS_AGENT_OFF_FILE="$T/agent-off.txt"
export BOT_LIVENESS_BOOT_GRACE=0            # 부팅 유예 때문에 건너뛰지 않게
export B3OS_ROOT="$T/b3os"
export BOT_LIVENESS_LOG="$T/b3os/var/bot-liveness-monitor.log"
export LIVENESS_LA_AUTOHEAL=0
export GD_CHAT_ID=test
printf 'CAPTURE_BOT_TOKEN=test\n' > "$HOME/Development/b3rys-team-collab/.env"

echo "■ 시나리오: bill 은 등록부에 있고 off 목록엔 없다. 세션은 안 떠 있다."
echo "  (= GD 가 로그인 항목에서만 뺀 상태)"
echo
bash "$SCRIPT" >"$T/out.txt" 2>"$T/err.txt"
script_rc=$?
echo "  스크립트 종료코드: $script_rc"
echo
echo "── LaunchAgent bootstrap 호출 ──"
if [ -s "$LAUNCHCTL_CALLS" ]; then
  sed 's/^/  /' "$LAUNCHCTL_CALLS"
  echo "  ⚠ alert-only인데 bootstrap했다"
  RC=1
else
  echo "  (0건 — alert-only ✓)"
  RC=0
fi
echo
echo "── ★restart-agent.sh 호출★ (= 팀원 되살아남) ──"
if [ -s "$RESTART_CALLS" ]; then
  sed 's/^/  /' "$RESTART_CALLS"
  echo "  ⚠ 되살렸다 — LaunchAgent 는 막혔는데 ★다른 경로로 복구됐다★"
  RC=1
else
  echo "  (0건 — 이 경로도 막혀있다 ✓)"
fi
echo
echo "── 스크립트 출력 ──"; sed 's/^/  /' "$T/out.txt" | head -20
[ -s "$T/err.txt" ] && { echo "── stderr ──"; sed 's/^/  /' "$T/err.txt" | head -10; }
echo
echo "임시경로: $T"
[ -d "$T/b3os/var/bot-liveness-monitor" ] || {
  echo "FAIL: 기본 상태 디렉터리가 <repo>/var/bot-liveness-monitor에 생성되지 않음" >&2
  RC=1
}
echo "PASS: 전체 진입점이 alert-only에서 bootstrap/restart를 호출하지 않음"

# 같은 등록부/off 조건에서 LaunchAgent가 로드돼 있으면 세션 부재는 실제 장애이므로 복구한다.
: > "$LAUNCHCTL_CALLS"
: > "$RESTART_CALLS"
export LOADED_AGENT=bill
bash "$SCRIPT" >"$T/loaded-out.txt" 2>"$T/loaded-err.txt"
loaded_calls="$(cat "$RESTART_CALLS")"
[ "$loaded_calls" = bill ] || {
  echo "FAIL: loaded LaunchAgent + missing session should restart bill, got: ${loaded_calls:-none}" >&2
  RC=1
}
[ ! -s "$LAUNCHCTL_CALLS" ] || {
  echo "FAIL: loaded LaunchAgent must not be bootstrapped" >&2
  RC=1
}
echo "PASS: 로드된 LaunchAgent의 세션 부재는 restart-agent로 복구함"
exit "$RC"

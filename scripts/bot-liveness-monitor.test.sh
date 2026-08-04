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
SCRIPT="${1:-$(cd "$(dirname "$0")" && pwd)/bot-liveness-monitor.sh}"

# PASS 문구는 ★그 시나리오에서 실패가 없었을 때만★ 낸다.
#   무조건 출력하면 FAIL 바로 뒤에 PASS 가 찍혀 로그만 보고는 통과로 읽힌다(RC 로만 판정됐다).
_LAST_RC=0
pass_if_clean() {
  if [ "$RC" = "$_LAST_RC" ]; then echo "PASS: $1"; else echo "SKIP(위 FAIL 때문): $1"; fi
  _LAST_RC="$RC"
}

T="$(mktemp -d "${TMPDIR:-/tmp}/probe-restart.XXXXXX")"
export HOME="$T/home"
if [ "${KEEP_TMP:-0}" != "1" ]; then trap 'rm -rf "$T"' EXIT; fi
# ★일부러 개인 라벨이 아닌 접두를 쓴다★ — 라벨을 다시 코드에 고정하면 이 테스트가 실패한다.
export TEAMOS_LAUNCHD_PREFIX="com.b3ostest"
mkdir -p "$HOME/Library/LaunchAgents" "$T/bin" \
         "$T/b3os/scripts" \
         "$HOME/.claude/channels/telegram-bill" "$T/b3os"
: > "$HOME/Library/LaunchAgents/$TEAMOS_LAUNCHD_PREFIX.claude-telegram-bill.plist"

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
[ "$1" = print ] && { case "$2" in *"${TEAMOS_LAUNCHD_PREFIX}.claude-telegram-${LOADED_AGENT:-__none__}") exit 0 ;; *) exit 1 ;; esac; }
[ "$1" = bootstrap ] && { printf '%s\n' "$3" >> "$LAUNCHCTL_CALLS"; exit 0; }
exit 2
SH

# mock: restart-agent.sh — ★이게 불리면 팀원이 되살아난 것★
cat > "$T/b3os/scripts/restart-agent.sh" <<'SH'
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

chmod +x "$T/bin/"* "$T/b3os/scripts/restart-agent.sh"
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
printf 'CAPTURE_BOT_TOKEN=test\n' > "$T/b3os/.env"

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
tail -1 "$BOT_LIVENESS_LOG" | grep -q 'bot-liveness DONE status=issues$' || {
  echo "FAIL: issue run must end with structured status=issues" >&2
  tail -3 "$BOT_LIVENESS_LOG" >&2
  RC=1
}
pass_if_clean "전체 진입점이 alert-only에서 bootstrap/restart를 호출하지 않음"

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
pass_if_clean "로드된 LaunchAgent의 세션 부재는 restart-agent로 복구함"

# 복구 수단이 없으면 파괴적 조치를 하지 않는다.
#   폴러 사망 분기는 세션을 ★먼저 죽이고★ 복구를 부른다. 복구 스크립트가 없는 설치에서 그대로 두면
#   세션만 죽고 복구는 실패해 봇이 완전히 내려간다. 그래서 감지·알림만 하고 손대지 않아야 한다.
: > "$LAUNCHCTL_CALLS"
: > "$RESTART_CALLS"
: > "$BOT_LIVENESS_LOG"          # 이 시나리오의 출력만 보도록 — 평상 실행은 stdout 을 로그로 보낸다
RESTART_AGENT="$T/b3os/scripts/does-not-exist.sh" \
  bash "$SCRIPT" >"$T/noheal-out.txt" 2>"$T/noheal-err.txt"
[ ! -s "$RESTART_CALLS" ] || {
  echo "FAIL: 복구 수단이 없는데 재시작을 시도했다: $(cat "$RESTART_CALLS")" >&2
  RC=1
}
grep -q "자동복구 불가" "$BOT_LIVENESS_LOG" || {
  echo "FAIL: 복구 수단 부재를 알리지 않았다" >&2
  RC=1
}
pass_if_clean "복구 수단이 없으면 재시작하지 않고 알림만 한다"

# ★폴러 사망★ + 복구 수단 없음 → 세션을 죽이지 않는다.
#   세션은 살아 있고 폴러만 죽은 상태. 이 분기는 tmux kill-session 을 ★먼저★ 하므로,
#   복구 수단이 없으면 세션만 죽고 봇이 완전히 내려간다. 위 시나리오들은 세션 부재라
#   세션 체크에서 continue 되어 이 경로에 도달하지 못한다 — 그래서 따로 만든다.
cat > "$T/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in
  has-session)   exit 0 ;;                       # ★세션은 살아 있다★
  kill-session)  printf '%s\n' "$*" >> "$TMUX_KILLS"; exit 0 ;;
  capture-pane)  printf 'idle\n'; exit 0 ;;
  display-message) printf '%s\n' "$(date +%s)"; exit 0 ;;
  list-sessions) printf 'claude-bill\n'; exit 0 ;;
  send-keys|load-buffer|paste-buffer|delete-buffer) exit 0 ;;
esac
exit 0
SH
chmod +x "$T/bin/tmux"
export TMUX_KILLS="$T/tmux.kills"; : > "$TMUX_KILLS"
printf 'CHANNEL_BOT_TOKEN=x\n' > "$HOME/.claude/channels/telegram-bill/.env"   # .env 가드로 빠지지 않게
printf '999999\n' > "$HOME/.claude/channels/telegram-bill/bot.pid"             # ★죽은 pid★
: > "$RESTART_CALLS"; : > "$BOT_LIVENESS_LOG"
RESTART_AGENT="$T/b3os/scripts/does-not-exist.sh" \
  bash "$SCRIPT" >"$T/poller-out.txt" 2>"$T/poller-err.txt"
[ ! -s "$TMUX_KILLS" ] || {
  echo "FAIL: 복구 수단이 없는데 세션을 죽였다: $(cat "$TMUX_KILLS")" >&2
  RC=1
}
grep -q "세션 유지하고 알림만" "$BOT_LIVENESS_LOG" || {
  echo "FAIL: 폴러 사망 + 복구불가에서 세션 유지 알림이 없다" >&2
  RC=1
}
pass_if_clean "폴러가 죽어도 복구 수단이 없으면 세션을 죽이지 않는다"
exit "$RC"

#!/usr/bin/env bash
# Bot liveness monitor — GD 2207 요청 (2026-06-03).
# 배경: weekly-healthcheck 는 주 1회 + 세션 "존재"만 봐서, 주중 freeze 를 못 잡았다.
#   2026-06-03 스티브가 1:1 리액션만 되고 응답 없던 건(설문 프롬프트 점거 + reply 도구 미호출)을
#   미리 잡기 위해 10분 주기 경량 liveness 체크를 추가한다. 순수 shell — LLM 미호출(토큰 0).
# Fired by ~/Library/LaunchAgents/com.gdmini.bot-liveness-monitor.plist (StartInterval=600s=10분)
#
# 검사 항목 (claude_channel 봇: bill steve demis dbak):
#   1) tmux 세션 존재 (claude-<bot>)
#   2) 폴러 alive (bot.pid → kill -0)            — 무성 폴러사망
#   3) pane 에 blocking UI (설문/권한 프롬프트)    — 입력 점거로 무응답
#   4) GD DM 무응답 의심 (react 갔는데 reply 미호출이 2회 연속 지속)
#   5) 세션 uptime 7일+ (노후화 → 선제 재시작 권고. 일요일 weekly-restart 기준 7일 초과=주간재시작 실패)
# + openclaw(codex)·hermes 게이트웨이 LaunchAgent PID 생존 (CLI 미호출, hang 회피).
# auto-heal(GD 2223·2416): 케이스별 자동복구. 케이스 카탈로그(증상→감지→heal→상태) 정본 =
#   b3rys-team-collab/docs/AUTOHEAL_CASES.md. heal 타입: A=pane-key(설문/resume),
#   B=nudge-inject(#4 reply-미호출 → 메시지 주입, 안 되면 재시작 에스컬레이션), C=alert-only(권한/폴러/uptime/게이트웨이),
#   D=process-up(봇 tmux 완전다운 → team-os up 자동복구, 2026-06-06. idempotent 라 stuck 무관).
#   복구=🔧 간단 메시지, 못 고침=⚠️ 알림. 새 케이스는 카탈로그 + 규칙 한 줄로 확장.
# 알림은 team op 봇(@gd452_team_op_bot) 으로 GD 1:1 DM(중복알림 방지 state). 이상·복구 없으면 조용히 종료.
#
# Usage:
#   bot-liveness-monitor.sh             # 실제 실행
#   bot-liveness-monitor.sh --dry-run   # DM 미전송, 결과만 출력 + state 미갱신
#   bot-liveness-monitor.sh --reset     # state 삭제 (재알림 가능)

set -uo pipefail

DRY_RUN=0
RESET=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  --reset)   RESET=1 ;;
esac

# ─── 상태 파일 루트 (테스트 격리용) ──────────────────────────────────────
# ★이 스크립트의 상태 파일은 전부 절대경로 /tmp 였다★ — HOME 을 격리한 테스트도 이건 못 막는다.
#   실제로 재현 하네스가 라이브 마커를 덮어써서, 라이브 감시기가 "방금 재시작했다"고 오인해
#   40분간 재시작을 보류하는 상태가 됐다(2026-07-26, steve 발견).
#   하필 이번 사고를 4시간 방치시킨 바로 그 가드를, 그 사고의 재현 테스트가 켜버린 것이다.
#   → 루트를 env 로 덮어쓸 수 있게 한다. 기본값은 그대로 /tmp 라 라이브 동작은 불변.
#   테스트는 LIVENESS_STATE_DIR 를 작업 디렉터리로 지정해 라이브 상태를 건드리지 않는다.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
: "${B3OS_ROOT:=$(dirname "$SCRIPT_DIR")}"
: "${LIVENESS_STATE_DIR:=$B3OS_ROOT/var/bot-liveness-monitor}"
mkdir -p "$LIVENESS_STATE_DIR" 2>/dev/null || true

: "${BOT_LIVENESS_LOG:=$B3OS_ROOT/var/bot-liveness-monitor.log}"
mkdir -p "$(dirname "$BOT_LIVENESS_LOG")" 2>/dev/null || true
LOG="$BOT_LIVENESS_LOG"
[ "$DRY_RUN" = "0" ] && [ "$RESET" = "0" ] && exec >> "$LOG" 2>&1

# ─── 설정 ────────────────────────────────────────────────────────────────
# ★감시 대상은 정본(agents.json)에서 읽는다 (GD 승인 2026-08-03)★
#   하드코딩 BOTS=(bill steve demis dbak) 였다 — ★lui 가 빠져 있었다.★ 그래서 2026-08-03 부팅에 lui 폴러가
#   죽었을 때 이 감시기가 lui 를 아예 보지 않았고, 자가치유 대상에서도 제외돼 그물이 0이었다(수동 복구함).
#   새 멤버를 영입할 때마다 이 줄을 고쳐야 하는 구조 자체가 누락의 원인이므로 정본을 읽는다.
#   읽기 실패 시에만 옛 하드코딩으로 폴백(감시가 통째로 죽는 것보다 낫다) + 경고.
: "${TEAM_AGENT_REGISTRY:=$HOME/Development/b3rys-team-os/agents.json}"
: "${TEAMOS_AGENT_OFF_FILE:=$HOME/Development/b3rys-team-collab/var/agent-off.txt}"
: "${LIVENESS_AUTOHEAL:=0}"
: "${LIVENESS_LA_AUTOHEAL:=$LIVENESS_AUTOHEAL}"
autoheal_enabled() { [ "$LIVENESS_AUTOHEAL" = "1" ]; }
_AGENTS_JSON="$TEAM_AGENT_REGISTRY"
_BOTS_STR="$(python3 -c "
import json
a=json.load(open('$_AGENTS_JSON'))
ms=a if isinstance(a,list) else a.get('agents',[])
print(' '.join(m['id'] for m in ms if m.get('runtime')=='claude_channel' and m.get('enabled', True) is not False))" 2>/dev/null)"
_BOTS_WARN=""
if [ -n "$_BOTS_STR" ]; then
  read -r -a BOTS <<< "$_BOTS_STR"
else
  # ★폴백을 하드코딩으로 두면 조용한 퇴행이다 (codex·steve 교차검증 2026-08-03)★
  #   옛 폴백은 (bill steve demis dbak) 라 ★lui 가 소리없이 감시에서 빠졌다.★ 게다가 경고를 stderr 로 냈는데
  #   위 47행에서 이미 로그파일로 리다이렉트된 뒤라 ★아무도 못 보는 자리★ 였다 — 오늘 lui 사고와 같은 형태.
  #   그래서 ①실제로 돌고 있는 tmux 세션에서 뽑고(낡을 수가 없다) ②그것도 실패하면 ★DM 으로 알린다.★
  _BOTS_STR="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | sed -n 's/^claude-//p' | tr '\n' ' ')"
  if [ -n "$_BOTS_STR" ]; then
    read -r -a BOTS <<< "$_BOTS_STR"
    _BOTS_WARN="· [감시기] agents.json 을 못 읽어 ★실행중 tmux 세션(${_BOTS_STR% })★ 으로 대체했습니다 — 꺼져 있는 팀원은 감시에서 빠집니다. 정본 확인 필요: $_AGENTS_JSON"
  else
    BOTS=(bill steve demis dbak lui)
    _BOTS_WARN="· [감시기] ★감시 대상을 정본에서도 tmux 에서도 못 읽었습니다★ — 하드코딩 목록으로 돕니다. 새 팀원은 감시에서 빠집니다. 확인 필요: $_AGENTS_JSON"
  fi
fi
# ─── ★부팅 유예 (GD 승인 2026-08-03)★ ──────────────────────────────────────
#   이 감시기 예약은 RunAtLoad=true 라 ★부팅하자마자★ 돈다. 그런데 감시 대상인 팀원들은 그때 아직 못 뜬다:
#   팀원 시작 스크립트는 스폰 순번 대기로 한 명당 최대 25초, boot-recovery 는 sleep 30 후에야 시작한다.
#   실측(2026-08-03): 부팅 13:47:38 → 이 감시기 시작 ★13:47:53(15초 뒤)★ → "demis·dbak·lui 세션 없음"
#   으로 판정해 팀장님께 장애 DM 을 보냈다. 아무도 뜰 수 없는 시점의 판정이라 ★매 부팅마다 나는 오보★ 였다.
#   게다가 감시기가 재시작 예산까지 써서 ★감시자가 기동자 노릇★ 을 했다(팀원 예약과 이중 기동 = 오늘 사고의 축).
#   → 부팅 직후에는 판정·조치·알림을 전부 건너뛴다. 다음 주기(10분)면 유예가 풀려 정상 감시한다.
# ─── LaunchAgent 등록 판정 ─────────────────────────────────────────────────
#   증상: 2026-08-03 13:47 재부팅에서 ~/Library/LaunchAgents 에 멀쩡히 있는 plist 중 ★일부만 로드됐다.★
#         실림: claude-telegram-steve · 안 실림: team-collab(서버)·claude-telegram-{bill,demis,dbak,lui}·b3rys-dev 등.
#         퍼미션·키 구성·print-disabled 전부 5개 동일했고 ★원인은 아직 못 밝혔다★(스티브·코덱스 조사 중).
#   디스크에 plist 가 있다는 사실은 실행 기대값이 아니다. 기대값은 agents.json 등록 여부와 명시적 off 목록에서만
#   계산한다. 기본은 alert-only이며, LIVENESS_LA_AUTOHEAL=1 로 명시해도 등록부의 활성 claude_channel 팀원만
#   bootstrap 할 수 있다. 등록부 미확인/미등록/off 대상은 절대 건드리지 않는다(fail closed).
agent_intentionally_off() {
  local ids
  [ -f "$TEAMOS_AGENT_OFF_FILE" ] || return 1
  ids="$(tr ',' ' ' < "$TEAMOS_AGENT_OFF_FILE" 2>/dev/null)"
  case " $ids " in *" $1 "*) return 0 ;; esac
  return 1
}

registered_claude_agent() {
  local agent="$1"
  [ -r "$TEAM_AGENT_REGISTRY" ] || return 1
  python3 - "$TEAM_AGENT_REGISTRY" "$agent" <<'PY' >/dev/null 2>&1
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
agents = data if isinstance(data, list) else data.get("agents", [])
matched = any(
    item.get("id") == sys.argv[2]
    and item.get("runtime") == "claude_channel"
    and item.get("enabled", True) is not False
    for item in agents
)
raise SystemExit(0 if matched else 1)
PY
}

launchagent_member() {
  case "$1" in
    com.gdmini.claude-telegram-*) printf '%s\n' "${1#com.gdmini.claude-telegram-}" ;;
    *) return 1 ;;
  esac
}

ensure_launchagents_registered() {
  local fixed="" p lbl member
  for p in "$HOME"/Library/LaunchAgents/com.gdmini.claude-telegram-*.plist \
           "$HOME/Library/LaunchAgents/com.gdmini.team-collab.plist"; do
    [ -f "$p" ] || continue
    lbl="$(basename "$p" .plist)"
    launchctl print "gui/$(id -u)/$lbl" >/dev/null 2>&1 && continue   # 이미 로드됨
    member="$(launchagent_member "$lbl" 2>/dev/null || true)"
    if [ -z "$member" ] || ! registered_claude_agent "$member"; then
      fixed="${fixed}· [$lbl] LaunchAgent 미등록 — 등록부 기대값 아님, alert-only
"
      continue
    fi
    if agent_intentionally_off "$member"; then
      fixed="${fixed}· [$lbl] LaunchAgent 미등록 — 의도적 off, alert-only
"
      continue
    fi
    if [ "$DRY_RUN" = "1" ] || ! autoheal_enabled || [ "$LIVENESS_LA_AUTOHEAL" != "1" ]; then
      fixed="${fixed}· [$lbl] LaunchAgent 미등록 — 등록부 확인됨, alert-only
"
    elif launchctl bootstrap "gui/$(id -u)" "$p" >/dev/null 2>&1; then
      fixed="${fixed}· [$lbl] LaunchAgent 미등록 → ★재등록 완료★
"
    else
      fixed="${fixed}· [$lbl] LaunchAgent 미등록 → 재등록 ★실패★ (수동 확인 필요)
"
    fi
  done
  [ -n "$fixed" ] && printf "%s" "$fixed"
}
_REG_FIXED="$(ensure_launchagents_registered)"
[ -n "$_REG_FIXED" ] && { echo "$(date '+%Y-%m-%d %H:%M:%S') [등록복구]"; printf "%s" "$_REG_FIXED"; }

BOOT_GRACE_SECS="${BOT_LIVENESS_BOOT_GRACE:-300}"
# 출력: `{ sec = 1785732457, usec = 322204 } Mon Aug  3 13:47:37 2026`
# ★행 머리에 고정한다★ — `.*sec = ` 로 쓰면 greedy 라 ★usec 을 집는다★(=322204). 그러면 부팅경과가 17억초로
# 계산돼 유예가 ★영영 발동하지 않는다★. 처음에 그렇게 짰다가 유예를 일부러 걸리게 시험해서 잡았다.
_boot_sec="$(/usr/sbin/sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ *sec *= *\([0-9][0-9]*\).*/\1/p')"
if [ -n "$_boot_sec" ]; then
  _up=$(( $(date +%s) - _boot_sec ))
  if [ "$_up" -ge 0 ] && [ "$_up" -lt "$BOOT_GRACE_SECS" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') bot-liveness SKIP — 부팅 ${_up}초 경과(유예 ${BOOT_GRACE_SECS}초). 팀원 기동이 끝나기 전이라 판정하지 않음."
    exit 0
  fi
fi
# 부팅시각을 못 읽으면(다른 OS 등) 유예 없이 진행 — 감시가 통째로 죽는 것보다 오보가 낫다.

GD_CHAT_ID="${GD_CHAT_ID:-}"
GD_DM_CHAT="${GD_DM_CHAT:-$GD_CHAT_ID}"  # hooklog 상 owner 1:1 DM chat_id (#4 판정용)
UPTIME_STALE_DAYS=7   # 매주 일요일 weekly-restart 기준 — 7일 초과 = 주간재시작 실패 신호 (GD 2217)
RECENT_SECS=1200      # #4 DM 무응답: react 가 최근 이 시간(20분) 이내일 때만 — stale/재시작 로그 false positive 제외
STATE_FILE="$LIVENESS_STATE_DIR/bot-liveness-monitor.state"      # 직전 이상치 signature (중복알림 방지)
PENDING_FILE="$LIVENESS_STATE_DIR/bot-liveness-monitor.pending"  # #4 지속성: 직전 run 의 pending DM msgid
ENV_FILE="$HOME/Development/b3rys-team-collab/.env"   # 알림은 team op 봇(@gd452_team_op_bot)으로 발신 — 운영성 시스템 메시지 (GD 2220, TEAM-OS §8 허용)
TOKEN_VAR="CAPTURE_BOT_TOKEN"
TEAM_OS="$HOME/Development/b3rys-team-collab/scripts/team-os.sh"   # 게이트웨이·서비스 복구용 (idempotent)
# ★봇 복구는 team-os.sh 를 거치지 않고 restart-agent 를 직접 부른다 (codex·steve 교차검증 2026-08-03)★
#   team-os.sh:26 은 CLAUDE_BOTS="bill steve demis dbak" ★하드코딩이라 lui 가 없다.★ 그래서 감시 목록만
#   agents.json 으로 동적화해도 ★lui 는 감지만 되고 복구는 조용히 실패★ 했다(`team-os up lui` 가 no-op).
#   restart-agent.sh:35 는 agents.json 을 읽어 lui 를 포함하므로 이쪽이 정본에 붙어 있다.
RESTART_AGENT="$HOME/Development/b3rys-team-collab/scripts/restart-agent.sh"
OPENCLAW_INGRESS_CHECK="$HOME/Development/b3rys-team-collab/scripts/openclaw-telegram-ingress-check.sh"  # OpenClaw Telegram ingress silence + provider stuck detector (read-only)
# onoff 서킷브레이커 조율(2026-06-11 forin 인시던트): GD가 /onoff 로 의도적 정지한 팀원은 auto-heal 이
# 되살리지 않는다. agentControl 이 이 파일에 off 명단을 기록 → 아래 복구 지점들이 존중(skip).
OFF_FILE="$TEAMOS_AGENT_OFF_FILE"

# ─── reset 모드 ───────────────────────────────────────────────────────────
if [ "$RESET" = "1" ]; then
  rm -f "$STATE_FILE" "$PENDING_FILE"
  echo "state 삭제 — 다음 이상 발견 시 알림 가능"
  exit 0
fi

echo ""
echo "$(date '+%Y-%m-%d %H:%M:%S') bot-liveness START (dry_run=$DRY_RUN)"

# ─── bus auto-clean (하루 1회) ────────────────────────────────────────────
# 정기 유지보수: 노후(48h+) terminal-bad(dead_letter + blocked 가드기록) 자동 아카이브 →
# 모니터링이 '최근 실제 문제'만 보이게. 옛 주차 레코드가 영구 카운트로 남아 "이게 뭐지?" 노이즈
# 되는 것 방지(GD 2026-06-07, blocked 포함 승인). 상세=scripts/bus-autoclean.sh
BUS_AUTOCLEAN="$HOME/Development/b3rys-team-collab/scripts/bus-autoclean.sh"
AUTOCLEAN_STAMP="$LIVENESS_STATE_DIR/bus-autoclean.lastrun"
if [ "$DRY_RUN" = "0" ] && [ -x "$BUS_AUTOCLEAN" ] && \
   [ "$(cat "$AUTOCLEAN_STAMP" 2>/dev/null)" != "$(date +%Y-%m-%d)" ]; then
  if BUS_AUTOCLEAN_INCLUDE_BLOCKED=1 "$BUS_AUTOCLEAN" >/dev/null 2>&1; then date +%Y-%m-%d > "$AUTOCLEAN_STAMP"; fi
fi

NOW_EPOCH=$(date '+%s')

# ─── 한 사이클 재시작 예산 ────────────────────────────────────────────
# ★여러 봇을 한 사이클에 연달아 재시작하면 자가치유가 사고를 재생산한다★
#   봇별 루프라 '순차' 이긴 한데 ★상한이 없었다★. 실측: 2026-07-25 22:25 에 한 사이클
#   3건, 2026-07-26 01:36(bill 4시간 방치 사고 시점)에 2건이 연달아 재시작됐다.
#   여럿이 동시에 죽었다는 건 대개 ★공통 원인★(시스템 리소스·업데이트·네트워크)이라,
#   전부 재시작해도 같은 이유로 또 죽고 그동안 부하만 키운다. 재시작은 컨텍스트를
#   잃는 무거운 조치이므로 한 번에 하나씩 하고 결과를 보는 편이 낫다.
#   초과분은 버리지 않는다 — 다음 점검(10분 뒤)에 그대로 다시 걸리고, 알림에 명시한다.
#   ※ 모달 해제 같은 가역·무해한 조치는 이 예산과 무관하다(위 1.5 단계에서 항상 시도).
RESTART_BUDGET="${LIVENESS_RESTART_BUDGET:-1}"
RESTARTS_USED=0
restart_budget_left() { [ "$RESTARTS_USED" -lt "$RESTART_BUDGET" ]; }
restart_budget_spend() { RESTARTS_USED=$((RESTARTS_USED + 1)); }

ISSUES=""
# 감시 대상 목록을 정본에서 못 읽었으면 ★조용히 넘어가지 않고 알림에 싣는다★ (위 폴백 참조).
[ -n "${_BOTS_WARN:-}" ] && ISSUES="${ISSUES}${_BOTS_WARN}
"
HEALED=""        # 이번 run 에서 auto-heal 로 복구한 항목 (team op 시스템 메시지로 보고)
NEW_PENDING=""   # 이번 run 에서 pending(미응답) DM 을 가진 봇별 msgid 기록

# 직전 run pending 로드 (bot=msgid 형식, 줄단위)
prev_pending() { grep -E "^$1=" "$PENDING_FILE" 2>/dev/null | head -1 | cut -d= -f2; }

# ─── auto-heal 규칙 (GD 2223: 계속 확대) ──────────────────────────────────
# 형식: "정규식|||send-keys 키|||라벨"  — pane 에 정규식이 보이면 그 키를 세션에 주입해 자동 복구.
# ★ 새 복구 케이스는 여기 한 줄만 추가하면 됨(범위 확장). 단 권한/신뢰 프롬프트는 보안상 제외(알림만).
AUTOHEAL_RULES=(
  # 설문 dismiss는 키주입이 신뢰불가라 제거(2026-06-17): `0`=피드백 필드에 "0" 타이핑됨 / `Escape`=insert 탈출만,
  #   2번째 Escape는 '되감기/복원 메뉴'를 열어 더 위험(Enter 오입력 시 파괴적 restore). → 설문막힘은 alert-only로
  #   escalate 후 'team-os restart <bot> --resume'(설문·메뉴 클리어+컨텍스트 보존)이 신뢰성 복구. 자동화는 카드.
  "Resume from summary|||Enter|||resume-from-summary 확정(추천옵션)"
  "resuming from a summary|||Enter|||세션 resume 확정(추천옵션)"
)

# attempt_heal: 현재 $pane 에 규칙 매칭 시 키 주입 후 재확인. 복구→HEALED+pane갱신 / 실패→ISSUES.
#   dry-run 은 세션을 건드리지 않고 "복구할 대상"만 표시. $1=session $2=bot
attempt_heal() {
  local rule pat rest keys label newpane
  for rule in "${AUTOHEAL_RULES[@]}"; do
    pat="${rule%%|||*}"; rest="${rule#*|||}"; keys="${rest%%|||*}"; label="${rest##*|||}"
    if echo "$pane" | grep -qiE "$pat"; then
      if ! autoheal_enabled; then
        ISSUES="${ISSUES}· [$2] $label 감지 — alert-only (LIVENESS_AUTOHEAL=0)
"
        return 0
      fi
      if [ "$DRY_RUN" = "1" ]; then
        HEALED="${HEALED}· [$2] $label (dry-run: 실제 복구는 안 함)
"
        return 0
      fi
      # shellcheck disable=SC2086
      tmux send-keys -t "$1" $keys 2>/dev/null
      sleep 2
      newpane=$(tmux capture-pane -p -t "$1" 2>/dev/null || echo "")
      if echo "$newpane" | grep -qiE "$pat"; then
        ISSUES="${ISSUES}· [$2] $label 자동복구 실패 — 여전히 막힘 (수동 재시작 필요)
"
      else
        HEALED="${HEALED}· [$2] $label ✓
"
        pane="$newpane"
      fi
      return 0
    fi
  done
  return 0
}

feedback_prompt_input() {
  printf "%s\n" "$1" | grep -E "^❯" | tail -1 | sed -E 's/^❯[[:space:]]*//'
}

attempt_feedback_heal() {  # $1=session $2=bot
  local has_survey=0 has_exit=0
  echo "$pane" | grep -qiE "How is Claude doing this session" && has_survey=1
  echo "$pane" | grep -qiE "Press Ctrl-C again to exit" && has_exit=1
  if [ "$has_survey" = "0" ] && [ "$has_exit" = "0" ]; then
    return 1
  fi
  if ! autoheal_enabled; then
    ISSUES="${ISSUES}· [$2] Claude 피드백/종료 프롬프트 감지 — alert-only (LIVENESS_AUTOHEAL=0)
"
    return 0
  fi
  local pending newpane
  pending=$(feedback_prompt_input "$pane")
  if [ "$has_survey" = "0" ] && [ -n "$pending" ]; then
    ISSUES="${ISSUES}· [$2] Claude 피드백/종료 프롬프트 대기 — 입력줄에 대기 문장 있음, auto-heal 제외: ${pending:0:80}
"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    if [ "$has_survey" = "1" ] && [ -n "$pending" ]; then
      HEALED="${HEALED}· [$2] Claude 설문 프롬프트 dismiss(0) — 입력줄 문장 보존 대상 (dry-run)
"
    else
      HEALED="${HEALED}· [$2] Claude 피드백 프롬프트 dismiss(0) (dry-run)
"
    fi
    return 0
  fi
  tmux send-keys -t "$1" 0 2>/dev/null
  sleep 1
  newpane=$(tmux capture-pane -p -t "$1" 2>/dev/null || echo "")
  if echo "$newpane" | grep -qiE "How is Claude doing this session|Press Ctrl-C again to exit"; then
    ISSUES="${ISSUES}· [$2] Claude 피드백 프롬프트 자동 dismiss 실패 — 수동 확인 필요
"
  else
    if [ "$has_survey" = "1" ] && [ -n "$pending" ]; then
      HEALED="${HEALED}· [$2] Claude 설문 프롬프트 dismiss(0) ✓ — 입력줄 문장 보존
"
    else
      HEALED="${HEALED}· [$2] Claude 피드백 프롬프트 dismiss(0) ✓
"
    fi
    pane="$newpane"
  fi
  return 0
}

# nudge_heal (CASE #4 — reply 미호출): 누를 프롬프트가 없는 케이스. 키 대신 "마지막 답을
#   reply 도구로 보내라"고 단발 메시지를 세션에 주입(bracketed paste). 안 되면 다음 run 에서 재시작 에스컬레이션.
nudge_heal() {  # $1=session
  local msg="[auto-heal] 방금 만든 답변이 telegram reply 도구로 전송되지 않았습니다. 마지막 답변을 reply 도구로 GD에게 다시 보내주세요."
  printf '%s' "$msg" | tmux load-buffer -b teamoss_nudge - 2>/dev/null
  tmux paste-buffer -p -t "$1" -b teamoss_nudge 2>/dev/null
  tmux send-keys -t "$1" Enter 2>/dev/null
  tmux delete-buffer -b teamoss_nudge 2>/dev/null
}

# ─── 자가치유 에스컬레이션 (GD 2026-06-08): 자동복구 실패(⚠️) 시 GD 알림 전에 빌을 깨워
#   안전·가역 조치를 한 번 시도하게 한다. 가드: ①빌 tmux 살아있을 때만(빌 자신이 다운이면 불가)
#   ②같은 sig 쿨다운(45분) — 루프/도배 방지 ③조치 범위는 빌 프롬프트에서 안전·가역으로 제한. ─────────
ESCALATE_STATE="$LIVENESS_STATE_DIR/bot-liveness-escalation.state"   # "sig|epoch" 줄단위
ESCALATE_COOLDOWN=2700                                  # 45분 — 같은 이슈 재에스컬레이션 금지
escalate_to_bill() {  # $1=ISSUES 텍스트, $2=sig → 0=에스컬레이션함 / 1=스킵
  tmux has-session -t "claude-bill" 2>/dev/null || return 1   # 빌 자신이 다운이면 불가
  local now last; now=$(date +%s)
  last=$(grep -E "^$2\|" "$ESCALATE_STATE" 2>/dev/null | head -1 | cut -d'|' -f2)
  [ -n "$last" ] && [ $((now - last)) -lt $ESCALATE_COOLDOWN ] && return 1   # 쿨다운 중
  local prompt="[자가치유 요청 · bot-liveness] 자동복구가 실패한 항목이야:
$1
→ 안전하고 가역적인 조치(team-os restart/clean·포트 orphan 정리 등)만 시도하고, 반드시 검증한 뒤 GD께 결과를 보고해줘. 못 고치거나 비가역·위험한 거면 손대지 말고 GD께 에스컬레이션. (인프라 자가치유 — 사이드이펙트 주의, 조치 후 검증 필수)"
  printf '%s' "$prompt" | tmux load-buffer -b teamoss_selfheal - 2>/dev/null
  tmux paste-buffer -p -t "claude-bill" -b teamoss_selfheal 2>/dev/null
  tmux send-keys -t "claude-bill" Enter 2>/dev/null
  tmux delete-buffer -b teamoss_selfheal 2>/dev/null
  { grep -v -E "^$2\|" "$ESCALATE_STATE" 2>/dev/null; echo "$2|$now"; } > "$ESCALATE_STATE.tmp" && mv "$ESCALATE_STATE.tmp" "$ESCALATE_STATE"
  return 0
}

for bot in "${BOTS[@]}"; do
  session="claude-$bot"
  chdir="$HOME/.claude/channels/telegram-$bot"
  pidf="$chdir/bot.pid"
  hooklog="$chdir/progress/_hooklog.txt"

  # 0) onoff: GD가 의도적으로 정지한 팀원은 복구·검사하지 않는다(서킷브레이커 존중).
  if agent_intentionally_off "$bot"; then continue; fi

  # 1) tmux 세션 존재 — 없으면 "완전 다운" → team-os up 으로 자동복구 (Type D, 2026-06-06).
  #    완전 다운만 처리: up 은 idempotent 라 살아있는(stuck) 세션은 건드리지 않음 → 과거 openclaw
  #    stuck-kickstart 도배 문제(2026-06-05 롤백)와 무관. 게이트웨이는 여전히 알림만(아래 check_gateway).
  if ! tmux has-session -t "$session" 2>/dev/null; then
    if [ "$DRY_RUN" = "1" ]; then
      HEALED="${HEALED}· [$bot] tmux 세션 없음 → team-os up $bot (dry-run)
"
    elif ! autoheal_enabled; then
      ISSUES="${ISSUES}· [$bot] tmux 세션 없음 — alert-only (LIVENESS_AUTOHEAL=0)
"
    elif ! restart_budget_left; then
      ISSUES="${ISSUES}· [$bot] tmux 세션 없음 — 이번 점검의 재시작 예산($RESTART_BUDGET)을 이미 썼다. 다음 점검에서 복구 시도(여러 봇 동시 재시작 방지)
"
    else
      restart_budget_spend
      "$RESTART_AGENT" "$bot" >/dev/null 2>&1   # 폴러 검증 포함(한도 45회 = 실측 ~51s). team-os 경유 안 함 = lui 포함
      if tmux has-session -t "$session" 2>/dev/null; then
        HEALED="${HEALED}· [$bot] tmux 세션 없음 → team-os up 자동복구 ✓
"
      else
        ISSUES="${ISSUES}· [$bot] tmux 세션 없음 — team-os up 자동복구 실패 (수동 확인 필요)
"
      fi
    fi
    continue   # 세션 없으면 이하 검사 의미 없음 (복구됐어도 다음 run 에서 정밀검사)
  fi

  # 1.5) ★blocking 모달 해제를 폴러 검사보다 먼저★ (2026-07-26, bill 4h30m 방치 사고)
  #   사고: 01:32 bill 세션 소멸 → 01:36 team-os up 으로 세션은 살았으나 폴러 미기동 →
  #        05:49 까지 10분마다 '폴러 미가동' 알림만, 조치 0 → 06:00 모달을 눌러주자 폴러 즉시 기동.
  #   근본: ★폴러가 안 뜬 원인이 Resume from summary 모달인데, 폴러 dead 분기가 continue 로
  #        사이클을 끝내서 모달 해제 루틴에 도달조차 못 했다.★ 원인을 풀 유일한 루틴이,
  #        그 원인이 만든 증상 때문에 차단되는 구조였다.
  #   대조 증거: 같은 사이클(04:08)에 steve 는 폴러가 살아 있어 모달 검사까지 도달 → 즉시 복구.
  #        같은 모달·같은 스크립트, 도달 여부만 달랐다.
  #   그래서 pane 캡처와 모달 해제를 폴러 검사 ★앞★으로 옮긴다. 세션만 살아 있으면 pane 은
  #        읽을 수 있으므로 폴러 상태와 무관하게 풀 수 있다. 키 주입은 가역·무해(Enter 1회)라
  #        재시작과 달리 thrash 가드를 걸 이유가 없다.
  pane=$(tmux capture-pane -p -t "$session" 2>/dev/null || echo "")
  _heal_before="$HEALED"
  attempt_heal "$session" "$bot"          # 매칭 시 복구(또는 dry-run 표시). 복구 후 $pane 갱신.
  attempt_feedback_heal "$session" "$bot"
  modal_cleared=0
  [ "$HEALED" != "$_heal_before" ] && modal_cleared=1
  # 모달을 풀었으면 폴러가 스스로 뜰 시간을 준다 — 실측(06:00:04 해제 → 06:00:02 기동)상 거의 즉시다.
  if [ "$modal_cleared" = "1" ] && [ "$DRY_RUN" = "0" ]; then sleep 5; fi

  # 2) 폴러 alive — 죽었으면(세션은 up) 클린 재시작으로 auto-heal(Type D 확장). 이전엔 alert-only라 poller-dead가
  #    스팸만 나고 안 고쳐졌음(steve 사례, GD 2026-07-01 하네스). 근본=.env 빈/깨짐이면 재시작해도 또 죽으니 토큰 먼저 가드.
  pid=$(cat "$pidf" 2>/dev/null || echo "")
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    # 쿨다운: 직전에 재시작했는데 또 죽었으면(=토큰 유효하지만 다른 이유 or invalid 토큰) 무한 10분 thrash 방지 — 알림만.
    hmark="$LIVENESS_STATE_DIR/bot-liveness-poller-heal-$bot.ts"
    if [ "$modal_cleared" = "1" ]; then
      # 방금 모달을 풀었다. 폴러가 못 뜬 원인이 그 모달이었을 가능성이 높으므로(사고 당시가 그랬다)
      #   재시작하지 않고 다음 점검(10분)에 맡긴다. 재시작은 컨텍스트를 잃는 무거운 조치라
      #   원인이 이미 제거된 상태에서 먼저 쓸 이유가 없다.
      ISSUES="${ISSUES}· [$bot] 폴러 미가동 — 방금 blocking 모달을 해제했으므로 재시작 없이 다음 점검에서 재확인
"
    elif [ ! -s "$chdir/.env" ]; then
      ISSUES="${ISSUES}· [$bot] 폴러 미가동 + .env 비어있음/없음 — 토큰 확인 필요(재시작해도 poller 죽음)
"
    elif [ -f "$hmark" ] && [ $(( $(date +%s) - $(stat -f %m "$hmark" 2>/dev/null || echo 0) )) -lt 2400 ]; then
      ISSUES="${ISSUES}· [$bot] 폴러 미가동 — 최근 재시작 후에도 또 죽음(40분내 재발) → 토큰/세션 수동 확인 필요(thrash 방지로 ★재시작만★ 보류. blocking 모달 해제는 위에서 이미 시도했다)
"
    elif [ "$DRY_RUN" = "1" ]; then
      HEALED="${HEALED}· [$bot] 폴러 사망(세션 up) → tmux kill + team-os up (dry-run)
"
    elif ! autoheal_enabled; then
      ISSUES="${ISSUES}· [$bot] 폴러 미가동 — alert-only (LIVENESS_AUTOHEAL=0)
"
    elif ! restart_budget_left; then
      ISSUES="${ISSUES}· [$bot] 폴러 미가동 — 이번 점검의 재시작 예산($RESTART_BUDGET)을 이미 썼다. 다음 점검에서 복구 시도(여러 봇 동시 재시작 방지)
"
    else
      restart_budget_spend
      touch "$hmark" 2>/dev/null   # 쿨다운 마커 — 다음 run이 40분내 재발이면 재시작 보류(thrash 방지)
      tmux kill-session -t "$session" 2>/dev/null; sleep 2
      "$RESTART_AGENT" "$bot" >/dev/null 2>&1; sleep 4
      if [ -s "$pidf" ] && kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null; then
        HEALED="${HEALED}· [$bot] 폴러 사망 → 클린 재시작 자동복구 ✓
"
      else
        ISSUES="${ISSUES}· [$bot] 폴러 사망 → 클린 재시작 시도했으나 여전히 미가동 (수동 확인)
"
      fi
    fi
    continue  # 재시작(또는 토큰이슈)했으니 이 봇의 이후 pane 체크는 skip(새 세션 대상)
  fi

  # 3) pane blocking UI — 권한/신뢰/한도는 보안·성격상 알림만.
  #   설문/resume auto-heal 은 위 1.5 로 옮겼다(폴러가 죽어 있어도 도달해야 하므로).
  #   ★여기서 attempt_heal 을 다시 부르지 않는다★ — 한 사이클에 Enter 가 두 번 들어가면
  #   모달이 풀린 뒤의 화면에서 엉뚱한 메뉴 항목을 확정할 수 있다(되감기/복원 메뉴가 그 예다).
  #   pane 은 1.5 이후 상태가 바뀌었을 수 있으므로 최신으로 다시 읽기만 한다.
  pane=$(tmux capture-pane -p -t "$session" 2>/dev/null || echo "")
  if echo "$pane" | grep -qiE "You've hit your monthly spend limit|Usage credit balance|Wait for limit to reset"; then
    ISSUES="${ISSUES}· [$bot] Claude 사용량 한도/결제 옵션 프롬프트 대기 — 응답 루프 멈춤 (리셋 후 세션 확인 필요)
"
  fi
  if echo "$pane" | grep -qiE "Please run /login|API Error: 401|Unauthorized|401 The socket connection was closed"; then
    ISSUES="${ISSUES}· [$bot] Telegram reply 플러그인 인증 만료 — /login 필요, visible reply 전송 실패
"
  fi
  if echo "$pane" | grep -qiE "Do you trust the files|Allow .* to run|permission to use"; then
    ISSUES="${ISSUES}· [$bot] 권한/신뢰 프롬프트 대기 — 입력 막힘 (보안상 auto-heal 제외, 수동 확인)
"
  fi

  # 4) GD DM 무응답 의심 — 마지막 DM react 가 reply 미전송(pending)이고, 최근(RECENT_SECS)+직전 run 에도 동일하면 확정.
  #    "reply 전송" 신호 = `clear src=reply` (≠ `pre first-send`=턴 첫 도구호출). recency 게이트로 재시작 후 stale 로그 제외.
  if [ -n "$GD_DM_CHAT" ] && [ -f "$hooklog" ]; then
    read -r pend_mid pend_time < <(tail -40 "$hooklog" | awk -v dm="chat=$GD_DM_CHAT" '
      $0 ~ ("react send " dm) { if (match($0, /msg=[0-9]+/)) { pending=substr($0,RSTART+4,RLENGTH-4); ptime=$1 } }
      /clear src=reply/ { pending=""; ptime="" }
      END { if (pending!="") print pending, ptime }
    ')
    if [ -n "${pend_mid:-}" ] && [ -n "${pend_time:-}" ]; then
      pts=$(echo "$pend_time" | awk -F: '{print ($1*3600)+($2*60)+$3}')
      nowts=$(date '+%H:%M:%S' | awk -F: '{print ($1*3600)+($2*60)+$3}')
      delta=$(( nowts - pts ))
      [ "$delta" -lt 0 ] && delta=$(( delta + 86400 ))   # 자정 넘김 보정 (#6 codex 리뷰 2026-06-06): HH:MM:SS만 비교해 자정 후 음수→stale 오판 방지
      if [ "$delta" -ge 0 ] && [ "$delta" -le "$RECENT_SECS" ]; then
        prev=$(prev_pending "$bot")   # "" | <mid>(1회감지) | <mid>:nudged(nudge함)
        if [ "$prev" = "${pend_mid}:nudged" ]; then
          # nudge 했는데도 여전히 pending → 재시작 에스컬레이션
          ISSUES="${ISSUES}· [$bot] GD DM(msg $pend_mid) 무응답 — nudge 후에도 reply 미전송 (재시작 필요)
"
          NEW_PENDING="${NEW_PENDING}${bot}=${pend_mid}:nudged
"
        elif [ "$prev" = "$pend_mid" ]; then
          # 2회 연속 확정 → nudge-heal 시도 (키 아님, 메시지 주입)
          if ! autoheal_enabled; then
            ISSUES="${ISSUES}· [$bot] reply-미호출(msg $pend_mid) — alert-only (LIVENESS_AUTOHEAL=0)
"
          elif [ "$DRY_RUN" = "1" ]; then
            HEALED="${HEALED}· [$bot] reply-미호출(msg $pend_mid) → reply 도구 nudge 주입 (dry-run)
"
          else
            nudge_heal "$session"
            HEALED="${HEALED}· [$bot] reply-미호출(msg $pend_mid) → reply 도구 nudge 주입 ✓
"
          fi
          NEW_PENDING="${NEW_PENDING}${bot}=${pend_mid}:nudged
"
        else
          # 첫 감지(run 1) — 봇이 아직 작업 중일 수 있어 1run 더 관찰(오탐 방지)
          NEW_PENDING="${NEW_PENDING}${bot}=${pend_mid}
"
        fi
      fi
    fi
  fi

  # 5) 세션 uptime 노후화
  created=$(tmux display-message -p -t "$session" '#{session_created}' 2>/dev/null || echo "")
  if [ -n "$created" ] && [ "$created" -gt 0 ] 2>/dev/null; then
    age_days=$(( (NOW_EPOCH - created) / 86400 ))
    if [ "$age_days" -ge "$UPTIME_STALE_DAYS" ]; then
      ISSUES="${ISSUES}· [$bot] 세션 uptime ${age_days}일 — 노후화, 선제 재시작 권고
"
    fi
  fi
done

# ─── 게이트웨이/서비스 완전다운 health (GD 2217) + 자동복구 (Type D, GD 2026-06-06) ─────────
# CLI 미호출(codex 는 headless hang 위험) — LaunchAgent PID 생존만 확인.
# launchctl list: col1=PID(미가동 시 "-"), col3=Label.
# 완전다운(미등록/미가동/PID死)은 team-os up 으로 자동복구. up 은 등록됨이면 kickstart, 미등록이면 bootstrap.
# ★ stuck(PID 살아있는데 응답없음)은 여기 안 걸림(kill -0 통과) → 과거 openclaw stuck-kickstart 도배(2026-06-05 롤백)와 무관.
gw_pid() { printf '%s\n' "$(launchctl list 2>/dev/null)" | awk -v l="$1" '$3==l{print $1}'; }  # 변수경유=SIGPIPE회피
check_gateway() {  # $1=LaunchAgent label, $2=표시이름, $3=team-os svc alias
  local pid; pid=$(gw_pid "$1")
  local down=""
  if [ -z "$pid" ]; then down="LaunchAgent 미등록 ($1)"
  elif [ "$pid" = "-" ]; then down="게이트웨이 미가동 (로드됐으나 프로세스 없음)"
  elif ! kill -0 "$pid" 2>/dev/null; then down="게이트웨이 PID $pid 死"
  fi
  if [ -z "$down" ]; then
    # PID 생존 = 완전다운 아님. health url 있으면 무응답(stuck) 체크 (#5 codex 2026-06-06).
    # 복구는 안 함(2026-06-05 stuck-kickstart 롤백 취지 유지) — 알림만. health 없으면(hermes) PID 생존=정상 취급.
    if [ "${4:--}" != "-" ] && ! curl -s -m 3 "$4" >/dev/null 2>&1; then
      ISSUES="${ISSUES}· [$2] 게이트웨이 먹통 — PID $pid 살아있으나 health 무응답($4). 자동복구 안 함(수동 확인)
"
    fi
    return 0
  fi
  # ★의도적 정지 가드: 이 게이트웨이의 owner 에이전트($5, 단일-에이전트 게이트웨이만)가 agent-off면 부활 금지.
  #   emergency-stop/offboard 로 정지한 runaway(hermes 계열)를 auto-heal이 team-os up으로 되살리던 갭(하네스 HIGH, GD 2026-07-02). 공유 게이트웨이(openclaw)는 $5="-"라 항상 복구.
  if [ "${5:--}" != "-" ] && agent_intentionally_off "$5"; then
    ISSUES="${ISSUES}· [$2] 게이트웨이 down이나 $5 의도적 정지(agent-off) — 부활 안 함(runaway 재부활 방지)
"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    HEALED="${HEALED}· [$2] $down → team-os up $3 (dry-run)
"
    return 0
  fi
  if ! autoheal_enabled; then
    ISSUES="${ISSUES}· [$2] $down — alert-only (LIVENESS_AUTOHEAL=0)
"
    return 0
  fi
  if ! restart_budget_left; then
    ISSUES="${ISSUES}· [$2] $down — 이번 점검의 재시작 예산($RESTART_BUDGET)을 이미 썼다. 다음 점검에서 복구 시도(여러 봇·게이트웨이 동시 재시작 방지)
"
    return 0
  fi
  restart_budget_spend
  "$TEAM_OS" up "$3" >/dev/null 2>&1   # 완전다운 자동복구 (idempotent)
  local pid2; pid2=$(gw_pid "$1")
  if [ -n "$pid2" ] && [ "$pid2" != "-" ] && kill -0 "$pid2" 2>/dev/null; then
    HEALED="${HEALED}· [$2] $down → team-os up 자동복구 ✓
"
  else
    # up 실패 → force-clean restart (포트 orphan 점유로 EADDRINUSE 크래시루프인 경우. 2026-06-08 새벽 사고 대응:
    #  orphan 이 포트+health 200 점유 → up no-op → 관리 인스턴스 크래시루프. restart 가 포트 orphan 정리 후 재기동.)
    "$TEAM_OS" restart "$3" >/dev/null 2>&1
    local pid3; pid3=$(gw_pid "$1")
    if [ -n "$pid3" ] && [ "$pid3" != "-" ] && kill -0 "$pid3" 2>/dev/null; then
      HEALED="${HEALED}· [$2] $down → team-os restart(force-clean) 자동복구 ✓
"
    else
      ISSUES="${ISSUES}· [$2] $down — team-os up·restart 둘다 실패 (수동 확인 필요)
"
    fi
  fi
}
# 인자: label · 표시이름 · team-os alias · health url("-"=http health 없음→PID만)
# ★b3os 서버를 제일 먼저 본다 (2026-08-03 추가)★
#   그동안 이 감시기는 openclaw·hermes·b3rys-dev 만 봤고 ★정작 b3os 서버는 감시 대상이 아니었다.★
#   2026-08-03 13:47 재부팅에서 com.gdmini.team-collab 이 로그인 시 로드되지 않아 ★12분간★ 서버 프로세스 0개 ·
#   대시보드 무응답 · 팀버스 정지였는데 ★아무 알림도 없었다★(사람이 수동으로 발견해 bootstrap 함).
#   서버 안에 health 워커(팀원 감시)가 들어 있어서, 서버가 없으면 팀원이 죽어도 볼 주체가 사라진다 = ★그물 0★.
#   재시작 예산이 주기당 1건이라 ★순서가 곧 우선순위★ 다. 그래서 다른 게이트웨이보다 앞에 둔다.
check_gateway "com.gdmini.team-collab" "b3os 서버" "collab" "http://127.0.0.1:7878/health" "-"
check_gateway "ai.openclaw.gateway" "codex/openclaw" "openclaw" "http://127.0.0.1:18789/health" "-"
check_gateway "ai.hermes.gateway-b3ryshermes" "hermes" "hermes" "-" "hermes"
check_gateway "com.gdmini.b3rys-dev" "b3rys-dev" "b3rys-dev" "http://127.0.0.1:3000/" "-"

# OpenClaw Telegram provider stuck detector (Phase A, 2026-06-16 outage):
# alert only when last inbound is stale AND provider state is stopped/disconnected.
# It writes read-only dashboard status + audit_event; gateway restart/kickstart stays OFF unless
# OPENCLAW_TELEGRAM_AUTO_RECOVER=1 is explicitly introduced in a later gated phase.
if [ -x "$OPENCLAW_INGRESS_CHECK" ]; then
  ingress_args=(--format env)
  [ "$DRY_RUN" = "1" ] && ingress_args=(--dry-run "${ingress_args[@]}")
  while IFS= read -r line; do
    case "$line" in
      ISSUE:*)
        ISSUES="${ISSUES}· ${line#ISSUE:}
"
        ;;
    esac
  done < <("$OPENCLAW_INGRESS_CHECK" "${ingress_args[@]}" 2>/dev/null || true)
fi

# ─── TEAM OP 라우터 ingress 킬스위치 감지 (2026-06-29, router-off 사고) ──────
# router_enabled(team.db setting) = telegramCapture worker 의 *라이브* ingress 킬스위치
# (captureConfig.isRouterEnabled). off 면 봇·게이트웨이 다 정상이어도 GD 그룹 메시지가
# claude_channel 에이전트에 *주입 자체*가 안 됨 → 전원 묵묵부답.
#   사고(2026-06-29): GD "왜 답없냐" — 빌 봇 멀쩡, team op 라우터만 off 라 입구가 막힘.
#   봇 생존 체크(#1~5)·게이트웨이 체크로는 못 잡던 갭 = "GD 메시지가 실제 도달 가능한가".
# router-off 는 봇 문제가 아니라 설정 킬스위치 → 재시작/자가치유 대상 아님(전용 조치 안내).
# 의도적 off 일 수 있으니 SIG dedup 으로 1회만 알림(off 유지 중 도배 안 함).
TEAM_DB="${TEAM_DB_OVERRIDE:-$HOME/Development/b3rys-team-collab/team.db}"
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$TEAM_DB" ]; then
  router_val=$(sqlite3 "$TEAM_DB" "SELECT value FROM setting WHERE key='router_enabled';" 2>/dev/null || echo "")
  # store 비면 env ROUTER_ENABLED fallback (captureConfig 와 동일 규약, 기본 on).
  [ -z "$router_val" ] && router_val="${ROUTER_ENABLED:-true}"
  if [ "$router_val" = "false" ] || [ "$router_val" = "0" ]; then
    ISSUES="${ISSUES}· [team-op] TEAM OP 라우터 OFF (router_enabled=false) — 봇 정상이어도 GD 그룹 메시지가 에이전트에 미도달(ingress 막힘)
"
  fi
fi

# ─── 게이트웨이 자동복구 정책 이력 ──────────────────────────────────────────
# 2026-06-05(GD 2831): stuck(PID 살아있는데 응답없음) 자동 kickstart 롤백 — codex 세션을 흔들고
#   알림만 도배했다(효과 없음). stuck 재시작 판단은 사람이 한다.
# 2026-06-06(GD): "완전다운은 다 자동복구" → 위 check_gateway 가 완전다운(미등록/미가동/PID死)만
#   team-os up 으로 복구한다(Type D). stuck 은 kill -0 통과해 여기 안 걸리므로 손대지 않음 →
#   2026-06-05 롤백 취지(stuck 흔들기 금지)와 충돌하지 않는다. 완전죽음만 살린다.

# 이번 run pending 저장 (#4 지속성 판정용) — dry-run 아닐 때만
if [ "$DRY_RUN" = "0" ]; then
  printf "%s" "$NEW_PENDING" > "$PENDING_FILE"
fi

# ─── 이상도 복구도 없음 → state 리셋 후 조용히 종료 ────────────────────────
if [ -z "$ISSUES" ] && [ -z "$HEALED" ]; then
  echo "이상 없음 — 전 봇 정상"
  [ "$DRY_RUN" = "0" ] && rm -f "$STATE_FILE"
  exit 0
fi

# ─── 메시지 구성 (team op 시스템 메시지) ───────────────────────────────────
# 복구분(HEALED)은 🔧 간단 상황 메시지, 못 고친 것(ISSUES)만 ⚠️ 알림.
# 중복방지 signature 는 ISSUES+HEALED 기준 — 성공 복구는 다음 run 에 사라져 자연히 1회만.
SIG=$(printf "%s" "$ISSUES$HEALED" | shasum | cut -d' ' -f1)
LAST_SIG=$(cat "$STATE_FILE" 2>/dev/null || echo "")

NOW=$(date '+%Y-%m-%d %H:%M KST')
MSG=""
# 라우터 OFF 는 봇 문제가 아니라 ingress 킬스위치 → 재시작/자가치유(escalate) 대상에서 제외.
NON_ROUTER_ISSUES=$(printf "%s" "$ISSUES" | grep -v "\[team-op\] TEAM OP 라우터 OFF" || true)
ESCALATABLE_ISSUES=$(printf "%s" "$NON_ROUTER_ISSUES" | grep -v "Claude 피드백/종료 프롬프트" | grep -v "Telegram reply 플러그인 인증 만료" || true)
if [ -n "$HEALED" ]; then
  MSG="🔧 [auto-heal] 자동복구 ($NOW)
${HEALED}"
fi
if [ -n "$ISSUES" ]; then
  [ -n "$MSG" ] && MSG="${MSG}
"
  MSG="${MSG}⚠️ Bot liveness — 점검 필요 ($NOW)
${ISSUES}"
  # 라우터 OFF 전용 조치(봇 재시작 아님) — 다른 이슈와 독립 안내.
  if printf "%s" "$ISSUES" | grep -q "\[team-op\] TEAM OP 라우터 OFF"; then
    MSG="${MSG}조치(라우터): /team 설정 또는 /onoff 에서 TEAM OP 라우터를 ON. 봇 재시작 아님 — ingress 킬스위치라 봇은 정상.
"
  fi
  if [ -n "$ESCALATABLE_ISSUES" ]; then
    # ★안내는 라이브 정본 경로로만 (GD 지적 2026-08-03)★
    #   예전엔 은퇴한 b3rys-team-collab 의 team-os.sh 를 안내했다. 실행 경로는 정본으로 바꿨는데 ★문구는 그대로라★,
    #   이 알림을 읽는 사람은 계속 낡은 경로를 쓰게 된다(문서가 사람을 잘못 가르치는 형태).
    #   ★WORKDIR 를 반드시 붙인다★ — tmux 안에서 실행하면 tmux 전역에 박힌 첫 기동자의 WORKDIR(예: lui)을
    #   정본 스크립트가 검증 없이 물려받아 ★그 팀원이 남의 폴더에서 뜬다★(2026-08-03 dbak 실측).
    MSG="${MSG}조치: 해당 봇 재시작 (라이브 정본 스크립트 · 컨텍스트 유지)
  WORKDIR=~/Development/<bot> ~/Development/b3rys-team-os/src/server/runtimes/claude/start-telegram-channel.sh <bot> --resume --force
  ※ WORKDIR 를 빼면 남의 폴더에서 뜰 수 있습니다(자기 CLAUDE.md/TEAM-OS 미로드)."
  elif printf "%s" "$NON_ROUTER_ISSUES" | grep -q "Telegram reply 플러그인 인증 만료"; then
    MSG="${MSG}조치: 해당 Claude 세션에서 /login 재인증 필요. 자동 로그인/토큰 조작은 하지 않음. 재인증 후에도 실패하면 채널 재시작."
  elif [ -n "$NON_ROUTER_ISSUES" ]; then
    MSG="${MSG}조치: 입력줄에 대기 문장이 있어 자동 조작하지 않음. 해당 팀원 응답/재시작은 PM이 판단."
  fi
  # 자가치유 에스컬레이션: GD 알림과 함께 빌을 깨워 안전조치 1회 시도(쿨다운·빌생존 가드 내부).
  # 단, Bill 본인이 이슈 대상이면 Bill에게 다시 요청하지 않는다. 자기 세션이 막힌 상태에
  # 자가치유 프롬프트를 얹으면 응답 루프가 더 꼬인다.
  if autoheal_enabled && [ "$DRY_RUN" = "0" ] && [ -n "$ESCALATABLE_ISSUES" ] && ! printf "%s" "$ESCALATABLE_ISSUES" | grep -q "· \\[bill\\]" && escalate_to_bill "$ESCALATABLE_ISSUES" "$SIG"; then
    MSG="${MSG}
→ 🔧 빌에게 자가치유 요청 보냄 (안전조치·검증 후 GD께 결과 보고 예정)"
  fi
fi

echo ""
echo "--- 메시지 미리보기 ---"
echo "$MSG"
echo "--- 끝 --- (sig=$SIG, last=$LAST_SIG)"

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo "[DRY-RUN] DM 전송 생략. 실제 실행 시 chat_id=${GD_CHAT_ID} 에 전송됨."
  exit 0
fi

if [ "$SIG" = "$LAST_SIG" ]; then
  echo "동일 이상치 — 중복알림 skip"
  exit 0
fi

# ─── 토큰 로드 + DM 전송 ──────────────────────────────────────────────────
if [ ! -s "$ENV_FILE" ]; then
  echo "ERROR: token env file missing: $ENV_FILE"
  exit 1
fi
if [ -z "$GD_CHAT_ID" ]; then
  echo "ERROR: GD_CHAT_ID 비어있음"
  exit 1
fi
TOKEN=$(grep -E "^${TOKEN_VAR}=" "$ENV_FILE" | head -1 | cut -d= -f2-)
if [ -z "$TOKEN" ]; then
  echo "ERROR: ${TOKEN_VAR} 비어있음"
  exit 1
fi

HTTP_CODE=$(curl -s -o /tmp/bot-liveness-resp.json -w "%{http_code}" --max-time 10 \
  "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${GD_CHAT_ID}" \
  --data-urlencode "text=${MSG}")
unset TOKEN

echo "Telegram API: HTTP $HTTP_CODE"
if [ "$HTTP_CODE" = "200" ]; then
  echo "DM 전송 완료"
  printf "%s" "$SIG" > "$STATE_FILE"
  rm -f /tmp/bot-liveness-resp.json
else
  echo "DM 전송 실패 — 응답:"
  cat /tmp/bot-liveness-resp.json
  rm -f /tmp/bot-liveness-resp.json
  exit 2
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') bot-liveness DONE"

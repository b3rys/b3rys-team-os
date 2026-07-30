#!/usr/bin/env bash
# team-os 의 팀원 poller 판정·복구 인수테스트.
#
# 무엇을 막나 (2026-07-30 실측 사고):
#   리사 tmux 세션은 08:03:33 에 정상 생성됐는데 poller 가 죽어 bot.pid 가 없었다. 28분간
#   텔레그램을 한 통도 못 받았는데 세션만 보면 정상이다. team-os 는 세션만 봤으므로
#   그 28분 동안 "리사 정상" 이라고 말했다.
#
# ★양방향을 다 본다★ — 한쪽만 보면 다음 사람이 반대쪽을 최적화로 걷어낸다:
#   T1 세션 살아있고 bot.pid 없음        -> unhealthy 로 봐야 한다 (D1)
#   T2 세션 살아있고 bot.pid 살아있음    -> healthy, ★세션을 죽이지 않아야 한다★ (오판정 = 강제종료)
#   T3 갓 뜬 세션 + bot.pid 없음         -> '기동 중' 으로 건드리지 않아야 한다 (부팅 오탐)
#   T4 복구 인자에 --resume --force 가   -> 둘 다 실려야 한다 (--force 만이면 컨텍스트 소실,
#      실리나                               --resume 만이면 런처 가드에 no-op)
#
# FS 격리: HOME 을 mktemp 로 갈고 tmux 세션명에 PID 를 붙인다. 실제 ~/.claude·팀원 세션 무접촉.
# 실행: scripts/team-os-poller.test.sh   (0=통과, 1=실패)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SCRIPT="$HERE/../bin/team-os"
[ -x "$SCRIPT" ] || { echo "FAIL: $SCRIPT 없음/실행권한 없음"; exit 1; }

FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

TMPROOT="$(mktemp -d)"
NAME="pollertest$$"
SESSION="claude-$NAME"

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf "$TMPROOT" 2>/dev/null || true
}
trap cleanup EXIT

STATE="$TMPROOT/home/.claude/channels/telegram-$NAME"
mkdir -p "$STATE"

# 판정 함수만 로드해서 부른다. TEAM_OS_REPO 를 줘야 한다 — source 하면 $0 이 스크립트 경로가
#   아니라서 저장소 자동탐색이 실패하고 함수 정의 전에 exit 1 한다(그러면 전부 unhealthy 로 보인다).
judge() {  # judge -> 0=healthy 1=unhealthy
  HOME="$TMPROOT/home" TEAM_OS_REPO="$REPO" \
    bash -c 'TEAMOS_LIB_ONLY=1 . "$1" >/dev/null 2>&1; poller_healthy "$2"' _ "$SCRIPT" "$NAME"
}
booting() {
  HOME="$TMPROOT/home" TEAM_OS_REPO="$REPO" \
    bash -c 'TEAMOS_LIB_ONLY=1 . "$1" >/dev/null 2>&1; member_booting "$2"' _ "$SCRIPT" "$NAME"
}

# 로딩 가드 — 이게 깨지면 아래 unhealthy 단정들이 전부 거짓 통과한다.
if HOME="$TMPROOT/home" TEAM_OS_REPO="$REPO" \
     bash -c 'TEAMOS_LIB_ONLY=1 . "$1" >/dev/null 2>&1; type poller_healthy >/dev/null 2>&1' _ "$SCRIPT"; then
  pass "판정 함수 로드됨 (크래시가 unhealthy 로 위장하지 않는다)"
else
  fail "판정 함수를 로드하지 못했다 — 이후 단정은 신뢰할 수 없다"
  echo "FAILED — team-os poller"; exit 1
fi

echo "── T1: 세션 살아있고 bot.pid 없음 → unhealthy (2026-07-30 리사 상태) ──"
tmux new-session -d -s "$SESSION" -c "$TMPROOT" "sleep 300" 2>/dev/null
rm -f "$STATE/bot.pid"
tmux has-session -t "$SESSION" 2>/dev/null \
  && pass "세션은 살아있다 (사고 상황 재현)" || fail "세션 생성 실패"
judge && fail "★세션만 보고 healthy 라고 했다 — 사고 재현★" || pass "unhealthy 로 판정"

echo "── T2: 세션 살아있고 bot.pid 살아있음 → healthy (★세션을 죽이면 안 된다★) ──"
echo $$ > "$STATE/bot.pid"      # 이 테스트 프로세스 = 확실히 살아있는 pid
judge && pass "healthy 로 판정" || fail "살아있는 poller 를 unhealthy 로 봤다 (오판정 = 강제종료 위험)"
tmux has-session -t "$SESSION" 2>/dev/null \
  && pass "판정이 세션을 건드리지 않았다" || fail "판정 중 세션이 죽었다"

echo "── T3: 죽은 pid → unhealthy ──"
echo "999999" > "$STATE/bot.pid"
judge && fail "죽은 pid 를 healthy 라고 했다" || pass "죽은 pid = unhealthy (정본 'not alive' 와 동일)"

echo "── T4: 갓 뜬 세션은 '기동 중' 으로 보호된다 (부팅 오탐 방지) ──"
# 방금 만든 세션이므로 나이가 유예(기본 90초) 안이다.
rm -f "$STATE/bot.pid"
booting && pass "갓 뜬 세션을 '기동 중' 으로 인식 (복구로 안 내려간다)" \
        || fail "갓 뜬 세션을 즉시 복구 대상으로 봤다 — 정상 기동 중인 멤버를 죽인다"
# 유예를 0 으로 주면 더 이상 보호하지 않아야 한다(게이트가 실제로 값에 반응하는지)
if HOME="$TMPROOT/home" TEAM_OS_REPO="$REPO" TEAMOS_POLLER_BOOT_GRACE=0 \
     bash -c 'TEAMOS_LIB_ONLY=1 . "$1" >/dev/null 2>&1; member_booting "$2"' _ "$SCRIPT" "$NAME"; then
  fail "유예 0 인데도 '기동 중' 이라고 했다 (게이트가 값에 반응하지 않는다)"
else
  pass "유예 0 이면 보호하지 않는다 (게이트가 값에 반응한다)"
fi

echo "── T5: 복구 인자에 --resume 와 --force 가 둘 다 실린다 ──"
# --force 만이면 fresh 로 떠서 멤버 컨텍스트가 사라진다. --resume 만이면 런처 가드에 no-op 이다.
if grep -qE '"\$sc" "\$2" --resume --force' "$SCRIPT"; then
  pass "member_restart 가 --resume --force 를 함께 싣는다"
else
  fail "복구 인자가 --resume --force 조합이 아니다"
  grep -nE 'bash "\$sc"' "$SCRIPT" | sed 's/^/    /'
fi
# 팀원 복구가 member_restart 를 타는지, 그리고 실행 코드의 kickstart 가 상주 서비스용 1곳만인지.
#   ★주석을 세면 안 된다★ — 이 파일 주석에 'kickstart' 가 설명으로 여러 번 나온다(왜 안 쓰는지가
#   기록이므로 지우면 안 된다). 그래서 주석을 지운 뒤 ★실행 코드만★ 센다.
_exec_only="$(sed 's/#.*//' "$SCRIPT")"
if grep -q 'member_restart "\$_plist" "\$_m"' <<<"$_exec_only"; then
  pass "팀원 복구가 member_restart 를 탄다"
else
  fail "팀원 복구가 member_restart 를 타지 않는다"
fi
_kick="$(grep -c 'kickstart' <<<"$_exec_only")"
if [ "$_kick" -eq 1 ]; then
  pass "실행 코드의 kickstart 는 1곳(상주 서비스용)뿐이다"
else
  fail "실행 코드에 kickstart 가 ${_kick}곳 — 팀원 복구에 남아있으면 런처 가드에 no-op 된다"
  grep -n 'kickstart' <<<"$_exec_only" | sed 's/^/    /'
fi

echo
if [ $FAILED -eq 0 ]; then echo "ALL PASS — team-os poller"; else echo "FAILED — team-os poller"; fi
exit $FAILED

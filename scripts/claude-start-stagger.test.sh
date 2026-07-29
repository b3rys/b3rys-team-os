#!/usr/bin/env bash
# start-telegram-channel.sh 의 spawn stagger(공유 플러그인 캐시 binlink 경합 가드) 인수테스트.
#
# 무엇을 막는 테스트인가 (2026-07-30 실측 사고):
#   jane·lisa launchd 잡이 RunAtLoad 로 같은 초에 떠서 두 세션의 claude 가 공유 플러그인 캐시에
#   `bun run` 을 동시에 걸었다 → `error: Failed to link which: EEXIST` → `MCP error -32000:
#   Connection closed`(144ms) → bot.pid 미생성 → 리사가 28분간 텔레그램을 못 받았다.
#   처방은 "머신 단위 mutex 로 스폰만 직렬화" 이고, 이 테스트가 그 직렬화를 실제로 검증한다.
#
# FS 격리(b3os-infra-safety ④): HOME 을 mktemp 로 갈아 실제 ~/.claude 를 건드리지 않는다.
#   claude 바이너리는 stub(실제 CC 안 뜬다). tmux 는 실물을 쓰되 세션 이름에 PID 를 붙여 격리하고
#   종료 시 반드시 kill 한다.
#
# 실행: scripts/test-claude-start-stagger.sh   (0=통과, 1=실패)
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/server/runtimes/claude/start-telegram-channel.sh"
[[ -x "$SCRIPT" ]] || { echo "FAIL: 대상 스크립트 없음/실행권한 없음: $SCRIPT"; exit 1; }

FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

TMPROOT="$(mktemp -d)"
SUFFIX="$$"
A="stagtesta$SUFFIX"
B="stagtestb$SUFFIX"

cleanup() {
  for n in "$A" "$B"; do tmux kill-session -t "claude-$n" 2>/dev/null || true; done
  rm -rf "$TMPROOT" 2>/dev/null || true
}
trap cleanup EXIT

# ─── stub claude: 지연 후 bot.pid 를 쓰고(=MCP poller 안착 신호) 살아있는다 ──────
#   ★타임스탬프는 STATE_DIR 안에 남긴다★ — 이미 떠 있는 tmux 서버에 new-session 을 걸면 새 세션은
#   ★클라이언트가 아니라 서버★의 환경을 물려받으므로, 테스트가 export 한 변수는 스텁에 안 보인다.
#   INNER_CMD 에 명시적으로 실리는 TELEGRAM_STATE_DIR 만이 확실한 전달 경로다(실측 함정).
mkdir -p "$TMPROOT/bin"
cat > "$TMPROOT/bin/claude" <<'STUB'
#!/usr/bin/env bash
sd="${TELEGRAM_STATE_DIR:?}"
mkdir -p "$sd"
date +%s > "$sd/start.stamp"
sleep "${STUB_LINK_DELAY:-3}"      # 공유 캐시 링크에 걸리는 시간을 모사
echo $$ > "$sd/bot.pid"
date +%s > "$sd/pid.stamp"
sleep 300                           # 세션 유지
STUB
chmod +x "$TMPROOT/bin/claude"

run_start() { # <botname> [VAR=val ...]  — env 로 넘긴다(prefix 할당은 "$@" 뒤에선 명령어로 해석됨)
  local name="$1"; shift
  env HOME="$TMPROOT/home" \
      PATH="$TMPROOT/bin:$PATH" \
      WORKDIR="$TMPROOT/work" \
      CLAUDE_START_STAGGER_LOCK="$TMPROOT/spawn.lock" \
      "$@" \
      "$SCRIPT" "$name" 2>&1
}

stamp() { cat "$TMPROOT/home/.claude/channels/telegram-$1/$2.stamp" 2>/dev/null || echo ""; }

prep_home() {
  mkdir -p "$TMPROOT/home/.claude/channels/telegram-$A" \
           "$TMPROOT/home/.claude/channels/telegram-$B" \
           "$TMPROOT/work"
  # 토큰은 형식만 있는 더미 — 네트워크로 나가지 않는다(stub claude 는 텔레그램에 접속하지 않음).
  for n in "$A" "$B"; do
    printf 'TELEGRAM_BOT_TOKEN=000000:TEST_DUMMY_NOT_A_REAL_TOKEN\n' \
      > "$TMPROOT/home/.claude/channels/telegram-$n/.env"
    chmod 600 "$TMPROOT/home/.claude/channels/telegram-$n/.env"
  done
}

echo "── T1: 동시 기동이 직렬화되는가 (경합 재발 방지 본체) ──"
prep_home

run_start "$A" >"$TMPROOT/outA" 2>&1 &
pidA=$!
run_start "$B" >"$TMPROOT/outB" 2>&1 &
pidB=$!
wait $pidA; rcA=$?
wait $pidB; rcB=$?

[[ $rcA -eq 0 && $rcB -eq 0 ]] && pass "두 기동 모두 exit 0 (rcA=$rcA rcB=$rcB)" \
                               || fail "기동 실패 (rcA=$rcA rcB=$rcB)"

# 두 멤버 모두 bot.pid 가 생겼는가 = 아무도 링크 경합에 탈락하지 않았다
for n in "$A" "$B"; do
  if [[ -s "$TMPROOT/home/.claude/channels/telegram-$n/bot.pid" ]]; then
    pass "$n bot.pid 생성됨"
  else
    fail "$n bot.pid 없음 (경합 탈락 = 사고 재현)"
  fi
done

# 핵심 단정: 나중에 뜬 쪽의 start 가 먼저 뜬 쪽의 pid(링크 완료) 이후여야 한다.
#   = 두번째 claude 는 캐시 링크가 끝난 뒤에 떴다 → 링크할 게 없어 EEXIST 경합이 불가능하다.
sA="$(stamp "$A" start)"; pA="$(stamp "$A" pid)"
sB="$(stamp "$B" start)"; pB="$(stamp "$B" pid)"
if [[ -n "$sA" && -n "$pA" && -n "$sB" && -n "$pB" ]]; then
  first_pid_t=$(( pA < pB ? pA : pB ))
  last_start_t=$(( sA > sB ? sA : sB ))
  if (( last_start_t >= first_pid_t )); then
    pass "직렬화 확인 — 늦은 start($last_start_t) ≥ 이른 bot.pid($first_pid_t)"
  else
    fail "직렬화 실패 — 두번째 세션이 첫 세션 링크 완료 전에 떴다 (start=$last_start_t < pid=$first_pid_t)"
  fi
else
  fail "stamp 부족 — A(start=$sA pid=$pA) B(start=$sB pid=$pB)"
fi

grep -q "Stagger     : 락 확보" "$TMPROOT/outA" "$TMPROOT/outB" \
  && pass "락 확보 로그 노출" || fail "락 확보 로그 없음"

for n in "$A" "$B"; do tmux kill-session -t "claude-$n" 2>/dev/null || true; done

echo "── T2: CLAUDE_START_NO_STAGGER=1 탈출구 ──"
rm -rf "$TMPROOT/home" "$TMPROOT/spawn.lock"; prep_home

out="$(run_start "$A" CLAUDE_START_NO_STAGGER=1)"
if grep -q "Stagger     : OFF" <<<"$out"; then
  pass "OFF 경로 동작 (락 미사용)"
else
  fail "OFF 경로 미동작"; sed 's/^/    /' <<<"$out" | head -20
fi
[[ ! -d "$TMPROOT/spawn.lock" ]] && pass "OFF 시 락 디렉토리 미생성" || fail "OFF 인데 락이 생겼다"
tmux kill-session -t "claude-$A" 2>/dev/null || true

echo "── T3: 죽은 소유자의 stale 락을 회수하는가 (부팅 중 크래시 복구) ──"
rm -rf "$TMPROOT/home" "$TMPROOT/spawn.lock"; prep_home

# 절대 존재하지 않는 pid 로 락을 선점 → 스크립트가 회수해야 한다.
mkdir -p "$TMPROOT/spawn.lock"
echo "999999" > "$TMPROOT/spawn.lock/pid"
out="$(run_start "$A")"
if grep -q "stale 락 회수" <<<"$out"; then
  pass "stale 락 회수됨"
else
  fail "stale 락을 회수하지 못했다 (부팅 실패 후 영구 블록 위험)"; sed 's/^/    /' <<<"$out" | head -20
fi
[[ -s "$TMPROOT/home/.claude/channels/telegram-$A/bot.pid" ]] \
  && pass "회수 후 정상 기동" || fail "회수 후에도 기동 실패"
tmux kill-session -t "claude-$A" 2>/dev/null || true

echo
if [[ $FAILED -eq 0 ]]; then echo "ALL PASS — start-telegram-channel stagger"; else echo "FAILED — start-telegram-channel stagger"; fi
exit $FAILED

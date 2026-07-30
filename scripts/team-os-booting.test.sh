#!/usr/bin/env bash
# member_booting 의 '세션 없는 창' 보호를 검증한다. ★서버는 안 띄운다.★
#   판정 함수만 떼어 돌리고, 런처는 이름만 흉내낸 sleep 프로세스로 만든다.
set -uo pipefail
SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../bin/team-os}"
TMP="$(mktemp)"; PIDS=""
cleanup() { for p in $PIDS; do kill "$p" 2>/dev/null || true; done; rm -f "$TMP"; }
trap cleanup EXIT

sed -n '/^session_age_sec() {/,/^}/p'   "$SRC" >  "$TMP"
sed -n '/^launcher_running() {/,/^}/p'  "$SRC" >> "$TMP"
sed -n '/^member_booting() {/,/^}/p'    "$SRC" >> "$TMP"
grep '^POLLER_BOOT_GRACE=' "$SRC"                >> "$TMP"
# shellcheck disable=SC1090
. "$TMP"

FAIL=0
ok(){ echo "  ✓ $1"; }; bad(){ echo "  ✗ $1"; FAIL=1; }

echo "── T1: 세션 없음 + 런처 안 돎 → ★기동 중 아님★ (진짜 다운은 계속 고쳐야 한다) ──"
if member_booting "nosuchmember$$"; then bad "보호됨 — 영구 다운을 영영 안 고치게 된다"; else ok "보호 안 함 (맞음)"; fi

echo "── T2: 세션 없음 + ★런처가 돌고 있음★ → 기동 중 (락 대기 중이라 죽이면 안 됨) ──"
NAME="fakemem$$"
# 런처와 같은 모양의 명령줄을 가진 프로세스를 띄운다(실제 런처는 안 부른다)
bash -c "exec -a 'bash /path/src/server/runtimes/claude/start-telegram-channel.sh $NAME' sleep 25" &
PIDS="$PIDS $!"
sleep 1
if launcher_running "$NAME"; then ok "런처 감지됨"; else bad "★런처를 못 찾는다 — 보호가 작동 안 함★"; fi
if member_booting "$NAME"; then ok "기동 중으로 판정 (보호됨)"; else bad "★보호 안 됨 — 락 대기 중인 멤버를 죽인다★"; fi

echo "── T3: 이름이 비슷한 다른 멤버로 오인하지 않나 ──"
if launcher_running "${NAME}x"; then bad "★다른 이름인데 매칭됨★"; else ok "다른 이름은 매칭 안 함"; fi
if launcher_running "akemem$$"; then bad "★부분 문자열로 매칭됨★"; else ok "부분 문자열 매칭 안 함"; fi

echo "── T4: 지금 살아있는 팀원 5명이 '기동 중' 으로 잘못 잡히지 않나 ──"
# (세션이 오래 됐으므로 age >= 90 이라 기동 중이 아니어야 정상 — 고장나면 복구가 영영 안 돈다)
for m in bill steve demis dbak lui; do
  if member_booting "$m"; then bad "$m 이 '기동 중' 으로 잡힘 — 복구가 영영 안 걸린다"; else ok "$m 정상(기동 중 아님)"; fi
done

echo
[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAIL"
exit "$FAIL"

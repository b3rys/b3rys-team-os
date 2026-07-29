#!/usr/bin/env bash
# release-preflight.sh 의 ★인자 파싱★ 시험. 네트워크·gh·설정을 안 탄다(파싱 단계에서 끝난다).
#
# ★왜 이 시험이 따로 있나★ (steve 실측, 2026-07-29)
#   우회로(`--skip-approver-check`)에 '이유 필수' 가드를 넣었는데, 이유 자리가
#   ★다음 플래그를 무조건 삼켰다★:
#       --skip-approver-check --allow-main   →  reason="--allow-main" 으로 ★통과★
#   결과가 둘이고 둘 다 나쁘다:
#     ① ★이유 필수 가드가 무력화된다★ — 기록에 남는 게 이유가 아니라 플래그다
#     ② ★사용자가 준 --allow-main 이 조용히 사라진다★ — 적용도 경고도 없이
#   ★플래그 순서만 바뀌어도 걸리고, 오타가 없어도 걸린다.★
#   ★우회 경로는 이 게이트의 마지막 방어선이라 거기가 제일 튼튼해야 한다.★
set -uo pipefail
cd "$(dirname "$0")"
S=./release-preflight.sh
pass=0; fail=0

run() { RC=0; OUT="$(bash "$S" "$@" 2>&1)" || RC=$?; }
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf '  ✖ %s\n     기대=%s 실제=%s\n     출력: %s\n' "$3" "$2" "$1" "${OUT:0:120}"; fi; }
has(){ case "$OUT" in *"$1"*) echo yes;; *) echo no;; esac; }

echo "── release-preflight.sh 인자 파싱 ──"

run --mode merge --skip-approver-check --allow-main --skip-branch-protection
  ok "$RC" 1 "① ★이유 자리가 플래그를 삼키지 않는다★ (steve 실측 케이스)"
  ok "$(has 'needs a real reason')" yes "① 이유가 필요하다고 말한다"

run --mode merge --skip-approver-check
  ok "$(has 'needs a real reason')" yes "② 이유 없이 우회 불가"

run --mode merge --skip-approver-check --pr
  ok "$(has 'needs a real reason')" yes "③ 뒤에 다른 플래그가 와도 삼키지 않는다"

# ★공백만 있는 이유도 이유가 아니다★ (ames 2차): rc=0 · reason:"   " 로 통과했다.
#   ★'왜 우회했는지 기록' 이 목적인데 빈 기록이면 목적이 죽는다.★
# ★rc 만 보면 안 된다★ — 이 스크립트는 gh·설정이 없으면 ★하류에서도 rc=1★ 이라
#   가드가 죽어도 시험이 통과한다(실제로 처음에 그렇게 짰다가 뮤턴트가 안 잡혀서 알았다).
#   ★어느 이유로 실패했는지를 메시지로 확인한다.★
run --mode merge --skip-approver-check "   " --allow-main --skip-branch-protection
  ok "$(has 'needs a real reason')" yes "★③b 공백만 있는 이유는 거부★ (ames 실측)"
run --mode merge --skip-approver-check "	" --skip-branch-protection
  ok "$(has 'needs a real reason')" yes "★③c 탭만 있는 이유도 거부★"
run --mode merge --skip-approver-check "  --allow-main  " --skip-branch-protection
  ok "$(has 'needs a real reason')" yes "★③d 공백으로 감싼 플래그도 거부★ (트림 후 판정)"

run --mode bogus
  ok "$RC" 1 "④ 모르는 모드는 거부"
  ok "$(has 'invalid --mode')" yes "④ 이유를 말한다"

# ★hotfix 는 '모르는 모드' 로 뭉뚱그리지 않는다★ (하네스 실측 2026-07-29)
#   이 모드는 ★받아주는 목록에는 있는데 승인 확인부에는 없어서★ 조용히 건너뛰고 "passed" 를 찍었다.
#   지우기만 하면 쓰던 사람이 ★"오타인가?" 하고 헤맨다★ — ★무엇으로 바꿔야 하는지까지 말한다.★
run --mode hotfix
  ok "$RC" 1 "★④b --mode hotfix 는 거부한다★ (조용한 스킵 경로였다)"
  ok "$(has 'was removed')" yes "★④b 지웠다고 말한다★"
  ok "$(has 'Use --mode merge')" yes "★④b 무엇을 쓰라고 알려준다★ (안 알려주면 못 따른다)"
  ok "$(has 'invalid --mode')" no "④b '모르는 모드' 로 뭉뚱그리지 않는다"

run --nosuchflag
  ok "$RC" 1 "⑤ 모르는 인자는 거부 — 조용히 무시하지 않는다"

run --help
  ok "$RC" 0 "⑥ --help 는 정상 종료"
  ok "$(has 'skip-approver-check')" yes "★⑦ usage 가 이유 필수를 알려준다★ (steve: 안 알려주면 못 따른다)"
  ok "$(has 'hotfix was REMOVED')" yes "★⑧ usage 가 hotfix 제거를 알려준다★"
  ok "$(has "must be this branch's own PR")" yes "★⑨ usage 가 --pr 대조를 알려준다★"

echo "  통과 $pass · 실패 $fail"
[ "$fail" = "0" ]

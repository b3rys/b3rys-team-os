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
  ok "$(has 'needs a reason')" yes "① 이유가 필요하다고 말한다"

run --mode merge --skip-approver-check
  ok "$RC" 1 "② 이유 없이 우회 불가"

run --mode merge --skip-approver-check --pr
  ok "$RC" 1 "③ 뒤에 다른 플래그가 와도 삼키지 않는다"

run --mode bogus
  ok "$RC" 1 "④ 모르는 모드는 거부"
  ok "$(has 'invalid --mode')" yes "④ 이유를 말한다"

run --nosuchflag
  ok "$RC" 1 "⑤ 모르는 인자는 거부 — 조용히 무시하지 않는다"

run --help
  ok "$RC" 0 "⑥ --help 는 정상 종료"
  ok "$(has 'skip-approver-check')" yes "★⑦ usage 가 이유 필수를 알려준다★ (steve: 안 알려주면 못 따른다)"

echo "  통과 $pass · 실패 $fail"
[ "$fail" = "0" ]

#!/usr/bin/env bash
# pr-who-approved.sh 의 시험. ★네트워크를 안 탄다★ (B3OS_REVIEWS_JSON 주입).
#
# ★이 시험이 재는 것★: "승인 0건" 과 "확인 불가" 를 구분하는가, 이름을 제대로 뽑는가,
#   그리고 ★--gate 가 실제로 막는가.★
#   되돌렸을 때 빨개지는지(뮤턴트)는 scripts/pr-who-approved.mutants.sh 가 확인한다.
set -uo pipefail
cd "$(dirname "$0")/.."
S=scripts/pr-who-approved.sh
pass=0; fail=0

run() {  # run <json> <extra-arg> → stdout, 종료코드는 $RC
  RC=0
  OUT="$(B3OS_REVIEWS_JSON="$1" bash "$S" 999 ${2:-} 2>&1)" || RC=$?
}
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf '  ✖ %s\n     기대=%s\n     실제=%s\n' "$3" "$2" "$1"; fi; }
has(){ case "$OUT" in *"$1"*) echo yes;; *) echo no;; esac; }

A_BILL='[{"state":"APPROVED","user":{"login":"gd452"},"body":"Bill 승인합니다. head=abc"}]'
A_NONE='[{"state":"APPROVED","user":{"login":"gd452"},"body":"확인했습니다. 문제 없습니다."}]'
A_EMPTY='[{"state":"APPROVED","user":{"login":"gd452"},"body":""}]'
A_MIX="[{\"state\":\"APPROVED\",\"user\":{\"login\":\"gd452\"},\"body\":\"Steve 승인합니다\"},{\"state\":\"APPROVED\",\"user\":{\"login\":\"gdb3rys\"},\"body\":\"좋습니다\"}]"
A_CHANGES='[{"state":"CHANGES_REQUESTED","user":{"login":"gd452"},"body":"Codex 반려합니다"}]'
A_COMMENT='[{"state":"COMMENTED","user":{"login":"gd452"},"body":"Bill 코멘트"}]'

echo "── pr-who-approved.sh ──"

run "$A_BILL";    ok "$(has '★bill★')" yes "① 이름 있는 승인 → 이름을 뽑는다"
                  ok "$RC" 0           "① 종료코드 0"
run "$A_BILL" --gate; ok "$RC" 0       "② --gate 라도 이름 있으면 통과"

run "$A_NONE";    ok "$(has '이름 없음')" yes "③ 이름 없는 승인 → 표시한다"
                  ok "$RC" 0           "③ 보여주기만 하면 종료코드 0 (막지 않는다)"
run "$A_NONE" --gate; ok "$RC" 1       "④ ★--gate 면 이름 없는 승인에서 막는다★"

run "$A_EMPTY" --gate; ok "$RC" 1      "⑤ 본문이 비어도 막는다"
                  ok "$(has '본문 없음')" yes "⑤ '본문 없음' 으로 표시"

run "$A_MIX" --gate;  ok "$RC" 1       "⑥ ★하나라도 이름 없으면 막는다★ (Steve 것은 정상인데도)"
                  ok "$(has '★steve★')" yes "⑥ 정상인 것은 이름을 그대로 보여준다"

run '[]';         ok "$(has '승인 0건')" yes "⑦ 승인 0건 — '확인 불가' 와 구분해서 말한다"
run '[]' --gate;  ok "$RC" 1           "⑦ 승인 0건도 --gate 면 막는다"

run "$A_CHANGES"; ok "$(has '승인 0건')" yes "⑧ 반려(CHANGES_REQUESTED)는 승인이 아니다"
run "$A_COMMENT"; ok "$(has '승인 0건')" yes "⑨ 코멘트는 승인이 아니다 — 이름이 있어도"

# ★깨진 입력을 '승인 없음' 으로 삼키지 않는다★ — 모르는 것을 정상으로 만들면 안 된다
run 'not json';   ok "$RC" 2           "⑩ ★깨진 응답 → 종료코드 2(확인 불가)★, 0 도 1 도 아니다"
                  ok "$(has '해석하지 못했습니다')" yes "⑩ 이유를 말한다"
run '{"oops":1}'; ok "$RC" 2           "⑪ 배열이 아닌 응답도 확인 불가"

echo "  통과 $pass · 실패 $fail"
[ "$fail" = "0" ]

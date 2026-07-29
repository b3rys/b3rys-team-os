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

run "$A_NONE";    ok "$(has '★모름★')" yes "③ 이름 없는 승인 → '모름' 으로 표시한다"
                  ok "$RC" 0           "③ 보여주기만 하면 종료코드 0 (막지 않는다)"
run "$A_NONE" --gate; ok "$RC" 1       "④ ★--gate 면 이름 없는 승인에서 막는다★"

run "$A_EMPTY" --gate; ok "$RC" 1      "⑤ 본문이 비어도 막는다"
                  ok "$(has '(본문 없음)')" yes "⑤ '본문 없음' 으로 표시"

run "$A_MIX" --gate;  ok "$RC" 1       "⑥ ★하나라도 이름 없으면 막는다★ (Steve 것은 정상인데도)"
                  ok "$(has '★steve★')" yes "⑥ 정상인 것은 이름을 그대로 보여준다"

# ─────────────────────────────────────────────────────────────────────────────
# ★서명 vs 언급 — 리뷰 3인(steve·ames·demis)이 독립적으로 같은 결함을 냈다★
#
#   이전 판은 `next((m for m in members if ...))` 라 ★MEMBERS 목록 순서★ 로 첫 히트를 골랐다.
#   글에서 누가 먼저 나왔는지와 ★무관★ 했고, 목록 첫 항목이 `bill` 이었다
#   → ★내 이름이 언급된 승인은 전부 나로 찍혔다.★
#   ★이 도구가 막으려던 사고(누가 봤는지 오판)를 도구 자신이 재생산한다.★
#
#   그래서 ★서명 문법 2개만★ 신뢰한다: `<이름> 승인…` / `리뷰어: <이름>`.
#   ★애매하면 사람을 지목하지 않는다★ — 추측해서 지목하는 것이 제일 나쁘다.
sig(){ echo "[{\"state\":\"APPROVED\",\"user\":{\"login\":\"gd452\"},\"body\":$1}]"; }

run "$(sig '"Steve 가 지적한 대로 수정됐습니다."')" --gate
  ok "$RC" 1 "⑫ ★언급만 있는 것을 승인자로 지목하지 않는다★ (ames 반례)"
  ok "$(has '★steve★')" no "⑫ steve 로 찍히지 않는다"

run "$(sig '"Steve 가 지적한 대로 수정됐습니다. Demis 승인합니다."')" --gate
  ok "$RC" 1 "⑬ ★형식을 안 지킨 승인은 '모름' 이다★ — 추측해서 Demis 라고 하지 않는다 (ames)"
  ok "$(has '★steve★')" no "⑬ ★특히 steve 로 찍히면 안 된다★ (실제 승인자는 Demis)"

run "$(sig '"Bill 지적대로 반영했습니다. Steve 승인합니다."')" --gate
  ok "$RC" 1 "⑭ ★목록 첫 항목(bill)으로 새지 않는다★ (steve 반례)"
  ok "$(has '★bill★')" no "⑭ bill 로 찍히지 않는다"

run "$(sig '"Demis 가 지적한 것을 Bill 이 반영했다 — 승인합니다"')" --gate
  ok "$(has '★bill★')" no "⑮ ★글 순서와도 목록 순서와도 무관하게, 서명이 아니면 지목 안 한다★ (demis 반례)"

run "$(sig '"PM 리뷰 완료. 머지해도 됩니다."')" --gate
  ok "$RC" 1 "⑯ ★역할어(PM)를 사람으로 잡지 않는다★ — 사전에서 뺐다"
run "$(sig '"GD 승인 후 머지하겠습니다."')" --gate
  ok "$RC" 1 "⑰ ★'GD 승인 후' 는 예고지 승인이 아니다★ — gd 도 사전에서 뺐다"

# ★반대 방향 — 정당한 서명은 반드시 통과해야 한다.★ 아니면 도구가 상시 빨간불이 된다.
run "$(sig '"스티브 승인합니다."')"
  ok "$(has '★steve★')" yes "⑱ ★한글 별칭★ 을 알아본다 (steve 지적: 없으면 한글 승인이 전부 '이름 없음')"
run "$(sig '"리뷰어: Demis (gd452 는 공용 계정이라...)"')"
  ok "$(has '★demis★')" yes "⑲ ★'리뷰어: <이름>' 형식★ — Demis 가 #116 에서 실제로 쓴 형식 (ames)"
run "$(sig '"**Bill 승인합니다.** (head d408deb)"')"
  ok "$(has '★bill★')" yes "⑳ 마크다운 장식을 벗긴다 — #117 실제 본문"
# ★이 시험은 뒤집혔다 (하네스 실측)★
#   처음엔 '인용(>)도 장식이니 벗긴다' 를 옳다고 봤다. ★틀렸다.★
#   '> Steve 승인합니다' 는 ★남의 승인을 인용★ 한 것이라, 벗기면 내 서명과 구분이 안 된다.
#   ★장식과 인용은 다르다★ — 인용줄은 서명 후보에서 통째로 뺀다.
run "$(sig '"> Bill 승인합니다"')" --gate
  ok "$RC" 1 "㉑ ★인용줄은 서명이 아니다★ — 남의 승인을 인용한 것일 수 있다"
  ok "$(has '★bill★')" no "㉑ bill 로 찍히지 않는다"

# ★㉑ 만으로는 '인용줄 건너뛰기' 를 안 재고 있었다★ (뮤턴트로 발견):
#   건너뛰기를 지워도 '> Bill…' 은 여전히 모름이다(장식 벗기기에 '>' 가 없어서).
#   ★건너뛰기가 실제로 일하는 곳은 "인용줄 다음에 진짜 서명이 오는" 경우★ 다.
run "$(sig '"> Steve 승인합니다\\nBill 승인합니다"')"
  ok "$(has '★bill★')" yes "㉑b ★인용줄을 건너뛰고 다음 줄의 진짜 서명을 찾는다★"
  ok "$(has '★steve★')" no "㉑b 인용된 남의 승인을 승인자로 삼지 않는다"

# ─────────────────────────────────────────────────────────────────────────────
# ★하네스가 찾은 것들 — 앵커를 좁히고, 판정 실패를 통과로 삼지 않는다★
run "$(sig '"- Bill 승인 필요\\n- 테스트 통과"')" --gate
  ok "$RC" 1 "㉔ ★'승인 필요' 는 승인이 아니다★ — 할일 불릿이 서명으로 승격되던 것"
run "$(sig '"Bill 의 승인 이후 머지합니다"')" --gate
  ok "$RC" 1 "㉕ ★'…의 승인 이후' 는 남의 승인 이야기다★"
run "$(sig '"Bill 은 승인 안 했지만 급해서 머지"')" --gate
  ok "$RC" 1 "㉖ ★부정문을 승인으로 읽지 않는다★"
run "$(sig '"Bill 이 준 SHA 기준 lgtm"')" --gate
  ok "$RC" 1 "㉗ ★PR#84 실물 어순★ — 남이 준 SHA 를 언급한 것이지 Bill 의 서명이 아니다"

# ★반대 방향 — 실제로 쓰는 서명은 통과해야 한다(안 그러면 상시 빨간불)★
run "$(sig '"Bill이 승인합니다"')"
  ok "$(has '★bill★')" yes "㉘ ★조사가 붙은 자연스러운 어순★ — 이게 막히면 도구가 못 쓰인다"
run "$(sig '"Codex 재검증 완료 — 이전 CHANGES_REQUESTED 해소, APPROVE."')"
  ok "$(has '★codex★')" yes "㉙ ★'재검증 완료'★ — Codex 가 실제로 쓰는 서명 형식 (PR#69·#74)"

# ★승인 뒤 철회를 본다★ — GitHub 은 나중 것을 따르는데 이전 판은 '승인함' 이라 답했다
A_WITHDRAW='[{"state":"APPROVED","user":{"login":"gd452"},"body":"Bill 승인합니다","submitted_at":"2026-07-01T00:00:00Z"},{"state":"CHANGES_REQUESTED","user":{"login":"gd452"},"body":"Bill 철회합니다","submitted_at":"2026-07-05T00:00:00Z"}]'
run "$A_WITHDRAW" --gate
  ok "$(has '승인 0건')" yes "㉚ ★나중 CHANGES_REQUESTED 가 앞선 승인을 무효화한다★"

# ★인자 파싱 — 게이트를 끄는 데 오타 하나면 안 된다★
run "$A_NONE" "--Gate";   ok "$RC" 2 "㉛ ★--Gate(대문자)를 조용히 무시하지 않는다★"
run "$A_NONE" "--gate=1"; ok "$RC" 2 "㉜ --gate=1 도 오류로 거부"
run "$A_NONE" "-gate";    ok "$RC" 2 "㉝ -gate 도 오류로 거부"

# ★★가장 중요한 가드 — 판정이 안 일어났으면 '통과' 가 아니라 '확인 불가' 다★★
#   `set -e` 가 없어서, 판정기가 죽으면 RESULT 가 빈 문자열이 되고 루프가 한 번도 안 돌아
#   ★UNKNOWN 이 0 인 채 exit 0 — 게이트가 조용히 통과★ 했다(하네스 발견).
#   ★검증이 0건 일어났는데 초록불★ — 이 스크립트가 막겠다고 선언한 바로 그 실패 방식이다.
RC=0; OUT="$(B3OS_REVIEWS_JSON="$A_NONE" B3OS_PYTHON=/usr/bin/false bash "$S" 999 --gate 2>&1)" || RC=$?
  ok "$RC" 2 "㉞ ★판정기가 죽으면 exit 2(확인 불가)★ — 0 이면 검증 0건인데 통과한 것"
  ok "$(has '판정이 실행되지')" yes "㉞ 이유를 말한다"
RC=0; OUT="$(B3OS_REVIEWS_JSON="$A_BILL" B3OS_PYTHON=/usr/bin/false bash "$S" 999 2>&1)" || RC=$?
  ok "$RC" 2 "㉟ --gate 없이도 확인 불가는 확인 불가다"

# ★이스케이프된 개행 — #103 실측 (steve)★
#   본문에 진짜 개행 대신 `\n` 두 글자가 오면 split 이 안 쪼개서 first = ★본문 전체★ 가 된다.
#   그러면 본문 어디의 이름이든 잡힌다. 실제로 승인자가 hermes 인데 bill 로 찍혔다.
run "$(sig '"Hermes 승인합니다.\\n\\n확인: Bill 이 알려준 경로로 재현했습니다."')"
  ok "$(has '★hermes★')" yes "㉒ ★이스케이프 개행을 정규화한다★ — #103 승인자는 hermes"
  ok "$(has '★bill★')" no  "㉒ ★본문 속 bill 로 새지 않는다★"

# ★위 ㉒ 만으로는 정규화를 안 재고 있었다★ (뮤턴트로 발견 — 정규화를 지워도 안 빨개졌다):
#   앵커가 줄 맨 앞이라 'Hermes…' 는 정규화가 없어도 그대로 맨 앞이다.
#   ★정규화가 실제로 필요한 것은 앞쪽에 개행이 붙은 경우★ 다.
run "$(sig '"\\nBill 승인합니다"')"
  ok "$(has '★bill★')" yes "㉓ ★앞에 이스케이프 개행이 붙어도 서명을 찾는다★ (정규화가 없으면 '모름')"

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

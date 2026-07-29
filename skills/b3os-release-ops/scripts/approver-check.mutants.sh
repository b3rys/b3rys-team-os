#!/usr/bin/env bash
# approver-check.mutants.sh — ★시험이 살아있는지★ 를 확인한다.
#
# ★왜 있나★: 시험이 전부 통과하는 것은 좋은 신호가 아니라 ★점검 신호★ 다.
#   2026-07-29 하루에 ★죽은 시험을 두 번★ 짰다 — 한 번은 대상 호출 규약을 짐작해서
#   대상이 실행조차 안 됐고(뮤턴트까지 전부 초록), 한 번은 변이가 파일을 아예 안 바꿨는데
#   화면엔 "실패 0건" 으로 나와 ★'가드에 시험이 없다' 와 똑같이 보였다.★
#
#   ★그래서 이 스크립트는 '변이가 실제로 걸렸는지' 를 먼저 확인하고,★
#   ★안 걸렸으면 그 자체를 오류로 낸다.★ '안 걸린 것' 과 '안 잡힌 것' 은 다른 문제다.
#
# 사용: bash skills/b3os-release-ops/scripts/approver-check.mutants.sh
set -uo pipefail
cd "$(dirname "$0")"
S=approver-check.py
T=approver-check.test.py
ORIG="$(mktemp)"; cp "$S" "$ORIG"; trap 'cp "$ORIG" "$S"; rm -f "$ORIG"' EXIT
bad=0

mutate() {  # mutate <설명> <찾을 문자열> <바꿀 문자열>
  local desc="$1"
  if ! MUT_FROM="$2" MUT_TO="$3" python3 - "$S" <<'PY'
import os, sys
p = sys.argv[1]; s = open(p).read()
f, t = os.environ["MUT_FROM"], os.environ["MUT_TO"]
if f not in s:   sys.exit(3)        # ★못 찾았다 = 변이 미적용★ — 조용히 넘어가면 안 된다
if s.count(f) != 1: sys.exit(4)     # 여러 곳이면 무엇을 바꿨는지 불분명하다
open(p, "w").write(s.replace(f, t, 1))
PY
  then
    printf '  %-46s → ★✖ 변이가 안 걸렸다 — 시험 결과가 아니라 이 스크립트가 낡은 것★\n' "$desc"
    bad=$((bad+1)); cp "$ORIG" "$S"; return
  fi
  local fails
  fails="$(python3 "$T" 2>&1 | tail -1 | sed -n 's/.*실패 \([0-9]*\).*/\1/p')"
  printf '  %-46s → 실패 %s건' "$desc" "${fails:-?}"
  if [ "${fails:-0}" = "0" ]; then printf '   ★✖ 이 가드는 시험이 없다★'; bad=$((bad+1)); fi
  printf '\n'
  cp "$ORIG" "$S"
}

echo "── 뮤턴트: 되돌리면 빨개져야 그 시험이 살아있다 ──"

mutate "① ★줄 전체 앵커를 버리고 아무 데나 매칭★" \
  'TRAILER = re.compile(r"^approved-by[ \t]*:[ \t]*([A-Za-z0-9._-]+)[ \t]*$", re.I | re.M)' \
  'TRAILER = re.compile(r"approved-by[ \t]*:[ \t]*([A-Za-z0-9._-]+)", re.I | re.M)'

mutate "② 시간순 접기 제거 (철회를 못 봄)" \
  '    ordered = sorted(
        [r for r in reviews if isinstance(r, dict)],
        key=lambda r: r.get("submitted_at") or "",
    )' \
  '    ordered = [r for r in reviews if isinstance(r, dict)]'

mutate "③ 명부 대조 제거" \
  '        if names[0] not in pool:' \
  '        if False:'

mutate "④ ★작성자 계정 검사 제거 (#119 증상)★" \
  '    if author.lower() != team.lower():' \
  '    if False:'

mutate "④b ★작성자 조회 실패를 통과시킴 (ames BLOCKER)★" \
  '    if not author:' \
  '    if False:'

mutate "⑤ ★승인 자격 제거 (아무 계정의 승인이나 인정)★" \
  '    mine = [(a, r) for a, r in approvals if a.lower() == appr.lower()]' \
  '    mine = list(approvals)'

mutate "⑥ ★설정 누락 검사 제거 (기본값으로 때움)★" \
  '    if missing:' \
  '    if False:'

mutate "⑦ ★배열 아닌 응답을 '승인 없음' 으로 삼킴★" \
  '    if not isinstance(reviews, list):' \
  '    if False:'

mutate "⑧ ★중복 서명 검사 제거★" \
  '        if len(attempts) > 1:' \
  '        if False:'

mutate "⑨ ★마지막 줄 제한을 버리고 아무 줄이나 허용★ (예시가 서명이 됨)" \
  '    for line in reversed(body.replace("\r\n", "\n").split("\n")):' \
  '    for line in body.replace("\r\n", "\n").split("\n"):'

# ══ 2026-07-29 하네스 실측으로 넣은 가드들 — ★이것도 되돌려서 빨개지는지 본다★ ══
mutate "⑩ ★안 닫힌 펜스를 통과시킴★ (화면엔 예시, 원문엔 서명)" \
  '    if fence is not None:
        return "", ("the approval body opens a code fence' \
  '    if False:
        return "", ("the approval body opens a code fence'

mutate "⑪ ★안 닫힌 주석을 통과시킴★ (화면에서 사라지는 서명)" \
  '    if in_comment:
        return "", ("the approval body opens an HTML comment' \
  '    if False:
        return "", ("the approval body opens an HTML comment'

mutate "⑫ ★차단 사유를 무시하고 진행★ (가드 호출 자체를 무력화)" \
  '        if why:
            return False, why' \
  '        if False:
            return False, why'

mutate "⑬ ★중복 세기를 다시 엄격 정규식으로★ (백슬래시 우회 부활)" \
  '        attempts = LOOSE_TRAILER.findall(candidate)' \
  '        attempts = TRAILER.findall(candidate)'

mutate "⑭ ★화면 기준 대신 원문을 그대로 씀★ (예시가 다시 서명이 된다)" \
  '        candidate, why = visible_text(body)' \
  '        candidate, why = body, ""'

mutate "⑮ ★계정 대조를 다시 대소문자 구분으로★" \
  '    mine = [(a, r) for a, r in approvals if a.lower() == appr.lower()]' \
  '    mine = [(a, r) for a, r in approvals if a == appr]'

mutate "⑯ ★'승인 없음' 원인 구분 제거★ (셋이 같은 말)" \
  '    if last == "DISMISSED":' \
  '    if False:'

# ══ 2차 리뷰 반영분 — ★통합 스캐너의 각 판단★ ══
# ★주의: 설명·문자열에 백틱을 쓰지 마라.★ 큰따옴표 안의 백틱은 셸이 ★명령으로 실행★ 해서
#   이 스크립트가 문법 오류로 죽는다(여기서 실제로 한 번 죽였다). 펜스는 '펜스' 라고 쓴다.
mutate "⑰ ★펜스 문자 구분 제거★ (백틱 펜스를 물결 펜스로 닫히게 — codex BLOCKER)" \
  '            if re.match(r"^ {0,3}" + re.escape(fence[0]) + "{" + str(fence[1]) + r",}[ \t]*$", line):' \
  '            if re.match(r"^ {0,3}(?:" + chr(96) + "{3,}|~{3,})[ \t]*$", line):'

mutate "⑱ ★펜스 길이 조건 제거★ (긴 펜스를 짧은 펜스로 닫히게 — codex BLOCKER)" \
  '+ "{" + str(fence[1]) + r",}[ \t]*$"' \
  '+ "{3,}[ \t]*$"'

# ⑲ ★펜스 정규식의 '들여쓰기 3칸 제한' 은 이제 뮤턴트로 못 잰다 — 그래서 안 넣는다.★
#   ★들여쓴 코드블록을 먼저 걷어내는 가드(㉘)가 그 줄을 이미 건너뛴다.★ 제한을 풀어도
#   그 줄이 펜스 판정에 도달하지 못해 ★결과가 안 바뀐다.★
#   ★가드 둘이 같은 것을 덮으면 변이가 결과를 못 바꾸고, 그건 '시험이 없다' 와 구분이 안 된다.★
#   (동작 자체는 ㉘ 이 덮는다 — 앞선 건너뛰기를 지우면 빨개진다)

mutate "⑳ ★주석을 왼쪽부터 훑지 않고 개수로 판정★ (고아 닫는 토큰이 상쇄 — codex·hermes BLOCKER)" \
  '            line = line[:a]                           # 여기서부터 안 보인다
            in_comment = True' \
  '            line = line[:a]                           # 여기서부터 안 보인다
            in_comment = body.count("<!--") > body.count("-->")'

mutate "㉑ ★펜스와 주석을 한 번에 훑지 않음★ (펜스 안 토큰이 주석을 연다 — hermes·steve)" \
  '            continue                                  # 펜스 안은 통째로 예시다' \
  '            pass'

mutate "㉒ ★코드 스팬 가림막을 안 씀★ (코드 안 토큰 언급이 막힘 — steve)" \
  '        probe, span = blank_code_spans(line, span)' \
  '        probe, span = line, span'

mutate "㉓ ★가림막이 아니라 본문을 지움★ (화면에 없는 서명을 만들어냄 — demis 3차)" \
  '                line = line[:a] + line[b + 3:]        # 한 줄 안에서 닫혔다
                probe = probe[:a] + probe[b + 3:]' \
  '                line = probe[:a] + probe[b + 3:]
                probe = probe[:a] + probe[b + 3:]'

mutate "㉘ ★들여쓴 코드블록을 주석보다 늦게 걷어냄★ (코드 안 토큰이 주석을 염 — codex 3차)" \
  '        elif span == 0 and re.match(r"^ {4,}' \
  '        elif False and re.match(r"^ {4,}'

# ㉓ ★'인라인 코드가 줄을 넘는다' 는 이제 뮤턴트로 못 잰다 — 그래서 안 넣는다.★
#   예전엔 정규식 플래그(re.S)가 막았지만, 지금은 ★스캐너가 한 줄씩 처리하는 구조★ 가 막는다.
#   즉 플래그를 되돌려도 sub() 에 들어가는 문자열이 한 줄이라 ★결과가 안 바뀐다.★
#   ★변이가 결과를 못 바꾸는 자리에 뮤턴트를 두면 '가드에 시험이 없다' 와 구분이 안 된다.★
#   (그 경로 자체는 ㉒ 가 덮는다 — 인라인 코드 제거를 통째로 지우면 빨개진다)

mutate "㉔ ★인용줄을 중복으로 셈★ (남의 서명을 인용하면 막힘 — 내 하네스)" \
  '        if re.match(r"^ {0,3}>", line):               # ★인용줄★ — 남의 서명을 인용한 것이다
            continue' \
  '        if False:
            continue'

# ㉕ 는 ㉘ 로 대체됐다 — 들여쓴 코드블록 처리가 주석보다 앞으로 옮겨가 대상 줄이 사라졌다.

mutate "㉖ ★목록 표시가 붙은 서명을 중복으로 안 셈★ (두 이름이 통과 — 내 하네스)" \
  'LOOSE_TRAILER = re.compile(r"^[ \t*_`#+\-　]*(?:\d+[.)][ \t]*)?approved-by[ \t]*:", re.I | re.M)' \
  'LOOSE_TRAILER = re.compile(r"^[ \t*_`#\-]*approved-by[ \t]*:", re.I | re.M)'

mutate "㉗ ★원인 판정에 남의 계정 상태를 섞음★ (틀린 원인을 단언 — 내 하네스)" \
  '                       if ((r.get("user") or {}).get("login") or "").lower() == appr.lower()' \
  '                       if True'

echo
if [ "$bad" = "0" ]; then
  echo "  ✓ 뮤턴트 전부 잡힘 — 시험이 살아 있다"
else
  echo "  ★✖ 문제 ${bad}건 — '변이가 안 걸렸다' 와 '시험이 없다' 는 다른 문제다.★" >&2
  exit 1
fi

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
mutate "⑩ ★안 닫힌 코드펜스 검사 제거★ (화면엔 예시, 원문엔 서명)" \
  '    if len(re.findall(r"^[ \t]*(?:```|~~~)", body, re.M)) % 2:' \
  '    if False:'

mutate "⑪ ★안 닫힌 HTML 주석 검사 제거★ (화면에서 사라지는 서명)" \
  '    if body.count("<!--") != body.count("-->"):' \
  '    if False:'

mutate "⑫ ★모호한 마크업이어도 그냥 진행★ (가드 호출 자체를 무력화)" \
  '        if bad:
            return False, why' \
  '        if False:
            return False, why'

mutate "⑬ ★중복 세기를 다시 엄격 정규식으로★ (백슬래시 우회 부활)" \
  '        attempts = LOOSE_TRAILER.findall(candidate)' \
  '        attempts = TRAILER.findall(candidate)'

mutate "⑭ ★예시 제거를 안 함★ (규약 문서 인용이 다시 막힘)" \
  '        candidate = strip_examples(body)' \
  '        candidate = body'

mutate "⑮ ★계정 대조를 다시 대소문자 구분으로★" \
  '    mine = [(a, r) for a, r in approvals if a.lower() == appr.lower()]' \
  '    mine = [(a, r) for a, r in approvals if a == appr]'

mutate "⑯ ★'승인 없음' 원인 구분 제거★ (셋이 같은 말)" \
  '    if any(s == "DISMISSED" for s in final_states):' \
  '    if False:'

echo
if [ "$bad" = "0" ]; then
  echo "  ✓ 뮤턴트 전부 잡힘 — 시험이 살아 있다"
else
  echo "  ★✖ 문제 ${bad}건 — '변이가 안 걸렸다' 와 '시험이 없다' 는 다른 문제다.★" >&2
  exit 1
fi

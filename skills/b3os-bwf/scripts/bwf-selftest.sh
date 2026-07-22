#!/usr/bin/env bash
# b3os-bwf self-test — 런타임 중립(claude/openclaw/hermes 어디서든 실행).
# 1층(로딩 테스트, 자동): BWF + 연계 스킬 + TEAM-OS thin 정의 발견 가능한가.
# 3층(퍼블릭 self-test, 출력): 골든태스크 절차 + 단계 산출물 체크리스트 + rubric.
# 종료코드 0 = 로딩 OK. 비-0 = 발견 실패(어느 게 빠졌는지 표시).
set -u

# repo 루트 추정(스킬 위치 기준 — 라이브/퍼블릭 클론 양쪽 동작)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"   # skills/b3os-bwf/scripts → repo root

fail=0
chk() { # chk <설명> <경로>
  if [ -e "$2" ]; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s  (없음: %s)\n' "$1" "$2"; fail=1; fi
}

echo "== BWF self-test :: 1층 로딩 테스트 =="
echo "repo: $ROOT"
echo "[필수 — BWF 본체]"
chk "b3os-bwf SKILL.md"            "$ROOT/skills/b3os-bwf/SKILL.md"
chk "BWF rubric"                    "$ROOT/skills/b3os-bwf/references/bwf-rubric.md"
echo "[연계 스킬 — BWF가 호출]"
chk "b3os-harness-playbook (품질방법 정본)"  "$ROOT/skills/b3os-harness-playbook/SKILL.md"
chk "b3os-task-loop (카드·guard)"   "$ROOT/skills/b3os-task-loop/SKILL.md"
chk "b3os-report (보고서)"          "$ROOT/skills/b3os-report/SKILL.md"
chk "b3os-team-inbox (버스)"        "$ROOT/skills/b3os-team-inbox/SKILL.md"
chk "b3os-team-learning-loop (학습 hook)" "$ROOT/skills/b3os-team-learning-loop/SKILL.md"
echo "[발견 경로]"
chk "스킬 인덱스 B3OS_SKILLS.md"    "$ROOT/rules/B3OS_SKILLS.md"

# TEAM-OS thin 정의(always-load) 확인 — 단순 "BWF" 언급(옛 한 줄)은 통과시키지 않는다.
# 진짜 thin def의 식별 토큰 = "BWF≠harness" 또는 스테이지(①PM계획). 없으면 '대기'(미반영)로 보고.
# 이건 스킬 자체의 fail이 아니다(claude 자동로드는 동작) — always-load 반영은 팀장 승인 대기 항목.
TEAMOS=""
for c in "$ROOT/rules/TEAM-OS.md" "$ROOT/TEAM-OS.md"; do [ -f "$c" ] && TEAMOS="$c" && break; done
if [ -n "$TEAMOS" ] && grep -qE "BWF≠harness|①PM계획|①PM 계획" "$TEAMOS"; then
  echo "  ✓ TEAM-OS에 BWF thin def(스테이지) 반영됨"
else
  echo "  ⏳ TEAM-OS thin def 미반영 (팀장 승인 대기 — TEAM-OS-INTEGRATION.md). 현재 claude 자동로드만 라이브."
fi

echo
echo "== 3층 퍼블릭 self-test :: 골든태스크 절차 (따라하기) =="
cat <<'EOF'
샘플 골든태스크(작은 수정)로 BWF 6단계가 실제로 도는지 확인:
  1) PM 계획   : 목표·완료기준을 적는다 (예: "함수 X 버그 fix, 완료=테스트 통과")
  2) 팀 배정   : owner 1명 (작은 일이면 본인)
  3) 실행+품질  : 좁은 일 → 솔로. (넓으면 harness)
  4) 검증      : 테스트/빌드 실측으로 완료기준 충족 입증
  5) 보고+카드  : 결과를 보이게 보고 (10분+면 카드)
  6) 학습 hook : 배운 것 있으면 learning-loop로

각 단계 산출물이 실제로 나왔는지 체크:
  [ ] 완료기준 문장   [ ] owner   [ ] 품질방법 선택 근거
  [ ] 검증증거(로그/테스트)   [ ] 가시 보고   [ ] (해당시) 학습 후보
EOF
echo
echo "rubric 채점표: skills/b3os-bwf/references/bwf-rubric.md"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: ✓ 로딩 OK (BWF 발견 가능)"; else echo "RESULT: ✗ 일부 미발견 — 위 ✗ 항목 확인"; fi
exit "$fail"

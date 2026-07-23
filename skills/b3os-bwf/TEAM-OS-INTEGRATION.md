# BWF → TEAM-OS 핵심룰 thin 정의 (GD 승인 대기)

> Status: Bill 초안 + Codex 교차검토 완료(2026-06-22, thread bwf-coreule-xreview-0622). **GD 승인 후 반영** — 핵심룰 변경이라 1명씩 적용·행동검증.

## 왜 always-load에 박나
GD 지시(2026-06-22): BWF를 team-os 핵심룰(always-load)에 명시 → 퍼블릭에 스킬과 같이 나가서, 받은 사람이 우리처럼 일하게. claude는 SKILL.md 자동로드지만 openclaw/hermes는 아니므로, **스킬을 못 읽어도 도는 최소 절차**가 always-load TEAM-OS에 있어야 한다(단일점 실패 대비 + 전 런타임 발견).

## 반영 위치 (Codex 교차검토 결론)
- **§4 공통 응답 규칙**의 기존 "BWF / b3os workflow 용어 정의" 줄을 **아래 thin 정의로 확장/대체**. (§4 = 모든 런타임이 먼저 보는 always-load.)
- **§10 과제 관리** 앞부분에 cross-ref 1줄: "BWF 실행 적용은 §4 정의를 따른다. 절차 상세는 `b3os-bwf` 스킬." (절차 상세는 §10·스킬로, §4엔 thin만.)

## thin 정의 (확정 압축본 — GD "핵심만" 2026-06-23, Codex 교차검토 + 칸반 자동등록 반영)

> **BWF(b3os workflow) = 팀 기본 과제 수행 흐름 (always-load 최소 정의).** GD 컨펌된 실행/위임 과제를 끝까지 닫는다. 단순 답변·조회·즉시 끝나는 일은 예외 — thread에 owner·근거만(§4/§10 "작은 일"). 6단계: ①PM계획(완료기준 먼저) + **착수 즉시 칸반 카드 등록(필수·자동 — GD가 물어서가 아니라 PM 킥오프의 기본 스텝)** ②팀배정(handoff=받는쪽 ack까지 추적, 보냄 ≠ 완료) ③실행+품질방법 ④검증(증거로, "됐다" 단정 X) ⑤보고+closure ⑥학습 hook. **PM은 단계마다 GD-visible 1줄 보고로 conti guard를 스스로 세운다 — 착수·handoff 직후(누구·무엇·ETA)·reviewer ack·gate 전이마다 보고, 무응답/blocked면 fallback. 완료 때만 보고가 아니며 실행 과제에서 침묵=실패.** BWF ≠ harness — harness·multi-ai·judge·적대적리뷰는 ③에서 고르는 품질방법(여러 실소스 동시=harness, 좁고 순차=솔로). 작업크기: 턴=솔로 / 주행=limited / 완전자율=full. 상세·rubric·트리거표 = `b3os-bwf` 스킬(스킬 못 읽어도 이 최소 절차와 예외는 TEAM-OS만으로 작동).

## 핵심 변경점 (초안 → 확정)
- **scope guard 추가** (Codex 캐치): "GD 컨펌된 실행/위임 과제에만 적용 + 단순 답변·조회는 작은 일 예외." 없으면 openclaw가 작은 질문까지 PM계획→카드로 끌고 가는 오작동(런타임별 행동 차이 — '직접 실행 폭주' 방지).
- **"보고+카드" → "보고+필요 시 카드"**: 카드가 모든 일에 필수처럼 읽혀 §10 작은 일 예외와 충돌하는 것 방지.
- **PM conti-guard cadence 추가** (GD 2026-06-23, 4888/4891 — Codex가 PM stall한 핵심 이유): "완료 때만 보고"로 오해해 그냥 기다리는 걸 막기 위해, always-load에 *단계마다 GD-visible 보고* 트리거(착수·핸드오프 직후·ack·게이트 전이·무응답 fallback)를 박는다. claude는 BWF 스킬 자동발견으로 사실상 적용되지만 openclaw/hermes는 스킬 자동로드가 없어 always-load에 없으면 안 도는 게 stall의 진짜 원인. 상세 표는 스킬, 최소 cadence는 §4 always-load. **이 delta가 6/22 교차검토 이후 추가분이라 Codex 재확인 필요(핵심룰 단독 금지).**

## 승인·적용 절차
1. GD 승인(핵심룰 변경).
2. §4 확장 + §10 cross-ref 1줄 반영.
3. 1명씩 적용 후 행동검증(특히 openclaw에서 작은 일 과잉절차 안 나는지 — scope guard 작동 확인).
4. openclaw/hermes AGENTS.md/profile에 "BWF 과제면 b3os-bwf 명시 로드" 진입점 추가(별도, 자기 토큰/세션이라 각 owner 또는 GD 게이트).

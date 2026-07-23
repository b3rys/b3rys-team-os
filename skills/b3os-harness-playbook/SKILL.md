---
name: b3os-harness-playbook
description: b3rys 팀 harness(sub agent 병렬 실행) 플레이북 — 트리거 우선. "병렬 실소스 커버 모양이면 limited harness가 기본, 그 외 솔로." 트리거 리스트 + ready-run 레시피(audit·migration·N후보) + ★구조 규약(역할분리 에이전트·프론트매터·오케스트레이터 분리·파일 산출, 실물 템플릿)★ + 7 품질패턴 + 런타임별(클로드 네이티브 Workflow / openclaw 수동 캡) + 비용 게이트. 사용 시점 — 코드 audit·다PR 리뷰·마이그레이션·멀티소스 리서치·N후보 비교·다면 교차검증·릴리즈 전 검증 등 '여러 군데 동시'가 보일 때 자동으로 이 스킬의 레시피를 집는다. Workflow/subagent fan-out 전. ※ 실행 엔진이 아니라 결정+품질 플레이북(실행은 네이티브 Workflow/Agent 툴). 에이전트+스킬 구성 메타스킬 `harness`와 다름. owner=maintainer.
---

# b3os-harness-playbook — harness 플레이북 (트리거 우선)

harness(한 팀원이 sub agent를 병렬로 띄워 일을 나눔)는 **단순작업을 제외한 기본 실행 방법**이다. 단 "무조건 병렬"이 아니라 — **"병렬 실소스 커버" 모양이면 limited harness가 기본, 그 외엔 솔로**다. 트리거 모양을 보면 아래 레시피를 집되, Q1~Q4 중 하나라도 NO면 솔로로 간다. 실행 자체는 네이티브 Workflow/Agent 툴이 한다.

> 한 줄: **맞는 모양엔 자동으로 harness, 잘 쓰게 7패턴으로 검증.** (옛 버전은 '켜기 전 통과' 게이트 우선이라 거의 안 쓰였다 — 이제 트리거 우선.)

---

## ① 트리거 — 이 모양이면 기본 harness (보면 바로 레시피)

**여러 군데(서로 다른 실제 소스)를 동시에 봐야 하는 일** = 기본 harness:

- 코드 **audit**/다영역 점검 · **다PR 리뷰** · **마이그레이션**(N곳 호출부)
- **멀티소스 리서치** · **N후보 비교**(모델·라이브러리·설계안)
- **로그·DB·코드 3면 교차검증** · **릴리즈 전 검증**(테스트·문서·구현 분리)

**솔로 유지 (harness 금지 — 노이즈·환각만 늘림):**

- 전략·개념 합성 · 단발 추론 · **단일 파일 섬세 수정**
- 한 사람의 긴 맥락을 따라야 하는 판단 · **단일 소스 리서치** · 요구 모호
- Q1 독립 분해, Q2 다른 실제 소스, Q3 비용 대비 이득, Q4 N·budget·verify 중 하나라도 NO인 작업

> 판정 한 줄: **"각 조각이 서로 다른 실제 소스를 읽나?"** YES → harness. NO(한 소스·개념합성·단일맥락) → 솔로가 더 정확·저렴.

---

## ② ready-run 레시피 (모양별 — 골라서 바로 실행)

핵심은 sub agent **수**가 아니라 **"각자 읽을 소스 + 반환 schema"를 먼저 박는 것.** 각 레시피는 owner가 마지막에 종합·검증(⑤).

- **audit**: A=라우팅/엔트리 코드 · B=DB/스키마 · C=테스트/로그 → owner: dedup + 재현 + 최종 판단.
- **migration**: A=호출부 검색 · B=타입/스키마 영향 · C=테스트 갭 → owner: 영향범위 합성 + 순서 결정.
- **N후보 비교**: 후보당 1 에이전트(같은 평가 기준표) → owner: 동일 rubric으로 비교 + 추천.
- **release-verify**: A=회귀 테스트 · B=문서 정합 · C=구현 diff → owner: gate 통과/blocker 판정.

→ 작업 카드/지시에 명시: `harness: limited|full · subagents: N · budget · scope · return-schema · verify` (`templates/harness-task-card.md`).

---

## ③ 구조 — 제대로 짜는 모양 (팀원이 하네스 짤 때 필독)

하네스는 "sub agent 여러 개"가 아니라 ★역할 분리 + 오케스트레이터 + 파일 산출★이다. 아래 6가지를 지켜야 '제대로 된' 하네스다:

1. **역할별 에이전트 분리** — 에이전트 1개 = 역할 1개(찾기·검증·종합처럼). 한 에이전트에 여러 역할을 몰지 않는다. 예: deck = 설계/작성/디자인/검증 4역할, humanize = 탐지/윤문/감사/리뷰.
2. **에이전트 프론트매터로 정의** — 각 에이전트는 `.claude/agents/<name>.md` 프론트매터로 박는다: `name · description(언제 이 에이전트를 부르나) · model · tools · isolation`. 이게 있어야 오케스트레이터가 골라 부른다. (설계는 무인 금지 — 적대 리뷰 필수.)
3. **스킬 분리** — 에이전트의 '어떻게'는 각자 스킬(SKILL.md)에 둔다. 에이전트=누가·언제, 스킬=어떻게. 새로 짤 땐 메타스킬 `harness`가 에이전트+그 에이전트용 스킬을 같이 찍어준다.
4. **오케스트레이터 분리** — 오케스트레이터는 ★일을 직접 안 한다.★ 단계 순서 + 각 단계 검증→재생성 게이트 + 종합만 맡고, 실제 일은 서브에이전트가. 예: deck-orchestrator = style-spec→outline→content→layout→render 순서 + 슬라이드별 validate→regenerate 게이트.
5. **파일로 산출** — 각 단계가 중간·최종 결과를 파일로 남긴다(스크래치패드/reports). 그래야 재개·감사·리뷰가 되고, 다음 단계가 앞 단계 ★파일을 입력으로★ 받는다. 결과가 대화창에만 있으면 하네스가 아니다.
6. **역할별 모델·추론강도 (품질 우선 배분)** — 에이전트마다 역할 난이도에 맞춰 모델을 준다. ★품질 최우선: 기본 일꾼 = Opus, 단순 작업만 Sonnet으로 내린다(GD 2026-07-20).★ 저가 티어는 당분간 미사용. 어려운 판정·반증·종합은 Opus + 높은 effort.
   - ★클로드: **Opus(기본 일꾼·어려운 역할)** / Sonnet(단순 작업: 포맷·1차 스캔·수집).★ Haiku 등 저가 티어 미사용.
   - ★codex·openclaw 등 다른 런타임은 각 급에 **준하는 동급 모델**을 고른다★ — 런타임마다 이름만 다르고 '기본(강)·단순(중)' 매핑은 같게. (특정 모델명 하드코딩 X, 급으로 지정.)
   - 지정=프론트매터 `model` 또는 Workflow `agent(…, {model, effort})`. 확신 없으면 세션 모델 상속(무분별 오버라이드 X). Workflow budget 하드캡이 이중 통제. → 기본은 Opus, 단순 반복만 Sonnet으로 절감.

★따라 짤 실물 템플릿★: `deck-orchestrator`(단계 파이프라인+슬라이드별 게이트) · `humanize`(5단계 역할 에이전트) · `deep-research`(팬아웃→수집→적대검증→종합). 새 하네스는 이 셋 중 가장 가까운 걸 골라 구조를 베낀다. ※ ②는 '무엇을 나눠 돌리나'(fan-out 모양), ③은 '그걸 어떤 구조로 짜나'다.

---

## ④ 하드 캡 + 런타임별 실행

- **cap(상한)은 목표 수가 아니라 천장**이다. 실제 N은 소스 분할 수와 검증 필요성으로 정하고, 기본은 2~3에서 시작한다.
- **limited harness = 보통 6 이하, 필요시 8까지**. **full harness = 머신캡 `min(16, logical CPU core - 2)`**(host override 가능, 보통 약 12, 절대 상한 16). **budget 상한** 명시(예: 각 ~50k 토큰, 전체 시간).
- **Claude Code 계열 에이전트 = 네이티브 Workflow 툴 우선**: `budget` 하드캡 + `schema` 강제 + `/workflows` 관측이 자동. 레시피를 Workflow 스크립트로 돌린다.
- **OpenClaw/Hermes 계열 에이전트 = subagent/session spawn**: workflow 표준 UX·자동 캡이 약하다 → 작업에 `scope · max_agents · budget · stop_rule · return_schema · owner synthesis`를 **직접 명시**해야 같은 품질·비용제어가 된다. 하나라도 없으면 harness 금지. `max_agents` 미기재 기존/모호 지시는 fallback 6으로 해석하고 무캡 실행하지 않는다. (같은 레시피, 수동 캡.)
- OpenClaw 수동 spawn 명시 cap은 6이다. 더 필요하면 full harness 또는 다른 runtime 배정을 검토하고 the team lead에게 고지한다.
- 가벼우면 인라인 Agent 2~4개도 OK. 수동 직접 spawn은 캡·스키마가 없어 토큰 폭주 위험(파일럿서 50k 캡 2배 초과 실측) — 가능하면 Workflow/명시 캡으로.

---

## ⑤ 검증 — 7 품질패턴 (병렬은 겹침·환각을 낸다, 안 하면 채택 금지)

owner가 산출물 채택 전 반드시 적용(작업 규모에 맞게 골라):

1. **adversarial verify(반증)** — 핵심 주장은 '맞다' 확인이 아니라 '틀렸다' 증명을 시도. 살아남는 것만 채택.
2. **perspective-diverse verify** — 검증자마다 다른 렌즈(정확성·보안·재현). 여러 실패유형 포착.
3. **judge panel** — N개 독립 시도를 병렬 생성·점수 → 베스트 합성(한 번 시도 반복보다 나음).
4. **loop-until-dry** — 새 발견이 안 나올 때까지(dry counter). 꼬리 케이스 포착.
5. **multi-modal sweep** — 같은 타깃을 여러 방식(문서·키워드·엔티티·시간)으로 동시 검색. 누락↓.
6. **completeness critic** — 마지막에 '뭐 빠졌나(미실행 modality·미검증 주장·미독 소스)?' 전담 검토.
7. **no silent caps** — 범위 줄였으면(top-N·샘플링) 명시. **조용한 truncation 금지**(다 본 척 X).

기본(필수): 종합·dedup 1회 + 핵심 발견 반증(1) + 근거 표시. 큰 작업이면 2~7 추가. (`references/verify-checklist.md`)

---

## ⑥ 비용 게이트 & 로깅

- **큰 fan-out·full workflow는 실행 전 the team lead 고지 + stop_rule**. 2층 harness(팀원 여러 명 × 각 N)면 **총 fan-out**을 본다. 총 동시 subagents가 8을 넘거나, 팀원 2명 이상이 동시에 돌려 총 동시 수가 10 이상이면 the team lead 고지 + stop_rule + 예상 토큰을 먼저 남긴다.
- **로깅**: 무엇을 몇 개로 fan-out했고 토큰 얼마 썼는지 남긴다(no silent caps).

---

## 근거 & 연계
- 룰: **TEAM-OS §10** harness 옵션(자율주행 매핑: 턴=off / 주행=limited 기본 / 완전자율=full).
- 파일럿: `~/Development/<workspace>/reports/harness-pilot-20260607/`. 7패턴 출처: external Workflow 품질검증 패턴.
- **파일럿(2026-06-14 #2)**: 2패턴(audit·마이그레이션) × 2런타임(클로드 Workflow / openclaw subagent). 합격 = '솔로가 놓친 실제 이슈 발견' + 중복/환각 dedup 비용 + 토큰·시간 상한 준수(속도 아님).
- 살아있는 스킬 — 사례 쌓이면 트리거·레시피·검증 기준 강화(§11 팀 스킬).

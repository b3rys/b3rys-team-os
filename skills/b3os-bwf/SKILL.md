---
name: b3os-bwf
description: b3rys 팀 기본 과제 수행 워크플로우(b3os workflow). 과제를 받으면 PM계획→팀배정→실행+품질방법→검증→보고+카드→학습hook 순으로 끝까지 끌고 가는 단일 진입점(stage router). BWF는 harness가 아니다 — harness/multi-ai/judge panel/적대적리뷰는 BWF 안에서 고르는 '품질방법'이다. 과제·프로젝트·구현·리서치·리뷰·릴리즈 등 실행이 필요한 일이면 이 흐름을 기본으로 쓴다. 얇은 오케스트레이터 — 실제 도구는 하위 스킬(task-loop·harness·report·team-inbox·learning-loop) 참조. 전 런타임(claude/openclaw/hermes). owner=maintainer.
---

# b3os-bwf — 기본 과제 수행 워크플로우 (stage router)

**BWF(b3os workflow)는 harness가 아니다.** b3rys 팀이 과제를 받아 끝까지 수행하는 **기본 흐름**이다. harness·multi-ai review·judge panel·적대적 리뷰는 이 흐름의 한 단계에서 고르는 **품질방법**일 뿐이다. (이 구분을 먼저 박는다 — 과거 "BWF=harness" 오해 방지.)

이 스킬은 **얇은 라우터**다. 각 단계는 "무엇을·어떻게 고르나"만 짧게 두고, 실제 실행은 하위 스킬을 참조한다(복붙 금지 — 정본은 각 스킬).

> 한 줄: **실행 과제는 이 6단계로. 작은 일은 가볍게, 큰 일은 풀 루프. 끝나지 않은 일이 조용히 사라지지 않게.**

**적용 범위(scope guard — 먼저 읽기)**: BWF는 **the team lead 컨펌을 받은 팀 실행 과제·위임 과제**에 적용한다. 단순 답변·가벼운 조회·의견·즉시 끝나는 국소 작업에는 풀 절차를 강제하지 않는다 — TEAM-OS §4/§10 "작은 일" 기준대로 thread에 owner·근거만 남기면 충분하다. (이걸 안 박으면 openclaw 런타임에서 작은 질문까지 PM계획→카드로 끌려간다 — cross-runtime review 2026-06-22.)

---

## 0. 모드 판단 (시작)

- **턴모드**: 한 번 묻고 한 번 답하는 대화·검토. (열린 과제 = 범위·완료기준을 새로 정해야 함 → 계획·확인 먼저, 산출물 생성은 컨펌 후.)
- **주행모드(실행 기본)**: the team lead 컨펌으로 실행 시작된 과제. `다음 액션·재개 시각·fallback·stop_rule` 남기고 완료/blocked/컨펌대기까지 들고 감.
- **완전자율모드**: 기획~검증~보고까지 넓게 위임. 범위·권한·stop_rule 더 명확히.

판정: "내가 범위·형식·완료기준을 새로 발명해야 하나?" YES=열린 과제(계획 먼저) / NO=명확한 지시(바로).

---

## 1~6. 스테이지 (실행 루프)

```
1. PM 계획     목표 / 비목표 / 완료기준(rubric)을 먼저. owner 결정.
               역할 밖 실행과제면 PM 전환 — 직접 다 하지 말고 적임자에 위임.
               ★착수(the team lead 컨펌) 즉시 칸반 카드 등록(필수·자동) — 누가 물어서가
                아니라 PM 킥오프 기본 스텝. reminder 의존 금지.
2. 팀 배정     owner · ETA · 검증자. handoff = 받는쪽 ack/거절/ETA 확인까지 추적
               (보냄 ≠ 수신확인). → b3os-team-inbox(reply.sh·thread.sh)
3. 실행 + 품질  작업모양 → 품질방법 선택(아래 표). 작업크기 게이팅:
               턴=솔로 / 주행=limited harness / 완전자율=full harness.
4. 검증        완료기준(rubric) 대조 + 검증증거(테스트·빌드·실측). "됐다" 단정 금지.
               중요 릴리즈/공개 = 팀원리뷰 + 하네스 다차원 (TEAM-OS §4, 무조건).
5. 보고 + 카드  the team lead에게 실제 보이는 보고(생성 ≠ 보임) + 칸반 갱신. closure까지 owner가.
               → b3os-task-loop(카드·guard 필드) · b3os-report(보고서)
6. 학습 hook   교훈·재발사례 → learning-loop 입력으로. (합치지 않고 넘김.)
               → b3os-team-learning-loop
```

작은 일(즉시 끝남)은 1·4·5만 thread에 가볍게. 10분+·handoff·배포·대기/재개가 생기면 카드 + 풀 루프.

## ★ PM 루프 — status cadence (트리거→액션, 외워서 따라 한다)

PM의 핵심 = **단계마다 상황파악 → the team lead에게 보이는 보고**. "보고해라"(추상)로는 안 됨 — 아래 트리거가 오면 *반사적으로* 1줄 쏜다. (stall의 흔한 이유 = "완료될 때 보고"로 오해해 그냥 기다림.)

| 트리거(이게 일어나면) | 액션(즉시) |
|---|---|
| 착수 | the team lead에 1줄 — 목표·owner·stop_rule |
| **핸드오프 보낸 직후** | the team lead에 **ack+ETA 1줄** (누구에게·무엇·언제까지) |
| **리뷰어/담당자 ack 받음** | the team lead에 보고 (**보냄 ≠ done** — ack까지 추적, ack 전 "넘김"으로 안 닫음) |
| **게이트 전이마다** (peer→pm→team_lead_report 등) | **the team lead에게 보이는 1줄** |
| 10~15분 무응답 / 30분+ blocked | 원인·옵션·추천 + fallback으로 진행 (**무한 침묵대기 금지**) |
| 최종 | 결과·변경파일·검증·잔여리스크·다음 |

**핵심**: 침묵은 실패로 읽힌다 — 대기 중에도 the team lead에겐 보여야. 수집형은 **2박자**(팬아웃 직후 1줄[받음+모으는중+ETA] + 결과/timeout 시 종합 1회). 단 응답자↔수집자 사이는 조용히 모으고(ack 도배 X), 수집자↔the team lead 사이는 안 기다리게(visible). = PM이 "단계마다 상황파악→the team lead 보고"의 conti guard를 *스스로* 세우는 것. (시스템 백스톱 = stale-proposal worker·task continuation guard가 멈춤 감지→owner wake→the team lead에게 보이는 에스컬레이션.)

병렬(harness)이면 **contract-first**(라우트·요청/응답·DB필드·파일 owner 경계를 코드 전에) — 상세는 b3os-harness-playbook.

**병렬 충돌 방지(project-loop 흡수)**: ①구현자는 **검증한 것 / 안 한 것**을 명시한다(unverified scope 숨기지 않기). ②**같은 공유파일 동시 편집 금지** — PM이 순서를 명시 지정할 때만. ③파일 owner 경계 깨끗이(한 에이전트=한 영역).

---

## 품질방법 카탈로그 (3단계에서 고름 — 라우팅만, 정본은 각 스킬)

| 작업 모양 | 품질방법 | 정본 |
|---|---|---|
| 좁고 순차·단일맥락·개념합성 | **솔로** | — |
| 여러 실제 소스 동시(audit·다PR·마이그레이션·N후보·멀티소스 리서치) | **harness(병렬)** | `b3os-harness-playbook` |
| 결함이 치명적·되돌리기 어려움 | **적대적 리뷰(반증)** | `b3os-harness-playbook` 7패턴 |
| 중요 설계·빌드 결정 | **multi-ai review** | `gd-multi-ai-review` |
| 후보·판정 비교 | **judge panel** | `b3os-harness-playbook` 7패턴 |
| 릴리즈/공개 전 | **팀원리뷰 + 하네스 다차원** | TEAM-OS §4 + `b3os-harness-playbook` |

판정 한 줄: **"각 조각이 서로 다른 실제 소스를 읽나?" YES→harness, NO→솔로.**
품질방법은 '켜기'보다 '맞게 쓰기'가 중요 — rubric/완료기준 없이 judge panel·적대적리뷰 돌리면 형식만 돈다(4단계의 완료기준이 선행).

---

## 런타임별 사용 (claude만 자동 ≠ 전원)

- **claude 런타임 팀원**: 이 SKILL.md 자동 발견. 하위 스킬도 자동.
- **openclaw·hermes 런타임 팀원**: SKILL.md 자동로드가 없을 수 있다 → BWF 과제면 이 스킬을 **명시 로드**한다(경로 = `<repo>/skills/b3os-bwf/SKILL.md`). 카탈로그는 `docs/B3OS_SKILLS.md`에서 발견. 핵심 단계는 위 6줄 표를 ready-run으로 바로 따라 실행.
- **TEAM-OS 핵심룰**에 BWF thin 정의(스테이지 + "BWF≠harness" + 품질 트리거)를 always-load로 **박을 예정**(초안=`TEAM-OS-INTEGRATION.md`, the team lead 승인 대기). 반영되면 스킬을 못 읽어도 최소 절차가 돈다.
- 실행 도구는 런타임중립 스크립트(`scripts/`)라 어디서든 직접 실행 가능.

> **현재 상태(정직)**: claude 런타임 자동로드만 라이브다. openclaw/hermes의 always-load thin 정의 + AGENTS.md 진입점은 **the team lead 승인 후 반영 예정** — 그 전까지는 위 "명시 로드"로 써야 한다. (이 줄을 사실로 단정하지 않는다.)

---

## 자가 점검 (rubric) — "BWF를 제대로 돌렸나"

`references/bwf-rubric.md`. 매 과제 자가 채점 + 팀원 학습 평가 + 퍼블릭 self-test에 같은 기준 재사용:
- [ ] 완료기준을 실행 전에 정했나
- [ ] 작업모양에 맞는 품질방법을 골랐나
- [ ] 카드화/추적했나(10분+·handoff·배포)
- [ ] 검증증거로 완료를 입증했나(할루시네이션 "됐다" 아님)
- [ ] the team lead에게 보이는 보고 + closure까지 갔나
- [ ] owner·안전룰(외부전송·self-mod·승인) 지켰나

self-test: `scripts/bwf-selftest.sh`(샘플 골든태스크 절차 + 단계 산출물 체크리스트).

---

## 경계 (무엇이 BWF가 아닌가)

- BWF는 **실행 절차**다. owner 판단·외부전송/self-mod 승인·릴리즈 게이트 같은 **안전/핵심룰은 TEAM-OS(always-load)에 남는다** — 스킬로 내리지 않는다(§9 DO-NOT-COMPACT).
- 품질방법 정본은 각 스킬(harness 등). BWF는 **고르는 표**만 — 복붙하면 드리프트.
- 주간 메타-개선(팀 정책 자가발전)은 **learning-loop**(별도). BWF는 6단계 hook으로 넘기기만.

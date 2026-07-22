---
name: b3os-team-learning-loop
description: "b3rys 팀 정책 자가발전, SHARED->TEAM-OS 승격, compacting, 프로젝트별 운영리뷰, 월간 개선지표를 운영하는 주간 learning-loop 스킬."
---

# b3rys Team Learning Loop

이 스킬은 b3rys 팀의 weekly self-learning(주간 자가학습) 세션을 운영할 때 사용한다. 목적은 문서 작업량을 늘리는 것이 아니라, 팀 정책·스킬·개인 설정·프로젝트 운영을 실제로 개선하고 그 개선이 측정되게 만드는 것이다.

> **BWF와의 관계 (2026-06-22, 팀 7/7 합의)**: learning-loop은 `b3os-bwf`와 **별도**다. BWF=개별 과제 실행(미시) / learning-loop=주간 메타-개선(거시·cadence·승인게이트 다름). BWF 6단계의 "학습 hook"이 만든 교훈·재발사례·검증증거가 이 루프의 **입력**으로 흘러든다(합치지 않고 데이터만 연계).

## 핵심 역할

- learning-loop PM(Project Manager, 조율 담당): `agents.json`에서 `learning_loop_pm` capability(역량)를 가진 팀원. 없으면 `coordinator` capability 보유자가 fallback(대체 담당자)으로 맡는다. 코드에서는 `learningLoopPmId(agents)` helper(도우미 함수)를 기준으로 한다.
- 공동 리뷰어: 공동 리더/역할 데이터 기준으로 지정한다. learning-loop PM 단독 결론을 막고, 운영·인프라·팀 현실성 관점에서 산출물 4개를 함께 줄인다.
- {{OWNER}}: 정책·보안·공개·팀원 정체성·큰 운영 변경의 최종 승인자.
- 주제 담당자: 프로젝트별 서브주제에 따라 참여한다. 검색품질 운영리뷰처럼 별도 전문성이 필요한 서브주제는 역할·capability 데이터 기준으로 담당자를 지정한다.

## 원칙

- self-learning의 메인 목적은 팀 정책과 팀원 피드백 루프의 자가발전이다. 프로젝트별 운영리뷰는 그 안에 붙는 교체 가능한 서브주제다.
- 사소한 후보를 많이 올리는 것보다 실제 팀 행동을 바꾸는 후보만 남긴다. 팀원은 자기 입장에서 작은 불편도 올릴 수 있으므로 learning-loop PM과 공동 리뷰어가 과감히 줄인다.
- `SHARED.md`는 학습 로그, `TEAM-OS.md`는 팀 공통 규칙, `skills/b3rys-*`는 반복 절차, 팀원별 `CLAUDE.md`/`AGENTS.md`/`IDENTITY.md`/`MEMORY.md`는 개인 런타임·정체성·기억의 반영처다.
- 정책 변경, 보안, 외부전송, 공개 가능성, 팀원 persona(정체성) 변경은 {{OWNER}} 승인 없이 반영하지 않는다.
- 매주 산출물은 짧아야 한다. 월간으로는 개선이 실제 측정되어야 한다.
- 금요일 10:00 KST에는 learning-loop PM(`learning_loop_pm` 보유자, 없으면 `coordinator` fallback)이 {{OWNER}}에게 정리된 결과를 보낸다. 보고는 learning-loop PM과 공동 리뷰어가 줄인 간결한 작업목록이어야 하며, 단순 회고가 아니라 다음 실행으로 이어져야 한다.
- learning-loop PM은 {{OWNER}}가 매번 시키지 않아도 이 프로젝트를 계속 진행한다. learning-loop 자체의 품질, 측정 지표, 서브주제 운영 방식, 자동화 수준을 Tasks 칸반에서 PM 과제로 관리한다.

## 주간 운영 흐름

금요일 05:00 KST self-learning 세션에서 실행한다. 자동화가 있더라도 파일을 바로 고치는 것이 아니라 후보를 만들고, 필요한 경우 공동 리뷰와 {{OWNER}} 승인 gate를 거친다. 금요일 10:00 KST에는 learning-loop PM이 {{OWNER}}에게 정리된 결과를 메시지로 보낸다.

1. 입력 수집
   - 지난 1주일 `rules/SHARED.md` 신규 항목과 stale(낡음)/중복 후보
   - Tasks 칸반에서 반복적으로 멈춘 과제, owner 혼선, handoff 실패, 완료 기준 누락
   - team bus/audit log에서 라우팅 실패, 중복 위임, 응답 가시성 문제
   - 프로젝트별 서브주제 지표와 실패 사례
   - 팀원별 설정 파일에 반영할 후보

2. 후보 선별
   - 버릴 것: 일회성 잡음, 개인 취향, 아직 반복되지 않은 사소한 불편, 이미 해결된 임시 장애
   - 남길 것: 반복 문제, 팀 행동을 바꾸는 교훈, 완료 기준을 명확히 하는 규칙, 재발 방지에 필요한 절차
   - 애매하면 남기는 쪽이 아니라 줄이는 쪽을 기본값으로 둔다. 단, 보안·외부전송·데이터 손실 가능성은 사소해 보여도 남긴다.

3. PM+공동 리뷰
   - learning-loop PM이 1차 후보와 산출물 초안을 만든다.
   - 공동 리뷰어가 운영 현실성, 인프라 리스크, 중복/사소함, 팀원 부담을 본다.
   - 두 역할이 합의한 간결한 작업목록만 {{OWNER}}에게 올린다.

4. 반영처 결정
   - `SHARED.md`: 사건과 교훈을 남길 가치가 있지만 아직 규칙은 아닌 것
   - `TEAM-OS.md`: 반복 확인된 팀 공통 운영 규칙
   - `skills/b3rys-*`: 실행 절차로 재사용할 수 있는 것
   - 팀원 설정 파일: 특정 팀원의 역할, 말투, 런타임, 기억에만 해당하는 것
   - Tasks 칸반: 실행 과제, 검증 과제, 다음 액션이 필요한 것

5. {{OWNER}} 보고
   - 보고는 긴 회고가 아니라 간결한 작업목록이다.
   - 포함: 이번 주 후보 중 채택/보류/폐기, 실제 반영 필요 파일, 위험하거나 {{OWNER}} 승인이 필요한 항목, 프로젝트별 서브주제 다음 액션.
   - 사소한 후보 목록 전체를 {{OWNER}}에게 올리지 않는다.
   - 금요일 10:00 KST 보고를 기본 cadence(운영 리듬)로 한다. 공동 리뷰가 늦으면 "공동 리뷰 대기"와 임시 판단을 분리해 보고한다.

6. 루프 자체 개선
   - 매주 learning-loop 운영에서 드러난 병목을 다음 주 개선 후보로 남긴다.
   - 너무 많은 후보가 올라오면 필터 기준을 강화한다.
   - {{OWNER}} 보고가 길어지면 보고 포맷을 줄인다.
   - 월간 지표가 행동 개선을 보여주지 못하면 측정 항목을 바꾼다.
   - 서브주제의 수명이 끝났으면 종료하고 새 주제는 최소 필드로만 추가한다.

## Tasks 칸반 쿼리 (정본 — schema-safe, 2026-06-15 운영 검증)

위 입력 수집(1번)에서 Tasks 칸반을 볼 때는 **반드시 아래 정본 쿼리만 사용**한다. `team.db`의 `task` 테이블을 즉흥 SQL로 치지 말 것 — 옛 컬럼명(`status`, `priority`, `next_action`, `blocker`, `needs_owner_decision`)은 **더 이상 존재하지 않아** 쿼리가 깨진다(2026-06-12 weekly 05:00 run sqlite 실패 원인).

현재 `task` 스키마: `id, title, lane, owner, sort_order, created_at, updated_at, description`
- `lane` = 칸반 컬럼(`plan` / `doing` / `done`). 옛 `status`의 대체.
- 완료기준·다음 액션·blocked·메모는 별도 컬럼이 아니라 **`description` 안에** 들어있다(TEAM-OS §10). 즉 blocked/next-action/완료기준 분석은 description 텍스트를 읽어 판단한다.

DB 정본: `<repo>/team.db`

정본 쿼리:

```sql
-- lane별 분포
SELECT lane, COUNT(*) FROM task GROUP BY lane;
-- doing 카드 품질 리뷰(다음액션/재개시각/fallback/stop_rule은 description에서 판단)
SELECT id, title, owner, updated_at, description FROM task WHERE lane='doing' ORDER BY updated_at;
-- 정체된 doing(3일+ 미갱신)
SELECT title, owner, date(updated_at) FROM task WHERE lane='doing' AND updated_at < datetime('now','-3 days') ORDER BY updated_at;
```

스키마가 또 바뀌면 먼저 `PRAGMA table_info(task);`로 실제 컬럼을 확인한 뒤 쿼리한다(관측이 기억을 이긴다).

## 프로젝트별 서브주제

서브주제는 특정 운영/품질 주제를 계속 모니터링하고 개선하기 위한 임시 트랙이다. 필요할 때 생기고, 안정되거나 가치가 사라지면 종료한다.

현재 기본 서브주제:

- 이름: 검색품질 운영리뷰
- 담당: learning-loop PM(정리), eval/품질 담당, 구현 담당, 운영 gate 담당을 역할·capability 데이터 기준으로 지정
- 목적: 검색 실패 사례, gold set(정답셋), eval(평가), 운영 검색 품질을 보고 다음 개선 방향을 정한다.
- 산출: 유지/수정/중단/다음 실험 1개 중 하나를 남긴다.

서브주제 추가 시 최소 필드:

```
서브주제:
담당:
왜 필요한가:
이번 달 측정 지표:
종료 조건:
이번 주 다음 액션:
```

## 주간 산출물 4개

learning-loop PM과 공동 리뷰어는 매주 아래 4개를 함께 리뷰한다.

1. `SHARED.md` 정리 결과: 신규/중복/compact/stale/pinned 후보
2. `TEAM-OS.md` 승격 후보: 팀 공통 규칙으로 올릴 만큼 반복·중요한 것만
3. skill/개인 설정 반영 후보: `skills/b3rys-*`, `CLAUDE.md`, `AGENTS.md`, `IDENTITY.md`, `MEMORY.md` 등
4. 프로젝트 서브주제 다음 액션: 현재는 검색품질 운영리뷰의 다음 실험/유지/종료 판단

## 월간 개선 지표

한 달에 한 번은 팀원 입장에서 learning-loop가 실제 의미 있었는지 측정한다. 정량과 정성을 섞되, 지표는 적게 유지한다.

추천 지표:

- 반복 문제 감소: 같은 유형의 owner 혼선, 중복 handoff, 완료 기준 누락, 응답 가시성 문제 건수
- 칸반 품질: `doing` 카드 중 다음 액션/재개 시각/fallback/stop_rule 누락 비율
- 정책 반영 리드타임: 교훈 발견부터 SHARED/TEAM-OS/skill 반영 또는 폐기 결정까지 걸린 시간
- 서브주제 품질: 검색품질이면 gold set pass rate(정답셋 통과율), 회귀 건수, 검색 실패 `SEARCH_BAD` 처리율
- 팀원 체감: 월 1회 짧게 "이번 달 learning-loop가 내 작업을 더 쉽게 만든 점/아직 거슬리는 점"을 수집

월간 리뷰는 {{OWNER}}가 모든 후보를 볼 필요 없이, 반영된 rules와 주요 지표를 learning-loop PM·공동 리뷰어·{{OWNER}}가 함께 확인하는 형태를 목표로 한다.

## 지속 PM 과제

`b3os-team-learning-loop` 자체는 계속 진행되는 팀 경쟁력 프로젝트다. learning-loop PM은 별도 지시가 없어도 아래를 관리한다.

- Tasks 칸반에 PM 과제를 유지하고, 다음 액션과 검증 증거를 갱신한다.
- 05:00 수집/정리, 공동 리뷰, 10:00 {{OWNER}} 보고가 실제로 도는지 확인한다.
- 보고가 사소한 후보로 부풀면 필터를 조정한다.
- 자동화가 부족하면 스크립트·cron·지표 수집을 단계적으로 제안한다.
- 월간 리뷰에서 성과 지표가 개선되지 않으면 루프 설계를 바꾼다.

## Compacting 기준

- 중복 항목은 합치되, 최초 원인과 반영처는 잃지 않는다.
- 오래된 항목은 삭제보다 stale 처리 또는 요약을 우선한다.
- `TEAM-OS.md`는 짧고 강한 규칙만 남긴다. 세부 절차는 skill로 뺀다.
- 개인 설정 파일은 해당 팀원 행동을 실제로 바꿀 때만 수정 후보로 둔다.
- 공개 가능한 패턴은 익명화와 {{OWNER}} 승인 전에는 외부화하지 않는다.

## 완료 기준

주간 세션 완료는 다음 조건을 만족해야 한다.

- learning-loop PM 1차 선별이 끝났다.
- 공동 리뷰가 끝났다.
- 사소한 후보가 제거되었다.
- 산출물 4개가 간결한 작업목록으로 정리되었다.
- 금요일 10:00 KST {{OWNER}} 보고가 완료되었거나, 공동 리뷰 지연 등 미완료 사유가 보고되었다.
- {{OWNER}} 승인 필요 항목과 자동/내부 반영 가능 항목이 분리되었다.
- 월간 지표에 영향을 주는 변화가 기록되었다.

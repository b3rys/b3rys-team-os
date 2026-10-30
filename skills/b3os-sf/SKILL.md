---
name: b3os-sf
description: "b3os SF(Software Factory) — 프로젝트 방법론. b3rys 팀원이 프로젝트(단순 리서치·프로토가 아닌, 팀장 요구가 여러 번 쌓이는 일)를 맡았을 때 항상 하는 관리·보고 스킬. 팀장 지시를 빠짐없이 목록으로 잡고(TODO.md 정본), 칸반 카드와 맞추고, 채널별(텔레그램·슬랙·팀버스·저장소) 정해진 모양으로 보고한다. 'b3os 는 어떻게 개발해요?'에 답하는 8단계 정본. 사용 시점 — 팀장이 '목록으로 관리해', '정리해서 보내봐', '다 처리했어?' 라고 할 때, 프로젝트 킥오프·마일스톤·인계 때, 개발 방법론을 설명할 때."
owner: steve
trigger: run a project (many lead requests over time)
---

# b3os SF (Software Factory) — 프로젝트 방법론

## 한 문단 답 — "b3os 는 어떻게 개발해요?"

팀장이 방향과 손맛을 정하고 AI 팀원이 역할을 나눠 만든다. 요청은 원문 그대로 `TODO.md` 에 올리고, 바꾸기 비싼 결정만 먼저 설계한다. 일은 10분 단위로 쪼개 병렬로 돌리고, 만드는 AI 와 리뷰하는 AI 를 나눈다. 시험은 바뀐 곳 + 필수만 돌리고, 출고 시험은 사용자가 실제로 쓰는 장면만 둔다(내부 정확성·안전·mutant 검사는 그대로). 손맛은 "사용자가 느끼는가"를 기준으로 프로젝트 표의 숫자로 잰다. 출고는 모드를 정해 dev·hotfix·fix 는 20분 안에(full 은 별도 승인), macOS 전달본은 공증본만. 같은 지적이 두 번 나오면 장치로 막고, 배운 것은 메모리 → SHARED → 스킬로 올린다. 사례: Steno.

## 목적

SF는 결과물 품질·과제 수행 시간·과제 수행 토큰량을 함께 잰다. RSI(반복적 자기개선)를 위한 환경·프로세스·라이브러리를 구축해 세 지표를 계속 개선한다. 10-05 개발 배포 검사는 19분에서 4분 46초로 줄었다(시간 지표). 측정법: [`references/knowledge-and-handoff.md`](references/knowledge-and-handoff.md#핵심-지표)

**작업시간 산출방법** — ETA·소요 시간은 남의 말(팀원의 사전 예상, 이전 메시지의 숫자)이 아니라 같은 종류 과제가 실제로 걸린 시간을 기준으로 한다. 말하기 전에 그 실제 시간(실행 기록 파일·스레드 시각 등)을 확인하고, 이미 있는 도구·데이터를 다시 쓰면 그만큼 줄인다. 실제 기록이 없으면 '추정'이라고 밝힌다. 단계를 순차로 더한 값은 말하지 않는다 — 겹칠 수 있는 것부터 정한다.

## 언제 작동?

팀장 요구가 여러 번 쌓이는 앱·서비스·긴 기능과 그 프로젝트의 킥오프, 마일스톤, 배포본 전달, 인계에 쓴다. 단발 리서치·프로토는 `b3os-task-loop` 카드 하나로 관리한다.

## 8단계 지도

| # | 단계 | 한 줄 | 상세 · 함께 쓰는 스킬 |
|---|---|---|---|
| 1 | 등록·환경 | 요구 원문 → `TODO.md`, 저장소 뼈대, 역할(만들기·판정·PM) | [`start.md`](references/start.md) · `b3os-github-workflow` |
| 2 | 설계·첫 동작 | 바꾸기 비싼 결정만 설계, 다른 모델로 교차검증, 첫날 시험이 닿는 구조·부팅 검사 | [`start.md`](references/start.md#구현-첫날부터-지킬-구조-규칙) · `b3os-ai-code-safety` Phase 1 |
| 3 | 구조 잡기 | 기능이 돌고 구조 신호가 보이면 앱 전체를 재고 리팩토링, 래칫으로 지킨다 | [`structure-refactor.md`](references/structure-refactor.md) |
| 4 | 만들기·리뷰 | 요청마다 순환. 아키 리뷰 먼저, 리뷰는 보고만 | [`development.md`](references/development.md) · `b3os-harness-playbook` |
| 5 | 시험·검증 | 바뀐 곳 + 필수, 출고 시험은 사용자 장면만, 실패하면 원인(시험·환경·제품)부터 가린다 | [`dev-mode-operations.md`](references/dev-mode-operations.md) · `b3os-verification` |
| 6 | 손맛 | "사용자가 느끼는가". 키 지연을 표로 재고 원칙으로 판정 | [`feel.md`](references/feel.md) · `b3os-verification` §3 |
| 7 | 공유 기계·출고 | 잠금 하나로 줄 세우기, dev·hotfix·fix 출고 20분(full 은 별도 승인), macOS 전달본은 공증본 | [`release.md`](references/release.md) · `b3os-verification` §1b·§6 · `b3os-release-ops` |
| 8 | 운영·지식 | 장애는 복구 먼저, 두 번 지적 → 장치, 교훈은 정본·SHARED·스킬로 | [`operations.md`](references/operations.md) · [`knowledge-and-handoff.md`](references/knowledge-and-handoff.md) · `b3os-team-learning-loop` |

 팀장 확인: 첫 기능 목록 · 초기 설계 · 머지 승인 · 실사용 확인.

### 시작 (1~2)

요구 원문을 목록으로 잡고 바꾸기 비싼 구조만 설계한 뒤, 저장소·문서·지속적 통합(CI)·칸반·에이전트 팀의 최소 뼈대를 만든다. 한 과제 = 메시지 하나 = 스레드 하나(놓을 자리 · 뺄 것 · 고정 완료 조건). 상세: [`references/start.md`](references/start.md)

### 개발 (3~5)

요청마다 `요청 → 만들기 → 검사 → 리뷰 → 머지 승인 → 내보내기 → 보고 → 배우기`를 돈다. 상세: [`references/development.md`](references/development.md)

- **설계 판단은 아키 리뷰 먼저.** 리팩토링 여부·공통 규칙 자리·큰 수정 방향은 읽기 전용 아키 에이전트에게 먼저 묻고, 질문에 "꼭 필요한가 / 오버엔지니어링인가"를 넣는다. 추론 최고 단계는 리팩·심각한 버그에만.
- **리뷰는 보고만, 고칠 것은 고른 뒤.** 리뷰·검사 에이전트는 읽기·재현만 한다. 결과를 깨짐 / 구조 / 개선으로 나누고, 실제로 깨지는 것과 팀장이 고른 개선만 가장 작은 수정으로 맡긴다.
- **오류 수정은 그 오류만.** 개선은 별도 작업으로 하나씩, 직전 출고본과 나란히 비교한 뒤.
- **구현은 구현 담당에게.** PM 이 외부 모델을 직접 띄워 대리 구현시키지 않는다(팀 버스 과제로). 담당이 밀리면 PM 도 나눠 직접 구현하되 먼저 이관을 알린다.

개발 속도는 구조화와 변경 영향 범위에 맞춘 검사 단계로 확보한다. 공유 기계에서는 검사 순번과 자동 재검사를 제어하고, 기다리는 동안 헤드리스 작업을 겹쳐 돌린다. 상세: [`references/dev-mode-operations.md`](references/dev-mode-operations.md) · 11개 코딩 원칙: [`references/ai-team-coding-guidelines.md`](references/ai-team-coding-guidelines.md)

상태 × 입력 조합이 많은 기능(편집기 키 처리, 화면 모드, 동기화 상태)은 처음부터 "판정 함수 하나 + 상태표 + 작은 실행 함수"로 짠다. 고쳤더니 다른 곳이 깨지면 같은 판단을 하는 곳이 몇 군데인지부터 센다. 방법·장단점: `b3os-ai-code-safety` 의 "상태 × 입력이 많으면 상태표로".

구조 정리(리팩터링)는 신호가 보일 때 앱 전체 지도로 재고, 위험 순으로 옮기고, 래칫으로 지킨다. 팀장이 미세 조정한 화면값은 직전 출고본과 픽셀로 비교해 지킨다. 상세: [`references/structure-refactor.md`](references/structure-refactor.md)

### 손맛 (6)

디테일의 기준은 "사용자가 화면·손으로 느끼는가"다. 느끼면 끝까지 챙기고, 느끼지 않는 손맛 조정(재현 안 되는 내부 경로의 미세 튜닝)은 멈추고 다음으로. 이 기준은 손맛 조정과 출고 시험 범위에만 쓰고, 내부 정확성·안전·mutant 검증은 줄이지 않는다. 손맛은 정의 → 판정선 표 → 동작 원칙 → 출고 게이트 순으로 제품에 넣는다. 의도하지 않은 액션 금지, 커서는 사용자의 의도를 따른다, 잘되던 기능 회귀 금지. 상세: [`references/feel.md`](references/feel.md)

### 출시 (7)

출고는 모드(dev·hotfix·fix·full)를 먼저 정한다. 전체 시험(full)은 필요성을 말하고 팀장 승인을 받은 뒤에만 돈다. 모드별 시험·시간 상한·승인자: `b3os-verification` §1b. 검사·리뷰를 통과한 산출물만 내보내고, 요구사항별로 자동 시험·앱 화면·못 본 것을 나눠 보고한다. 상세: [`references/release.md`](references/release.md)

바깥 사용자에게 처음 여는 오픈(베타·알파)은 단계 체크리스트를 `TODO.md` 로 옮겨 하나씩 닫는다. 상세: [`references/launch-and-stats.md`](references/launch-and-stats.md)

### 운영·지식 (8)

장애는 영향 제한과 복구(롤백)를 먼저 한 뒤 수정 요청으로 개발 순환에 돌려보낸다. 상세: [`references/operations.md`](references/operations.md)

TODO·기능·설계·검증 근거를 정본에 갱신하고, 재사용 가능한 교훈을 프로젝트와 팀 지식에 남긴다. 같은 지적이 두 번 나오면 글이 아니라 장치(구조·검사·시험)로 막는다. 인계와 종료 때 잰 것과 못 잰 것을 구분한다. 상세: [`references/knowledge-and-handoff.md`](references/knowledge-and-handoff.md)

## 공통 원칙

1. 요청 원문으로 추적하고 정본을 하나씩만 둔다.
2. 검사가 머지와 출시를 막으며, 만든 AI와 리뷰하는 AI를 나눈다.
3. 사람은 정해진 확인 지점에서 방향과 결과를 반드시 확인한다.
4. 잰 것과 못 잰 것을 나눠 사실로 보고하고, 배운 것은 다음 일의 입력으로 남긴다.
5. 진행은 시간 칸이 아니라 실제 작업으로 본다. 끝나면 바로 다음, 막히면 쪼개 병렬로 — 순차로 더하지 않는다.

## 관련

`b3os-bwf` · `b3os-task-loop` · `b3os-github-workflow` · `b3os-release-ops` · `b3os-verification` · `b3os-ai-code-safety` · `b3os-harness-playbook` · `b3os-team-learning-loop`

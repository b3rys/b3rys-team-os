---
name: b3os-sf
description: "b3os SF(Software Factory) — 프로젝트 방법론. b3rys 팀원이 ★프로젝트★(단순 리서치·프로토가 아닌, 팀장 요구가 여러 번 쌓이는 일)를 맡았을 때 항상 쓰는 관리·보고 스킬. 팀장 지시를 빠짐없이 목록으로 잡고(TODO.md 정본), 칸반 카드와 맞추고, 채널별(텔레그램·슬랙·팀버스·저장소) 정해진 모양으로 보고한다. 'b3os 는 어떻게 개발해요?'에 답하는 8단계 정본. 사용 시점 — 팀장이 '목록으로 관리해', '정리해서 보내봐', '다 처리했어?' 라고 할 때, 프로젝트 킥오프·마일스톤·인계 때, 개발 방법론을 설명할 때."
owner: steve
trigger: run a project (many lead requests over time)
---

# b3os SF (Software Factory) — 프로젝트 방법론

## 한 문단 답 — "b3os 는 어떻게 개발해요?"

팀장이 방향을 정하고 AI 팀원이 역할을 나눠 만든다. 요청은 원문 그대로 `TODO.md` 에 올리고, 바꾸기 비싼 결정만 먼저 설계한다. 요청 하나는 BWF 로 닫고 그 ③ 실행 · ④ 검증 칸은 Find · Pick · Fix · Check 역할이 맡으며, Fix 와 Check 는 다른 AI 가 맡는다. 테스트는 바뀐 곳 + 필수만 돌리고, 출고 테스트는 사용자가 실제로 쓰는 장면만 둔다. 손맛은 "사용자가 느끼는가"를 기준으로 프로젝트 표의 숫자로 잰다. 출고는 모드를 정해 dev·hotfix·fix 는 20분 안에 끝낸다(full 은 별도 승인). 같은 지적이 두 번 나오면 장치로 막고, 배운 것은 메모리 → SHARED → 스킬로 올린다.

용어(처음 나오는 말)
- 래칫(ratchet): 지표(예: 큰 파일 수)가 나빠지는 커밋은 막고, 좋아지면 그 값을 새 상한으로 고정하는 검사.
- 뮤턴트(mutant): 코드 한 줄을 일부러 고장 낸 사본. 테스트가 그 고장을 잡는지(실패하는지)로 테스트가 쓸모 있는지 확인한다.
- 게이트: 통과하지 못하면 머지·출고로 못 가게 막는 검사.
- 손맛: 사용자가 화면·손으로 느끼는 반응 품질(속도·입력·조작 흐름).
- 공증(본): 앱을 배포하기 전에 플랫폼 제공자(Apple)가 확인해 주는 절차, 그 절차를 통과한 앱. macOS 전달본은 공증본만 보낸다.
- 출고 모드 dev · hotfix · fix · full: 출고에서 돌릴 검사 범위·시간 상한·승인자를 정하는 4단계(`b3os-verification` §1b).
- 하네스(harness): 한 팀원이 서브에이전트 여러 개를 병렬로 띄워 일을 나누는 방식.
- 아키: 구조(자리·분기·중복)만 읽기 전용으로 보는 리뷰 역할(아키텍처 담당).
- 회귀(regression): 전에 되던 것이 고친 뒤 안 되는 일.

## 목적

SF는 결과물 품질·과제 수행 시간·과제 수행 토큰량을 함께 잰다. RSI(반복적 자기개선)에 필요한 환경·프로세스·라이브러리를 갖춰 세 지표를 계속 개선한다. 측정법: [`references/knowledge-and-handoff.md`](references/knowledge-and-handoff.md#핵심-지표)

**작업시간 산출방법** — ETA·소요 시간은 같은 종류 과제에 실제로 걸린 시간(실행 기록·스레드 시각)을 확인해서 말한다. 기록이 없으면 '추정'이라 밝히고, 단계를 순차로 더한 값은 말하지 않는다.

## 언제 작동?

팀장 요구가 여러 번 쌓이는 앱·서비스·긴 기능과 그 프로젝트의 킥오프, 마일스톤, 배포본 전달, 인계에 쓴다. 단발 리서치·프로토는 `b3os-task-loop` 카드 하나로 관리한다.

이 스킬과 references 의 "적용 사례:" 는 이해를 돕는 예시다. 적용 사례는 그대로 따라 하지 말고, 상황마다 맞게 적용한다.

요청 말투별로 볼 곳:
- 목록으로 관리하라는 요청 → [`start.md`](references/start.md#todo-목록-규율)
- 정리본 요청(예: "정리해서 보내봐") → [`channel-formats.md`](references/channel-formats.md) 의 "텔레그램 1:1 — 정리"
- todo 목록 요청(예: "todo 리스트 줘") → [`channel-formats.md`](references/channel-formats.md) 의 "텔레그램 1:1 — todo 리스트"
- 완료 여부 질문(예: "다 처리했어?") → [`knowledge-and-handoff.md`](references/knowledge-and-handoff.md#종료)(전체·완료·남은 수를 숫자로, 남은 이유와 못 잰 범위)

## 8단계 지도

| # | 단계 | 한 줄 | 상세 · 함께 쓰는 스킬 |
|---|---|---|---|
| 1 | 등록·환경 | 요구 원문 → `TODO.md`, 저장소 뼈대, 역할(Find · Pick · Fix · Check 담당). 요청은 여기로 들어온다 | [`start.md`](references/start.md) · `b3os-github-workflow` |
| 2 | 설계·첫 동작 | 필요할 때만. 바꾸기 비싼 결정만 설계, 다른 모델로 교차검증, 첫날 테스트가 닿는 구조·부팅 검사 | [`start.md`](references/start.md#구현-첫날부터-지킬-구조-규칙) · `b3os-ai-code-safety` Phase 1 |
| 3 | 구조 잡기 | 필요할 때만. 기능이 돌고 구조 신호가 보이면 앱 전체를 재고 리팩토링, 래칫으로 지킨다 | [`structure-refactor.md`](references/structure-refactor.md) |
| 4 | 만들기·리뷰 | 요청 하나 = BWF, ③·④ 칸 = FPFC. 설계 판단 전 아키 리뷰, 리뷰는 보고만 | [`development.md`](references/development.md) · `b3os-harness-playbook` |
| 5 | 시험·검증 | 바뀐 곳 + 필수, 출고 테스트는 사용자 장면만, 실패하면 원인(테스트·환경·제품)부터 가린다. FPFC 의 Check 가 이 방법을 쓴다 | [`dev-mode-operations.md`](references/dev-mode-operations.md) · `b3os-verification` |
| 6 | 손맛 | "사용자가 느끼는가". 불편 → 원칙 한 줄 → 숫자 표·테스트로 바꿔 판정 | [`feel.md`](references/feel.md) · `b3os-verification` §3 |
| 7 | 공유 기계·출고 | 결과가 묶음으로 모인다. 잠금 하나로 줄 세우기, dev·hotfix·fix 출고 20분(full 은 별도 승인), macOS 전달본은 공증본 | [`release.md`](references/release.md) · `b3os-verification` §1b·§6 · `b3os-release-ops` |
| 8 | 운영·지식 | 배운 것이 모인다. 장애는 복구 먼저, 두 번 지적 → 장치, 교훈은 정본·SHARED·스킬로 | [`operations.md`](references/operations.md) · [`knowledge-and-handoff.md`](references/knowledge-and-handoff.md) · `b3os-team-learning-loop` |

★ 팀장 확인 지점은 넷이다: 첫 기능 목록 · 초기 설계 · 머지 승인 · 실사용 확인. 그 밖의 승인(외부 발송 · 자기 수정 · 삭제 등)은 TEAM-OS §4 승인 게이트를 따른다. 머지 승인은 tier 별 승인자가 한다(일반 = 승인 권한자, 핵심 = 팀장 — TEAM-OS §4 · `b3os-github-workflow` ⑦). 팀장에게 PR Approve 를 요청하지 않는다(핵심 제외).

### 시작 (1~2)

요구 원문을 목록으로 잡고 바꾸기 비싼 구조만 설계한 뒤, 저장소·문서·지속적 통합(CI)·칸반·에이전트 팀의 최소 뼈대를 만든다. 한 과제 = 메시지 하나 = 스레드 하나(놓을 자리 · 뺄 것 · 고정 완료 조건). 상세: [`references/start.md`](references/start.md)

### 개발 (3~5)

요청 하나 = BWF, ③·④ 칸 = FPFC(Find · Pick · Fix · Check — 역할 · 입구 · 끝 조건은 `b3os-bwf`). 별도의 요청 순환을 두지 않는다. 상세: [`references/development.md`](references/development.md)

- **아키 리뷰 = 설계 판단 전 + 출고 묶음마다 1회.** 리팩토링 여부·공통 규칙 자리·큰 수정 방향을 정하기 전에 먼저 묻고, 출고 묶음마다 그 묶음의 diff 전체를 한 번 본다. 읽기 전용, 상위 모델 + 높은 추론. 질문에 "꼭 필요한가 / 오버엔지니어링인가"를 넣는다. 기능 머지마다는 PR 에 세 질문(제자리인가 · 새 분기가 생겼나 · 같은 값의 입구가 둘 이상인가)의 답만 남긴다.
- **Find 는 보고만, Pick 뒤에 Fix.** 리뷰·검사 agent 는 읽기·재현만 한다. 결과를 깨짐 / 구조 / 개선으로 나누고, 실제로 깨지는 것(PM 판단)과 팀장이 고른 개선만 가장 작은 수정으로 맡긴다. 구조는 리팩터링 신호로 `TODO.md` 킵 절에 `[구조]` 머리말로 적고(발생 횟수 · 미실행 시 영향 · 비용), 시점은 PM 이 정한다. 같은 신호가 두 번째로 나오거나 검사가 3단계로 올라가면 3 구조 잡기로 올린다. 크기별 인원: [`development.md`](references/development.md#fpfc-를-프로젝트에서-쓰는-법-pm-절차)
- **오류 수정은 그 오류만.** 개선은 별도 작업으로 하나씩, Check 의 나란히 비교(직전 출고본과)를 통과한 뒤.
- **구현은 구현 담당에게.** PM 이 외부 모델을 직접 띄워 대신 구현시키지 않는다(팀 버스 과제로). 담당이 밀리면(움직임 없음 10분 → 담당에게 질문, 움직임 없음 20분 또는 예고 시각 초과 → 이관) PM 도 나눠 직접 구현하되, 먼저 원 담당(미커밋분은 커밋해 SHA 로 넘기게)과 과제를 요청한 사람에게 이관을 알린다.

개발 속도는 구조화와 변경 영향 범위에 맞춘 검사 단계로 확보한다. 상세: [`references/dev-mode-operations.md`](references/dev-mode-operations.md) · 11개 코딩 원칙: [`references/ai-team-coding-guidelines.md`](references/ai-team-coding-guidelines.md)

상태 × 입력 조합이 많은 기능(편집기 키 처리, 화면 모드, 동기화 상태)은 처음부터 "판정 함수 하나 + 상태표 + 작은 실행 함수"로 짠다. 고쳤더니 다른 곳이 깨지면 같은 판단을 하는 곳이 몇 군데인지부터 센다. 방법·장단점: `b3os-ai-code-safety` 의 "상태 × 입력이 많으면 상태표로".

구조 정리(리팩터링)는 신호가 보일 때 앱 전체 지도로 재고, 위험 순으로 옮기고, 래칫으로 지킨다. 팀장이 미세 조정한 화면값은 직전 출고본과 픽셀로 비교해 지킨다. 상세: [`references/structure-refactor.md`](references/structure-refactor.md)

### 손맛 (6)

사람이 느낀 것을 AI 가 지킬 수 있는 형태로 바꾼다: 불편(영상·한 줄 제보) → 원칙 한 줄 → 잴 수 있으면 숫자 표·테스트 → Fix 와 Check 가 그 기준으로 작업. 기준은 "사용자가 화면·손으로 느끼는가"다. 느끼면 끝까지 챙기고, 느끼지 않는 미세 튜닝은 멈춘다. 이 기준은 손맛 조정과 출고 테스트 범위에만 쓰고 내부 정확성·안전·mutant 검증은 줄이지 않는다. 순서: 정의 → 판정선 표 → 동작 원칙 → 출고 게이트. 원칙 예: 의도하지 않은 액션 금지 · 잘되던 기능 회귀 금지(전체 목록은 feel.md §3). 상세: [`references/feel.md`](references/feel.md)

### 출시 (7)

출고는 모드(dev·hotfix·fix·full)를 먼저 정한다. 전체 테스트(full)는 필요성을 말하고 팀장 승인을 받은 뒤에만 돈다. 모드별 테스트·시간 상한·승인자: `b3os-verification` §1b. 검사·리뷰를 통과한 산출물만 내보내고, 요구사항별로 자동 테스트·앱 화면·못 본 것을 나눠 보고한다. 공유 기계에서는 검사 순번과 자동 재검사를 제어하고, 기다리는 동안 헤드리스(앱 화면 없이 도는 테스트) 작업을 겹쳐 돌린다([`dev-mode-operations.md`](references/dev-mode-operations.md)). 상세: [`references/release.md`](references/release.md)

바깥 사용자에게 처음 여는 오픈(베타·알파)은 launch-and-stats.md 의 §1~§10 전체를 `TODO.md` 로 옮겨 하나씩 닫는다. 이후 단계 승격(알파 → 베타 → 정식)에서는 §1 기준선(새 태그) · §3 릴리즈 노트 · §8 오픈 전 검수만 다시 닫고, 나머지는 앞선 오픈의 기록이 아직 맞는지만 확인한다. 상세: [`references/launch-and-stats.md`](references/launch-and-stats.md)

### 운영·지식 (8)

장애는 영향 제한과 복구(롤백)를 먼저 한 뒤 수정 요청으로 받아 BWF 로 닫는다. 롤백(직전 정상 버전으로 되돌리기)은 영향 제한이 먼저라 승인을 기다리지 않고 한 뒤 곧바로 팀장에게 보고한다. 롤백이 아닌 새 업로드·새 배포·재시작과 되돌릴 수 없는 복구(데이터 삭제·스키마 변경)는 승인 게이트를 따른다. 상세: [`references/operations.md`](references/operations.md)

TODO·기능·설계·검증 근거를 정본에 갱신하고, 다시 쓸 수 있는 교훈을 프로젝트와 팀 지식에 남긴다. 같은 지적이 두 번 나오면 글이 아니라 장치(구조·검사·테스트)로 막는다(TODO 줄에 횟수를 적는다 — [`start.md`](references/start.md#todo-목록-규율)). 인계와 종료 때 잰 것과 못 잰 것을 구분한다. 상세: [`references/knowledge-and-handoff.md`](references/knowledge-and-handoff.md)

## 공통 원칙

1. 요청 원문으로 추적하고 정본을 하나씩만 둔다.
2. 검사를 통과해야 머지·출시하고, Fix 와 Check 를 다른 AI 가 맡는다.
3. 사람은 정해진 확인 지점에서 방향과 결과를 반드시 확인한다.
4. 잰 것과 못 잰 것을 나눠 사실로 보고하고, 배운 것은 다음 일에 쓰도록 남긴다.
5. 진행은 시간 칸이 아니라 실제 작업으로 본다. 끝나면 바로 다음, 막히면 쪼개 병렬로 — 순차로 더하지 않는다.

## 관련

`b3os-bwf` · `b3os-task-loop` · `b3os-github-workflow` · `b3os-release-ops` · `b3os-verification` · `b3os-ai-code-safety` · `b3os-harness-playbook` · `b3os-team-learning-loop`

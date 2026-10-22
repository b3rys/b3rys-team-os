---
name: b3os-sf
description: "b3os SF(Software Factory) — 프로젝트 방법론. b3rys 팀원이 ★프로젝트★(단순 리서치·프로토가 아닌, 팀장 요구가 여러 번 쌓이는 일)를 맡았을 때 항상 하는 관리·보고 스킬. 팀장 지시를 빠짐없이 목록으로 잡고(TODO.md 정본), 칸반 카드와 맞추고, 채널별(텔레그램·슬랙·팀버스·저장소) 정해진 모양으로 보고한다. 사용 시점 — 팀장이 '목록으로 관리해', '정리해서 보내봐', '다 처리했어?' 라고 할 때, 프로젝트 킥오프·마일스톤·인계 때."
owner: steve
trigger: run a project (many lead requests over time)
---

# b3os SF (Software Factory) — 프로젝트 방법론

## 목적

SF는 결과물 품질·과제 수행 시간·과제 수행 토큰량을 함께 잰다. RSI(반복적 자기개선)를 위한 환경·프로세스·라이브러리를 구축해 세 지표를 계속 개선한다. 10-05 개발 배포 검사는 19분에서 4분 46초로 줄었다(시간 지표). 측정법: [`references/knowledge-and-handoff.md`](references/knowledge-and-handoff.md#핵심-지표)

**작업시간 산출방법** — ETA·소요 시간은 남의 말(팀원의 사전 예상, 이전 메시지의 숫자)이 아니라 같은 종류 과제가 실제로 걸린 시간을 기준으로 한다. 말하기 전에 그 실제 시간(실행 기록 파일·스레드 시각 등)을 확인하고, 이미 있는 도구·데이터를 다시 쓰면 그만큼 줄인다. 실제 기록이 없으면 '추정'이라고 밝힌다.

## 언제 작동?

팀장 요구가 여러 번 쌓이는 앱·서비스·긴 기능과 그 프로젝트의 킥오프, 마일스톤, 배포본 전달, 인계에 쓴다. 단발 리서치·프로토는 `b3os-task-loop` 카드 하나로 관리한다.

## 단계 지도

```text
시작 ──> 개발 ──> 출시 ──> 운영
  ^        │        │        │
  └────────┴── 지식 <────────┘
```

★ 팀장 확인: 첫 기능 목록 · 초기 설계 · 머지 승인 · 실사용 확인.

### 1. 시작

요구 원문을 목록으로 잡고 바꾸기 비싼 구조만 설계한 뒤, 저장소·문서·지속적 통합(CI)·칸반·에이전트 팀의 최소 뼈대를 만든다. 상세: [`references/start.md`](references/start.md)

### 2. 개발

요청마다 `요청 → 만들기 → 검사 → 리뷰 → 머지 승인 → 내보내기 → 보고 → 배우기`를 돈다. 구조 가드와 진행 점검은 개발 순환 안에서 함께 적용한다. 상세: [`references/development.md`](references/development.md)

기능을 바꾸는 커밋에는 그 변경의 릴리즈 노트(`docs/release-notes/<다음 버전>.md`)와 `FEATURES.md` 갱신을 같이 넣는다. 출고 때 몰아서 쓰지 않는다 — 문서가 기억보다 정확한 정본이 되게.

개발 속도는 구조화와 변경 영향 범위에 맞춘 검사 단계로 확보한다. 공유 기계에서는 검사 순번과 자동 재검사를 제어하고, 기다리는 동안 헤드리스 작업을 겹쳐 돌린다. 상세: [`references/dev-mode-operations.md`](references/dev-mode-operations.md)

AI 팀이 기능을 만들 때 지키는 11개 코딩 원칙과 점검법: [`references/ai-team-coding-guidelines.md`](references/ai-team-coding-guidelines.md)

상태 × 입력 조합이 많은 기능(편집기 키 처리, 화면 모드, 동기화 상태)은 처음부터 "판정 함수 하나 + 상태표 + 작은 실행 함수"로 짠다. 고쳤더니 다른 곳이 깨지면 증상을 더 막지 말고 같은 판단을 하는 곳이 몇 군데인지부터 센다. 상태표는 만능이 아니다 — 판정 함수 하나·표 밖 if 금지·칸마다 시험과 함께 써야 효과가 난다. 방법·장단점: `b3os-ai-code-safety` 의 "상태 × 입력이 많으면 상태표로".

구조 정리(리팩터링)는 신호가 보일 때 앱 전체 지도로 재고, 위험 순으로 옮기고, 래칫으로 지킨다. 구현 첫날부터 지킬 구조 규칙은 시작 단계에 둔다. 상세: [`references/structure-refactor.md`](references/structure-refactor.md) · [`references/start.md`](references/start.md#구현-첫날부터-지킬-구조-규칙)

### 3. 출시

검사·리뷰를 통과한 산출물만 내보내고, 요구사항별로 자동 시험·앱 화면·못 본 것을 나눠 보고한다. 채널별 형식과 빌드 전달 절차를 따른다. 상세: [`references/release.md`](references/release.md)

바깥 사용자에게 처음 여는 오픈(베타·알파)은 단계 체크리스트를 TODO.md 로 옮겨 하나씩 닫는다 — 기준선·초대·릴리즈 노트·사용 통계(익명 설치 ID)·대시보드 접근·개인정보 안내·피드백·오픈 전 검수. 상세: [`references/launch-and-stats.md`](references/launch-and-stats.md)

출고는 모드(dev·hotfix·fix·full)를 먼저 정한다. 전체 시험(full)은 필요성을 말하고 팀장 승인을 받은 뒤에만 돈다. 모드별로 도는 시험·시간 상한·승인자: `b3os-verification` §1b.

### 4. 운영

가용성·성능·오류를 감시하고, 장애는 영향 제한과 복구를 먼저 한 뒤 수정 요청으로 개발 순환에 돌려보낸다. 정비와 사용자 피드백도 같은 순환으로 관리한다. 상세: [`references/operations.md`](references/operations.md)

### 5. 지식·종료

TODO·기능·설계·검증 근거를 정본에 갱신하고, 재사용 가능한 교훈을 프로젝트와 팀 지식에 남긴다. 인계와 종료 때 잰 것과 못 잰 것을 구분한다. 상세: [`references/knowledge-and-handoff.md`](references/knowledge-and-handoff.md)

## 공통 원칙

1. 요청 원문으로 추적하고 정본을 하나씩만 둔다.
2. 검사가 머지와 출시를 막으며, 만든 AI와 리뷰하는 AI를 나눈다.
3. 사람은 정해진 확인 지점에서 방향과 결과를 반드시 확인한다.
4. 잰 것과 못 잰 것을 나눠 사실로 보고하고, 배운 것은 다음 일의 입력으로 남긴다.

## 관련

`b3os-bwf` · `b3os-task-loop` · `b3os-github-workflow` · `b3os-release-ops` · `b3os-verification` · `b3os-harness-playbook` · `b3os-team-learning-loop`

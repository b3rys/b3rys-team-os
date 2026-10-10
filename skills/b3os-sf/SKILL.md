---
name: b3os-sf
description: "b3os SF(Software Factory) — 프로젝트 방법론. b3rys 팀원이 ★프로젝트★(단순 리서치·프로토가 아닌, 팀장 요구가 여러 번 쌓이는 일)를 맡았을 때 항상 하는 관리·보고 스킬. 팀장 지시를 빠짐없이 목록으로 잡고(TODO.md 정본), 칸반 카드와 맞추고, 채널별(텔레그램·슬랙·팀버스·저장소) 정해진 모양으로 보고한다. 사용 시점 — 팀장이 '목록으로 관리해', '정리해서 보내봐', '다 처리했어?' 라고 할 때, 프로젝트 킥오프·마일스톤·인계 때."
owner: steve
trigger: run a project (many lead requests over time)
---

# b3os SF (Software Factory) — 프로젝트 방법론

> **검증은 BEFORE** — 머지·배포·"됐다" 보고 전에 여섯 줄을 훑는다(팀장님 10-10 · 2026-10-09 노트 바꾸기 속도 작업에서 나온 순서).
> - **B 진짜 그것인가** — 띄운 앱·잰 바이너리가 그 커밋인가(경로·mtime·sha). 10-09 바이섹트가 매번 같은 최신 앱을 재서 "코드 탓 아님"이라 틀리게 보고했다.
> - **E 같은 조건 전후** — 성공 기준·허용 오차를 재기 전에 정하고, 같은 부하·같은 데이터로 전과 후를 잰다.
> - **F 큰 차이부터 쪼개 좁히기** — 느리거나 틀린 결과를 메인 로직의 큰 덩어리로 나눠 각각 재고, 가장 큰 덩어리부터 다시 나눈다.
> - **O 일부러 깨 보기 + 다른 눈** — 고친 부분을 되돌리면 시험이 실패하는지(뮤턴트) 보고, 별도 리뷰어가 낡은 캐시·순서 역전·종료 유실·빠진 상태를 본다. 근거: [`b3os-verification` §4](../b3os-verification/SKILL.md).
> - **R 화면으로 확인** — 화면이 있는 제품은 빌드 통과가 아니라 사진·픽셀 비교로 본다(라이트·다크).
> - **E 임시 코드 지우기** — 측정·진단용 코드를 되돌린 뒤 정상 코드로 한 번 더 재고, 저장소 검색 0건을 확인한다.
>
> **주의** — '0건'은 잰 범위까지 적는다("없다"와 "조건이 안 생겼다"는 다르다) · 미검증·건너뜀·판정 못 함을 통과로 쓰지 않는다(분류: [`b3os-verification` §5](../b3os-verification/SKILL.md)) · 팀원의 "했다"도 직접 조회한다 · 검사 결과와 실행(머지·배포)을 한 명령에 묶지 않는다 · 재시작 전 돌고 있는 빌드를 확인한다.

## 목적

SF는 결과물 품질·과제 수행 시간·과제 수행 토큰량을 함께 잰다. RSI(반복적 자기개선)를 위한 환경·프로세스·라이브러리를 구축해 세 지표를 계속 개선한다. 10-05 개발 배포 검사는 19분에서 4분 46초로 줄었다(시간 지표). 측정법: [`references/knowledge-and-handoff.md`](references/knowledge-and-handoff.md#핵심-지표)

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

개발 속도는 구조화와 변경 영향 범위에 맞춘 검사 단계로 확보한다. 공유 기계에서는 검사 순번과 자동 재검사를 제어하고, 기다리는 동안 헤드리스 작업을 겹쳐 돌린다. 상세: [`references/dev-mode-operations.md`](references/dev-mode-operations.md)

AI 팀이 기능을 만들 때 지키는 11개 코딩 원칙과 점검법: [`references/ai-team-coding-guidelines.md`](references/ai-team-coding-guidelines.md)

구조 정리(리팩터링)는 신호가 보일 때 앱 전체 지도로 재고, 위험 순으로 옮기고, 래칫으로 지킨다. 구현 첫날부터 지킬 구조 규칙은 시작 단계에 둔다. 상세: [`references/structure-refactor.md`](references/structure-refactor.md) · [`references/start.md`](references/start.md#구현-첫날부터-지킬-구조-규칙)

### 3. 출시

검사·리뷰를 통과한 산출물만 내보내고, 요구사항별로 자동 시험·앱 화면·못 본 것을 나눠 보고한다. 채널별 형식과 빌드 전달 절차를 따른다. 상세: [`references/release.md`](references/release.md)

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

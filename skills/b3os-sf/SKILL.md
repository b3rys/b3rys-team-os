---
name: b3os-sf
description: "b3os SF(Software Factory) — 프로젝트 방법론. b3rys 팀원이 ★프로젝트★(단순 리서치·프로토가 아닌, 팀장 요구가 여러 번 쌓이는 일)를 맡았을 때 항상 하는 관리·보고 스킬. 팀장 지시를 빠짐없이 목록으로 잡고(TODO.md 정본), 칸반 카드와 맞추고, 채널별(텔레그램·슬랙·팀버스·저장소) 정해진 모양으로 보고한다. 사용 시점 — 팀장이 '목록으로 관리해', '정리해서 보내봐', '다 처리했어?' 라고 할 때, 프로젝트 킥오프·마일스톤·인계 때."
owner: steve
trigger: run a project (many lead requests over time)
---

# b3os SF (Software Factory) — 프로젝트 방법론

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

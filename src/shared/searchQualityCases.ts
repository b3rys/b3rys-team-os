// 팀 검색(TeamSearch) 화면에 보여주는 ★예시 질의★ 시드.
//
// ★공개 제품에 나가는 화면 데이터다 — 특정 팀의 실제 운영 데이터를 넣지 마라.★
// 원래는 우리 팀의 실제 장애·멤버(실명, 실제 인시던트)가 그대로 들어 있었고, TeamSearch 가 이걸
// 예시 질의 패널로 렌더링해서 ★공개 사용자 화면에 남의 팀 내부 이슈가 보였다.★ (2026-07-12)
// 그래서 '어떤 b3os 팀이든 그대로 말이 되는' 일반 예시로 바꿨다. 팀원 이름은 예시 이름(Alice/Bob…)만 쓴다.
//
// 평가용 데이터가 필요하면 이 파일이 아니라 별도(비공개) 픽스처로 두어라 —
// 이건 UI 예시일 뿐이고, 서버·평가 스크립트는 이 시드를 참조하지 않는다.
export type SearchQualitySeedCategory =
  | "ops"
  | "routing"
  | "tasks"
  | "docs"
  | "quality"
  | "member";

export interface SearchQualitySeed {
  id: string;
  category: SearchQualitySeedCategory;
  owner: string;
  query: string;
  intent: string;
  expectedHint: string;
  mustNotHint: string;
}

export const SEARCH_QUALITY_SEEDS: SearchQualitySeed[] = [
  // ── 운영/장애 ────────────────────────────────────────────────
  {
    id: "ops-member-no-reply",
    category: "ops",
    owner: "Example",
    query: "팀원이 응답을 안 함 원인",
    intent: "팀원이 조용할 때 무엇부터 확인해야 하는지 찾는다.",
    expectedHint: "런타임 상태, 세션/게이트웨이 로그, 재시작 절차",
    mustNotHint: "원인을 안 보고 무작정 재시작만 반복",
  },
  {
    id: "ops-server-down",
    category: "ops",
    owner: "Example",
    query: "대시보드가 안 열림 서버 확인",
    intent: "서버가 떠 있는지, 어떻게 다시 띄우는지 찾는다.",
    expectedHint: "health 엔드포인트, 서버 기동 커맨드, 로그 위치",
    mustNotHint: "설정 파일을 먼저 바꿔보라는 식의 추측성 조치",
  },
  {
    id: "ops-restart-procedure",
    category: "ops",
    owner: "Example",
    query: "팀원 재시작 방법과 주의점",
    intent: "재시작이 무엇을 잃고 무엇을 보존하는지 확인한다.",
    expectedHint: "재시작 시 컨텍스트 유지/초기화 차이, 진행 중 작업 영향",
    mustNotHint: "재시작하면 아무것도 안 잃는다는 단정",
  },
  {
    id: "ops-startup-failure",
    category: "ops",
    owner: "Example",
    query: "설치 후 첫 기동 실패",
    intent: "처음 띄울 때 자주 걸리는 지점을 찾는다.",
    expectedHint: "의존성 설치, 환경변수(.env), 포트 충돌",
    mustNotHint: "에러 메시지를 확인하지 않고 재설치부터 권하는 안내",
  },

  // ── owner/라우팅 ─────────────────────────────────────────────
  {
    id: "routing-who-owns",
    category: "routing",
    owner: "Example",
    query: "담당자가 지정되지 않은 메시지는 누가 받나",
    intent: "owner 미지정 시의 기본 담당자 규칙을 찾는다.",
    expectedHint: "기본 담당자(coordinator) 규칙, 팀 리드로의 fallback",
    mustNotHint: "아무나 먼저 답하면 된다는 해석",
  },
  {
    id: "routing-mention",
    category: "routing",
    owner: "Example",
    query: "멘션하면 그 팀원만 답하나",
    intent: "멘션 기반 라우팅 규칙을 확인한다.",
    expectedHint: "@멘션 우선순위, 다중 멘션 처리",
    mustNotHint: "멘션과 무관하게 전원이 답한다는 해석",
  },
  {
    id: "routing-handoff",
    category: "routing",
    owner: "Example",
    query: "일을 넘길 때 담당이 언제 바뀌나",
    intent: "핸드오프(담당 이관) 성립 조건을 찾는다.",
    expectedHint: "인계 확인(ack) 전에는 담당이 넘어가지 않음",
    mustNotHint: "답장 한 번으로 담당이 자동 변경된다는 해석",
  },
  {
    id: "routing-context",
    category: "routing",
    owner: "Example",
    query: "팀방 대화 맥락은 누가 보나",
    intent: "팀 전체 맥락을 받는 팀원이 누구인지 확인한다.",
    expectedHint: "팀 리드(full_context) 만 팀방 맥락 수신, 나머지는 자기 메시지",
    mustNotHint: "모든 팀원이 항상 모든 대화를 본다는 설명",
  },

  // ── 태스크/칸반 ──────────────────────────────────────────────
  {
    id: "tasks-my-open",
    category: "tasks",
    owner: "Example",
    query: "내가 맡은 진행 중인 일",
    intent: "담당자 기준으로 열린 과제를 모은다.",
    expectedHint: "담당자 필터, 진행중 상태 카드",
    mustNotHint: "완료된 카드까지 섞어서 보여주기",
  },
  {
    id: "tasks-blocked",
    category: "tasks",
    owner: "Example",
    query: "막혀 있는 과제와 이유",
    intent: "블로커가 무엇이고 누구를 기다리는지 찾는다.",
    expectedHint: "대기 대상(waiting_on), 다음 액션, 재개 조건",
    mustNotHint: "블로커 없이 '진행 중'이라고만 표시",
  },
  {
    id: "tasks-next-action",
    category: "tasks",
    owner: "Example",
    query: "다음에 뭘 해야 하나",
    intent: "카드에 적힌 다음 액션을 찾는다.",
    expectedHint: "다음 액션 · 재개 시각 · 완료 기준",
    mustNotHint: "카드 제목만 보고 임의로 다음 일을 만들어내기",
  },
  {
    id: "tasks-done-criteria",
    category: "tasks",
    owner: "Example",
    query: "이 과제는 언제 완료인가",
    intent: "완료 기준(stop rule)을 확인한다.",
    expectedHint: "완료 기준, 검증 방법",
    mustNotHint: "코드만 작성되면 완료라는 해석",
  },

  // ── 문서/정본 ────────────────────────────────────────────────
  {
    id: "docs-canonical-rule",
    category: "docs",
    owner: "Example",
    query: "팀 규칙 정본은 어디에 있나",
    intent: "규칙의 단일 출처(정본)를 찾는다.",
    expectedHint: "팀 규칙 파일 위치, 정본과 사본의 구분",
    mustNotHint: "사본/요약본을 정본으로 인용",
  },
  {
    id: "docs-setup-guide",
    category: "docs",
    owner: "Example",
    query: "처음 설치하고 팀원 영입하는 방법",
    intent: "온보딩 절차를 순서대로 찾는다.",
    expectedHint: "설치 → 팀 기본정보 → 첫 팀원 영입 순서",
    mustNotHint: "영입부터 하고 팀 설정을 나중에 하라는 안내",
  },
  {
    id: "docs-runtime-choice",
    category: "docs",
    owner: "Example",
    query: "런타임은 어떤 걸 골라야 하나",
    intent: "런타임별 차이와 선택 기준을 찾는다.",
    expectedHint: "런타임별 설치 난이도·인증 요건 비교",
    mustNotHint: "모든 런타임이 동일하다는 설명",
  },
  {
    id: "docs-changelog",
    category: "docs",
    owner: "Example",
    query: "이 기능이 언제 왜 바뀌었나",
    intent: "변경 이력과 결정 근거를 찾는다.",
    expectedHint: "커밋/결정 기록, 변경 이유",
    mustNotHint: "근거 없이 '원래 그렇다'는 답",
  },

  // ── 검색 품질 ────────────────────────────────────────────────
  {
    id: "quality-not-found",
    category: "quality",
    owner: "Example",
    query: "분명히 있었던 내용이 검색이 안 됨",
    intent: "누락 원인(색인/범위/표현 차이)을 찾는다.",
    expectedHint: "색인 범위, 동의어/표현 차이, 검색 모드",
    mustNotHint: "'없는 내용'이라고 단정",
  },
  {
    id: "quality-too-many",
    category: "quality",
    owner: "Example",
    query: "결과가 너무 많아서 못 찾겠음",
    intent: "결과를 좁히는 방법을 찾는다.",
    expectedHint: "소스 필터, 기간/담당자 조건",
    mustNotHint: "질의를 더 길게 쓰라고만 안내",
  },
  {
    id: "quality-stale",
    category: "quality",
    owner: "Example",
    query: "옛날 내용이 최신인 것처럼 나옴",
    intent: "최신성 판단 근거를 찾는다.",
    expectedHint: "시점 표시, 최신 결정으로의 갱신 여부",
    mustNotHint: "오래된 문서를 현재 정본처럼 인용",
  },
  {
    id: "quality-evidence",
    category: "quality",
    owner: "Example",
    query: "이 답의 근거가 어디인지",
    intent: "출처를 확인할 수 있는지 본다.",
    expectedHint: "출처 문서·메시지 링크, 인용 위치",
    mustNotHint: "출처 없이 결론만 제시",
  },

  // ── 팀원별 사용 ──────────────────────────────────────────────
  {
    id: "member-onboarding",
    category: "member",
    owner: "Alice",
    query: "새로 온 팀원이 먼저 읽어야 할 것",
    intent: "새 팀원의 첫 컨텍스트를 모은다.",
    expectedHint: "팀 규칙, 현재 진행 중인 과제, 담당 구조",
    mustNotHint: "전체 히스토리를 통째로 읽으라는 안내",
  },
  {
    id: "member-handover",
    category: "member",
    owner: "Bob",
    query: "내가 맡기 전에 이 일이 어떻게 진행됐나",
    intent: "인수인계에 필요한 경과를 찾는다.",
    expectedHint: "이전 담당자의 결정과 남은 이슈",
    mustNotHint: "최신 메시지 하나만 보고 상태를 단정",
  },
  {
    id: "member-decision",
    category: "member",
    owner: "Carol",
    query: "이 결정은 누가 언제 했나",
    intent: "결정의 주체·시점·근거를 찾는다.",
    expectedHint: "결정 메시지, 승인 기록",
    mustNotHint: "논의 중인 의견을 확정된 결정으로 인용",
  },
];

export const SEARCH_QUALITY_CATEGORY_LABELS: Record<SearchQualitySeedCategory, string> = {
  ops: "운영/장애",
  routing: "owner/라우팅",
  tasks: "태스크/칸반",
  docs: "문서/정본",
  quality: "검색 품질",
  member: "팀원별 사용",
};

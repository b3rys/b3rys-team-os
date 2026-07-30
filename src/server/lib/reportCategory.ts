/**
 * 보고서 분류를 ★세 개로만★ 둔다 — 보고서 · 리서치 · 교육자료. (팀장님 지시 2026-07-30)
 *
 * ■ 왜 필요했나
 * `report.category` 가 ★자유 문자열★ 이었다. 올리는 사람이 아무 값이나 적을 수 있어서 같은 뜻이
 * 표기별로 갈렸다 — 실측(48건): 리서치 9 · research 4 · AI 리서치 1 · AI Research 1 · 교육자료 5 ·
 * english-learning 1 · 가이드 1 · 보고서 2 · ★빈 값 24★. 화면에 알약이 9개로 늘어 두 줄을 먹었고,
 * 팀장님이 그것을 태그로 오인해 "팀원이 등록한 태그는 내가 삭제/수정도 안돼" 로 신고하셨다.
 * (분류는 보고서에서 집계되는 값이라 지울 실체가 없다 — 그래서 아이콘도 안 붙는다.)
 *
 * ■ 왜 표인가
 * 분기를 늘리는 대신 ★별칭 표★ 하나를 둔다. 새 표기가 생기면 표에 한 줄 추가하면 되고, 판정 코드는
 * 바뀌지 않는다. 그리고 ★읽는 쪽·쓰는 쪽·과거 데이터 정리가 모두 같은 표를 쓴다★ — 세 곳이 갈리면
 * 오늘 같은 상태로 다시 돌아간다.
 *
 * ■ 모르는 값은 '보고서' 로 넣지만 ★조용히 하지 않는다★
 * 팀장님 방침이 "세 개로만" 이라 미지의 값은 보고서로 모은다. 다만 조용히 바꾸면 올린 사람은 자기
 * 분류가 사라진 걸 모른다 — 오늘 하루 우리를 괴롭힌 게 정확히 그 '무증상' 이다. 그래서 한 줄 남긴다.
 */

export const REPORT_CATEGORIES = ["보고서", "리서치", "교육자료"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** 기본 분류 — 빈 값·미지의 값이 모이는 곳. */
export const DEFAULT_REPORT_CATEGORY: ReportCategory = "보고서";

/**
 * 별칭 → 정본. 키는 ★소문자·공백정리된 형태★ 로 둔다(비교 전에 같은 방식으로 다듬는다).
 * 새 표기를 만나면 여기 한 줄만 추가한다.
 */
const CATEGORY_ALIASES: Record<string, ReportCategory> = {
  "보고서": "보고서",
  "report": "보고서",
  "reports": "보고서",
  "가이드": "교육자료",        // 가르치는 성격이라 교육자료로 본다 (팀장님 확인 요청해 둠)
  "guide": "교육자료",
  "교육자료": "교육자료",
  "education": "교육자료",
  "english-learning": "교육자료",
  "리서치": "리서치",
  "research": "리서치",
  "ai 리서치": "리서치",
  "ai research": "리서치",
  "ai리서치": "리서치",
};

function normalizeKey(raw: string): string {
  // 전각 공백·연속 공백까지 하나로 — "AI  Research" 와 "ai research" 가 갈리지 않게.
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * 어떤 문자열이든 세 분류 중 하나로 접는다.
 * @param raw 사용자·스크립트가 넣은 원본(빈 값·null 허용)
 * @param onFallback 표에 없어서 기본값으로 접을 때 부르는 훅(로그·감사용). 빈 값에는 부르지 않는다 —
 *                   빈 값은 '분류를 안 적었다' 는 정상 상태이고 미지의 표기와 다르다.
 */
export function canonicalCategory(
  raw: string | null | undefined,
  onFallback?: (original: string) => void,
): ReportCategory {
  const key = normalizeKey(String(raw ?? ""));
  if (!key) return DEFAULT_REPORT_CATEGORY;
  const hit = CATEGORY_ALIASES[key];
  if (hit) return hit;
  onFallback?.(String(raw));
  return DEFAULT_REPORT_CATEGORY;
}

/** 표에 등록된 별칭 전부 — 과거 데이터 정리 스크립트가 무엇을 덮는지 보여줄 때 쓴다. */
export function knownCategoryAliases(): Array<[string, ReportCategory]> {
  return Object.entries(CATEGORY_ALIASES);
}

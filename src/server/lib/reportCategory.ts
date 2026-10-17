// 읽기·쓰기·기존 데이터 정리에 같은 별칭 표를 사용해 분류가 갈리지 않게 한다. 미지 값은 보고서로 모으되 원래 분류가 사라진 사실은 기록한다.

export const REPORT_CATEGORIES = ["보고서", "리서치", "교육자료"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** 기본 분류 — 빈 값·미지의 값이 모이는 곳. */
export const DEFAULT_REPORT_CATEGORY: ReportCategory = "보고서";

/**
 * 별칭 → 정본. 키는 소문자·공백정리된 형태 로 둔다(비교 전에 같은 방식으로 다듬는다).
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

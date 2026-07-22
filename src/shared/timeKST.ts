/**
 * KST(Asia/Seoul) 시각 표시 — 단일 정본.
 *
 * 근본원인(OWNER 2026-06-13, "매번 틀림"): DB의 created_at 등은 SQLite `datetime('now')` =
 * UTC를 tz suffix 없이 저장한다("YYYY-MM-DD HH:MM:SS"). 이걸 변환 없이 표시하거나
 * `new Date(...)`에 그대로 넘기면 (a) 브라우저 로컬 타임존을 따라가거나 (b) 문자열을
 * 로컬로 오해석해 매번 어긋난다. formatKST는 입력을 항상 UTC로 못박은 뒤 Asia/Seoul
 * 로 고정 변환한다. 모든 날짜 표시는 이 함수 하나만 쓴다(한 곳 관리 → 재발 방지).
 */

/** 입력 문자열을 tz가 명시된 ISO로 정규화. SQLite UTC·tz없는 ISO는 UTC(Z)로 못박는다. */
function toUtcIso(ts: string): string {
  const s = ts.trim();
  // SQLite 'YYYY-MM-DD HH:MM:SS(.sss)' (UTC, tz 없음) → 'T' + 'Z'
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?/.test(s)) {
    return s.replace(" ", "T") + "Z";
  }
  // ISO인데 tz 표기(Z/+09:00)가 없으면 UTC로 간주
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/([Zz]|[+-]\d{2}:?\d{2})$/.test(s)) {
    return s + "Z";
  }
  // 이미 tz 명시(Z/offset) → 그대로
  return s;
}

export interface KSTOpts {
  /** 연도 포함 (기본 false: 'MM-DD HH:MM') */
  year?: boolean;
  /** 초 포함 (기본 false) */
  seconds?: boolean;
  /** 날짜 생략하고 시:분만 (기본 false) */
  timeOnly?: boolean;
}

/**
 * UTC/ISO 타임스탬프를 KST 표시 문자열로. 파싱 실패 시 원문을 그대로 반환(안전).
 * 기본 포맷: "MM-DD HH:MM" (24h, Asia/Seoul).
 */
export function formatKST(ts: string | null | undefined, opts: KSTOpts = {}): string {
  if (!ts) return "";
  const d = new Date(toUtcIso(ts));
  if (Number.isNaN(d.getTime())) return ts; // 못 읽으면 원문 유지

  const dateFmt = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    ...(opts.year ? { year: "numeric" as const } : {}),
    month: "2-digit",
    day: "2-digit",
  });
  const timeFmt = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    ...(opts.seconds ? { second: "2-digit" as const } : {}),
    hour12: false,
  });

  // ko-KR date는 "06. 13." 식 → 깔끔히 "MM-DD"로 정규화
  const datePart = dateFmt
    .format(d)
    .replace(/\.\s*/g, "-")
    .replace(/-$/, "")
    .replace(/^(\d{4})-/, "$1-"); // 연도 포함시 'YYYY-MM-DD' 유지
  const timePart = timeFmt.format(d).replace(/^24:/, "00:");

  if (opts.timeOnly) return timePart;
  return `${datePart} ${timePart}`;
}

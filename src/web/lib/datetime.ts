// 공유 날짜/시각 유틸 — SQLite 타임스탬프를 뷰어의 로컬 타임존으로 정확히 렌더.
//   SQLite datetime('now') 은 타임존 없는 UTC 문자열("YYYY-MM-DD HH:MM:SS") 을 저장한다.
//   JS `new Date("2026-07-04 14:00:00")` 은 이를 로컬(KST) 로 해석 → UTC 로 명시(Z)하지 않으면 9시간 오차.
//   (GD 발견 2026-07-04.) 각 컴포넌트가 복제하던 parseSqliteDate 를 단일 출처로 통합한다.
import { getLocale } from "../i18n";

/**
 * SQLite 타임스탬프 문자열을 Date 로 파싱한다.
 * "YYYY-MM-DD[ T]HH:MM:SS…" 형태면 공백을 "T" 로 바꾸고, Z/+ 오프셋이 없을 때 "Z" 를 붙여 UTC 로 명시 파싱.
 * 그 외 문자열은 그대로 new Date 에 넘긴다. 파싱 실패(NaN) 또는 null 입력 시 null.
 */
export function parseSqliteDate(s: string | null): Date | null {
  if (!s) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)
    ? s.replace(" ", "T") + (s.includes("Z") || s.includes("+") ? "" : "Z")
    : s;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * SQLite 타임스탬프를 뷰어의 로컬 타임존으로 렌더한다(toLocaleString).
 * 로컬 타임존을 쓰므로 GD(KST) 뿐 아니라 어떤 사용자 브라우저에서도 올바른 현지 시각으로 보인다.
 * null/파싱 실패 시 "—".
 */
export function formatLocal(s: string | null, opts?: Intl.DateTimeFormatOptions): string {
  const d = parseSqliteDate(s);
  if (!d) return "—";
  const locale = getLocale() === "en" ? "en-US" : "ko-KR";
  try {
    return d.toLocaleString(locale, opts);
  } catch {
    return d.toLocaleString(undefined, opts);
  }
}

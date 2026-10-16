// DB 시각은 시간대 표시가 없어도 UTC이므로 공통 파서로 읽는다. 상대 시각으로 표시해 수신자의 별도 시간대 계산을 줄인다.

// 시간대 없는 DB 값에만 Z를 붙인다. envelope의 오프셋 ISO에 다시 붙이면 파싱할 수 없다.
export function parseDbUtc(createdAt: string): number {
  const s = createdAt.trim();
  // 이미 시간대가 명시돼 있으면 그대로 파싱한다 (Z 또는 ±HH:MM)
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return Date.parse(s);
  // 시간대 표시가 없다 = 원본 DB 형식 = UTC → Z 를 붙여 명시한다
  return Date.parse(s.replace(" ", "T") + "Z");
}

/** "방금" · "5분 전" · "3시간 전" · "2일 전" */
export function timeAgo(createdAtUtc: string, now: number = Date.now()): string {
  const t = parseDbUtc(createdAtUtc);
  if (Number.isNaN(t)) return "?";
  const min = Math.floor((now - t) / 60_000);
  if (min < 0) return "방금";      // 시계 밀림 — 미래로 보이면 그냥 '방금'
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

/**
 * epoch(ms) → DB 가 쓰는 UTC 문자열 ("YYYY-MM-DD HH:MM:SS").
 * DB 의 created_at 과 직접 비교하려면 같은 형식·같은 시간대 여야 한다.
 * 손으로 new Date(...).toISOString().slice(...) 하지 마라 — 한 번은 맞아도 다음 사람이 틀린다.
 */
export function toDbUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace("T", " ");
}

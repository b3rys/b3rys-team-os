/**
 * ★시각을 사람 말로 바꾸는 곳 — ★여기 하나뿐이다.★★ (GD 2026-07-13: "시간 잘못쓰면 완전 꼬이니 붙이는 건 다 함수로 처리")
 *
 * ═══ 왜 함수 하나로 강제하나 ═══
 * ★DB 는 UTC 로 저장한다.★ 그런데 JS 의 `new Date("2026-07-13 01:27:41")` 은 그걸 ★로컬 시각★ 으로 읽는다.
 * → KST 머신에서 ★정확히 9시간 거짓말★ 을 한다.
 * 실측(2026-07-13): 대기 시간을 audit 에 남기는데 ★실제 62초를 "9시간"★ 이라고 찍었다.
 * ★내 룰에 그 함정이 적혀 있는데 내가 거기 빠졌다.★ 한 번 빠지면 또 빠진다 —
 * ★그래서 손으로 파싱하지 못하게 하고, 이 함수만 쓰게 한다.★
 *
 * ★상대 시각을 쓴다★ (절대 시각 아님):
 *   · 팀원이 ★시간대를 계산할 필요가 없다★ — 계산하는 순간 또 9시간 틀린다
 *   · "2일 전" 은 ★오해할 여지가 없다★
 */

/**
 * 시각 문자열 → epoch ms. 실패하면 NaN.
 *
 * ★두 가지 형식이 들어온다 — 둘 다 받아야 한다.★ (2026-07-13 라이브에서 물렸다)
 *   ① ★원본 DB 형식★ "2026-07-13 01:27:41"  — 시간대 표시가 ★없다★. ★UTC 다.★
 *      → ★"Z" 를 붙여야 한다.★ 안 붙이면 JS 가 ★로컬로 읽어서 KST 에서 9시간 틀린다.★
 *   ② ★envelope 형식★ "2026-07-13T23:56:06+09:00" — rowToEnvelope 가 ★이미 KST 오프셋을 붙여준다.★
 *      → ★여기에 또 "Z" 를 붙이면 깨진다★ ("…+09:00Z" = 파싱 불가 → NaN).
 *
 * ★내가 ①만 보고 만들었다가 라이브에서 시각이 전부 "?" 로 나왔다.★
 * ★유닛 테스트는 초록이었다 — 라이브 형식을 안 먹여봤기 때문이다.★ (커밋 ≠ 동작)
 */
export function parseDbUtc(createdAt: string): number {
  const s = createdAt.trim();
  // ★이미 시간대가 명시돼 있으면 그대로 파싱한다★ (Z 또는 ±HH:MM)
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return Date.parse(s);
  // ★시간대 표시가 없다 = 원본 DB 형식 = UTC★ → Z 를 붙여 명시한다
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
 * ★epoch(ms) → DB 가 쓰는 UTC 문자열★ ("YYYY-MM-DD HH:MM:SS").
 * DB 의 created_at 과 ★직접 비교하려면 같은 형식·같은 시간대★ 여야 한다.
 * ★손으로 new Date(...).toISOString().slice(...) 하지 마라★ — 한 번은 맞아도 다음 사람이 틀린다.
 */
export function toDbUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace("T", " ");
}

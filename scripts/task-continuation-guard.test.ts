/**
 * continuation-guard — 가드가 자기가 시킨 표시를 읽는가
 *
 * 배경: guardBody() 는 "막혔으면 blocked 표시를 description 에 남기라" 고 시키는데,
 * 판정부(stalledDoingCards)는 column/owner/updated_at 만 보고 description 을 아예 읽지
 * 않았다. 시킨 대로 해도 반영되는 경로가 없으니 지킬 수 없는 약속이었고, 재핑이 에피소드
 * 기준이라 ★성실히 갱신하는 blocked 카드일수록 더 자주 핑을 받는★ 역유인까지 있었다.
 */
import { describe, expect, test } from "bun:test";
import { isBlockedCard, stalledDoingCards, guardBody, parseUtc, toUtcIso } from "./task-continuation-guard";

const NOW = Date.parse("2026-07-26T00:00:00Z");
const STALL = 60 * 60 * 1000; // 60분
const OWNERS = new Set(["someone"]);

// updated_at 형식은 실제 DB 와 같은 "YYYY-MM-DD HH:MM:SS"(UTC, TZ 표기 없음).
const agoIso = (ms: number) => new Date(NOW - ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

function card(over: Partial<Parameters<typeof stalledDoingCards>[0][number]> = {}) {
  return {
    id: "c1",
    title: "카드",
    owner: "someone",
    column: "doing" as const,
    description: null as string | null,
    updated_at: agoIso(2 * STALL),
    ...over,
  };
}

describe("blocked 표시 인식", () => {
  test("영어·한국어 표기를 모두 인정한다", () => {
    for (const d of ["blocked on review", "waiting_on GD", "waiting on GD", "승인 대기 중", "차단 중", "보류 중"]) {
      expect(isBlockedCard(card({ description: d }))).toBe(true);
    }
  });

  test("표시가 없으면 blocked 가 아니다", () => {
    expect(isBlockedCard(card({ description: null }))).toBe(false);
    expect(isBlockedCard(card({ description: "다음 액션: 테스트 작성" }))).toBe(false);
  });

  test("★unblocked 를 blocked 로 읽지 않는다★ (부분일치 함정)", () => {
    expect(isBlockedCard(card({ description: "unblocked, 재개함" }))).toBe(false);
  });
});

describe("stall 판정 — 가드가 시킨 표시를 실제로 반영한다", () => {
  test("표시 없는 카드는 기존대로 stallMs 로 걸린다", () => {
    const t = card({ updated_at: agoIso(STALL + 1000) });
    expect(stalledDoingCards([t], OWNERS, NOW, STALL)).toHaveLength(1);
  });

  test("★blocked 표시가 있으면 같은 경과시간에 걸리지 않는다★ (이게 없어서 영구 나그가 났다)", () => {
    const t = card({ updated_at: agoIso(STALL + 1000), description: "blocked — GD 판단 대기" });
    expect(stalledDoingCards([t], OWNERS, NOW, STALL)).toHaveLength(0);
  });

  test("★그래도 면제는 아니다★ — 6배를 넘기면 blocked 카드도 걸린다", () => {
    const t = card({ updated_at: agoIso(6 * STALL + 1000), description: "blocked — GD 판단 대기" });
    expect(stalledDoingCards([t], OWNERS, NOW, STALL)).toHaveLength(1);
  });

  test("doing 이 아니거나 owner 가 대상 밖이면 표시와 무관하게 제외", () => {
    expect(stalledDoingCards([card({ column: "plan" })], OWNERS, NOW, STALL)).toHaveLength(0);
    expect(stalledDoingCards([card({ owner: "other" })], OWNERS, NOW, STALL)).toHaveLength(0);
    expect(stalledDoingCards([card({ owner: null })], OWNERS, NOW, STALL)).toHaveLength(0);
  });
});

test("보류된 doing 카드는 continuation 대상으로 깨우지 않는다", () => {
  const now = Date.parse("2026-08-03T06:00:00Z");
  const card = { id: "held", title: "보류", owner: "codex", column: "doing" as const, description: null, updated_at: "2026-08-01 00:00:00", held_at: "2026-08-02 00:00:00" };
  expect(stalledDoingCards([card], new Set(["codex"]), now, 60_000)).toEqual([]);
});

describe("안내 문구", () => {
  test("표시하면 무엇이 달라지는지 알려준다 — 안 그러면 유인이 서지 않는다", () => {
    const body = guardBody("someone", [card()], 60);
    expect(body).toContain("blocked");
    expect(body).toContain("뜸하게");
  });
});

describe("parseUtc — 시간대 표시자", () => {
  // 문자열로 단정한다. Date.parse 결과는 프로세스 시간대를 타고, 테스트 러너는 UTC 로 돌아서
  // 표시자를 빠뜨려도 결과가 같아진다 — 그러면 이 판정을 검사할 수 없다.

  test("표시자가 없으면 Z 를 붙인다 — 구분자가 공백이든 T 든 같다", () => {
    expect(toUtcIso("2026-07-24 13:31:36")).toBe("2026-07-24T13:31:36Z");
    expect(toUtcIso("2026-07-30T18:10:00")).toBe("2026-07-30T18:10:00Z");
  });

  test("표시자가 있으면 그대로 둔다", () => {
    for (const v of [
      "2026-07-30T18:10:00Z",
      "2026-07-30T18:10:00+09:00",
      "2026-07-30T18:10:00-05:00",
      "2026-07-30T18:10:00+0900",
      "2026-07-30T18:10:00z",
      "2026-07-30T18:10:00.123Z",
      "2026-07-30T18:10Z",
    ]) {
      expect(toUtcIso(v)).toBe(v);
    }
  });

  test("표시자가 없는 변형에도 Z 를 하나만 붙인다", () => {
    expect(toUtcIso("2026-07-30T18:10")).toBe("2026-07-30T18:10Z");
    expect(toUtcIso("2026-07-30T18:10:00.123")).toBe("2026-07-30T18:10:00.123Z");
    expect(toUtcIso("  2026-07-30 18:10:00  ")).toBe("2026-07-30T18:10:00Z");
  });

  test("결과에는 항상 표시자가 있다", () => {
    for (const v of ["2026-07-24 13:31:36", "2026-07-30T18:10:00", "2026-07-30T18:10:00Z"]) {
      expect(toUtcIso(v)).toMatch(/(?:Z|[+-]\d{2}:?\d{2})$/);
    }
  });

  test("빈 값과 파싱 실패는 now 를 돌려준다", () => {
    expect(parseUtc("", 12345)).toBe(12345);
    expect(parseUtc(null, 12345)).toBe(12345);
    expect(parseUtc("not-a-date", 12345)).toBe(12345);
  });
});

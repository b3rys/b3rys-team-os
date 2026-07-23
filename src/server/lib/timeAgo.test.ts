/**
 * ★시각은 한 번 틀리면 전부 틀린다.★ (GD 2026-07-13: "시간 잘못쓰면 완전 꼬이니 붙이는 건 다 함수로 처리")
 *
 * ★DB 는 UTC. JS 의 `new Date("2026-07-13 01:27:41")` 은 그걸 ★로컬★ 로 읽는다 → KST 에서 ★정확히 9시간 거짓말★.★
 * 실측: 대기 시간을 audit 에 남기는데 ★실제 62초를 "9시간"★ 이라고 찍었다.
 * ★룰에 그 함정이 적혀 있는데 거기 빠졌다.★ → 손으로 파싱하지 못하게 하고, 이 함수만 쓴다.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { timeAgo, parseDbUtc } from "./timeAgo";

/** DB 형식(UTC, Z 없음) */
const utc = (isoZ: string) => isoZ.replace("T", " ").replace("Z", "").replace(/\.\d+$/, "");

describe("★UTC 를 로컬로 오독하지 않는다★ (이게 틀리면 9시간 거짓말)", () => {
  // ★주의: `bun test` 는 TZ=UTC 로 돈다 → ★이 환경에서는 그 함정이 재현되지 않는다.★
  //   (라이브는 KST(+0900). `bun -e` 로 재보면 DB 형식을 그냥 파싱했을 때 ★정확히 -9시간★ 나온다)
  //   ★그래서 "환경에 의존하는 비교" 로 테스트하면 안 된다 — 초록인데 라이브에서 틀린다.★
  //   → ★불변식 자체★ 를 못박는다: 우리는 ★반드시 UTC 로 해석한다.★
  it("★DB 형식을 언제나 UTC 로 해석한다★ (TZ 무관 — 이 단언은 어느 머신에서도 같다)", () => {
    expect(parseDbUtc("2026-07-13 01:27:41")).toBe(Date.UTC(2026, 6, 13, 1, 27, 41));
    expect(parseDbUtc("2026-01-01 00:00:00")).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it("★KST 머신이었다면 9시간 어긋났을 값과 다르다★ (함정을 명시적으로 계산해서 비교)", () => {
    const correct = parseDbUtc("2026-07-13 01:27:41");
    const naiveOnKst = Date.UTC(2026, 6, 13, 1, 27, 41) - 9 * 3600_000;  // 로컬(+9) 로 읽었을 때
    expect(correct).not.toBe(naiveOnKst);
    expect(correct - naiveOnKst).toBe(9 * 3600_000);   // ★정확히 9시간★
  });

  it("★실측 재현: 62초를 '9시간' 이라 하지 않는다★", () => {
    const now = Date.parse("2026-07-13T01:28:43Z");
    expect(timeAgo("2026-07-13 01:27:41", now)).toBe("1분 전");   // 62초 → 1분. ★9시간이 아니다★
  });
});

/**
 * ★라이브에서 시각이 전부 "?" 로 나왔다.★ (2026-07-13 — 유닛은 초록이었다)
 *
 * ★원인★: 팀원에게 가는 문맥은 ★원본 DB 행이 아니라 envelope 객체★ 다.
 *   rowToEnvelope(_shared.ts:59) 가 created_at 을 ★이미 KST 오프셋 ISO 로 바꿔서★ 준다:
 *     원본 DB   "2026-07-13 14:56:06"        (시간대 표시 없음 = UTC)
 *     envelope  "2026-07-13T23:56:06+09:00"  (오프셋 명시)
 *   ★내 함수는 ①만 보고 만들어서 ②에 또 "Z" 를 붙였다★ → "…+09:00Z" → 파싱 불가 → "?"
 *
 * ★유닛 테스트가 초록이었던 이유: 라이브 형식을 안 먹여봤다.★
 * ★그래서 이 테스트는 ★두 형식 모두★ 를 먹인다. 실제로 흘러다니는 것을 먹여야 테스트다.★
 */
describe("★라이브 형식 — envelope 은 이미 오프셋이 붙어 있다★", () => {
  const SAME_MOMENT = Date.parse("2026-07-13T14:56:06Z");
  const NOW = SAME_MOMENT + 5 * 60_000;

  it("★원본 DB 형식(시간대 없음 = UTC)★", () => {
    expect(parseDbUtc("2026-07-13 14:56:06")).toBe(SAME_MOMENT);
    expect(timeAgo("2026-07-13 14:56:06", NOW)).toBe("5분 전");
  });

  it("★envelope 형식(+09:00 붙음) — 여기에 또 Z 를 붙이면 NaN 이다★", () => {
    expect(parseDbUtc("2026-07-13T23:56:06+09:00")).toBe(SAME_MOMENT);
    expect(timeAgo("2026-07-13T23:56:06+09:00", NOW)).toBe("5분 전");
  });

  it("★Z 형식도 받는다★", () => {
    expect(parseDbUtc("2026-07-13T14:56:06Z")).toBe(SAME_MOMENT);
  });

  it("★★같은 순간이면 형식이 달라도 같은 값★★ (이게 무너지면 시각이 전부 거짓말이 된다)", () => {
    const a = parseDbUtc("2026-07-13 14:56:06");
    const b = parseDbUtc("2026-07-13T23:56:06+09:00");
    const c = parseDbUtc("2026-07-13T14:56:06Z");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("★사람 말로 옳게 옮긴다★", () => {
  const NOW = Date.parse("2026-07-13T12:00:00Z");
  const ago = (min: number) => timeAgo(utc(new Date(NOW - min * 60_000).toISOString()), NOW);

  it("방금 (1분 미만)", () => expect(ago(0)).toBe("방금"));
  it("분", () => { expect(ago(5)).toBe("5분 전"); expect(ago(59)).toBe("59분 전"); });
  it("시간", () => { expect(ago(60)).toBe("1시간 전"); expect(ago(23 * 60)).toBe("23시간 전"); });
  it("일", () => { expect(ago(24 * 60)).toBe("1일 전"); expect(ago(3 * 24 * 60)).toBe("3일 전"); });

  it("★시계가 밀려 미래로 보여도 터지지 않는다★", () => expect(ago(-10)).toBe("방금"));
  it("★못 읽으면 '?' — 조용히 0 을 내지 않는다★ (0 이면 '방금' 이라고 거짓말한다)", () =>
    expect(timeAgo("이건 시각이 아니다")).toBe("?"));
});

describe("★계약: 시각을 손으로 파싱하지 않는다★", () => {
  it("★wakeDispatcher 는 정본 함수만 쓴다★ — 직접 Date.parse/new Date 로 DB 시각을 읽으면 또 9시간 틀린다", () => {
    const SRC = readFileSync(join(import.meta.dir, "../bus/wakeDispatcher.ts"), "utf8");
    expect(SRC).toMatch(/import { timeAgo(, toDbUtc)? } from "..\/lib\/timeAgo";/);
    // 문맥 라인에 시각을 붙이는 건 ★timeAgo 하나뿐★
    expect(SRC).toContain("${timeAgo(m.created_at)}");
    expect(SRC).not.toMatch(/new Date\(m\.created_at\)/);
  });
});

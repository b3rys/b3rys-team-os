import { describe, expect, test } from "bun:test";
import { formatKST } from "./timeKST";

describe("formatKST — UTC→Asia/Seoul 고정 변환", () => {
  test("SQLite UTC 'YYYY-MM-DD HH:MM:SS' → KST (+9h)", () => {
    // UTC 01:00 → KST 10:00
    expect(formatKST("2026-06-13 01:00:00")).toBe("06-13 10:00");
  });

  test("자정 넘김: UTC 16:30 → 다음날 KST 01:30", () => {
    expect(formatKST("2026-06-12 16:30:00")).toBe("06-13 01:30");
  });

  test("ISO with Z → 동일하게 KST", () => {
    expect(formatKST("2026-06-13T01:00:00Z")).toBe("06-13 10:00");
  });

  test("ISO without tz → UTC로 간주 후 KST", () => {
    expect(formatKST("2026-06-13T01:00:00")).toBe("06-13 10:00");
  });

  test("이미 +09:00 offset → 그대로 KST 해석(이중변환 안 함)", () => {
    expect(formatKST("2026-06-13T10:00:00+09:00")).toBe("06-13 10:00");
  });

  test("year 옵션", () => {
    expect(formatKST("2026-06-13 01:00:00", { year: true })).toBe("2026-06-13 10:00");
  });

  test("seconds 옵션", () => {
    expect(formatKST("2026-06-13 01:00:30", { seconds: true })).toBe("06-13 10:00:30");
  });

  test("timeOnly 옵션", () => {
    expect(formatKST("2026-06-13 01:00:00", { timeOnly: true })).toBe("10:00");
  });

  test("빈/null → 빈 문자열", () => {
    expect(formatKST(null)).toBe("");
    expect(formatKST("")).toBe("");
  });

  test("파싱 불가 → 원문 유지(안전)", () => {
    expect(formatKST("not-a-date")).toBe("not-a-date");
  });
});

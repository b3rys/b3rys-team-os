// 보고서 목록의 형식 배지 — HTML 만 초록 강조, 나머지 형식은 회색 그대로.
import { describe, expect, test } from "bun:test";
import { badgeClass } from "./Reports";

describe("badgeClass", () => {
  test("HTML 은 초록 토큰으로 강조한다(대소문자 무관)", () => {
    for (const t of ["html", "HTML"]) {
      const c = badgeClass(t);
      expect(c).toContain("text-txt-green");
      expect(c).toContain("border-accent-green/30");
      expect(c).toContain("bg-accent-green/10");
    }
  });
  test("MD·PDF 는 회색 테두리 그대로", () => {
    for (const t of ["md", "pdf"]) {
      const c = badgeClass(t);
      expect(c).toContain("text-slate-500");
      expect(c).toContain("border-surface-3");
      expect(c).not.toContain("green");
    }
  });
});

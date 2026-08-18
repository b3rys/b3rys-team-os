import { test, expect, describe } from "bun:test";
import {
  toMarkdownV2, splitForTelegram, toPlain, unitsOf, escapeAll, escapeInCode, hardSplit, TG_LIMIT_UNITS,
} from "./telegramMarkdown";

const FENCE = "```";

describe("MarkdownV2 변환", () => {
  test("★굵게가 별표 글자로 보이던 것★ — **x** 는 *x* 가 된다", () => {
    expect(toMarkdownV2("**중요**")).toBe("*중요*");
  });

  test("제목은 굵게로 바뀐다 — 텔레그램에는 제목 문법이 없다", () => {
    expect(toMarkdownV2("## 오늘 결과")).toBe("*오늘 결과*");
  });

  test("★코드 안은 건드리지 않는다★ — 일괄 치환하면 여기가 망가진다", () => {
    const out = toMarkdownV2("설명 `a_b*c` 끝");
    expect(out).toContain("`a_b*c`");        // 밑줄·별표가 그대로 살아 있다
    expect(out).not.toContain("a\\_b");
  });

  test("코드 펜스도 보호된다 — 안의 예약문자는 이스케이프하지 않는다", () => {
    const md = FENCE + "ts\nconst a = b[0].c!;\n" + FENCE;
    const out = toMarkdownV2(md);
    expect(out).toContain("const a = b[0].c!;");
    expect(out.startsWith(FENCE)).toBe(true);
  });

  test("링크는 주소를 깨지 않고 옮긴다", () => {
    const out = toMarkdownV2("[날씨](https://weather.com/ko-KR/x_y)");
    expect(out).toBe("[날씨](https://weather.com/ko-KR/x_y)");
  });

  test("★남은 예약문자는 전부 이스케이프한다★ — 하나만 빠져도 메시지 전체가 안 나간다", () => {
    const out = toMarkdownV2("판교 날씨(맑음). 기온 28-31도!");
    for (const ch of ["(", ")", ".", "-", "!"]) expect(out).toContain("\\" + ch);
  });

  test("★대조군 — 이스케이프를 걷으면 원문으로 돌아온다★", () => {
    const src = "판교 날씨(맑음). 28-31도!";
    expect(toPlain(toMarkdownV2(src))).toBe(src);
  });

  test("표는 깨뜨리지 않고 글자 그대로 남긴다 — 지원 범위 밖", () => {
    const out = toMarkdownV2("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(toPlain(out)).toContain("| a | b |");
  });
});

describe("길이 초과 — 자르지 않고 나눈다", () => {
  test("한도 이하면 그대로 한 조각", () => {
    expect(splitForTelegram("짧은 답")).toEqual(["짧은 답"]);
  });

  test("★모든 조각이 한도 이내다★", () => {
    const text = Array.from({ length: 400 }, (_, i) => "줄 " + i + " 내용이 제법 길다 ".repeat(2)).join("\n");
    const parts = splitForTelegram(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(unitsOf(p)).toBeLessThanOrEqual(TG_LIMIT_UNITS);
  });

  test("★내용을 잃지 않는다★ — 이어 붙이면 원문의 줄이 다 있다", () => {
    const text = Array.from({ length: 300 }, (_, i) => "line" + i + " " + "x".repeat(30)).join("\n");
    const joined = splitForTelegram(text).join("\n");
    expect(joined).toContain("line0 ");
    expect(joined).toContain("line299 ");
  });

  test("★코드 펜스 중간에서 끊기면 닫고 다시 연다★ — 안 그러면 조각이 parse 거부된다", () => {
    const body = Array.from({ length: 300 }, (_, i) => "code line " + i + " " + "y".repeat(20)).join("\n");
    const parts = splitForTelegram(FENCE + "\n" + body + "\n" + FENCE, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      const fences = (p.match(/```/g) ?? []).length;
      expect(fences % 2, "조각마다 펜스가 짝이 맞아야 한다").toBe(0);
    }
  });

  test("★닫힘 줄에 조각 번호를 붙이지 않는다★ — 붙였다가 parse 거부된 사고가 있었다", () => {
    const body = Array.from({ length: 200 }, (_, i) => "c" + i).join("\n");
    const parts = splitForTelegram(FENCE + "\n" + body + "\n" + FENCE, 500);
    for (const p of parts) {
      const lines = p.split("\n").filter((l) => l.trim().startsWith("```"));
      for (const l of lines) expect(l.trim()).toBe("```");
    }
  });

  test("★이스케이프 뒤 길이로 나눠야 한다★ — 원문이 한도 이하여도 변환 후 넘을 수 있다", () => {
    // 예약문자만 400개면 원문 400, 변환 후 800 이 된다.
    const raw = ".".repeat(400);
    const converted = toMarkdownV2(raw);
    expect(unitsOf(raw)).toBeLessThan(unitsOf(converted));
    const parts = splitForTelegram(converted, 500);
    for (const p of parts) expect(unitsOf(p)).toBeLessThanOrEqual(500);
  });
});

describe("이스케이프 도우미", () => {
  test("코드 안에서는 백슬래시와 백틱만", () => {
    expect(escapeInCode("a_b`c\\d")).toBe("a_b\\`c\\\\d");
    expect(escapeInCode("a_b*c")).toBe("a_b*c");
  });

  test("코드 밖에서는 예약문자 전부", () => {
    expect(escapeAll("a_b")).toBe("a\\_b");
    expect(escapeAll("(x)")).toBe("\\(x\\)");
  });
});

describe("긴 한 줄 — 이스케이프 쌍을 깨지 않는다", () => {
  test("★백슬래시와 그 뒤 글자 사이를 끊지 않는다★ — 끊기면 다음 조각이 통째로 parse 거부된다", () => {
    const line = toMarkdownV2(".".repeat(200)); // "\." 100쌍
    for (const part of hardSplit(line, 41)) {
      const trailing = part.match(/\\+$/)?.[0].length ?? 0;
      expect(trailing % 2, "조각이 홀수 개의 백슬래시로 끝나면 안 된다").toBe(0);
    }
  });

  test("조각을 이어 붙이면 원래 줄 그대로", () => {
    const line = toMarkdownV2("가나다.".repeat(80));
    expect(hardSplit(line, 37).join("")).toBe(line);
  });

  test("한도보다 짧으면 그대로 한 조각", () => {
    expect(hardSplit("짧다", 100)).toEqual(["짧다"]);
  });
});

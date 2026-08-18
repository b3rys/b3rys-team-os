import { test, expect } from "bun:test";
import {
  previewOf, appendLine, renderBubble, fits, retryPlan,
  PREVIEW_MAX, BUBBLE_MAX_UNITS, RETRY_WAIT_MAX_SEC,
} from "./progressLines";

test("★긴 줄은 미리보기 길이로 잘린다★ — 자른 결과도 그 길이를 넘지 않는다", () => {
  const long = "x".repeat(200);
  const out = previewOf(long);
  expect(out.length).toBe(PREVIEW_MAX);
  expect(out.endsWith("…")).toBe(true);
});

test("★경계 너머까지 잰다★ — 39·40·41자", () => {
  expect(previewOf("y".repeat(39)).length).toBe(39);
  expect(previewOf("y".repeat(40)).length).toBe(40);
  expect(previewOf("y".repeat(41)).length).toBe(40); // 41자는 잘린다
  expect(previewOf("y".repeat(40))).not.toContain("…"); // 딱 맞으면 안 자른다
});

test("줄바꿈·연속 공백은 한 칸으로 접힌다 — 여러 줄 명령이 버블을 밀어내지 않는다", () => {
  expect(previewOf("git status\n  --short\t-b")).toBe("git status --short -b");
});

test("★연속 중복은 새 줄을 만들지 않고 세기만 올린다★", () => {
  let lines: ReturnType<typeof appendLine> = [];
  lines = appendLine(lines, "read file.ts");
  lines = appendLine(lines, "read file.ts");
  lines = appendLine(lines, "read file.ts");
  expect(lines.length).toBe(1);
  expect(lines[0]).toEqual({ text: "read file.ts", count: 3 });
  expect(renderBubble("⏳", lines)).toContain("(×3)");
});

test("★대조군 — 사이에 다른 줄이 끼면 접지 않는다★ (연속일 때만 접는다)", () => {
  let lines: ReturnType<typeof appendLine> = [];
  lines = appendLine(lines, "a");
  lines = appendLine(lines, "b");
  lines = appendLine(lines, "a");
  expect(lines.map((l) => l.text)).toEqual(["a", "b", "a"]);
  expect(lines.every((l) => l.count === 1)).toBe(true);
});

test("빈 줄·공백만 있는 줄은 버블에 안 들어간다", () => {
  let lines: ReturnType<typeof appendLine> = [];
  lines = appendLine(lines, "   ");
  lines = appendLine(lines, "\n\t");
  expect(lines).toEqual([]);
});

test("줄이 없으면 버블은 머리글 그대로다 — 빈 줄이 붙지 않는다", () => {
  expect(renderBubble("⏳ 작업 중…", [])).toBe("⏳ 작업 중…");
});

test("★버블 한도를 넘으면 fits 가 false 다★ — 호출자가 새 버블을 연다", () => {
  const header = "⏳ 작업 중…";
  const many = Array.from({ length: 200 }, (_, i) => ({ text: `cmd-${i} ` + "z".repeat(30), count: 1 }));
  expect(renderBubble(header, many).length).toBeGreaterThan(BUBBLE_MAX_UNITS);
  expect(fits(header, many)).toBe(false);
  expect(fits(header, many.slice(0, 5))).toBe(true);
});

test("★한도 경계를 넘겨서 잰다★ — 4032 이하는 담고 초과는 못 담는다", () => {
  const header = "H";
  const fill = (units: number) => [{ text: "q".repeat(units), count: 1 }];
  // 버블 = header + "\n" + "🛠️ " + text. 그 고정분을 뺀 길이로 경계를 만든다.
  const fixed = renderBubble(header, fill(0)).length;
  expect(fits(header, fill(BUBBLE_MAX_UNITS - fixed))).toBe(true);
  expect(fits(header, fill(BUBBLE_MAX_UNITS - fixed + 1))).toBe(false);
});

test("★429 대기 계획 — 짧으면 기다리고 길면 포기한다★ (경계 5초 포함)", () => {
  expect(retryPlan(2)).toEqual({ wait: true, waitMs: 2000 });
  expect(retryPlan(RETRY_WAIT_MAX_SEC)).toEqual({ wait: true, waitMs: 5000 });
  expect(retryPlan(RETRY_WAIT_MAX_SEC + 1)).toEqual({ wait: false, waitMs: 0 });
  expect(retryPlan(0)).toEqual({ wait: false, waitMs: 0 });
});

import { test, expect, describe } from "bun:test";
import {
  previewOf, appendLine, renderBubble, fits, retryPlan, iconFor, WORK_ICONS,
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

// ── ★같은 항목은 줄을 새로 만들지 않고 교체한다★ ──
//
// 실측(codex 0.147.0): 웹 검색 항목은 ★시작 때 query="" · action=null★ 로 오고,
// 검색어는 ★완료 때★ 채워진다. 두 시점을 각각 새 줄로 쌓으면 같은 검색이 두 번 일어난 것처럼 보이고,
// 시작 줄만 쓰면 "웹 검색" 에서 영영 멈춘다.
describe("진행 줄 — 항목 id 로 교체", () => {
  test("★같은 id 가 다시 오면 그 자리를 바꾼다★ — 줄이 늘지 않는다", () => {
    let lines = appendLine([], "웹 검색", undefined, "exec-1");
    lines = appendLine(lines, "웹 검색: 판교 날씨", undefined, "exec-1");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("웹 검색: 판교 날씨");
  });

  test("★다른 id 는 각자 줄을 갖는다★ — 검색을 두 번 하면 두 줄이다", () => {
    let lines = appendLine([], "웹 검색", undefined, "exec-1");
    lines = appendLine(lines, "웹 검색", undefined, "exec-2");
    lines = appendLine(lines, "웹 검색: 첫째", undefined, "exec-1");
    lines = appendLine(lines, "웹 검색: 둘째", undefined, "exec-2");
    expect(lines.map((l) => l.text)).toEqual(["웹 검색: 첫째", "웹 검색: 둘째"]);
  });

  test("교체해도 자리는 그대로 — 뒤에 온 줄이 앞으로 튀지 않는다", () => {
    let lines = appendLine([], "웹 검색", undefined, "exec-1");
    lines = appendLine(lines, "생각하는 중");
    lines = appendLine(lines, "웹 검색: 판교 날씨", undefined, "exec-1");
    expect(lines.map((l) => l.text)).toEqual(["웹 검색: 판교 날씨", "생각하는 중"]);
  });

  test("★대조군 — id 가 없으면 예전처럼 쌓이고 연속 중복은 접힌다★", () => {
    let lines = appendLine([], "생각하는 중");
    lines = appendLine(lines, "생각하는 중");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.count).toBe(2);
  });

  test("★id 있는 줄은 연속 중복으로 접지 않는다★ — 접으면 어느 항목인지 잃는다", () => {
    let lines = appendLine([], "웹 검색", undefined, "exec-1");
    lines = appendLine(lines, "웹 검색", undefined, "exec-2");
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.count === 1)).toBe(true);
  });

  test("같은 값으로 다시 오면 아무것도 안 바뀐다 — 헛 편집을 만들지 않는다", () => {
    const first = appendLine([], "웹 검색", undefined, "exec-1");
    const again = appendLine(first, "웹 검색", undefined, "exec-1");
    expect(again).toBe(first);
  });
});

describe("버블 — 머리글은 상태 한 자리, 작업은 그 아래 누적", () => {
  test("★머리글은 남고 작업은 아래에 쌓인다★ — 상태는 거기서 교체된다", () => {
    let lines = appendLine([], "실행: a");
    lines = appendLine(lines, "웹 검색: b");
    const out = renderBubble("🧠 생각하는 중…", lines);
    expect(out.split("\n")[0]).toBe("🧠 생각하는 중…");
    expect(out).toContain("실행: a");
    expect(out).toContain("웹 검색: b");
  });

  test("★대조군 — 아직 작업이 없으면 머리글만★ (빈 메시지는 못 보낸다)", () => {
    expect(renderBubble("⏳ 작업 중…", [])).toBe("⏳ 작업 중…");
  });

  test("★아이콘은 줄마다 돌아간다★ — 같은 그림이 세로로 반복되면 줄 수를 눈으로 못 센다", () => {
    let lines = appendLine([], "a");
    lines = appendLine(lines, "b");
    lines = appendLine(lines, "c");
    const icons = renderBubble("H", lines).split("\n").slice(1).map((l) => l.split(" ")[0]);
    expect(new Set(icons).size).toBe(3);
    expect(icons[0]).toBe(iconFor(0));
  });

  test("★아이콘은 자리 기준이라 다시 그려도 같다★ — 편집마다 바뀌면 화면이 요동친다", () => {
    const lines = appendLine(appendLine([], "a"), "b");
    expect(renderBubble("H", lines)).toBe(renderBubble("H", lines));
  });

  test("아이콘 목록보다 줄이 많으면 처음부터 다시 쓴다", () => {
    expect(iconFor(0)).toBe(iconFor(WORK_ICONS.length));
  });
});

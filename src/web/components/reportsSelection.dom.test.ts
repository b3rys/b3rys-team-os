/** Reports 선택 모드 — 토글과 선택 재렌더의 스크롤 보존 회귀 테스트. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const installedGlobals: string[] = [];
const savedGlobals: Record<string, unknown> = {};
let previousFetch: typeof fetch;

const reports = Array.from({ length: 3 }, (_, index) => ({
  id: `report-${index + 1}`,
  title: `검증 보고서 ${index + 1}`,
  author: "Devon",
  summary: "선택 모드 검증",
  category: "보고서",
  is_important: index === 0,
  created_at: `2026-08-${29 - index} 08:00:00`,
  forms: index === 0 ? ["html", "md"] : ["md"],
}));

beforeAll(() => {
  const globals = globalThis as Record<string, unknown>;
  const window = (globals.window as Window | undefined) ?? new Window({ url: "http://localhost/team?view=reports" });
  for (const [key, value] of [
    ["window", window],
    ["document", window.document],
    ["Element", window.Element],
    ["HTMLElement", window.HTMLElement],
    ["HTMLButtonElement", window.HTMLButtonElement],
    ["MutationObserver", window.MutationObserver],
  ] as const) {
    if (!globals[key]) {
      savedGlobals[key] = globals[key];
      installedGlobals.push(key);
      globals[key] = value;
    }
  }
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;

  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/reports/api/list")) {
      return new Response(JSON.stringify({
        reports,
        next_cursor: null,
        has_more: false,
        total: reports.length,
        total_all: 72,
        important_count: 1,
        category_counts: { "보고서": reports.length },
        tags: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  document.body.innerHTML = "";
});

afterAll(() => {
  globalThis.fetch = previousFetch;
  const globals = globalThis as Record<string, unknown>;
  for (const key of installedGlobals) {
    if (savedGlobals[key] === undefined) delete globals[key];
    else globals[key] = savedGlobals[key];
  }
});

async function renderFixture(): Promise<HTMLElement> {
  const { renderReports } = await import("./Reports");
  const root = document.createElement("div");
  document.body.appendChild(root);
  renderReports(root);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(root.querySelectorAll(".reports-card")).toHaveLength(reports.length);
  return root;
}

describe("Reports selection interactions", () => {
  test("선택 버튼 두 번 클릭 → 체크박스가 나타났다가 사라진다", async () => {
    const root = await renderFixture();
    expect(root.querySelectorAll(".reports-select")).toHaveLength(0);

    root.querySelector<HTMLButtonElement>("#reports-selection-mode")!.click();
    expect(root.querySelectorAll(".reports-select")).toHaveLength(reports.length);
    expect(root.querySelector("#reports-selection-mode")?.textContent).toBe("선택 해제");

    root.querySelector<HTMLButtonElement>("#reports-selection-mode")!.click();
    expect(root.querySelectorAll(".reports-select")).toHaveLength(0);
    expect(root.querySelector("#reports-selection-mode")?.textContent).toBe("선택");
  });

  test("체크박스 클릭 재렌더 전후 scrollTop이 같다", async () => {
    const root = await renderFixture();
    root.querySelector<HTMLButtonElement>("#reports-selection-mode")!.click();
    const scroller = root.querySelector<HTMLElement>("[data-reports-list-scroll]")!;
    scroller.scrollTop = 246;

    root.querySelector<HTMLButtonElement>(".reports-select")!.click();

    expect(root.querySelector<HTMLElement>("[data-reports-list-scroll]")!.scrollTop).toBe(246);
    expect(root.querySelectorAll(".reports-select[aria-pressed='true']")).toHaveLength(1);
  });

  test("필터 결과와 별도로 전체 개수를 표시하고 HTML 배지는 새창으로 연다", async () => {
    const root = await renderFixture();
    expect(root.querySelector("[data-reports-all-count]")?.textContent).toBe("72");
    root.querySelector<HTMLButtonElement>('.reports-form-badge[data-type="html"]')!
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(window.location.hash).toBe("");

    root.querySelector<HTMLButtonElement>('.reports-form-badge[data-type="md"]')!
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(window.location.hash).toBe("#/r/report-1");
  });
});

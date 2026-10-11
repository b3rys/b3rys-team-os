/** Reports 상세의 ⋯ 메뉴 — 바깥 클릭·Esc·미리보기(iframe) 클릭으로 창이 포커스를 잃을 때 닫히는지. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const installedGlobals: string[] = [];
const savedGlobals: Record<string, unknown> = {};

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
});

afterAll(() => {
  const globals = globalThis as Record<string, unknown>;
  for (const key of installedGlobals) globals[key] = savedGlobals[key];
});

describe("Reports 상세 ⋯ 메뉴", () => {
  function setup() {
    document.body.innerHTML = `<details class="reports-more" open><summary>⋯</summary><button id="inside">삭제</button></details><p id="outside">본문</p>`;
    return document.querySelector<HTMLDetailsElement>("details.reports-more")!;
  }

  test("메뉴 안을 누르면 열린 채, 바깥을 누르면 닫힌다", async () => {
    const { bindMoreMenuCloser } = await import("./Reports");
    bindMoreMenuCloser();
    bindMoreMenuCloser(); // 다시 그려도 문서에 리스너가 쌓이지 않는다(두 번 불러도 한 번만 건다)
    const menu = setup();
    document.getElementById("inside")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(menu.open).toBe(true);
    document.getElementById("outside")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(menu.open).toBe(false);
  });

  test("Esc 로 닫힌다", () => {
    const menu = setup();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event);
    expect(menu.open).toBe(false);
  });

  test("창이 포커스를 잃으면(미리보기 iframe 클릭) 닫힌다", () => {
    const menu = setup();
    window.dispatchEvent(new window.Event("blur") as unknown as Event);
    expect(menu.open).toBe(false);
  });
});

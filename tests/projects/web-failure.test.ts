/**
 * 수용 기준 §6-5 화면 쪽 — 서버가 502 {error,key} 를 주면 빈 목록이 아니라 오류+다시 시도,
 * 다시 시도로 회복되고, 그 뒤 실패해도 이전 목록을 비우지 않는다. stale 은 배지로 보인다.
 * DOM 준비는 src/web/components/projects.test.ts 와 같다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import fixture from "../../src/web/fixtures/projects-steno.example.json";

const installed: string[] = []; const saved: Record<string, unknown> = {};
let previousFetch: typeof fetch;
let mode: "ok" | "502" | "stale" = "ok";
let calls = 0;
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  const window = (g.window as Window | undefined) ?? new Window({ url: "http://localhost/team?view=projects" });
  for (const [k, v] of [["window", window], ["document", window.document], ["Element", window.Element], ["HTMLElement", window.HTMLElement], ["HTMLButtonElement", window.HTMLButtonElement], ["MutationObserver", window.MutationObserver]] as const) {
    if (!g[k]) { saved[k] = g[k]; installed.push(k); g[k] = v; }
  }
  (window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (mode === "502") return json({ error: "github_unavailable", key: "branch" }, 502);
    return json({ projects: [{ ...fixture.summary, stale: mode === "stale" }] });
  }) as unknown as typeof fetch;
});
beforeEach(() => { mode = "ok"; calls = 0; window.history.replaceState(null, "", "/team?view=projects"); });
afterEach(() => { document.body.innerHTML = ""; });
afterAll(() => {
  globalThis.fetch = previousFetch;
  const g = globalThis as Record<string, unknown>;
  for (const k of installed) { if (saved[k] === undefined) delete g[k]; else g[k] = saved[k]; }
});
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
async function mount(): Promise<HTMLElement> {
  const { renderProjects, resetProjectsState } = await import("../../src/web/components/Projects");
  resetProjectsState();
  const root = document.createElement("div"); document.body.appendChild(root);
  renderProjects(root); await tick();
  return root;
}
describe("Projects 화면 — GitHub 실패", () => {
  test("첫 로드 502 → 빈 목록이 아니라 오류 문구(error 키 포함)+다시 시도 버튼", async () => {
    mode = "502";
    const root = await mount();
    const err = root.querySelector(".projects-error");
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain("github_unavailable");
    expect(root.querySelectorAll(".projects-row")).toHaveLength(0);
    expect(root.textContent).not.toContain("등록된 프로젝트가 없습니다");
    expect(root.querySelector("#projects-retry")).not.toBeNull();
  });
  test("다시 시도 → 성공하면 목록, 그 뒤 502 가 와도 이전 목록을 비우지 않는다", async () => {
    mode = "502";
    const root = await mount();
    expect(calls).toBe(1);
    mode = "ok";
    root.querySelector<HTMLButtonElement>("#projects-retry")!.click();
    await tick();
    expect(calls).toBe(2);
    expect(root.querySelectorAll(".projects-row")).toHaveLength(1);
    expect(root.querySelector(".projects-error")).toBeNull();
    // 한 번 받은 목록은 세션 안에서 다시 조회하지 않는다(ensureLoaded) — 실패 응답이 목록을 덮을 경로가 없다.
    // (서버 쪽 "캐시 있으면 stale" 은 src/server/routes/projects.test.ts 가 잰다.)
    mode = "502";
    const { renderProjects } = await import("../../src/web/components/Projects");
    renderProjects(root); await tick();
    expect(calls).toBe(2);
    expect(root.querySelectorAll(".projects-row")).toHaveLength(1);
  });
  test("stale:true 는 목록 줄에 stale 배지로 보인다", async () => {
    mode = "stale";
    const root = await mount();
    expect(root.querySelectorAll(".projects-row")).toHaveLength(1);
    expect(root.querySelector(".projects-row")!.textContent).toContain("stale");
  });
});

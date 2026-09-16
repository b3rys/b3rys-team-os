/**
 * Projects 탭 — 목록·문서 화면·TODO 현재 상태·fixture 폴백 (계약 docs/PROJECTS_TAB.md §4).
 * DOM 방식은 reportsSelection.dom.test.ts 와 같다(happy-dom + window.SyntaxError 패치, 심은 전역은 걷는다).
 * 서버 API 는 fetch 를 갈아끼워 흉내낸다 — 실제 서버 응답의 정확성은 tests/ 의 검증자 몫.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import fixture from "../fixtures/projects-steno.example.json";

const installedGlobals: string[] = [];
const savedGlobals: Record<string, unknown> = {};
let previousFetch: typeof fetch;
// 어떤 서버를 흉내낼지 — "api": 계약대로 응답 · "404": 서버 없음
let serverMode: "api" | "404" | "spa" = "api";
const fetchLog: string[] = [];

beforeAll(() => {
  const globals = globalThis as Record<string, unknown>;
  const window = (globals.window as Window | undefined) ?? new Window({ url: "http://localhost/team?view=projects" });
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
    const url = String(input);
    fetchLog.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (serverMode === "404") return new Response("not found", { status: 404 });
    // 빌드된 서버는 모르는 /api 경로에도 SPA 폴백으로 index.html(200, text/html) 을 준다 — 이것도 "API 없음"
    if (serverMode === "spa") return new Response("<!doctype html><title>team</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    const m = url.match(/\/api\/projects(?:\/([^/?]+)(?:\/doc\/([a-z]+)(\/raw)?)?)?(?:\?.*)?$/);
    if (!m) return new Response("not found", { status: 404 });
    const [, id, key, raw] = m;
    if (!id) return json({ projects: [fixture.summary] });
    if (id !== "steno") return json({ error: "unknown project", key: id }, 404);
    if (!key) return json(fixture.summary);
    const doc = (fixture.docs as Record<string, { md: string }>)[key];
    if (!doc) return json({ error: "unknown doc", key }, 404);
    if (raw) return new Response(doc.md, { status: 200, headers: { "content-type": "text/markdown" } });
    return json(doc);
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  serverMode = "api";
  fetchLog.length = 0;
  window.history.replaceState(null, "", "/team?view=projects");
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

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(): Promise<HTMLElement> {
  const { renderProjects, resetProjectsState } = await import("./Projects");
  resetProjectsState();
  const root = document.createElement("div");
  document.body.appendChild(root);
  renderProjects(root);
  await tick();
  return root;
}

describe("Projects 목록", () => {
  test("fixture 로 목록 1줄 — 칩 4개 · 건수 · 지금 과제 · GitHub 링크 새 탭", async () => {
    const root = await mount();
    const rows = root.querySelectorAll(".projects-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-id")).toBe("steno");
    expect(root.querySelectorAll(".projects-chip")).toHaveLength(4);
    expect(root.querySelectorAll("button.projects-chip")).toHaveLength(4); // 4문서 모두 exists=true → 전부 버튼
    expect(root.querySelector('[data-count="doing"]')?.textContent).toBe("3");
    expect(root.querySelector('[data-count="plan"]')?.textContent).toBe("5");
    expect(root.querySelector('[data-count="done"]')?.textContent).toBe("40");
    // 지금 과제 = doingTitles 3 + 칸반 doing 1
    expect(root.querySelectorAll(".projects-tasks li")).toHaveLength(4);
    expect(root.querySelector(".projects-tasks")?.textContent).toContain("[steno] 핵심코드 리뷰");
    const gh = root.querySelector<HTMLAnchorElement>("a.projects-github")!;
    expect(gh.getAttribute("href")).toBe("https://github.com/b3rys/steno");
    expect(gh.getAttribute("target")).toBe("_blank");
    expect(root.textContent).toContain("Vim 을 쓰는 사람을 위한 macOS 마크다운 편집기");
  });

  test("exists=false 문서 칩은 비활성(버튼이 아니다)", async () => {
    const { renderProjects, resetProjectsState } = await import("./Projects");
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      projects: [{ ...fixture.summary, docs: fixture.summary.docs.map((d) => (d.key === "features" ? { ...d, exists: false } : d)) }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    try {
      resetProjectsState();
      const root = document.createElement("div");
      document.body.appendChild(root);
      renderProjects(root);
      await tick();
      expect(root.querySelectorAll("button.projects-chip")).toHaveLength(3);
      const off = root.querySelector('.projects-chip[data-doc="features"]')!;
      expect(off.tagName).toBe("SPAN");
      expect(off.getAttribute("aria-disabled")).toBe("true");
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe("Projects 문서 화면", () => {
  test("DESIGN 칩 → toc 4항목 · 본문 HTML · mermaid 배지 · GitHub blob 링크 · sha 7자 · URL deep-link", async () => {
    const root = await mount();
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    expect(root.querySelectorAll(".projects-toc a")).toHaveLength(fixture.docs.design.toc.length);
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(3);
    // 서버 html 그대로 + mermaid 원문 블록 위 배지
    expect(root.querySelectorAll("#projects-viewer pre.mermaid-src")).toHaveLength(1);
    expect(root.querySelectorAll("#projects-viewer .projects-mermaid-badge")).toHaveLength(1);
    const sha7 = fixture.summary.sha.slice(0, 7);
    expect(root.textContent).toContain(sha7);
    expect(root.querySelector<HTMLAnchorElement>("#projects-open-github")!.getAttribute("href"))
      .toBe(`https://github.com/b3rys/steno/blob/${fixture.summary.sha}/DESIGN.md`);
    const p = new URLSearchParams(window.location.search);
    expect(p.get("view")).toBe("projects");
    expect(p.get("id")).toBe("steno");
    expect(p.get("doc")).toBe("design");
  });

  test("HTML | MD 토글 — MD 는 /raw 를 <pre> 로, 다시 HTML 로 돌아온다", async () => {
    const root = await mount();
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    root.querySelector<HTMLButtonElement>('.projects-mode[data-mode="md"]')!.click();
    await tick();
    expect(fetchLog.some((u) => u.endsWith("/api/projects/steno/doc/design/raw"))).toBe(true);
    const pre = root.querySelector("#projects-viewer pre.projects-raw")!;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toContain("```mermaid");
    expect(root.querySelector('.projects-mode[data-mode="md"]')?.getAttribute("aria-pressed")).toBe("true");
    root.querySelector<HTMLButtonElement>('.projects-mode[data-mode="html"]')!.click();
    await tick();
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(3);
  });

  test("뒤로 → 목록, URL 에서 id·doc 제거", async () => {
    const root = await mount();
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="readme"]')!.click();
    await tick();
    root.querySelector<HTMLButtonElement>("#projects-back")!.click();
    await tick();
    expect(root.querySelectorAll(".projects-row")).toHaveLength(1);
    const p = new URLSearchParams(window.location.search);
    expect(p.get("id")).toBeNull();
    expect(p.get("doc")).toBeNull();
  });

  test("deep-link ?id=steno&doc=design 로 부팅하면 바로 문서 화면", async () => {
    window.history.replaceState(null, "", "/team?view=projects&id=steno&doc=design");
    const root = await mount();
    expect(root.querySelectorAll(".projects-row")).toHaveLength(0);
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(3);
  });
});

describe("TODO 현재 상태", () => {
  test("기본 탭 = 현재 상태: 진행중 doingTitles 3 · 계획(킵 절 제외) · 완료 접힘 · 칸반; 전체 탭 = 원문 HTML", async () => {
    const root = await mount();
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="todo"]')!.click();
    await tick();
    expect(root.querySelector('.projects-todo-tab[data-todo-tab="status"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelectorAll('[data-todo-section="doing"] li')).toHaveLength(3);
    expect(root.querySelector('[data-todo-section="doing"]')?.textContent).toContain("줄번호가 겹친다");
    // fixture TODO.md: `- [ ]` 6줄 중 킵 절 1줄은 plan 에서 뺀다 → 5 (summary.todo.plan 과 같다)
    expect(root.querySelectorAll('[data-todo-section="plan"] li')).toHaveLength(5);
    expect(root.querySelector('[data-todo-section="plan"]')?.textContent).not.toContain("킵 — plan 에 안 센다");
    expect(root.querySelectorAll('[data-todo-section="kanban"] li')).toHaveLength(1);
    // 완료: 건수는 summary(40), 목록은 원문 [x] 5줄(미리보기 5 이내라 더 보기 없음)
    expect(root.querySelector('[data-todo-section="done"]')?.textContent).toContain("40");
    expect(root.querySelectorAll('[data-todo-section="done"] li')).toHaveLength(5);

    root.querySelector<HTMLButtonElement>('.projects-todo-tab[data-todo-tab="all"]')!.click();
    await tick();
    expect(root.querySelectorAll("#projects-viewer .projects-prose h2")).toHaveLength(2);
    expect(root.querySelectorAll('[data-todo-section]')).toHaveLength(0);
  });

  test("parseTodoMd — 킵·승인대기 절의 [ ] 는 plan 에서 빠지고, 60자에서 자른다", async () => {
    const { parseTodoMd } = await import("./Projects");
    const md = [
      "## 일",
      "- [~] 하는 중",
      "- [ ] 할 것",
      "- [x] 한 것",
      "## 📌 킵",
      "- [ ] 킵 항목",
      "### GD 선택 대기",
      "- [ ] 대기 항목",
      "## 다시 일",
      `- [ ] ${"가".repeat(80)}`,
    ].join("\n");
    const r = parseTodoMd(md);
    expect(r.doing).toEqual(["하는 중"]);
    expect(r.done).toEqual(["한 것"]);
    expect(r.plan).toHaveLength(2);
    expect(r.plan[1]).toHaveLength(60);
  });
});

describe("서버 404 폴백", () => {
  test("?fixture=1 이 없으면 404 는 오류 화면(폴백 안 함)", async () => {
    serverMode = "404";
    const root = await mount();
    expect(root.querySelector(".projects-error")).not.toBeNull();
    expect(root.querySelectorAll(".projects-row")).toHaveLength(0);
  });

  test("SPA 폴백(200 text/html)도 API 없음으로 본다 — fixture=1 없으면 오류, 있으면 폴백", async () => {
    serverMode = "spa";
    let root = await mount();
    expect(root.querySelector(".projects-error")).not.toBeNull();
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/team?view=projects&fixture=1");
    root = await mount();
    expect(root.querySelectorAll(".projects-row")).toHaveLength(1);
  });

  test("?fixture=1 이면 404 → fixture 로 목록·문서·MD 원문까지 렌더", async () => {
    serverMode = "404";
    window.history.replaceState(null, "", "/team?view=projects&fixture=1");
    const root = await mount();
    expect(root.querySelectorAll(".projects-row")).toHaveLength(1);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    expect(root.querySelectorAll("#projects-viewer pre.mermaid-src")).toHaveLength(1);
    root.querySelector<HTMLButtonElement>('.projects-mode[data-mode="md"]')!.click();
    await tick();
    expect(root.querySelector("#projects-viewer pre.projects-raw")?.textContent).toContain("# Steno 설계");
  });
});

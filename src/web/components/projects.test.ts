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
    expect(root.querySelector(".projects-tasks")?.textContent).toContain("[steno] 과제 A");
    const gh = root.querySelector<HTMLAnchorElement>("a.projects-github")!;
    expect(gh.getAttribute("href")).toBe("https://github.com/b3rys/steno");
    expect(gh.getAttribute("target")).toBe("_blank");
    expect(root.textContent).toContain(fixture.summary.intro);
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
  test("DESIGN 칩 → 절 탭 3(h1 하나뿐이라 h2 로 자름, 서문 없음) · 첫 절만 본문 · 왼쪽 toc 칸 없음 · GitHub blob 링크 · sha 7자 · URL deep-link", async () => {
    const root = await mount();
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    expect(root.querySelector("#projects-toc")).toBeNull();
    expect(root.querySelector(".projects-toc")).toBeNull();
    const tabs = root.querySelectorAll<HTMLButtonElement>(".projects-sec-tab");
    expect(tabs).toHaveLength(3);
    expect(Array.from(tabs).map((b) => b.textContent)).toEqual(["1. 무엇을 만드나", "2. 시스템 구조", "3. 주요 클래스"]);
    expect(tabs[0]!.getAttribute("aria-pressed")).toBe("true");
    // 절 탭은 Reports 폼 탭과 같은 클래스 토큰
    expect(tabs[0]!.className).toContain("text-accent-green border-accent-green/35 bg-accent-green/10");
    expect(tabs[1]!.className).toContain("text-slate-400 border-surface-3 bg-surface-2");
    // 본문은 현재 절(1) 만 — h2 하나, mermaid 는 2절에 있으니 아직 없음
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(1);
    expect(root.querySelector("#projects-viewer h2")?.textContent).toBe("1. 무엇을 만드나");
    expect(root.querySelectorAll("#projects-viewer pre.mermaid-src")).toHaveLength(0);
    const sha7 = fixture.summary.sha.slice(0, 7);
    expect(root.textContent).toContain(sha7);
    expect(root.querySelector<HTMLAnchorElement>("#projects-open-github")!.getAttribute("href"))
      .toBe(`https://github.com/b3rys/steno/blob/${fixture.summary.sha}/DESIGN.md`);
    const p = new URLSearchParams(window.location.search);
    expect(p.get("view")).toBe("projects");
    expect(p.get("id")).toBe("steno");
    expect(p.get("doc")).toBe("design");
    expect(p.get("sec")).toBe("1-무엇을-만드나");
  });

  test("절 탭 클릭 → 그 절 HTML 만(mermaid 배지 포함) · URL &sec= 갱신 · 뒤로가면 sec 제거", async () => {
    const root = await mount();
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    root.querySelector<HTMLButtonElement>('.projects-sec-tab[data-sec="2-시스템-구조"]')!.click();
    await tick();
    expect(root.querySelector('.projects-sec-tab[data-sec="2-시스템-구조"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(1);
    expect(root.querySelector("#projects-viewer article")?.getAttribute("data-sec")).toBe("2-시스템-구조");
    // 서버 html 그대로 — 서버가 figcaption(mermaid-pending) 을 넣으므로 클라 배지는 안 겹친다(두 줄 중복 방지)
    expect(root.querySelectorAll("#projects-viewer pre.mermaid-src")).toHaveLength(1);
    expect(root.querySelectorAll("#projects-viewer .mermaid-pending")).toHaveLength(1);
    expect(root.querySelectorAll("#projects-viewer .projects-mermaid-badge")).toHaveLength(0);
    expect(new URLSearchParams(window.location.search).get("sec")).toBe("2-시스템-구조");
    root.querySelector<HTMLButtonElement>("#projects-back")!.click();
    await tick();
    expect(new URLSearchParams(window.location.search).get("sec")).toBeNull();
  });

  test("deep-link &sec=3-주요-클래스 로 부팅하면 그 절이 열린다 · 모르는 sec 은 첫 절", async () => {
    window.history.replaceState(null, "", "/team?view=projects&id=steno&doc=design&sec=3-주요-클래스");
    let root = await mount();
    expect(root.querySelector('.projects-sec-tab[aria-pressed="true"]')?.getAttribute("data-sec")).toBe("3-주요-클래스");
    expect(root.querySelector("#projects-viewer h2")?.textContent).toBe("3. 주요 클래스");
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/team?view=projects&id=steno&doc=design&sec=없는-절");
    root = await mount();
    expect(root.querySelector('.projects-sec-tab[aria-pressed="true"]')?.getAttribute("data-sec")).toBe("1-무엇을-만드나");
    expect(new URLSearchParams(window.location.search).get("sec")).toBe("1-무엇을-만드나");
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
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(1);
    expect(root.querySelectorAll(".projects-sec-tab")).toHaveLength(3);
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
    expect(root.querySelectorAll(".projects-sec-tab")).toHaveLength(3);
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(1);
  });
});

describe("TODO 현재 상태", () => {
  test("기본 탭 = 현재 상태: 진행중 doingTitles 3 · 계획(킵 절 제외) · 완료 접힘 · 칸반; 전체 탭 = 원문 HTML", async () => {
    const root = await mount();
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="todo"]')!.click();
    await tick();
    expect(root.querySelector('.projects-todo-tab[data-todo-tab="status"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelectorAll('[data-todo-section="doing"] li')).toHaveLength(3);
    expect(root.querySelector('[data-todo-section="doing"]')?.textContent).toContain("줄번호 겹침");
    // fixture TODO.md: `- [ ]` 6줄 중 킵 절 1줄은 plan 에서 뺀다 → 5 (summary.todo.plan 과 같다)
    expect(root.querySelectorAll('[data-todo-section="plan"] li')).toHaveLength(5);
    expect(root.querySelector('[data-todo-section="plan"]')?.textContent).not.toContain("킵 — plan 에 안 센다");
    expect(root.querySelectorAll('[data-todo-section="kanban"] li')).toHaveLength(1);
    // 완료: 건수는 summary(40), 목록은 원문 [x] 5줄(미리보기 5 이내라 더 보기 없음)
    expect(root.querySelector('[data-todo-section="done"]')?.textContent).toContain("40");
    expect(root.querySelectorAll('[data-todo-section="done"] li')).toHaveLength(5);

    root.querySelector<HTMLButtonElement>('.projects-todo-tab[data-todo-tab="all"]')!.click();
    await tick();
    // "전체" 안에서도 절 탭: h1 뒤 서문(p) 이 있으니 "개요" + h2 절 3 = 탭 4, 본문은 개요(h1 + p)
    expect(root.querySelectorAll('[data-todo-section]')).toHaveLength(0);
    const tabs = root.querySelectorAll<HTMLButtonElement>(".projects-sec-tab");
    expect(tabs).toHaveLength(4);
    expect(tabs[0]!.textContent).toBe("개요");
    expect(root.querySelectorAll("#projects-viewer .projects-prose h2")).toHaveLength(0);
    expect(root.querySelectorAll("#projects-viewer .projects-prose h1")).toHaveLength(1);
    expect(root.querySelectorAll(".projects-todo-tab")).toHaveLength(2);
  });

  test("parseTodoMd — 제외 절(서버가 준 목록) 의 [ ] 는 plan 에서 빠지고, 60자에서 자른다", async () => {
    const { parseTodoMd } = await import("./Projects");
    const md = [
      "## 일",
      "- [~] 하는 중",
      "- [ ] 할 것",
      "- [x] 한 것",
      "## 📌 킵",
      "- [ ] 킵 항목",
      "### 선택 대기",
      "- [ ] 대기 항목",
      "## 다시 일",
      `- [ ] ${"가".repeat(80)}`,
    ].join("\n");
    const r = parseTodoMd(md, ["킵", "선택 대기"]);
    expect(r.doing).toEqual(["하는 중"]);
    expect(r.done).toEqual(["한 것"]);
    expect(r.plan).toHaveLength(2);
    expect(r.plan[1]).toHaveLength(60);
    // 목록은 화면이 아니라 서버 응답에서 온다 — 빈 목록이면 아무 절도 빼지 않는다
    expect(parseTodoMd(md, []).plan).toHaveLength(4);
    expect(parseTodoMd(md, ["킵"]).plan).toHaveLength(3);
  });

  test("현재 상태의 제외 절은 summary.excludeSections 를 쓴다 — 서버가 다른 목록을 주면 그대로 따른다", async () => {
    const { renderProjects, resetProjectsState } = await import("./Projects");
    const saved = globalThis.fetch;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/doc/todo")) return json(fixture.docs.todo);
      return json({ projects: [{ ...fixture.summary, excludeSections: [] }] });
    }) as unknown as typeof fetch;
    try {
      resetProjectsState();
      const root = document.createElement("div");
      document.body.appendChild(root);
      renderProjects(root);
      await tick();
      root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="todo"]')!.click();
      await tick();
      // 제외 목록이 비면 킵 절의 1건도 plan 목록에 보인다 (6건)
      expect(root.querySelectorAll('[data-todo-section="plan"] li')).toHaveLength(6);
      expect(root.querySelector('[data-todo-section="plan"]')?.textContent).toContain("킵 — plan 에 안 센다");
    } finally {
      globalThis.fetch = saved;
    }
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
    root.querySelector<HTMLButtonElement>('.projects-sec-tab[data-sec="2-시스템-구조"]')!.click();
    await tick();
    expect(root.querySelectorAll("#projects-viewer pre.mermaid-src")).toHaveLength(1);
    root.querySelector<HTMLButtonElement>('.projects-mode[data-mode="md"]')!.click();
    await tick();
    expect(root.querySelector("#projects-viewer pre.projects-raw")?.textContent).toContain("# Steno 설계");
  });
});

describe("splitSections — 순수 함수", () => {
  const toc = (...rows: [number, string][]) => rows.map(([level, anchor]) => ({ level, anchor, text: anchor }));
  const H = (l: number, id: string, t = id) => `<h${l} id="${id}">${t}</h${l}>`;

  test("`#` 하나 + `##` 3 → 절 3 · 서문 없으면 개요 탭 없음 · 각 절 html 은 헤딩+본문", async () => {
    const { splitSections } = await import("../lib/projectSections");
    const html = `${H(1, "t")}${H(2, "a")}<p>A</p>${H(2, "b")}<p>B1</p><p>B2</p>${H(2, "c")}`;
    const secs = splitSections(html, toc([1, "t"], [2, "a"], [2, "b"], [2, "c"]));
    expect(secs.map((s) => s.anchor)).toEqual(["a", "b", "c"]);
    expect(secs.map((s) => s.level)).toEqual([2, 2, 2]);
    expect(secs[1]!.html).toBe(`${H(2, "b")}<p>B1</p><p>B2</p>`);
    expect(secs[2]!.html).toBe(H(2, "c"));
    expect(secs.every((s) => s.children.length === 0)).toBe(true);
  });

  test("서문(제목 뒤 본문) 이 있으면 첫 절은 '개요' — anchor 는 제목 id, html 은 제목+서문", async () => {
    const { splitSections } = await import("../lib/projectSections");
    const html = `${H(1, "t", "제목")}<p>서문</p>${H(2, "a")}<p>A</p>${H(2, "b")}`;
    const secs = splitSections(html, toc([1, "t"], [2, "a"], [2, "b"]));
    expect(secs.map((s) => s.anchor)).toEqual(["t", "a", "b"]);
    expect(secs[0]!.label).toBe("개요");
    expect(secs[0]!.level).toBe(0);
    expect(secs[0]!.html).toBe(`${H(1, "t", "제목")}<p>서문</p>`);
  });

  test("절 안 `###`·`####` 는 children(level·anchor·text) — 절 경계는 `##` 만", async () => {
    const { splitSections } = await import("../lib/projectSections");
    const html = `${H(2, "a")}${H(3, "a-1", "A 하나")}<p>x</p>${H(4, "a-1-1")}${H(3, "a-2")}${H(2, "b")}${H(3, "b-1")}`;
    const secs = splitSections(html, toc([2, "a"], [3, "a-1"], [4, "a-1-1"], [3, "a-2"], [2, "b"], [3, "b-1"]));
    expect(secs.map((s) => s.anchor)).toEqual(["a", "b"]);
    expect(secs[0]!.children).toEqual([
      { level: 3, anchor: "a-1", text: "A 하나" }, { level: 4, anchor: "a-1-1", text: "a-1-1" }, { level: 3, anchor: "a-2", text: "a-2" },
    ]);
    expect(secs[1]!.children).toEqual([{ level: 3, anchor: "b-1", text: "b-1" }]);
    expect(secs[0]!.html).toContain('id="a-1-1"');
    expect(secs[1]!.html).not.toContain('id="a-2"');
  });

  test("헤딩 없음 → 절 1개(전체 html 그대로) · `#`·`##` 각 하나뿐이면 `##` 에서 자른다 · `##` 없으면 `###`", async () => {
    const { splitSections, sectionLevel } = await import("../lib/projectSections");
    const plain = splitSections("<p>only</p><ul><li>x</li></ul>", []);
    expect(plain).toHaveLength(1);
    expect(plain[0]!.html).toBe("<p>only</p><ul><li>x</li></ul>");
    expect(plain[0]!.anchor).toBe("");
    expect(sectionLevel(toc([1, "t"], [2, "a"]))).toBe(2);
    expect(sectionLevel(toc([1, "t"], [3, "a"], [3, "b"]))).toBe(3);
    expect(sectionLevel(toc([1, "t"]))).toBe(1);
    expect(sectionLevel(toc([2, "a"], [2, "b"]))).toBe(2);
    // `#` 하나뿐 + 본문만 → 절 1개(제목 포함)
    const one = splitSections(`${H(1, "t")}<p>본문</p>`, toc([1, "t"]));
    expect(one).toHaveLength(1);
    expect(one[0]!.anchor).toBe("t");
    expect(one[0]!.html).toBe(`${H(1, "t")}<p>본문</p>`);
  });

  test("sectionTabLabel — 24자 넘으면 자르고 …", async () => {
    const { sectionTabLabel } = await import("../lib/projectSections");
    expect(sectionTabLabel("짧은 제목")).toBe("짧은 제목");
    expect(sectionTabLabel("가".repeat(24))).toBe("가".repeat(24));
    expect(sectionTabLabel("가".repeat(25))).toBe("가".repeat(24) + "…");
  });
});

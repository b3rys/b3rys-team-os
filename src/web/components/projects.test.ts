/**
 * Projects 탭 — 목록·문서 화면·TODO 현재 상태·fixture 폴백 (계약 docs/PROJECTS_TAB.md §4).
 * DOM 방식은 reportsSelection.dom.test.ts 와 같다(happy-dom + window.SyntaxError 패치, 심은 전역은 걷는다).
 * 서버 API 는 fetch 를 갈아끼워 흉내낸다 — 실제 서버 응답의 정확성은 tests/ 의 검증자 몫.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import fixture from "../fixtures/projects-sample.example.json";

// 가짜 mermaid — 진짜(5MB)는 테스트에서 안 받는다. render 가 준 svg 를 figure 에 넣는 절차만 잰다.
const fakeMermaid = {
  calls: [] as { id: string; src: string }[],
  fail: false,
  initialized: null as Record<string, unknown> | null,
  initialize(cfg: Record<string, unknown>) { this.initialized = cfg; },
  async render(id: string, src: string) { this.calls.push({ id, src }); if (this.fail) throw new Error("parse"); return { svg: `<svg data-fake="1" data-id="${id}"></svg>` }; },
};

const installedGlobals: string[] = [];
const savedGlobals: Record<string, unknown> = {};
let previousFetch: typeof fetch;
// 어떤 서버를 흉내낼지 — "api": 계약대로 응답 · "404": 서버 없음
let serverMode: "api" | "404" | "spa" = "api";
// 문서 응답 바꿔치기 — 소제목(###) 이 있는 문서로 트리 children 을 볼 때
let docOverride: Record<string, unknown> | null = null;
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
    if (id !== "sample") return json({ error: "unknown project", key: id }, 404);
    if (!key) return json(fixture.summary);
    const doc = (docOverride?.[key] as { md: string } | undefined) ?? (fixture.docs as Record<string, { md: string }>)[key];
    if (!doc) return json({ error: "unknown doc", key }, 404);
    if (raw) return new Response(doc.md, { status: 200, headers: { "content-type": "text/markdown" } });
    return json(doc);
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  serverMode = "api";
  docOverride = null;
  fetchLog.length = 0;
  window.history.replaceState(null, "", "/team?view=projects");
});

afterEach(async () => {
  document.body.innerHTML = "";
  const { resetPanelsState } = await import("../lib/panels");
  resetPanelsState();
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
  const { renderProjects, resetProjectsState, setMermaidLoader } = await import("./Projects");
  resetProjectsState();
  fakeMermaid.calls = []; fakeMermaid.fail = false; fakeMermaid.initialized = null;
  setMermaidLoader(() => Promise.resolve(fakeMermaid));
  const root = document.createElement("div");
  document.body.appendChild(root);
  renderProjects(root);
  await tick();
  return root;
}

/** Cards expose documents directly; retained for existing document-flow tests. */
function openSummary(_root: HTMLElement): void {}

describe("Projects 목록", () => {
  test("fixture 로 목록 1줄 — 칩 4개 · 건수 · 지금 과제 · GitHub 링크 새 탭", async () => {
    const root = await mount();
    const rows = root.querySelectorAll(".projects-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-id")).toBe("sample");
    expect(root.querySelectorAll(".projects-now > div > ul > li")).toHaveLength(3);
    expect(root.querySelector(".projects-more summary")?.textContent).toContain("+1");
    expect(root.querySelector(".projects-more")?.hasAttribute("open")).toBe(false);
    openSummary(root);
    expect(root.querySelectorAll(".projects-chip")).toHaveLength(4);
    expect(root.querySelectorAll("button.projects-chip")).toHaveLength(4); // 4문서 모두 exists=true → 전부 버튼
    expect(root.querySelector('[data-count="doing"]')?.textContent).toBe("3");
    expect(root.querySelector('[data-count="plan"]')?.textContent).toBe("5");
    expect(root.querySelector('[data-count="done"]')?.textContent).toBe("40");
    // 지금 과제 = doingTitles 3 + 칸반 doing 1
    expect(root.querySelectorAll(".projects-tasks li")).toHaveLength(4);
    expect(root.querySelector(".projects-more .projects-tasks")?.textContent).toContain("[sample] 과제 A");
    const gh = root.querySelector<HTMLAnchorElement>("a.projects-github")!;
    expect(gh.getAttribute("href")).toBe("https://github.com/your-org/sample");
    expect(gh.getAttribute("target")).toBe("_blank");
    expect(root.textContent).toContain(fixture.summary.intro);
    expect(root.querySelector(".projects-track-name")).toBeNull();
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
      openSummary(root);
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
  test("DESIGN 칩 → 왼쪽 목차 트리(절 3: h1 하나뿐이라 h2 가 절) · 현재 절만 펼침·강조 · 본문은 전체 문서 · 절 탭 없음 · GitHub blob 링크 · URL deep-link", async () => {
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    expect(root.querySelector(".projects-sec-tabs")).toBeNull();
    const toc = root.querySelector("#projects-toc")!;
    expect(toc).not.toBeNull();
    const secs = toc.querySelectorAll<HTMLElement>(".projects-toc-sec");
    expect(secs).toHaveLength(3);
    expect(Array.from(secs).map((el) => el.querySelector(".projects-toc-head")?.textContent)).toEqual(["1. 무엇을 만드나", "2. 시스템 구조", "3. 주요 클래스"]);
    // 현재 절(첫 절)만 펼침·강조
    expect(Array.from(secs).map((el) => el.dataset.open)).toEqual(["true", "false", "false"]);
    expect(Array.from(secs).map((el) => el.querySelector(".projects-toc-head")?.getAttribute("aria-current"))).toEqual(["true", "false", "false"]);
    // 소제목이 없는 절엔 캐럿 버튼이 없다
    expect(toc.querySelectorAll(".projects-toc-caret[data-toggle]")).toHaveLength(0);
    // 본문은 전체 문서 — h2 3개 모두, 2절의 mermaid 도 이미 있다(서버 figcaption 만, 클라 배지 없음)
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(3);
    expect(root.querySelectorAll("#projects-viewer article")).toHaveLength(1);
    // 2절의 mermaid figure 는 (가짜) mermaid 로 SVG 가 됐다 — 원문 <pre>·"렌더 예정" 캡션은 사라진다
    expect(root.querySelectorAll("#projects-viewer figure.project-diagram[data-rendered=\"1\"] .project-diagram-svg svg[data-fake]")).toHaveLength(1);
    expect(root.querySelectorAll("#projects-viewer pre.mermaid-src")).toHaveLength(0);
    expect(root.querySelectorAll("#projects-viewer .mermaid-pending")).toHaveLength(0);
    expect(fakeMermaid.calls.map((c) => c.src.trim().split("\n")[0])).toEqual(["flowchart TB"]);
    expect(fakeMermaid.initialized?.securityLevel).toBe("strict");
    // Responsive geometry is exercised in a browser; this checks the toggle structure.
    expect(toc.parentElement?.className).toContain("projects-toc-wrap");
    expect(toc.className).toContain("hidden");
    expect(root.querySelector("#projects-toc-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector("#projects-open-github")?.getAttribute("href")).toContain(fixture.summary.sha);
    expect(root.querySelector<HTMLAnchorElement>("#projects-open-github")!.getAttribute("href"))
      .toBe(`https://github.com/your-org/sample/blob/${fixture.summary.sha}/DESIGN.md`);
    const p = new URLSearchParams(window.location.search);
    expect(p.get("view")).toBe("projects");
    expect(p.get("id")).toBe("sample");
    expect(p.get("doc")).toBe("design");
    expect(p.get("sec")).toBe("1-무엇을-만드나");
  });

  test("트리의 절 클릭 → 그 절이 현재(펼침·강조 이동) · URL &sec= 갱신 · 본문은 다시 안 그림(전체 그대로) · 뒤로가면 sec 제거", async () => {
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    const article = root.querySelector("#projects-viewer article")!;
    root.querySelector<HTMLButtonElement>('.projects-toc-head[data-sec="2-시스템-구조"]')!.click();
    await tick();
    expect(root.querySelector('.projects-toc-head[data-sec="2-시스템-구조"]')?.getAttribute("aria-current")).toBe("true");
    expect(root.querySelector('.projects-toc-head[data-sec="1-무엇을-만드나"]')?.getAttribute("aria-current")).toBe("false");
    expect(root.querySelector('.projects-toc-sec[data-sec="2-시스템-구조"]')?.getAttribute("data-open")).toBe("true");
    expect(root.querySelector('.projects-toc-sec[data-sec="1-무엇을-만드나"]')?.getAttribute("data-open")).toBe("false");
    expect(root.querySelector("#projects-viewer article")).toBe(article); // 같은 노드 — 스크롤 이동만
    expect(article.getAttribute("data-sec")).toBe("2-시스템-구조");
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(3);
    expect(new URLSearchParams(window.location.search).get("sec")).toBe("2-시스템-구조");
    root.querySelector<HTMLButtonElement>("#projects-back")!.click();
    await tick();
    expect(new URLSearchParams(window.location.search).get("sec")).toBeNull();
  });

  test("소제목(###) 이 있는 문서: 절 아래 들여쓴 링크 · 캐럿으로 다른 절도 펼침 · 소제목 클릭 → 그 절이 현재 + 소제목 강조", async () => {
    const H = (l: number, id: string, t = id) => `<h${l} id="${id}">${t}</h${l}>`;
    const html = `${H(1, "t")}${H(2, "a")}<p>a</p>${H(3, "a-1")}<p>a1</p>${H(3, "a-2")}<p>a2</p>${H(2, "b")}<p>b</p>${H(3, "b-1")}<p>b1</p>${H(4, "b-1-1")}<p>b11</p>`;
    const toc = [[1, "t"], [2, "a"], [3, "a-1"], [3, "a-2"], [2, "b"], [3, "b-1"], [4, "b-1-1"]].map(([level, anchor]) => ({ level, anchor, text: anchor }));
    docOverride = { design: { ...fixture.docs.design, html, toc } };
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    const secs = root.querySelectorAll<HTMLElement>(".projects-toc-sec");
    expect(secs).toHaveLength(2);
    expect(Array.from(secs[0]!.querySelectorAll("a")).map((a) => `${a.dataset.level}:${a.textContent}`)).toEqual(["3:a-1", "3:a-2"]);
    expect(Array.from(secs[1]!.querySelectorAll("a")).map((a) => `${a.dataset.level}:${a.textContent}`)).toEqual(["3:b-1", "4:b-1-1"]);
    expect(Array.from(secs).map((el) => el.dataset.open)).toEqual(["true", "false"]);
    // 캐럿: 다른 절(b) 을 펼쳐 본다 — 현재 절(a) 은 그대로 펼침
    secs[1]!.querySelector<HTMLButtonElement>(".projects-toc-caret[data-toggle]")!.click();
    expect(Array.from(secs).map((el) => el.dataset.open)).toEqual(["true", "true"]);
    expect(secs[1]!.querySelector(".projects-toc-caret")?.getAttribute("aria-expanded")).toBe("true");
    secs[1]!.querySelector<HTMLButtonElement>(".projects-toc-caret[data-toggle]")!.click();
    expect(Array.from(secs).map((el) => el.dataset.open)).toEqual(["true", "false"]);
    // 소제목 b-1 클릭 → 절 b 가 현재(펼침), a 접힘, b-1 강조, URL sec=b
    root.querySelector<HTMLAnchorElement>('.projects-toc-children a[data-anchor="b-1"]')!.click();
    await tick();
    expect(Array.from(secs).map((el) => el.dataset.open)).toEqual(["false", "true"]);
    expect(secs[1]!.querySelector(".projects-toc-head")?.getAttribute("aria-current")).toBe("true");
    expect(root.querySelector('.projects-toc-children a[data-anchor="b-1"]')?.getAttribute("aria-current")).toBe("true");
    expect(root.querySelector('.projects-toc-children a[data-anchor="a-1"]')?.getAttribute("aria-current")).toBe("false");
    expect(new URLSearchParams(window.location.search).get("sec")).toBe("b");
    // 본문은 여전히 전체(h2 2 · h3 3)
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(2);
    expect(root.querySelectorAll("#projects-viewer h3")).toHaveLength(3);
  });

  test("모바일 목차 버튼: 칸만 보였다 감춤(본문 재렌더 없음) · 절 클릭 뒤 자동으로 접힘", async () => {
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    const article = root.querySelector("#projects-viewer article")!;
    const btn = root.querySelector<HTMLButtonElement>("#projects-toc-toggle")!;
    btn.click();
    expect(root.querySelector("#projects-toc")?.className).not.toContain("hidden");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector("#projects-viewer article")).toBe(article);
    root.querySelector<HTMLButtonElement>('.projects-toc-head[data-sec="3-주요-클래스"]')!.click();
    expect(root.querySelector("#projects-toc")?.className).toContain("hidden");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(new URLSearchParams(window.location.search).get("sec")).toBe("3-주요-클래스");
  });

  test("deep-link &sec=3-주요-클래스 로 부팅하면 그 절이 현재 · 모르는 sec 은 첫 절", async () => {
    window.history.replaceState(null, "", "/team?view=projects&id=sample&doc=design&sec=3-주요-클래스");
    let root = await mount();
    expect(root.querySelector('.projects-toc-head[aria-current="true"]')?.getAttribute("data-sec")).toBe("3-주요-클래스");
    expect(root.querySelector("#projects-viewer article")?.getAttribute("data-sec")).toBe("3-주요-클래스");
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(3);
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/team?view=projects&id=sample&doc=design&sec=없는-절");
    root = await mount();
    expect(root.querySelector('.projects-toc-head[aria-current="true"]')?.getAttribute("data-sec")).toBe("1-무엇을-만드나");
    expect(new URLSearchParams(window.location.search).get("sec")).toBe("1-무엇을-만드나");
  });

  test("HTML | MD 토글 — MD 는 /raw 를 <pre> 로, 다시 HTML 로 돌아온다", async () => {
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    root.querySelector<HTMLButtonElement>('.projects-mode[data-mode="md"]')!.click();
    await tick();
    expect(fetchLog.some((u) => u.endsWith("/api/projects/sample/doc/design/raw"))).toBe(true);
    const pre = root.querySelector("#projects-viewer pre.projects-raw")!;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toContain("```mermaid");
    expect(root.querySelector('.projects-mode[data-mode="md"]')?.getAttribute("aria-pressed")).toBe("true");
    root.querySelector<HTMLButtonElement>('.projects-mode[data-mode="html"]')!.click();
    await tick();
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(3);
    expect(root.querySelectorAll(".projects-toc-sec")).toHaveLength(3);
  });

  test("문서 → 목록의 원래 카드 강조, URL 에서 doc 제거", async () => {
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="readme"]')!.click();
    await tick();
    root.querySelector<HTMLButtonElement>("#projects-back")!.click();
    await tick();
    expect(root.querySelectorAll(".projects-track")).toHaveLength(1);
    expect(new URLSearchParams(window.location.search).get("doc")).toBeNull();
    expect(root.querySelector("#projects-back")).toBeNull();
    expect(root.querySelectorAll(".projects-row")).toHaveLength(1);
    expect(root.querySelector(".projects-highlight")?.getAttribute("data-id")).toBe("sample");
    const p = new URLSearchParams(window.location.search);
    expect(p.get("id")).toBe("sample");
    expect(p.get("doc")).toBeNull();
  });

  test("deep-link ?id=sample&doc=design 로 부팅하면 바로 문서 화면", async () => {
    window.history.replaceState(null, "", "/team?view=projects&id=sample&doc=design");
    const root = await mount();
    expect(root.querySelectorAll(".projects-row")).toHaveLength(0);
    expect(root.querySelectorAll(".projects-toc-sec")).toHaveLength(3);
    expect(root.querySelectorAll("#projects-viewer h2")).toHaveLength(3);
  });
});

describe("문서 화면 — 좌우 패널 자동 접기", () => {
  test("문서 진입 → body 에 sidebar-collapsed·thread-panel-collapsed · 목록으로 복귀 → 들어오기 전 상태(왼쪽 펼침·오른쪽 접힘) 복원", async () => {
    const { applyPanelCollapsed } = await import("../lib/panels");
    applyPanelCollapsed("thread", true); // 들어오기 전: 오른쪽은 이미 접혀 있었다
    const root = await mount();
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);
    expect(document.body.classList.contains("thread-panel-collapsed")).toBe(true);
    root.querySelector<HTMLButtonElement>("#projects-back")!.click();
    await tick();
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);
    expect(document.body.classList.contains("thread-panel-collapsed")).toBe(true);
  });

  test("다른 탭으로 나가면(setProjectsVisible(false)) 복원, 돌아오면(true) 다시 접힘", async () => {
    const { setProjectsVisible } = await import("./Projects");
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="readme"]')!.click();
    await tick();
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);
    setProjectsVisible(false);
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);
    expect(document.body.classList.contains("thread-panel-collapsed")).toBe(false);
    setProjectsVisible(true);
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);
    expect(document.body.classList.contains("thread-panel-collapsed")).toBe(true);
  });

  test("문서 안에서 사용자가 왼쪽을 직접 펼치면 — 복귀 때 그대로 두고, 다음 문서에서도 다시 안 접는다(오른쪽은 계속 자동)", async () => {
    const { togglePanel } = await import("../lib/panels");
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);
    togglePanel("sidebar"); // = 왼쪽 접기 버튼 클릭
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);
    root.querySelector<HTMLButtonElement>("#projects-back")!.click();
    await tick();
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);
    expect(document.body.classList.contains("thread-panel-collapsed")).toBe(false);
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="readme"]')!.click();
    await tick();
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(false); // 존중
    expect(document.body.classList.contains("thread-panel-collapsed")).toBe(true);
    // 사용자가 문서 안에서 다시 접으면 존중 표시가 풀린다 → 복귀 시 접힌 채(사용자 선택), 다음 진입은 자동 접힘
    togglePanel("sidebar");
    root.querySelector<HTMLButtonElement>("#projects-back")!.click();
    await tick();
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);
  });
});

describe("TODO 현재 상태", () => {
  test("기본 탭 = 현재 상태: 진행중 doingTitles 3 · 계획(킵 절 제외) · 완료 접힘 · 칸반; 전체 탭 = 원문 HTML", async () => {
    const root = await mount();
    openSummary(root);
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
    // "전체" 안에서는 목차 트리: h1 뒤 서문(p) 이 있으니 "개요" + h2 절 3 = 4 줄, 본문은 원문 전체(h1 1 + h2 3)
    expect(root.querySelectorAll('[data-todo-section]')).toHaveLength(0);
    const heads = root.querySelectorAll<HTMLButtonElement>(".projects-toc-head");
    expect(heads).toHaveLength(4);
    expect(heads[0]!.textContent).toBe("개요");
    expect(root.querySelectorAll("#projects-viewer .projects-prose h2")).toHaveLength(3);
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
    openSummary(root);
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
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    expect(root.querySelectorAll(".projects-toc-sec")).toHaveLength(3);
    expect(root.querySelectorAll("#projects-viewer figure.project-diagram .project-diagram-svg svg[data-fake]")).toHaveLength(1); // fixture 의 mermaid 도 (가짜로) 렌더
    root.querySelector<HTMLButtonElement>('.projects-mode[data-mode="md"]')!.click();
    await tick();
    expect(root.querySelector("#projects-viewer pre.projects-raw")?.textContent).toContain("# Sample 설계");
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
});

describe("문서 헤더 — 문서 전환 탭 · 새창 · 글자 크기", () => {
  test("헤더 첫 줄에 GitHub 아이콘·문서 칩·새창·HTML/MD 가 있고, 현재 문서 칩은 선택 모양", async () => {
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    const gh = root.querySelector<HTMLAnchorElement>("#projects-open-github")!;
    expect(gh.getAttribute("aria-label")).toBe("GitHub");
    expect(gh.querySelector("svg")).not.toBeNull();
    const chips = [...root.querySelectorAll(".projects-doc-chip")].map((c) => c.textContent?.trim());
    expect(chips).toEqual(["README", "DESIGN", "FEATURES", "TODO"]);
    expect(root.querySelector('.projects-doc-chip[aria-current="page"]')?.textContent?.trim()).toBe("DESIGN");
    expect(root.querySelectorAll("button[data-doc-chip]")).toHaveLength(3);
    const win = root.querySelector<HTMLAnchorElement>("#projects-open-window")!;
    expect(win.getAttribute("href")).toContain("/api/projects/sample/doc/design/page");
    expect(win.getAttribute("href")).not.toContain("mode=md");
    expect(win.getAttribute("target")).toBe("_blank");
  });

  test("메타 줄에 프로젝트 이름·파일·크기 버튼이 있고, sticky 헤더 높이를 재서 --projects-head 로 반영한다", async () => {
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    const head = root.querySelector<HTMLElement>("[data-projects-doc-head]")!;
    expect(head).not.toBeNull();
    expect(head.textContent).toContain("Sample / DESIGN.md");
    const { measureHeadOffset } = await import("./Projects");
    // happy-dom 은 레이아웃이 없어 0 → 기본값 유지, 변수도 안 박는다
    expect(measureHeadOffset()).toBe(72);
    expect(root.style.getPropertyValue("--projects-head")).toBe("");
    Object.defineProperty(head, "offsetHeight", { value: 54, configurable: true });
    expect(measureHeadOffset()).toBe(66);
    expect(root.style.getPropertyValue("--projects-head")).toBe("66px");
  });

  test("칩으로 다른 문서로 넘어가면 HTML/MD 모드가 유지되고 새창 링크도 그 모드·그 문서를 가리킨다", async () => {
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    root.querySelector<HTMLButtonElement>('.projects-mode[data-mode="md"]')!.click();
    await tick();
    root.querySelector<HTMLButtonElement>('button[data-doc-chip="features"]')!.click();
    await tick();
    expect(new URLSearchParams(window.location.search).get("doc")).toBe("features");
    expect(root.querySelector('.projects-doc-chip[aria-current="page"]')?.textContent?.trim()).toBe("FEATURES");
    expect(root.querySelector('.projects-mode[data-mode="md"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector<HTMLAnchorElement>("#projects-open-window")!.getAttribute("href")).toContain("/doc/features/page?mode=md");
  });

  test("목차 글자는 이모지·장식 기호를 뺀다(tocLabel) — 본문 제목·title 은 원문 그대로", async () => {
    const { tocLabel } = await import("./Projects");
    expect(tocLabel("🔄 실사용 피드백 (2026-01-01)")).toBe("실사용 피드백 (2026-01-01)");
    expect(tocLabel("📌 예시 절 — ★나중에 손본다★")).toBe("예시 절 — 나중에 손본다");
    expect(tocLabel("🎯 목표 (2026-01-02 10:00) — 킵")).toBe("목표 (2026-01-02 10:00) — 킵");
    expect(tocLabel("✅ 완료된 것 🧹")).toBe("완료된 것");
    expect(tocLabel("1단계 — 편집기 만들기")).toBe("1단계 — 편집기 만들기");
    expect(tocLabel("★ 킵 ★ 하나")).toBe("킵 하나");   // 공백 축약
    expect(tocLabel("—킵—")).toBe("킵");               // 앞뒤 대시
    expect(tocLabel("완료: ✅")).toBe("완료");           // 뒤 콜론
    expect(tocLabel("👍🏽 굿")).toBe("굿");              // 피부색 수식자까지
    expect(tocLabel("🎉")).toBe("🎉"); // 전부 기호면 원문 유지
    // DOM: 목차 글자는 정리본, title 은 원문
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="todo"]')!.click();
    await tick();
    root.querySelector<HTMLButtonElement>('button[data-todo-tab="all"]')?.click();
    await tick();
    const heads = [...root.querySelectorAll<HTMLButtonElement>(".projects-toc-head")];
    const decorated = heads.find((b) => /\p{Extended_Pictographic}/u.test(b.title));
    expect(decorated).toBeDefined();
    expect(decorated!.textContent?.trim()).toBe(tocLabel(decorated!.title));
    expect(decorated!.textContent?.trim()).not.toBe(decorated!.title);
    expect(decorated!.querySelector(".projects-toc-label")).not.toBeNull();
  });

  test("mermaid 문법 오류면 원문 <pre> 를 두고 캡션만 오류 문구로 — 로더 실패면 서버 캡션 그대로", async () => {
    const root = await mount();          // mount 가 fail 을 초기화하므로 그 뒤에 켠다
    fakeMermaid.fail = true;
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    const fig = root.querySelector<HTMLElement>("#projects-viewer figure.project-diagram")!;
    expect(fig.dataset.rendered).toBe("error");
    expect(fig.querySelector("pre.mermaid-src")).not.toBeNull();
    expect(fig.querySelector(".mermaid-pending")?.textContent).toContain("문법 오류");
    // 로더 자체가 실패하면(청크 못 받음) 서버가 넣은 "렌더 예정" 캡션과 원문이 그대로 남는다
    const { setMermaidLoader, resetProjectsState, renderProjects } = await import("./Projects");
    resetProjectsState();
    setMermaidLoader(() => Promise.reject(new Error("chunk")));
    const root2 = document.createElement("div"); document.body.appendChild(root2); renderProjects(root2); await tick();
    openSummary(root2);
    root2.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')?.click(); // URL 이 이미 design 딥링크면 목록 칩이 없다
    await tick();
    const fig2 = root2.querySelector<HTMLElement>("#projects-viewer figure.project-diagram")!;
    expect(fig2.dataset.rendered).toBeUndefined();
    expect(fig2.querySelector(".mermaid-pending")?.textContent).toContain("렌더 예정");
    expect(fig2.querySelector("pre.mermaid-src")).not.toBeNull();
  });

  test("목록에서 바로 문서 진입 후 새창 링크(README·HTML 로 시작)", async () => {
    const root = await mount();
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="readme"]')!.click();
    await tick();
    const a = root.querySelector<HTMLAnchorElement>("#projects-open-window")!;
    expect(a.getAttribute("href")).toContain("/api/projects/sample/doc/readme/page");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  test("⌘= / ⌘− / ⌘0 — 문서 화면에서만 90/100/110/125 를 오가고 % 배지를 띄운다 · 목록에서는 무시", async () => {
    const { handleZoomKey, currentZoom, setProjectsVisible } = await import("./Projects");
    const root = await mount();
    const key = (k: string) => { const e = new window.KeyboardEvent("keydown", { key: k, metaKey: true, cancelable: true }); const handled = handleZoomKey(e as unknown as KeyboardEvent); return { handled, prevented: e.defaultPrevented }; };
    expect(key("=").handled).toBe(false);      // 목록 화면 — 브라우저 확대에 맡긴다
    openSummary(root);
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="design"]')!.click();
    await tick();
    expect(key("=")).toEqual({ handled: true, prevented: true });
    expect(currentZoom()).toBe(110);
    expect(root.style.getPropertyValue("--projects-zoom")).toBe("1.1");
    expect(document.getElementById("projects-zoom-badge")?.textContent).toBe("110%");
    key("="); expect(currentZoom()).toBe(125);
    key("="); expect(currentZoom()).toBe(125);  // 상한
    key("-"); key("-"); key("-"); expect(currentZoom()).toBe(90);
    key("-"); expect(currentZoom()).toBe(90);   // 하한
    key("0"); expect(currentZoom()).toBe(100);
    expect(window.localStorage.getItem("bill-dash-projects-zoom")).toBe("100");
    setProjectsVisible(false);                  // 다른 탭 — 브라우저 확대를 가로채지 않는다
    expect(key("=")).toEqual({ handled: false, prevented: false });
    expect(currentZoom()).toBe(100);
    setProjectsVisible(true);
    expect(key("=").handled).toBe(true);
    expect(currentZoom()).toBe(110);
    key("0");
    document.getElementById("projects-zoom-badge")?.remove();
  });
});

describe("Projects multi-track overview", () => {
  const tracks = [
    { ...fixture.summary, id: "desktop", name: "Desktop", todo: { doing: 1, plan: 2, done: 3, doingTitles: ["Desktop work"] }, kanban: [] },
    { ...fixture.summary, id: "mobile", name: "Mobile", repo: "your-org/sample-mobile", todo: { doing: 1, plan: 1, done: 0, doingTitles: ["Mobile work"] }, kanban: [] },
  ];
  async function withTracks(broken: boolean, action: (root: HTMLElement) => Promise<void>, sparse = false): Promise<void> {
    const saved = globalThis.fetch;
    globalThis.fetch = (async input => {
      const url = String(input);
      if (!url.includes("/doc/")) return Response.json({ projects: [{ ...fixture.summary, tracks: broken ? [tracks[0], { id: "mobile", name: "Mobile", repo: "your-org/sample-mobile", error: "github_auth_or_not_found", key: "branch" }] : sparse ? [tracks[0], { ...tracks[1], docs: tracks[1]!.docs.filter(d => d.key === "readme" || d.key === "todo") }] : tracks }] });
      return saved(input);
    }) as typeof fetch;
    try { await action(await mount()); } finally { globalThis.fetch = saved; }
  }
  test("list cards separate track counts, tasks and direct document buttons", async () => {
    await withTracks(false, async root => {
      expect(root.querySelectorAll(".projects-row")).toHaveLength(1);
      expect(root.querySelectorAll(".projects-chip")).toHaveLength(8);
      expect(root.querySelectorAll(".projects-tasks")).toHaveLength(2);
      openSummary(root);
      expect(root.querySelectorAll(".projects-track")).toHaveLength(2);
      expect(root.querySelector('[data-track="desktop"] [data-count="done"]')?.textContent).toBe("3");
      expect(root.querySelector('[data-track="mobile"] .projects-tasks')?.textContent).toBe("Mobile work");
      expect(root.querySelector('[data-track="mobile"]')?.textContent).not.toContain("Desktop work");
    });
  });
  test("failed track retains its name and error while healthy documents remain clickable", async () => {
    await withTracks(true, async root => {
      expect(root.textContent).toContain("트랙을 불러오지 못했습니다");
      openSummary(root);
      expect(root.querySelector('[data-track="mobile"]')?.textContent).toContain("github_auth_or_not_found");
      expect(root.querySelectorAll('[data-track="desktop"] button.projects-chip')).toHaveLength(4);
      expect(root.querySelectorAll('[data-track="mobile"] button.projects-chip')).toHaveLength(0);
    });
  });
  test("sparse track overview and document tabs omit unregistered documents", async () => {
    await withTracks(false, async root => {
      openSummary(root);
      expect(root.querySelectorAll('[data-track="mobile"] button.projects-chip')).toHaveLength(2);
      root.querySelector<HTMLButtonElement>('[data-track="mobile"] button[data-doc="readme"]')!.click(); await tick();
      expect([...root.querySelectorAll(".projects-doc-chip")].map(d => d.textContent?.trim())).toEqual(["README", "TODO"]);
    }, true);
  });
  test("mobile document, raw mode and new-window links retain track selection", async () => {
    await withTracks(false, async root => {
      openSummary(root);
      root.querySelector<HTMLButtonElement>('[data-track="mobile"] button[data-doc="design"]')!.click();
      await tick();
      expect(fetchLog.some(u => u.endsWith("/doc/design?track=mobile"))).toBe(true);
      expect(new URLSearchParams(window.location.search).get("track")).toBe("mobile");
      expect(root.querySelector("#projects-open-github")?.getAttribute("href")).toContain("your-org/sample-mobile");
      root.querySelector<HTMLButtonElement>('[data-mode="md"]')!.click(); await tick();
      expect(fetchLog.some(u => u.endsWith("/doc/design/raw?track=mobile"))).toBe(true);
      expect(root.querySelector("#projects-open-window")?.getAttribute("href")).toContain("track=mobile&mode=md");
    });
  });
});

 describe("Projects 카드·글자 크기 회귀", () => {
  test("기존 상세 URL은 문서 없이 해당 목록 카드를 강조한다", async () => {
    window.history.replaceState(null, "", "/team?view=projects&id=sample");
    const root = await mount();
    expect(root.querySelector(".projects-highlight")?.getAttribute("data-id")).toBe("sample");
    expect(root.querySelector("#projects-viewer")).toBeNull();
    expect(root.querySelectorAll("button.projects-chip")).toHaveLength(4);
  });
  test("과제 접두 이모지·마크다운 제거, 긴 문장은 임의로 자르지 않는다", async () => {
    const { taskLabel } = await import("./Projects");
    const long = "긴 과제 설명 ".repeat(30).trim();
    expect(taskLabel("🛠️ **단축키** [문서](https://example.com) 정리")).toBe("단축키 문서 정리");
    expect(taskLabel(long)).toBe(long);
  });
  test("가−/가+ 버튼은 저장 실패 때도 크기를 바꾸고 문서 외 단축키는 잡지 않는다", async () => {
    window.localStorage.clear();
    const root = await mount();
    root.querySelector<HTMLButtonElement>('button.projects-chip[data-doc="readme"]')!.click();
    await tick();
    const { currentZoom, handleZoomKey } = await import("./Projects");
    const storage = window.localStorage;
    const savedSet = storage.setItem;
    storage.setItem = () => { throw new Error("blocked"); };
    try {
      root.querySelector<HTMLButtonElement>('[data-zoom="1"]')!.click();
      expect(currentZoom()).toBe(110);
      root.querySelector<HTMLButtonElement>('[data-zoom="-1"]')!.click();
      expect(currentZoom()).toBe(100);
    } finally { storage.setItem = savedSet; }
    root.querySelector<HTMLButtonElement>("#projects-back")!.click();
    const event = new window.KeyboardEvent("keydown", { key: "=", metaKey: true, cancelable: true });
    expect(handleZoomKey(event as unknown as KeyboardEvent)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});

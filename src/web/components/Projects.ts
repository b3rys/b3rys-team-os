// Projects — 프로젝트 목록·문서 열람 탭 (계약 docs/PROJECTS_TAB.md §4).
// Reports 와 같은 자리·같은 밀도. 원본은 GitHub md, 여기서는 ★읽기만★ 한다.
//   GET  <base>/api/projects                 → { projects: [ProjectSummary] }
//   GET  <base>/api/projects/:id/doc/:key    → ProjectDoc (html 은 서버가 정제한 것 — 그대로 innerHTML)
//   GET  <base>/api/projects/:id/doc/:key/raw → text/markdown (MD 토글)
// URL 상태: /team?view=projects[&id=steno&doc=design] — 목록 ↔ 문서 deep-link.
// 개발 폴백: `?fixture=1` 일 때만, API 가 404 면 fixtures/projects-steno.example.json 을 쓴다.

import { pick } from "../i18n";
import { mdInlineToHtml } from "../lib/mdInline";
import { apiBase } from "../ws";

export type ProjectDocKey = "readme" | "design" | "features" | "todo";
export interface ProjectSummary {
  id: string;
  name: string;
  repo: string;
  branch: string;
  sha: string;
  intro: string;
  docs: { key: ProjectDocKey; path: string; exists: boolean }[];
  todo: { doing: number; plan: number; done: number; doingTitles: string[] };
  /** TODO 헤더에 이 문자열이 들어가면 그 절의 `[ ]` 는 plan 에서 뺀다 — 정본은 서버(projects.json). */
  excludeSections?: string[];
  kanban: { id: string; title: string; lane: "plan" | "doing"; updatedAt: string }[];
  fetchedAt: string;
  stale?: boolean;
}
export interface ProjectDoc {
  id: string;
  key: ProjectDocKey;
  sha: string;
  path: string;
  html: string;
  md: string;
  title: string;
  toc: { level: number; text: string; anchor: string }[];
  stale?: boolean;
  /** TODO 문서만: 서버가 센 현재 상태 (excludeSections 포함). */
  current?: { doing: number; plan: number; done: number; doingTitles: string[]; excludeSections?: string[] };
}
interface Fixture {
  summary: ProjectSummary;
  docs: Record<ProjectDocKey, ProjectDoc>;
}

const DOC_KEYS: ProjectDocKey[] = ["readme", "design", "features", "todo"];
const DOC_LABEL: Record<ProjectDocKey, string> = { readme: "README", design: "DESIGN", features: "FEATURES", todo: "TODO" };

// 컴포넌트 로컬 상태 (대시보드는 store.mainView, 여기 list↔doc 은 자체 상태 + URL 쿼리)
let _root: HTMLElement | null = null;
let _projects: ProjectSummary[] = [];
let _loaded = false;
let _loadError: string | null = null;
let _view: "list" | "doc" = "list";
let _curId: string | null = null;
let _curKey: ProjectDocKey | null = null;
let _curDoc: ProjectDoc | null = null;
let _mode: "html" | "md" = "html";
let _todoTab: "status" | "all" = "status";
let _tocOpen = false;       // 모바일: toc 접힘 기본
let _doneOpen = false;      // TODO 현재 상태: 완료 접힘 기본
let _rawCache = new Map<string, string>();

function escape(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** fetchedAt 상대시간 — 목록 줄 끝에 "N분 전". 파싱 실패면 원문. */
export function relTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escape(iso);
  const sec = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (sec < 60) return pick("방금", "just now");
  const min = Math.round(sec / 60);
  if (min < 60) return pick(`${min}분 전`, `${min}m ago`);
  const hr = Math.round(min / 60);
  if (hr < 24) return pick(`${hr}시간 전`, `${hr}h ago`);
  const day = Math.round(hr / 24);
  return pick(`${day}일 전`, `${day}d ago`);
}

function fixtureMode(): boolean {
  return new URLSearchParams(window.location.search).get("fixture") === "1";
}
async function loadFixture(): Promise<Fixture> {
  const mod = await import("../fixtures/projects-steno.example.json");
  return (mod.default ?? mod) as unknown as Fixture;
}

// missing = API 가 아직 없다: 404, 또는 SPA 폴백이 index.html(200, text/html) 을 돌려준 경우.
async function fetchJson(path: string): Promise<{ status: number; body: unknown; missing: boolean }> {
  const r = await fetch(`${apiBase()}/api/projects${path}`, { headers: { accept: "application/json" } });
  const isJson = (r.headers.get("content-type") ?? "").includes("json");
  let body: unknown = null;
  if (isJson) { try { body = await r.json(); } catch { body = null; } }
  return { status: r.status, body, missing: r.status === 404 || (r.ok && !isJson) };
}

/** 목록 — 실패해도 이전 목록을 빈 값으로 덮지 않는다(계약 §2). */
async function loadProjects(): Promise<void> {
  try {
    const { status, body, missing } = await fetchJson("");
    if (missing && fixtureMode()) {
      const fx = await loadFixture();
      _projects = [fx.summary];
      _loaded = true;
      _loadError = null;
      return;
    }
    if (status >= 400 || missing) throw new Error(`HTTP ${status}${(body as { error?: string })?.error ? ` — ${(body as { error: string }).error}` : ""}`);
    const list = (body as { projects?: ProjectSummary[] })?.projects;
    if (!Array.isArray(list)) throw new Error("bad response");
    _projects = list;
    _loaded = true;
    _loadError = null;
  } catch (e) {
    _loadError = (e as Error).message || String(e);
    if (!_projects.length) _loaded = false;
  }
}

async function loadDoc(id: string, key: ProjectDocKey): Promise<ProjectDoc> {
  const { status, body, missing } = await fetchJson(`/${encodeURIComponent(id)}/doc/${key}`);
  if (missing && fixtureMode()) {
    // fixture 는 프로젝트 하나 — 목록에 실린 첫 항목(= fixture summary) 의 id 만 받는다.
    const fx = await loadFixture();
    if (id !== (_projects[0]?.id ?? fx.summary.id)) throw new Error(`HTTP ${status}`);
    const d = fx.docs[key];
    if (!d) throw new Error("fixture has no " + key);
    _rawCache.set(`${id}/${key}`, d.md);
    return d;
  }
  if (status >= 400 || missing) throw new Error(`HTTP ${status}${(body as { error?: string })?.error ? ` — ${(body as { error: string }).error}` : ""}`);
  return body as ProjectDoc;
}

async function loadRaw(id: string, key: ProjectDocKey): Promise<string> {
  const cacheKey = `${id}/${key}`;
  const hit = _rawCache.get(cacheKey);
  if (hit != null) return hit;
  const r = await fetch(`${apiBase()}/api/projects/${encodeURIComponent(id)}/doc/${key}/raw`);
  if (!r.ok) throw new Error("HTTP " + r.status);
  const txt = await r.text();
  _rawCache.set(cacheKey, txt);
  return txt;
}

// ── URL 상태 (?view=projects&id=…&doc=…) ──
function readUrlState(): { id: string | null; doc: ProjectDocKey | null } {
  const p = new URLSearchParams(window.location.search);
  const id = p.get("id");
  const doc = p.get("doc");
  return { id, doc: doc && (DOC_KEYS as string[]).includes(doc) ? (doc as ProjectDocKey) : null };
}
function writeUrlState(id: string | null, doc: ProjectDocKey | null): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("id", id); else url.searchParams.delete("id");
  if (doc) url.searchParams.set("doc", doc); else url.searchParams.delete("doc");
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) window.history.replaceState(null, "", next);
}

// ── TODO.md 현재 상태 파싱 (계약 §3 규칙과 같은 모양) ──
// 제외 절 목록은 서버 응답(ProjectSummary.excludeSections · TODO doc current.excludeSections)에서 온다 — 여기에 목록을 두지 않는다.
export function parseTodoMd(md: string, excludeSections: readonly string[]): { doing: string[]; plan: string[]; done: string[] } {
  const doing: string[] = []; const plan: string[] = []; const done: string[] = [];
  let inKeep = false;
  for (const raw of String(md).replace(/\r\n/g, "\n").split("\n")) {
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) { inKeep = excludeSections.some((needle) => h[2]!.includes(needle)); continue; }
    const m = raw.match(/^\s*[-*]\s+\[([ ~x])\]\s+(.*)$/);
    if (!m) continue;
    const text = m[2]!.trim().slice(0, 60);
    if (m[1] === "~") doing.push(text);
    else if (m[1] === "x") done.push(text);
    else if (!inKeep) plan.push(text);
  }
  return { doing, plan, done };
}

// ── 스타일 (Reports 의 prose 와 같은 톤, projects 전용 클래스) ──
function injectStyle(): void {
  if (document.getElementById("projects-prose-style")) return;
  const st = document.createElement("style");
  st.id = "projects-prose-style";
  st.textContent = `
.projects-prose{font-size:14.5px;line-height:1.75;color:rgb(var(--slate-200));min-width:0;overflow-wrap:anywhere}
.projects-prose h1,.projects-prose h2,.projects-prose h3,.projects-prose h4{color:rgb(var(--slate-50));font-weight:700;line-height:1.3;margin:1.4em 0 .5em;letter-spacing:-.01em;scroll-margin-top:72px}
.projects-prose h1{font-size:1.6em;border-bottom:1px solid rgb(var(--border));padding-bottom:.3em}
.projects-prose h2{font-size:1.35em}.projects-prose h3{font-size:1.15em}.projects-prose h4{font-size:1em}
.projects-prose h1:first-child,.projects-prose h2:first-child{margin-top:0}
.projects-prose p{margin:.7em 0}
.projects-prose ul,.projects-prose ol{margin:.7em 0;padding-left:1.5em}
.projects-prose ul.task-list{list-style:none;padding-left:.2em}
.projects-prose li{margin:.3em 0}
.projects-prose a{color:var(--accent-soft-text);text-decoration:underline;text-underline-offset:2px}
.projects-prose code{background:rgb(var(--surface-0));border:1px solid rgb(var(--border));border-radius:5px;padding:.1em .4em;font-size:.88em;font-family:ui-monospace,Menlo,monospace;color:var(--accent-soft-text)}
.projects-prose pre{background:rgb(var(--surface-0));border:1px solid rgb(var(--border));border-radius:10px;padding:14px 16px;overflow-x:auto;margin:1em 0;max-width:100%}
.projects-prose pre code{background:none;border:0;padding:0;color:rgb(var(--slate-200))}
.projects-prose pre.mermaid-src{margin-top:0;border-top-left-radius:0;border-top-right-radius:0}
.projects-prose .projects-mermaid-badge{display:inline-flex;align-items:center;gap:6px;margin-top:1em;padding:3px 10px;border:1px solid rgb(var(--border));border-bottom:0;border-radius:8px 8px 0 0;background:rgb(var(--surface-1));font-size:11px;font-weight:600;color:var(--txt-amber)}
.projects-prose blockquote{border-left:3px solid rgb(var(--accent) / .5);padding:.2em 0 .2em 14px;margin:1em 0;color:rgb(var(--slate-400))}
.projects-prose strong{color:rgb(var(--slate-50));font-weight:600}
.projects-prose hr{border:0;border-top:1px solid rgb(var(--border));margin:1.6em 0}
.projects-prose img{max-width:100%;height:auto}
.projects-prose .table-wrap,.projects-prose table{max-width:100%}
.projects-prose table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.92em;display:block;overflow-x:auto}
.projects-prose th,.projects-prose td{border:1px solid rgb(var(--border));padding:7px 11px;text-align:left}
.projects-prose th{background:rgb(var(--surface-1));color:rgb(var(--slate-50));font-weight:600}
.projects-toc a{display:block;color:rgb(var(--slate-400));text-decoration:none;padding:2px 0;line-height:1.4;overflow-wrap:anywhere}
.projects-toc a:hover{color:rgb(var(--slate-100))}
.projects-toc a[data-level="1"]{font-weight:600;color:rgb(var(--slate-200))}
.projects-toc a[data-level="3"]{padding-left:12px;font-size:12px}
.projects-toc a[data-level="4"],.projects-toc a[data-level="5"],.projects-toc a[data-level="6"]{padding-left:22px;font-size:12px}
.projects-raw{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;color:rgb(var(--slate-200))}`;
  document.head.appendChild(st);
}

// ── 목록 ──
function githubUrl(p: ProjectSummary): string { return `https://github.com/${p.repo}`; }
function blobUrl(p: { repo: string; sha: string }, path: string): string { return `https://github.com/${p.repo}/blob/${p.sha}/${path}`; }

function chipHtml(p: ProjectSummary, d: ProjectSummary["docs"][number]): string {
  const base = "projects-chip inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border";
  if (!d.exists) {
    return `<span class="${base} text-slate-600 border-surface-3/60 bg-transparent cursor-not-allowed" data-doc="${d.key}" data-disabled="1" aria-disabled="true" title="${pick(`${d.path} 없음`, `${d.path} missing`)}">${DOC_LABEL[d.key]}</span>`;
  }
  return `<button class="${base} text-txt-green border-accent-green/30 bg-accent-green/10 hover:brightness-110" data-id="${escape(p.id)}" data-doc="${d.key}" title="${pick(`${d.path} 보기`, `Open ${d.path}`)}">${DOC_LABEL[d.key]}</button>`;
}

function currentTasks(p: ProjectSummary): string[] {
  const fromTodo = (p.todo?.doingTitles ?? []).slice(0, 3);
  const fromKanban = (p.kanban ?? []).filter((k) => k.lane === "doing").map((k) => k.title);
  return [...fromTodo, ...fromKanban];
}

function renderList(): void {
  if (!_root) return;
  const rows = _projects.map((p) => {
    const docs = DOC_KEYS.map((k) => p.docs.find((d) => d.key === k) ?? { key: k, path: "", exists: false });
    const chips = docs.map((d) => chipHtml(p, d)).join("");
    const tasks = currentTasks(p);
    const taskHtml = tasks.length
      ? `<ul class="projects-tasks mt-2 space-y-0.5">${tasks.map((t) => `<li class="text-[13px] text-slate-300 leading-snug flex gap-1.5 min-w-0"><span class="text-accent-greenSoft shrink-0">▸</span><span class="min-w-0 break-words">${mdInlineToHtml(t)}</span></li>`).join("")}</ul>`
      : `<div class="mt-2 text-[12px] text-slate-500">${pick("진행중인 과제 없음", "No task in progress")}</div>`;
    const stale = p.stale ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold border text-txt-amber border-amber-400/25 bg-amber-400/10" title="${pick("GitHub 조회 실패 — 캐시본", "GitHub fetch failed — cached copy")}">stale</span>` : "";
    return `
      <div class="projects-row group relative w-full text-left rounded-xl border border-surface-3 bg-surface-2 px-4 py-3 hover:bg-surface-3/60 transition-colors overflow-hidden" data-id="${escape(p.id)}">
        <span class="absolute left-0 top-0 bottom-0 w-[3px] bg-accent-green opacity-0 group-hover:opacity-100 transition-opacity"></span>
        <div class="flex items-start gap-2 flex-wrap">
          <div class="min-w-0 flex-1 text-[15px] font-semibold text-slate-100 leading-snug">${escape(p.name)}<span class="ml-2 text-[11px] font-normal text-slate-500 font-mono">${escape(p.id)}</span></div>
          <a class="projects-github shrink-0 inline-flex items-center gap-1 text-[12px] font-semibold text-slate-300 hover:text-accent-greenSoft" href="${escape(githubUrl(p))}" target="_blank" rel="noopener" title="${escape(p.repo)} · ${escape(p.branch)}">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>GitHub</a>
        </div>
        ${p.intro ? `<div class="text-[13px] text-slate-400 leading-relaxed mt-1.5 line-clamp-2">${escape(p.intro)}</div>` : ""}
        <div class="flex items-center gap-1.5 flex-wrap mt-2">${chips}</div>
        <div class="projects-counts flex items-center gap-1.5 flex-wrap text-[12px] mt-2">
          <span class="text-txt-amber font-semibold">${pick("진행중", "Doing")} <span data-count="doing">${p.todo?.doing ?? 0}</span></span><span class="text-slate-600">·</span>
          <span class="text-txt-blue font-semibold">${pick("계획", "Plan")} <span data-count="plan">${p.todo?.plan ?? 0}</span></span><span class="text-slate-600">·</span>
          <span class="text-txt-green font-semibold">${pick("완료", "Done")} <span data-count="done">${p.todo?.done ?? 0}</span></span>
          ${stale}
        </div>
        <div class="mt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">${pick("지금 과제", "Now")}</div>
        ${taskHtml}
        <div class="flex items-center gap-2 flex-wrap text-[11px] text-slate-500 mt-2"><span class="font-mono">${escape(p.sha.slice(0, 7))}</span><span>·</span><span data-fetched-at="${escape(p.fetchedAt)}">${relTime(p.fetchedAt)}</span></div>
      </div>`;
  }).join("");

  const empty = !_loaded
    ? `<div class="text-center text-slate-500 py-16"><div class="text-slate-300 font-medium mb-1">${pick("불러오는 중…", "Loading…")}</div></div>`
    : `<div class="text-center text-slate-500 py-16"><div class="text-slate-300 font-medium mb-1">${pick("등록된 프로젝트가 없습니다", "No projects registered")}</div><div class="text-xs">projects.json</div></div>`;
  const error = `<div class="projects-error text-center text-txt-red py-16">
    <div class="font-semibold mb-1">${pick("프로젝트 목록을 불러오지 못했습니다", "Failed to load projects")}</div>
    <div class="text-xs text-slate-500 mb-4">${escape(_loadError || "unknown error")}</div>
    <button id="projects-retry" class="px-3 py-1.5 rounded-lg border border-surface-3 bg-surface-2 text-sm text-slate-200 hover:bg-surface-3">${pick("다시 시도", "Retry")}</button>
  </div>`;

  _root.innerHTML = `
    <div data-projects-list-scroll class="h-full overflow-y-auto overflow-x-hidden">
      <div class="max-w-3xl mx-auto px-4 md:px-6 py-5 pb-20 min-w-0">
        <div class="flex items-center gap-2 flex-wrap mb-3">
          <div class="text-xs font-semibold uppercase tracking-widest text-slate-500">${pick("Projects · 프로젝트", "Projects")}</div>
          <span class="text-[11px] text-slate-500">${_projects.length}</span>
          <span class="ml-auto text-[11px] text-slate-500">${pick("원본은 GitHub md — 여기서는 읽기만", "Source is GitHub md — read-only here")}</span>
        </div>
        ${_loadError && !_projects.length ? error : (rows ? `<div class="space-y-2">${rows}</div>` : empty)}
      </div>
    </div>`;

  _root.querySelector<HTMLButtonElement>("#projects-retry")?.addEventListener("click", () => { void reload(); });
  _root.querySelectorAll<HTMLButtonElement>("button.projects-chip").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void openDoc(btn.dataset.id!, btn.dataset.doc as ProjectDocKey);
    });
  });
}

async function reload(): Promise<void> {
  _loaded = false;
  renderList();
  await loadProjects();
  if (_view === "list") renderList();
}

// ── 문서 화면 ──
function tocHtml(doc: ProjectDoc): string {
  if (!doc.toc?.length) return `<div class="text-[12px] text-slate-500">${pick("목차 없음", "No headings")}</div>`;
  return `<nav class="projects-toc text-[13px]">${doc.toc.map((t) => `<a href="#${escape(t.anchor)}" data-level="${t.level}" data-anchor="${escape(t.anchor)}">${escape(t.text)}</a>`).join("")}</nav>`;
}

function decorateMermaid(container: HTMLElement): number {
  const pres = Array.from(container.querySelectorAll<HTMLElement>("pre.mermaid-src"));
  for (const pre of pres) {
    const badge = document.createElement("div");
    badge.className = "projects-mermaid-badge";
    badge.textContent = pick("다이어그램 (렌더 예정)", "Diagram (render pending)");
    pre.parentElement?.insertBefore(badge, pre);
  }
  return pres.length;
}

function todoStatusHtml(p: ProjectSummary | null, doc: ProjectDoc): string {
  const parsed = parseTodoMd(doc.md ?? "", doc.current?.excludeSections ?? p?.excludeSections ?? []);
  const doingTitles = p?.todo?.doingTitles?.length ? p.todo.doingTitles : parsed.doing;
  const counts = p?.todo ?? { doing: doingTitles.length, plan: parsed.plan.length, done: parsed.done.length };
  const kanban = (p?.kanban ?? []);
  const MARK: Record<string, string> = { doing: "◐", plan: "○", done: "✓" };
  const item = (t: string, cls: string) => `<li class="flex gap-2 min-w-0 text-[13.5px] leading-snug text-slate-200"><span class="shrink-0 text-[11px] mt-0.5 ${cls === "doing" ? "text-txt-amber" : cls === "plan" ? "text-txt-blue" : "text-txt-green"}">${MARK[cls] ?? "·"}</span><span class="min-w-0 break-words">${mdInlineToHtml(t)}</span></li>`;
  const section = (title: string, count: number, cls: string, items: string[], extra = "") => `
    <section class="rounded-xl border border-surface-3 bg-surface-2 px-4 py-3" data-todo-section="${cls}">
      <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider ${cls === "doing" ? "text-txt-amber" : cls === "plan" ? "text-txt-blue" : "text-txt-green"}">${title}<span class="text-slate-500 normal-case tracking-normal font-mono">${count}</span></div>
      ${items.length ? `<ul class="mt-2 space-y-1">${items.map((t) => item(t, cls)).join("")}</ul>` : `<div class="mt-2 text-[12px] text-slate-500">${pick("없음", "None")}</div>`}
      ${extra}
    </section>`;
  const kanbanHtml = kanban.length
    ? `<section class="rounded-xl border border-surface-3 bg-surface-2 px-4 py-3" data-todo-section="kanban">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">${pick("칸반 과제", "Kanban tasks")}<span class="ml-2 text-slate-500 normal-case tracking-normal font-mono">${kanban.length}</span></div>
        <ul class="mt-2 space-y-1">${kanban.map((k) => `<li class="flex gap-2 min-w-0 text-[13.5px] text-slate-200"><span class="shrink-0 px-1.5 rounded text-[10px] font-semibold border ${k.lane === "doing" ? "text-txt-amber border-amber-400/25 bg-amber-400/10" : "text-txt-blue border-blue-400/25 bg-blue-400/10"}">${k.lane}</span><span class="min-w-0 break-words">${escape(k.title)}</span></li>`).join("")}</ul>
      </section>`
    : "";
  const DONE_PREVIEW = 5;
  const doneShown = _doneOpen ? parsed.done : parsed.done.slice(0, DONE_PREVIEW);
  const doneMore = parsed.done.length > DONE_PREVIEW
    ? `<button id="projects-done-more" class="mt-2 text-[12px] text-slate-400 hover:text-slate-100 underline underline-offset-2">${_doneOpen ? pick("접기", "Collapse") : pick(`더 보기 (${parsed.done.length - DONE_PREVIEW})`, `Show more (${parsed.done.length - DONE_PREVIEW})`)}</button>`
    : "";
  return `<div class="space-y-3">
    ${section(pick("진행중", "Doing"), counts.doing, "doing", doingTitles)}
    ${kanbanHtml}
    ${section(pick("계획", "Plan"), counts.plan, "plan", parsed.plan)}
    ${section(pick("완료", "Done"), counts.done, "done", doneShown, doneMore)}
  </div>`;
}

async function renderDoc(): Promise<void> {
  if (!_root || !_curId || !_curKey) return;
  const id = _curId; const key = _curKey;
  const project = _projects.find((p) => p.id === id) ?? null;
  const backBtn = `<button id="projects-back" title="${pick("프로젝트 목록으로", "Back to project list")}" class="inline-flex items-center gap-1.5 shrink-0 text-txt-green text-sm font-semibold px-3 py-1.5 rounded-lg border border-accent-green/45 bg-accent-green/12 hover:bg-accent-green/20 hover:border-accent-green/70 transition-colors">← ${pick("목록", "List")}</button>`;
  _root.innerHTML = `<div class="h-full overflow-y-auto"><div class="max-w-5xl mx-auto px-4 md:px-6 py-5">${backBtn}<div class="text-slate-500 py-16 text-center">${pick("문서 불러오는 중…", "Loading document…")}</div></div></div>`;
  _root.querySelector("#projects-back")?.addEventListener("click", goList);

  let doc: ProjectDoc;
  try {
    doc = _curDoc && _curDoc.id === id && _curDoc.key === key ? _curDoc : await loadDoc(id, key);
  } catch (e) {
    if (!_root || _curId !== id || _curKey !== key) return;
    _root.innerHTML = `<div class="h-full overflow-y-auto"><div class="max-w-5xl mx-auto px-4 md:px-6 py-5">${backBtn}<div class="projects-error text-center text-txt-red py-16"><div class="font-medium">${pick("문서를 불러오지 못했습니다", "Failed to load document")}</div><div class="text-xs text-slate-500 mt-1">${escape(id)}/${escape(key)} · ${escape((e as Error).message)}</div></div></div></div>`;
    _root.querySelector("#projects-back")?.addEventListener("click", goList);
    return;
  }
  if (!_root || _curId !== id || _curKey !== key) return;
  _curDoc = doc;

  const repo = project?.repo ?? "";
  const gh = repo ? `<a id="projects-open-github" href="${escape(blobUrl({ repo, sha: doc.sha }, doc.path))}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg border border-surface-3 text-slate-200 bg-surface-2 hover:text-slate-100 hover:border-accent-green/45 hover:bg-surface-0 transition-colors"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>${pick("GitHub 에서 보기", "View on GitHub")}</a>` : "";
  const modeBtn = (m: "html" | "md") => `<button class="projects-mode px-3 py-1 text-xs font-semibold uppercase tracking-wide border transition-colors ${m === "html" ? "rounded-l-lg" : "rounded-r-lg -ml-px"} ${_mode === m ? "text-accent-green border-accent-green/35 bg-accent-green/10" : "text-slate-400 border-surface-3 bg-surface-2 hover:text-slate-200"}" data-mode="${m}" aria-pressed="${_mode === m}">${m.toUpperCase()}</button>`;
  const isTodo = key === "todo";
  const todoTabBtn = (t: "status" | "all", label: string) => `<button class="projects-todo-tab px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${_todoTab === t ? "text-slate-100 bg-surface-0 border-surface-3" : "text-slate-400 border-transparent hover:text-slate-200"}" data-todo-tab="${t}" aria-pressed="${_todoTab === t}">${label}</button>`;
  const stale = doc.stale ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold border text-txt-amber border-amber-400/25 bg-amber-400/10">stale</span>` : "";

  _root.innerHTML = `
    <div data-projects-doc-scroll class="h-full overflow-y-auto overflow-x-hidden">
      <div class="max-w-5xl mx-auto px-4 md:px-6 pb-20 min-w-0">
        <div class="sticky top-0 z-20 -mx-4 md:-mx-6 px-4 md:px-6 bg-surface-1/95 backdrop-blur border-b border-surface-3">
          <div class="flex items-center gap-3 py-2.5 min-w-0">
            ${backBtn}
            <div class="min-w-0 flex-1">
              <div class="text-[15px] font-semibold text-slate-100 truncate" title="${escape(doc.title)}">${escape(doc.title)}</div>
              <div class="text-[11px] text-slate-500 leading-snug break-words">${escape(project?.name ?? id)} · ${escape(doc.path)} · <span class="font-mono">${escape(doc.sha.slice(0, 7))}</span> ${stale}</div>
            </div>
            <div class="flex shrink-0" role="group" aria-label="HTML | MD">${modeBtn("html")}${modeBtn("md")}</div>
          </div>
          <div class="flex items-center gap-2 flex-wrap pb-2.5">
            <button id="projects-toc-toggle" class="md:hidden inline-flex items-center gap-1 text-[12px] font-semibold px-3 py-1.5 rounded-lg border border-surface-3 text-slate-300 bg-surface-2" aria-expanded="${_tocOpen}">${pick("목차", "Contents")} ${_tocOpen ? "▴" : "▾"}</button>
            ${isTodo && _mode === "html" ? `<div class="flex gap-1 rounded-lg border border-surface-3 bg-surface-2 p-0.5">${todoTabBtn("status", pick("현재 상태", "Status"))}${todoTabBtn("all", pick("전체", "All"))}</div>` : ""}
            <span class="ml-auto"></span>
            ${gh}
          </div>
        </div>
        <div class="pt-4 grid grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)] gap-6 min-w-0">
          <aside id="projects-toc" class="${_tocOpen ? "block" : "hidden"} md:block md:sticky md:top-24 md:self-start md:max-h-[calc(100vh-8rem)] md:overflow-y-auto rounded-xl border border-surface-3 bg-surface-2 px-3 py-3 min-w-0">
            <div class="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1.5">${pick("목차", "Contents")}</div>
            ${tocHtml(doc)}
          </aside>
          <div id="projects-viewer" class="min-w-0"></div>
        </div>
      </div>
    </div>`;

  _root.querySelector("#projects-back")?.addEventListener("click", goList);
  _root.querySelector<HTMLButtonElement>("#projects-toc-toggle")?.addEventListener("click", () => { _tocOpen = !_tocOpen; void renderDoc(); });
  _root.querySelectorAll<HTMLButtonElement>(".projects-mode").forEach((b) => b.addEventListener("click", () => {
    const m = b.dataset.mode as "html" | "md";
    if (m === _mode) return;
    _mode = m; void renderDoc();
  }));
  _root.querySelectorAll<HTMLButtonElement>(".projects-todo-tab").forEach((b) => b.addEventListener("click", () => {
    const t = b.dataset.todoTab as "status" | "all";
    if (t === _todoTab) return;
    _todoTab = t; void renderDoc();
  }));
  // toc 클릭 → 본문 헤딩으로 스크롤 (id 는 서버 anchor). 모바일은 누른 뒤 toc 를 접는다.
  _root.querySelectorAll<HTMLAnchorElement>(".projects-toc a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const anchor = a.dataset.anchor ?? "";
    const target = _root?.querySelector<HTMLElement>("#projects-viewer")?.querySelector<HTMLElement>(`[id="${anchor.replace(/"/g, '\\"')}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (_tocOpen) { _tocOpen = false; _root?.querySelector("#projects-toc")?.classList.add("hidden"); }
  }));

  const viewer = _root.querySelector<HTMLDivElement>("#projects-viewer");
  if (!viewer) return;
  if (_mode === "md") {
    viewer.innerHTML = `<div class="rounded-xl border border-surface-3 bg-surface-2 p-4 md:p-6 text-slate-500">${pick("원문 불러오는 중…", "Loading source…")}</div>`;
    try {
      const raw = await loadRaw(id, key);
      if (_mode !== "md" || _curKey !== key) return;
      viewer.innerHTML = `<pre class="projects-raw rounded-xl border border-surface-3 bg-surface-2 p-4 md:p-6 overflow-x-auto">${escape(raw)}</pre>`;
    } catch (e) {
      viewer.innerHTML = `<div class="rounded-xl border border-surface-3 bg-surface-2 p-4 md:p-6 text-txt-red">${pick("원문 불러오기 실패", "Failed to load source")}: ${escape((e as Error).message)}</div>`;
    }
    return;
  }
  if (isTodo && _todoTab === "status") {
    viewer.innerHTML = `<div class="projects-todo-status">${todoStatusHtml(project, doc)}</div>`;
    viewer.querySelector<HTMLButtonElement>("#projects-done-more")?.addEventListener("click", () => { _doneOpen = !_doneOpen; void renderDoc(); });
    return;
  }
  // 서버가 정제한 HTML 을 그대로. mermaid 원문 블록에는 배지를 붙인다.
  viewer.innerHTML = `<article class="projects-prose rounded-xl border border-surface-3 bg-surface-2 p-5 md:p-8">${doc.html}</article>`;
  decorateMermaid(viewer);
}

async function openDoc(id: string, key: ProjectDocKey): Promise<void> {
  _view = "doc";
  _curId = id;
  _curKey = key;
  _curDoc = null;
  _mode = "html";
  _todoTab = "status";
  _tocOpen = false;
  _doneOpen = false;
  writeUrlState(id, key);
  await renderDoc();
}

function goList(): void {
  _view = "list";
  _curId = null;
  _curKey = null;
  _curDoc = null;
  writeUrlState(null, null);
  renderList();
}

async function ensureLoaded(): Promise<void> {
  if (_loaded) return;
  await loadProjects();
}

/** 테스트·재마운트용 — 모듈 상태 초기화. */
export function resetProjectsState(): void {
  _root = null; _projects = []; _loaded = false; _loadError = null;
  _view = "list"; _curId = null; _curKey = null; _curDoc = null;
  _mode = "html"; _todoTab = "status"; _tocOpen = false; _doneOpen = false;
  _rawCache = new Map();
}

export function renderProjects(root: HTMLElement): void {
  _root = root;
  injectStyle();
  const { id, doc } = readUrlState();
  if (id && doc) { _view = "doc"; _curId = id; _curKey = doc; _curDoc = null; }
  root.innerHTML = `<div class="h-full overflow-y-auto"><div class="max-w-3xl mx-auto px-4 md:px-6 py-5"><div class="text-slate-500 py-16 text-center">${pick("프로젝트 목록 불러오는 중…", "Loading projects…")}</div></div></div>`;
  void ensureLoaded().then(() => {
    if (!_root) return;
    if (_view === "doc" && _curId && _curKey) void renderDoc();
    else renderList();
  });
}

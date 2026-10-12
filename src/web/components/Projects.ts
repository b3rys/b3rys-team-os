import { browseListClass, browseTabClass } from "./BrowseStyles";
// Projects — 프로젝트 목록·문서 열람 탭 (계약 docs/PROJECTS_TAB.md §4).
// Reports와 색 토큰·목록 여백을 공유한다. 원본은 GitHub md, 여기서는 ★읽기만★ 한다.
//   GET  <base>/api/projects                 → { projects: [ProjectSummary] }
//   GET  <base>/api/projects/:id/doc/:key    → ProjectDoc (html 은 서버가 정제한 것 — 그대로 innerHTML)
//   GET  <base>/api/projects/:id/doc/:key/raw → text/markdown (MD 토글)
// URL 상태: /team?view=projects[&id=sample&doc=design[&sec=<anchor>]] — 목록 ↔ 문서 ↔ 절 deep-link.
// 문서 화면: 왼쪽 목차 트리(절마다 접기/펼치기, 현재 절만 펼침) + 본문은 ★전체 문서★ 한 번에(스크롤 이동).
//   절 판정(현재 절·트리 재료)은 lib/projectSections.ts 의 splitSections. 스크롤 위치 → 현재 절 → &sec= 갱신.
// 문서 화면에 들어가면 대시보드 좌우 패널(팀원·THREADS)을 접고, 목록·다른 탭으로 나가면 들어오기 전 상태로 되돌린다
//   (사용자가 문서 안에서 직접 펼친 패널은 그 세션에선 다시 접지 않는다) — lib/panels.ts.
// 개발 폴백: `?fixture=1` 일 때만, API 가 404 면 fixtures/projects-sample.example.json 을 쓴다.

import { dashboardScaleFactor, layoutPixels } from "../lib/dashboardScale";
import { projectsCss } from "./ProjectsStyles";
import { pick } from "../i18n";
import { mdInlineToHtml } from "../lib/mdInline";
import { applyPanelCollapsed, isPanelCollapsed, onPanelChange, PANEL_IDS, type Panel } from "../lib/panels";
import { splitSections, type DocSection } from "../lib/projectSections";
import { proseCss } from "../../shared/projectsProse";
import { renderMermaidFigures, type MermaidLike } from "../../shared/mermaidFigures";
import { renderIcon } from "../icons";
import { apiBase } from "../ws";

export type ProjectDocKey = "readme" | "project" | "design" | "features" | "todo";
export interface ProjectSummary {
  tracks?: ProjectTrackSummary[];
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
export type ProjectTrackSummary = Omit<ProjectSummary, "tracks"> | { id: string; name: string; repo: string; error: string; key: string };
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

const DOC_KEYS: ProjectDocKey[] = ["readme", "project", "design", "features", "todo"];
const DOC_LABEL: Record<ProjectDocKey, string> = { readme: "README", project: "PROJECT", design: "DESIGN", features: "FEATURES", todo: "TODO" };

// 컴포넌트 로컬 상태 (대시보드는 store.mainView, 여기 list↔doc 은 자체 상태 + URL 쿼리)
let _root: HTMLElement | null = null;
let _projects: ProjectSummary[] = [];
let _loaded = false;
let _loadError: string | null = null;
let _view: "list" | "doc" = "list";
let _curId: string | null = null;
let _curTrack: string | null = null;
let _listScrollTop = 0;
let _curKey: ProjectDocKey | null = null;
let _curDoc: ProjectDoc | null = null;
let _mode: "html" | "md" = "html";
let _todoTab: "status" | "all" = "status";
let _curSec: string | null = null;   // 현재 절(anchor). null = 첫 절
let _curHead: string | null = null;  // 스크롤 위치의 헤딩(anchor) — 트리 강조
let _tocOpen = new Set<string>();    // 트리에서 펼친 절(anchor). 현재 절이 바뀌면 그 절만
let _tocMobileOpen = false;          // 모바일: 목차 접힘 기본
let _doneOpen = false;      // TODO 현재 상태: 완료 접힘 기본
let _rawCache = new Map<string, string>();

// ── 좌우 패널 자동 접기 (문서 화면) ──
// 들어갈 때 두 패널의 그때 상태를 적어 두고 접는다(저장 X). 나갈 때 사용자가 손대지 않은 패널만 그 상태로 되돌린다.
// 사용자가 문서 안에서 직접 펼친 패널은 _keepOpen 에 올려 이 세션(페이지 수명)에선 다시 접지 않는다.
let _panelsBefore: Partial<Record<Panel, boolean>> | null = null; // null = 문서 화면 밖
let _panelsTouched = new Set<Panel>();
const _keepOpen = new Set<Panel>();
let _panelUnsub: (() => void) | null = null;
let _visible = true; // main.ts 가 Projects 탭을 보이는 중인가

function watchPanels(): void {
  if (_panelUnsub) return;
  _panelUnsub = onPanelChange((panel, collapsed, source) => {
    if (source !== "user" || !_panelsBefore) return;
    _panelsTouched.add(panel);
    if (collapsed) _keepOpen.delete(panel); else _keepOpen.add(panel);
  });
}
function enterDocPanels(): void {
  if (_panelsBefore || !_visible) return;
  watchPanels();
  _panelsBefore = {};
  _panelsTouched = new Set();
  for (const p of PANEL_IDS) {
    _panelsBefore[p] = isPanelCollapsed(p);
    if (!_keepOpen.has(p)) applyPanelCollapsed(p, true);
  }
}
function leaveDocPanels(): void {
  if (!_panelsBefore) return;
  const before = _panelsBefore;
  _panelsBefore = null;
  for (const p of PANEL_IDS) {
    if (_panelsTouched.has(p)) continue;
    applyPanelCollapsed(p, before[p] ?? false);
  }
  _panelsTouched = new Set();
}
/** main.ts: Projects 탭이 보이기 시작/끝날 때. 문서 화면이면 패널을 접거나 되돌린다. */
export function setProjectsVisible(visible: boolean): void {
  _visible = visible;
  if (_view !== "doc") return;
  if (visible) enterDocPanels(); else leaveDocPanels();
}

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
  const mod = await import("../fixtures/projects-sample.example.json");
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
  const { status, body, missing } = await fetchJson(`/${encodeURIComponent(id)}/doc/${key}${trackQuery()}`);
  if (missing && fixtureMode()) {
    // fixture 는 프로젝트 하나 — 목록에 실린 첫 항목(= fixture summary) 의 id 만 받는다.
    const fx = await loadFixture();
    if (id !== (_projects[0]?.id ?? fx.summary.id)) throw new Error(`HTTP ${status}`);
    const d = fx.docs[key];
    if (!d) throw new Error("fixture has no " + key);
    _rawCache.set(`${id}/${_curTrack ?? ""}/${key}`, d.md);
    return d;
  }
  if (status >= 400 || missing) throw new Error(`HTTP ${status}${(body as { error?: string })?.error ? ` — ${(body as { error: string }).error}` : ""}`);
  return body as ProjectDoc;
}

async function loadRaw(id: string, key: ProjectDocKey): Promise<string> {
  const cacheKey = `${id}/${_curTrack ?? ""}/${key}`;
  const hit = _rawCache.get(cacheKey);
  if (hit != null) return hit;
  const r = await fetch(`${apiBase()}/api/projects/${encodeURIComponent(id)}/doc/${key}/raw${trackQuery()}`);
  if (!r.ok) throw new Error("HTTP " + r.status);
  const txt = await r.text();
  _rawCache.set(cacheKey, txt);
  return txt;
}

// ── URL 상태 (?view=projects&id=…&doc=…) ──
function readUrlState(): { id: string | null; doc: ProjectDocKey | null; sec: string | null; track: string | null } {
  const p = new URLSearchParams(window.location.search);
  const id = p.get("id");
  const doc = p.get("doc");
  return { id, doc: doc && (DOC_KEYS as string[]).includes(doc) ? (doc as ProjectDocKey) : null, sec: p.get("sec") || null, track: p.get("track") };
}
function writeUrlState(id: string | null, doc: ProjectDocKey | null, sec: string | null = null): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("id", id); else url.searchParams.delete("id");
  if (doc) url.searchParams.set("doc", doc); else url.searchParams.delete("doc");
  if (id && doc && sec) url.searchParams.set("sec", sec); else url.searchParams.delete("sec");
  if (id && _curTrack !== null) url.searchParams.set("track", _curTrack); else url.searchParams.delete("track");
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
/** 문서 화면 sticky 헤더 높이의 기본값(한 줄 + 여백). 실제 높이는 렌더 뒤 measureHeadOffset 이 재서 --projects-head 로 덮는다 — 헤딩 scroll-margin-top 과 스크롤 추적 판정선이 같이 쓴다. */
const HEAD_OFFSET = 72;
let _headOffset = HEAD_OFFSET;
let _headObserver: ResizeObserver | null = null;
/** sticky 헤더의 실제 높이를 재서 --projects-head(px) 로 반영. 잴 수 없으면(레이아웃 없음) 기본값 유지. */
export function measureHeadOffset(): number {
  const head = _root?.querySelector<HTMLElement>("[data-projects-doc-head]");
  const h = head?.offsetHeight ?? 0;
  if (!_root || !head || !h) return _headOffset;
  _headOffset = h + 12;
  _root.style.setProperty("--projects-head", `${_headOffset}px`);
  return _headOffset;
}
function observeHead(): void {
  _headObserver?.disconnect();
  _headObserver = null;
  const head = _root?.querySelector<HTMLElement>("[data-projects-doc-head]");
  if (!head || typeof ResizeObserver === "undefined") return;
  _headObserver = new ResizeObserver(() => measureHeadOffset());
  _headObserver.observe(head);
}
function injectStyle(): void {
  if (document.getElementById("projects-prose-style")) return;
  const st = document.createElement("style");
  st.id = "projects-prose-style";
  st.textContent = proseCss(HEAD_OFFSET) + projectsCss;
  document.head.appendChild(st);
}

// ── 목록 ──
function githubUrl(p: ProjectSummary): string { return `https://github.com/${p.repo}`; }
/** 새창 페이지 — 서버가 만드는 독립 HTML(문서 전환 바 포함). mode=md 면 원문. */
function trackQuery(track = _curTrack, mode?: "html" | "md"): string {
  const q = new URLSearchParams(); if (track !== null) q.set("track", track); if (mode === "md") q.set("mode", "md");
  return q.size ? `?${q}` : "";
}
function pageUrl(id: string, key: ProjectDocKey, mode: "html" | "md", track = _curTrack): string { return `${apiBase()}/api/projects/${encodeURIComponent(id)}/doc/${key}/page${trackQuery(track, mode)}`; }
function blobUrl(p: { repo: string; sha: string }, path: string): string { return `https://github.com/${p.repo}/blob/${p.sha}/${path}`; }

function chipHtml(p: ProjectSummary, d: ProjectSummary["docs"][number]): string {
  const base = `projects-chip ${browseTabClass(false)} border border-surface-3`;
  if (!d.exists) {
    return `<span class="${base} text-slate-600 border-surface-3/60 bg-transparent cursor-not-allowed" data-doc="${d.key}" data-disabled="1" aria-disabled="true" title="${pick(`${d.path} 없음`, `${d.path} missing`)}">${DOC_LABEL[d.key]}</span>`;
  }
  return `<button class="${base}" data-id="${escape(p.id)}" data-doc="${d.key}" title="${pick(`${d.path} 보기`, `Open ${d.path}`)}">${DOC_LABEL[d.key]}</button>`;
}

function currentTasks(p: ProjectSummary): string[] {
  const fromTodo = p.todo?.doingTitles ?? [];
  const fromKanban = (p.kanban ?? []).filter((k) => k.lane === "doing").map((k) => k.title);
  return [...fromTodo, ...fromKanban];
}

function countsHtml(p: ProjectSummary): string {
  return `<span class="projects-counts inline-flex items-center gap-2 text-[12px] whitespace-nowrap"><span class="text-txt-amber">${pick("진행", "Doing")} <span data-count="doing">${p.todo?.doing ?? 0}</span></span><span class="text-txt-blue">${pick("계획", "Plan")} <span data-count="plan">${p.todo?.plan ?? 0}</span></span><span class="text-txt-green">${pick("완료", "Done")} <span data-count="done">${p.todo?.done ?? 0}</span></span></span>`;
}
export function taskLabel(title: string): string {
  return title.replace(/^\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D★✦✓✔]+\s*)+/u, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
}
function trackHtml(p: ProjectSummary, t: ProjectTrackSummary): string {
  const track = p.tracks ? t.id : "";
  if ("error" in t) return `<section class="projects-track" data-track="${escape(track)}"><strong>${escape(t.name)}</strong><p class="text-txt-amber text-[12px]">${pick("트랙을 불러오지 못했습니다", "Track unavailable")} · ${escape(t.error)}</p></section>`;
  const tasks = [...new Set(currentTasks(t).map(taskLabel).filter(Boolean))];
  const total = t.todo.doing + t.todo.plan + t.todo.done;
  const percent = total ? Math.round(t.todo.done / total * 100) : 0;
  const task = (title: string) => `<li class="projects-task" title="${escape(title)}">${escape(title)}</li>`;
  return `<section class="projects-track" data-track="${escape(track)}">
    <div class="projects-track-line">${(p.tracks?.length ?? 1) > 1 ? `<h2 class="projects-track-name">${escape(t.name)}</h2>` : ""}${countsHtml(t)}
      <div class="projects-progress" role="progressbar" aria-label="${escape(t.name)} ${pick("완료", "Done")}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>
      <div class="projects-docs">${t.docs.map(d => chipHtml({ ...t, id: p.id }, d).replace('data-id=', `data-track="${escape(track)}" data-id=`)).join("")}</div>
      <a class="projects-github" href="${escape(githubUrl(t))}" target="_blank" rel="noopener">GitHub</a>
      <time class="projects-updated" data-fetched-at="${escape(t.fetchedAt)}" datetime="${escape(t.fetchedAt)}">${relTime(t.fetchedAt)}${t.stale ? " · stale" : ""}</time>
    </div>
    <div class="projects-now"><span>${pick("지금 과제", "Now")}</span><div class="min-w-0"><ul class="projects-tasks">${tasks.slice(0,3).map(task).join("") || `<li class="text-slate-500">${pick("진행중인 과제 없음", "No task in progress")}</li>`}</ul>
      ${tasks.length > 3 ? `<details class="projects-more"><summary>+${tasks.length - 3} ${pick("펼침", "more")}</summary><ul class="projects-tasks">${tasks.slice(3).map(task).join("")}</ul></details>` : ""}</div></div>
  </section>`;
}
/** The card opens the first track, preferring its available PROJECT document. */
export function projectEntry(p: ProjectSummary): { track: string | null; key: ProjectDocKey } | null {
  const first = p.tracks?.[0] ?? p;
  if ("error" in first) return null;
  const key = (["project", "readme"] as ProjectDocKey[]).find(key => first.docs.some(doc => doc.key === key && doc.exists));
  return key ? { track: p.tracks ? first.id : null, key } : null;
}
function renderList(): void {
  if (!_root) return;
  const rows = _projects.map(p => `<article tabindex="-1" class="projects-row projects-card" data-id="${escape(p.id)}">
    <button type="button" class="projects-card-head" data-open-project="${escape(p.id)}"${projectEntry(p) ? "" : ` disabled title="${pick("읽을 수 있는 첫 트랙 문서가 없습니다", "No available first-track document")}"`}><span class="projects-card-name">${escape(p.name)}</span><span class="projects-card-intro">${escape(p.intro)}</span></button>
    ${(p.tracks ?? [p]).map(t => trackHtml(p,t)).join("")}</article>`).join("");
  _root.innerHTML = `<div data-projects-list-scroll class="h-full overflow-y-auto overflow-x-hidden"><div class="${browseListClass}">
    <div class="projects-list-head"><span class="text-[15px] font-semibold text-slate-100">${pick("Projects · 프로젝트", "Projects")}</span><span class="text-[12px] text-slate-500">${_projects.length}</span>
      <button id="projects-retry" type="button" class="projects-refresh ml-auto" title="${_loadError ? pick("다시 시도", "Retry") : pick("새로 고침", "Refresh")}" aria-label="${_loadError ? pick("다시 시도", "Retry") : pick("새로 고침", "Refresh")}">${renderIcon("refresh-cw", { size: 15 })}</button></div>
    ${_loadError ? `<div class="projects-error py-4 text-[13px] text-txt-red">${pick("프로젝트 목록을 불러오지 못했습니다", "Failed to load projects")} · ${escape(_loadError)}</div>` : ""}
    ${rows || (_loadError ? "" : `<div class="py-16 text-center text-slate-500">${pick("등록된 프로젝트가 없습니다", "No projects registered")}</div>`)}</div></div>`;
  const scroll = _root.querySelector<HTMLElement>("[data-projects-list-scroll]");
  if (scroll) scroll.scrollTop = _listScrollTop;
  const card = Array.from(_root.querySelectorAll<HTMLElement>(".projects-card")).find(el => el.dataset.id === _curId);
  card?.scrollIntoView?.({ block: "center" });
  _root.querySelectorAll<HTMLButtonElement>("[data-open-project]").forEach(button => button.addEventListener("click", () => {
    const project = _projects.find(project => project.id === button.dataset.openProject);
    const entry = project && projectEntry(project);
    if (!project || !entry) return;
    _listScrollTop = scroll?.scrollTop ?? 0;
    _curTrack = entry.track;
    void openDoc(project.id, entry.key);
  }));
  _root.querySelector("#projects-retry")?.addEventListener("click", () => { void reload(); });
  _root.querySelectorAll<HTMLButtonElement>("button.projects-chip").forEach(btn => btn.addEventListener("click", () => {
    _listScrollTop = scroll?.scrollTop ?? 0;
    _curTrack = btn.dataset.track || null; void openDoc(btn.dataset.id!, btn.dataset.doc as ProjectDocKey);
  }));
}
function showListCard(id: string): void {
  leaveDocPanels(); _view = "list"; _curId = id; _curKey = null; _curDoc = null; _curTrack = null;
  writeUrlState(id, null); renderList();
}

async function reload(): Promise<void> {
  _loaded = false;
  renderList();
  await loadProjects();
  if (_view === "list") renderList();
}

// ── 문서 화면 ──
// 목차 트리 — 절(최상위 헤딩) 줄 + 그 아래 들여쓴 하위 헤딩. 현재 절만 펼침, 캐럿으로 다른 절도 펼쳐 볼 수 있다.
function pickSection(secs: DocSection[], anchor: string | null): DocSection {
  return (anchor && secs.find((s) => s.anchor === anchor)) || secs[0]!;
}
/** 트리를 보일 만한가 — 절이 둘 이상이거나 하위 헤딩이 있을 때. 헤딩 없는 문서는 본문만 전체 폭. */
function hasToc(secs: DocSection[]): boolean {
  return secs.length > 1 || (secs[0]?.children.length ?? 0) > 0;
}
/** 목차 글자 — 제목의 이모지·장식 기호(★✦✓ 등)를 빼고 공백을 정리한다. 본문 제목은 그대로, 목차만 담백하게(팀장 2026-09-18). */
export function tocLabel(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[★☆✦✧✓✔✗✘◆◇■□●○▶▷►]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-·—–:]+|[\s\-·—–:]+$/g, "") || text.trim();
}
function tocTreeHtml(secs: DocSection[], cur: DocSection): string {
  const rows = secs.map((s) => {
    const open = s === cur || _tocOpen.has(s.anchor);
    const caret = s.children.length
      ? `<button class="projects-toc-caret" type="button" data-toggle="${escape(s.anchor)}" aria-expanded="${open}" aria-label="${pick("소제목 접기/펼치기", "Toggle subheadings")}">▶</button>`
      : `<span class="projects-toc-caret" aria-hidden="true"></span>`;
    const kids = s.children.length
      ? `<div class="projects-toc-children">${s.children.map((t) => `<a href="#${escape(t.anchor)}" data-level="${t.level}" data-anchor="${escape(t.anchor)}" aria-label="${escape(t.text)}" aria-current="${t.anchor === _curHead}"><span class="projects-toc-label">${escape(tocLabel(t.text))}</span></a>`).join("")}</div>`
      : "";
    return `<div class="projects-toc-sec" data-sec="${escape(s.anchor)}" data-open="${open}">
      <div class="projects-toc-row">${caret}<button class="projects-toc-head" type="button" data-sec="${escape(s.anchor)}" aria-label="${escape(s.label)}" aria-current="${s === cur}"><span class="projects-toc-label">${escape(tocLabel(s.label))}</span></button></div>
      ${kids}</div>`;
  }).join("");
  return `<nav class="projects-toc" aria-label="${pick("목차", "Contents")}">${rows}</nav>`;
}
/** 헤딩 anchor → 그 헤딩이 속한 절. 절 헤딩 자체면 그 절. */
function sectionOf(secs: DocSection[], anchor: string): DocSection | null {
  return secs.find((s) => s.anchor === anchor || s.children.some((c) => c.anchor === anchor)) ?? null;
}
function scrollToAnchor(viewer: HTMLElement, anchor: string, smooth = true): void {
  const target = anchor ? viewer.querySelector<HTMLElement>(`[id="${anchor.replace(/"/g, '\\"')}"]`) : viewer;
  target?.scrollIntoView?.({ behavior: smooth ? "smooth" : "auto", block: "start" });
}

// mermaid 는 5MB 라 문서에 다이어그램이 있을 때만 별도 청크로 받는다. 테스트는 setMermaidLoader 로 가짜를 넣는다.
let _mermaidLoader: () => Promise<MermaidLike> = () => import("mermaid").then((m) => (m.default ?? m) as unknown as MermaidLike);
let _mermaidMod: Promise<MermaidLike> | null = null;
export function setMermaidLoader(fn: (() => Promise<MermaidLike>) | null): void {
  _mermaidLoader = fn ?? (() => import("mermaid").then((m) => (m.default ?? m) as unknown as MermaidLike));
  _mermaidMod = null;
}
/** 다이어그램 figure 를 SVG 로. 로드·렌더 실패 시 서버가 넣은 "렌더 예정" 캡션과 원문이 그대로 남는다. */
function decorateMermaid(container: HTMLElement): number {
  const count = container.querySelectorAll("figure.project-diagram").length;
  if (!count) return 0;
  const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  _mermaidMod ??= _mermaidLoader();
  void _mermaidMod
    .then((m) => renderMermaidFigures(container, m, { dark, errorText: pick("다이어그램 문법 오류 — 원문 표시", "Diagram syntax error — showing source") }))
    .catch(() => { _mermaidMod = null; });
  return count;
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
        <ul class="mt-2 space-y-1">${kanban.map((k) => `<li class="flex gap-2 min-w-0 text-[13.5px] text-slate-200"><span class="shrink-0 px-1.5 rounded text-[11px] font-semibold border ${k.lane === "doing" ? "text-txt-amber border-amber-400/25 bg-amber-400/10" : "text-txt-blue border-blue-400/25 bg-blue-400/10"}">${k.lane}</span><span class="min-w-0 break-words">${escape(k.title)}</span></li>`).join("")}</ul>
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
  const parent = _projects.find((p) => p.id === id) ?? null;
  const selected = parent?.tracks?.find(t => t.id === _curTrack);
  const project = selected && !("error" in selected) ? selected : parent;
  const track = _curTrack;
  const backBtn = `<button id="projects-back" title="${pick("프로젝트 목록으로", "Back to project list")}" class="projects-back">${renderIcon("arrow-left", { size: 16 })}<span>${pick("목록", "List")}</span></button>`;
  _root.innerHTML = `<div class="h-full overflow-y-auto"><div class="w-full px-4 md:px-6 py-5">${backBtn}<div class="text-slate-500 py-16 text-center">${pick("문서 불러오는 중…", "Loading document…")}</div></div></div>`;
  _root.querySelector("#projects-back")?.addEventListener("click", () => showListCard(id));

  let doc: ProjectDoc;
  try {
    doc = _curDoc && _curDoc.id === id && _curDoc.key === key ? _curDoc : await loadDoc(id, key);
  } catch (e) {
    if (!_root || _curId !== id || _curKey !== key || _curTrack !== track) return;
    _root.innerHTML = `<div class="h-full overflow-y-auto"><div class="w-full px-4 md:px-6 py-5">${backBtn}<div class="projects-error text-center text-txt-red py-16"><div class="font-medium">${pick("문서를 불러오지 못했습니다", "Failed to load document")}</div><div class="text-xs text-slate-500 mt-1">${escape(id)}/${escape(key)} · ${escape((e as Error).message)}</div></div></div></div>`;
    _root.querySelector("#projects-back")?.addEventListener("click", () => showListCard(id));
    return;
  }
  if (!_root || _curId !== id || _curKey !== key || _curTrack !== track) return;
  _curDoc = doc;
  enterDocPanels();

  const repo = project?.repo ?? "";
  const gh = repo ? `<a id="projects-open-github" href="${escape(blobUrl({ repo, sha: doc.sha }, doc.path))}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[12px] font-semibold text-slate-300 hover:text-accent-greenSoft whitespace-nowrap" aria-label="GitHub" title="${pick("GitHub 에서 이 파일 보기", "View this file on GitHub")}">${renderIcon("github", { size: 16 })}</a>` : "";
  // 문서 전환은 밑줄 탭으로, 등록된 문서만 표시한다.
  const docChips = DOC_KEYS.filter((k) => !project || project.docs.some((x) => x.key === k)).map((k) => {
    const d = project?.docs.find((x) => x.key === k);
    const base = `projects-doc-chip${k === key ? " is-active" : ""}`;
    if (d && !d.exists) return `<span class="${base} text-slate-600 border-surface-3/60 bg-transparent cursor-not-allowed" aria-disabled="true">${DOC_LABEL[k]}</span>`;
    return k === key
      ? `<span class="${base}" aria-current="page">${DOC_LABEL[k]}</span>`
      : `<button class="${base}" type="button" data-doc-chip="${k}">${DOC_LABEL[k]}</button>`;
  }).join("");
  const modeBtn = (m: "html" | "md") => `<button class="projects-mode${_mode === m ? " is-active" : ""}" data-mode="${m}" aria-pressed="${_mode === m}">${m.toUpperCase()}</button>`;
  const isTodo = key === "todo";
  const todoTabBtn = (t: "status" | "all", label: string) => `<button class="projects-todo-tab px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${_todoTab === t ? "text-slate-100 bg-surface-0 border-surface-3" : "text-slate-400 border-transparent hover:text-slate-200"}" data-todo-tab="${t}" aria-pressed="${_todoTab === t}">${label}</button>`;
  const stale = doc.stale ? `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold border text-txt-amber border-amber-400/25 bg-amber-400/10">stale</span>` : "";
  // 목차 트리는 HTML 본문(TODO 는 "전체" 탭)에서만. 절 판정은 splitSections — 본문은 자르지 않고 전체를 보인다.
  const treeMode = _mode === "html" && !(isTodo && _todoTab === "status");
  const secs = treeMode ? splitSections(doc.html, doc.toc ?? []) : [];
  const cur = treeMode ? pickSection(secs, _curSec) : null;
  const showToc = treeMode && hasToc(secs);
  if (cur) {
    if ((cur.anchor || null) !== _curSec) { _curSec = cur.anchor || null; _tocOpen = new Set(); }
    if (_curHead && sectionOf(secs, _curHead) !== cur) _curHead = null;
  }

  _root.innerHTML = `
    <div data-projects-doc-scroll class="projects-doc-scroll h-full overflow-y-auto overflow-x-hidden">
      <div class="projects-doc-shell">
        <div data-projects-doc-head class="projects-doc-head">
          ${backBtn}
          <div class="projects-breadcrumb" title="${escape(parent?.name ?? id)} / ${escape(project?.name ?? "")} / ${escape(doc.path)}">${escape(parent?.name ?? id)}${parent?.tracks ? ` / ${escape(project?.name ?? _curTrack)}` : ""} <span>/ ${escape(doc.path)}</span>${stale}</div>
          <div class="projects-doc-tabs" role="group" aria-label="${pick("문서 전환", "Switch document")}">${docChips}</div>
          <div class="projects-tools">
          <div class="projects-modes" role="group" aria-label="HTML | MD">${modeBtn("html")}${modeBtn("md")}</div>
          ${gh}<a id="projects-open-window" href="${escape(pageUrl(id, key, _mode))}" target="_blank" rel="noopener" aria-label="${pick("새창", "Open in new window")}" title="${pick("새창", "Open in new window")}">${renderIcon("external-link", { size: 16 })}</a></div>
          ${isTodo && _mode === "html" ? `<div class="projects-status-tabs">${todoTabBtn("status", pick("현재 상태", "Status"))}${todoTabBtn("all", pick("전체", "All"))}</div>` : ""}
        </div>
        <div class="projects-doc-layout${showToc ? " has-toc" : ""}">
          ${showToc && cur ? `<div class="projects-toc-wrap"><button id="projects-toc-toggle" type="button" aria-expanded="${_tocMobileOpen}" aria-controls="projects-toc">${pick("목차", "Contents")} ${_tocMobileOpen ? "▴" : "▾"}</button>
          <aside id="projects-toc" class="${_tocMobileOpen ? "" : "hidden"}"><div class="projects-toc-title">${pick("목차", "Contents")}</div>${tocTreeHtml(secs, cur)}</aside></div>` : ""}
          <div id="projects-viewer" class="min-w-0"></div>
        </div>
      </div>
    </div>`;

  _root.querySelector("#projects-back")?.addEventListener("click", () => showListCard(id));
  _root.querySelectorAll<HTMLButtonElement>("[data-doc-chip]").forEach((b) => b.addEventListener("click", () => { void openDoc(id, b.dataset.docChip as ProjectDocKey); }));
  _root.querySelector<HTMLButtonElement>("#projects-toc-toggle")?.addEventListener("click", () => setMobileToc(!_tocMobileOpen));
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

  measureHeadOffset();
  observeHead();
  const viewer = _root.querySelector<HTMLDivElement>("#projects-viewer");
  if (!viewer) return;
  if (_mode === "md") {
    viewer.innerHTML = `<div class="rounded-xl border border-surface-3 bg-surface-2 p-4 md:p-6 text-slate-500">${pick("원문 불러오는 중…", "Loading source…")}</div>`;
    try {
      const raw = await loadRaw(id, key);
      if (_mode !== "md" || _curKey !== key || _curTrack !== track) return;
      viewer.innerHTML = `<pre class="projects-raw projects-reading overflow-x-auto">${escape(raw)}</pre>`;
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
  // 본문은 전체 문서 한 번에. 트리(절 헤딩·소제목) 클릭 → 그 헤딩으로 스크롤 + 현재 절 갱신(&sec=). 스크롤 → 현재 절·헤딩 추적.
  if (!cur) return;
  writeUrlState(id, key, secs.length > 1 ? _curSec : null);
  viewer.innerHTML = `<article class="projects-prose projects-reading" data-sec="${escape(_curSec ?? "")}">${doc.html}</article>`;
  decorateMermaid(viewer);
  if (_curSec && secs.length > 1 && cur && secs[0] !== cur) scrollToAnchor(viewer, cur.anchor, false);
  bindTocTree(viewer, secs);
  watchScroll(viewer, secs);
}

/** 모바일 목차 칸 보이기/감추기 — 다시 그리지 않는다(현재 절로 재스크롤 방지). 펼치면 그 칸이 보이게 스크롤. */
function setMobileToc(open: boolean): void {
  const toc = _root?.querySelector<HTMLElement>("#projects-toc");
  const btn = _root?.querySelector<HTMLButtonElement>("#projects-toc-toggle");
  if (!toc || !btn) return;
  _tocMobileOpen = open;
  toc.classList.toggle("hidden", !open);
  btn.setAttribute("aria-expanded", String(open));
  btn.textContent = `${pick("목차", "Contents")} ${open ? "▴" : "▾"}`;
  if (open) toc.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

/** 트리의 현재 절·현재 헤딩 표시만 갱신 — 본문은 다시 그리지 않는다. */
function paintToc(secs: DocSection[]): void {
  const toc = _root?.querySelector<HTMLElement>("#projects-toc");
  if (!toc) return;
  const cur = pickSection(secs, _curSec);
  toc.querySelectorAll<HTMLElement>(".projects-toc-sec").forEach((el) => {
    const a = el.dataset.sec ?? "";
    const open = a === cur.anchor || _tocOpen.has(a);
    el.dataset.open = String(open);
    el.querySelector(".projects-toc-caret[data-toggle]")?.setAttribute("aria-expanded", String(open));
    el.querySelector(".projects-toc-head")?.setAttribute("aria-current", String(a === cur.anchor));
  });
  toc.querySelectorAll<HTMLAnchorElement>(".projects-toc-children a").forEach((a) => a.setAttribute("aria-current", String(a.dataset.anchor === _curHead)));
  _root?.querySelector("#projects-viewer article")?.setAttribute("data-sec", cur.anchor);
  // 현재 줄이 목차 칸 밖이면 목차 칸만 스크롤(페이지는 안 건드림)
  const on = toc.querySelector<HTMLElement>('.projects-toc-children a[aria-current="true"]') ?? toc.querySelector<HTMLElement>('.projects-toc-head[aria-current="true"]');
  if (on && typeof on.getBoundingClientRect === "function" && toc.scrollHeight > toc.clientHeight) {
    const r = on.getBoundingClientRect(); const t = toc.getBoundingClientRect();
    if (r.top < t.top || r.bottom > t.bottom) toc.scrollTop += layoutPixels(r.top - t.top - t.height / 3);
  }
}

function setCurrent(secs: DocSection[], sec: string | null, head: string | null): void {
  const nextSec = sec || null;
  if (nextSec !== _curSec) { _curSec = nextSec; _tocOpen = new Set(); }
  _curHead = head;
  if (_curId && _curKey) writeUrlState(_curId, _curKey, secs.length > 1 ? _curSec : null);
  paintToc(secs);
}

function bindTocTree(viewer: HTMLElement, secs: DocSection[]): void {
  const toc = _root?.querySelector<HTMLElement>("#projects-toc");
  if (!toc) return;
  const closeMobile = () => { if (_tocMobileOpen) setMobileToc(false); };
  toc.querySelectorAll<HTMLButtonElement>(".projects-toc-head").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.sec ?? "";
    _scrollLock = Date.now() + 900; // 부드러운 스크롤 동안 스크롤 추적이 되돌리지 않게
    setCurrent(secs, a, null);
    closeMobile();
    scrollToAnchor(viewer, a);
  }));
  toc.querySelectorAll<HTMLButtonElement>(".projects-toc-caret[data-toggle]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.toggle ?? "";
    const cur = pickSection(secs, _curSec);
    // 현재 절은 기본 펼침 — 캐럿으로 접으면 _tocOpen 이 아니라 별도 표시가 필요하니, 현재 절은 접지 않는다(항상 보임).
    if (a === cur.anchor) return;
    if (_tocOpen.has(a)) _tocOpen.delete(a); else _tocOpen.add(a);
    paintToc(secs);
  }));
  toc.querySelectorAll<HTMLAnchorElement>(".projects-toc-children a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const anchor = a.dataset.anchor ?? "";
    _scrollLock = Date.now() + 900;
    setCurrent(secs, sectionOf(secs, anchor)?.anchor ?? _curSec, anchor);
    closeMobile();
    scrollToAnchor(viewer, anchor);
  }));
}

// 스크롤 추적: 본문 스크롤 칸의 위쪽(sticky 헤더 아래) 을 지난 마지막 헤딩 = 현재 헤딩 → 그 절이 현재 절.
// _headOffset = 헤딩 scroll-margin-top(sticky 헤더 실측 높이) — 판정선은 그보다 조금 아래여야 방금 스크롤한 헤딩이 "현재" 가 된다.
let _scrollLock = 0;
let _scrollRaf = 0;
function watchScroll(viewer: HTMLElement, secs: DocSection[]): void {
  const scroller = _root?.querySelector<HTMLElement>("[data-projects-doc-scroll]");
  if (!scroller || !secs.length || typeof scroller.addEventListener !== "function") return;
  const headings = Array.from(viewer.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]"));
  const onScroll = () => {
    if (_scrollRaf) return;
    _scrollRaf = requestAnimationFrame(() => {
      _scrollRaf = 0;
      if (Date.now() < _scrollLock) return;
      const top = scroller.getBoundingClientRect().top + (_headOffset + 8) * dashboardScaleFactor(); // 헤딩이 sticky 헤더 아래(scroll-margin-top) 에 닿으면 그 헤딩
      let last: HTMLElement | null = null;
      for (const h of headings) { if (h.getBoundingClientRect().top <= top) last = h; else break; }
      // A short final section cannot reach the toolbar; retain its selection at the end.
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8) last = headings.at(-1) ?? last;
      const anchor = last?.id ?? "";
      const sec = anchor ? sectionOf(secs, anchor) : secs[0]!;
      const head = sec && anchor !== sec.anchor ? anchor : null;
      const nextSec = sec?.anchor ?? "";
      if ((nextSec || null) === _curSec && head === _curHead) return;
      setCurrent(secs, nextSec, head);
    });
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
}

async function openDoc(id: string, key: ProjectDocKey): Promise<void> {
  const switching = _view === "doc" && _curId === id;   // 헤더 칩으로 같은 프로젝트의 다른 문서로 — HTML/MD 모드는 유지
  _view = "doc";
  _curId = id;
  _curKey = key;
  _curDoc = null;
  if (!switching) _mode = "html";
  _todoTab = "status";
  _curSec = null; _curHead = null; _tocOpen = new Set(); _tocMobileOpen = false;
  _doneOpen = false;
  writeUrlState(id, key);
  await renderDoc();
}

function goList(): void {
  _view = "list";
  _curId = null; _curTrack = null;
  _curKey = null;
  _curDoc = null;
  leaveDocPanels();
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
  _curTrack = null; _listScrollTop = 0;
  _view = "list"; _curId = null; _curKey = null; _curDoc = null;
  _mode = "html"; _todoTab = "status"; _curSec = null; _curHead = null; _tocOpen = new Set(); _tocMobileOpen = false; _doneOpen = false;
  _rawCache = new Map();
  _panelsBefore = null; _panelsTouched = new Set(); _keepOpen.clear(); _visible = true; _scrollLock = 0;
  _headOffset = HEAD_OFFSET; _headObserver?.disconnect(); _headObserver = null;
  if (_panelUnsub) { _panelUnsub(); _panelUnsub = null; }
}

export function renderProjects(root: HTMLElement): void {
  _root = root;
  injectStyle();

  const { id, doc, sec, track } = readUrlState();
  _curTrack = track;
  if (id && !doc) { _view = "list"; _curId = id; }
  if (id && doc) { _view = "doc"; _curId = id; _curKey = doc; _curDoc = null; _curSec = sec; }
  root.innerHTML = `<div class="h-full overflow-y-auto"><div class="max-w-3xl mx-auto px-4 md:px-6 py-5"><div class="text-slate-500 py-16 text-center">${pick("프로젝트 목록 불러오는 중…", "Loading projects…")}</div></div></div>`;
  void ensureLoaded().then(() => {
    if (!_root) return;
    if (_view === "doc" && _curId && _curKey) void renderDoc();
    else renderList();
  });
}

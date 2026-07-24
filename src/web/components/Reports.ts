// Reports — 팀 보고서 목록·열람 대시보드 탭.
// reports.html 로직 포팅(목록·검색·category 필터·상세 md↔html·다운로드·요청하기).
// API는 origin 루트 /reports/* 를 절대경로로 직접 fetch (대시보드 BASE=/team 과 무관).
//   GET  /reports/api/list        → {reports:[...]} | [...]  (양형식 수용)
//      with ?limit=&cursor=&category=&important=1&q= → {reports,next_cursor,has_more,...}
//   GET  /reports/api/:id         → bare | {report:..}
//   GET  /reports/file/:id/:type  → md=text, html=full
//   PATCH /reports/api/:id/important → {important:boolean} → {ok, report}
//   POST /reports/api/:id/request → {text, assignee?} → {ok, assignee, thread_id}
//   DELETE /reports/api/:id       → {ok:boolean}

import { pick } from "../i18n";
import { parseSqliteDate } from "../lib/datetime";
import { showAlert, showConfirm } from "./dialogs";

const REPORTS_BASE = "/reports";
const DEFAULT_CAT = "보고서";
const ALL_FILTER = "전체";
const IMPORTANT_FILTER = "__important";
const PAGE_SIZE = 30;

interface ReportForm {
  type: string;
  path?: string;
}
interface Report {
  id: string;
  title: string;
  author?: string | null;
  summary?: string | null;
  category?: string | null;
  is_important?: boolean | number | null;
  created_at?: string | null;
  forms?: (string | ReportForm)[];
}
interface ReportListPage {
  reports: Report[];
  next_cursor?: string | null;
  has_more?: boolean;
  total?: number;
  important_count?: number;
  category_counts?: Record<string, number>;
}

// 컴포넌트 로컬 상태 (대시보드는 store.mainView 기반, Reports 내부 list↔detail 은 자체 상태)
let _root: HTMLElement | null = null;
let _all: Report[] = [];
let _loaded = false;
let _loading = false;
let _loadError: string | null = null;
let _hasMore = false;
let _nextCursor: string | null = null;
let _totalCount = 0;
let _importantCount = 0;
let _categoryCounts: Record<string, number> = {};
let _view: "list" | "detail" = "list";
let _curId: string | null = null;
let _curType: string | null = null;
let _query = "";
let _cat = ALL_FILTER;
let _listScrollTop = 0;
let _detailScrollTop = 0;
let _restoreSearchFocus = false;

function escape(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// ★DB 시각은 UTC 인데 Z 가 없다.★ 옛 주석은 이걸 '로컬' 이라 적어 두고 Z 를 안 붙였다 →
//   ★화면에 9시간 이른 시각이 찍혔다★ (DB 04:48 → 화면 04:48, 실제 13:48 KST).
//   parseSqliteDate 가 Z 를 붙여 UTC 로 고정한다 — GD 가 2026-07-04 에 만든 단일 출처인데 ★여기만 안 썼다.★
function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  const d = parseSqliteDate(s);
  if (!d) return escape(s);
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function catOf(r: Report): string {
  const c = r && r.category != null ? String(r.category).trim() : "";
  return c || DEFAULT_CAT;
}
function isImportant(r: Report): boolean {
  return r.is_important === true || r.is_important === 1;
}
function formType(t: string | ReportForm): string {
  return typeof t === "string" ? t : t.type;
}
function preferredFormType(forms: string[]): string | null {
  if (!forms.length) return null;
  if (_curType && forms.includes(_curType)) return _curType;
  return forms.includes("html") ? "html" : forms[0]!;
}
function asList(res: unknown): Report[] {
  if (Array.isArray(res)) return res as Report[];
  if (res && typeof res === "object" && Array.isArray((res as { reports?: Report[] }).reports)) {
    return (res as { reports: Report[] }).reports;
  }
  return [];
}
function asPage(res: unknown): ReportListPage {
  if (res && typeof res === "object" && Array.isArray((res as { reports?: Report[] }).reports)) {
    const page = res as ReportListPage;
    return {
      reports: page.reports,
      next_cursor: page.next_cursor ?? null,
      has_more: Boolean(page.has_more),
      total: typeof page.total === "number" ? page.total : page.reports.length,
      important_count: typeof page.important_count === "number" ? page.important_count : page.reports.filter(isImportant).length,
      category_counts: page.category_counts ?? {},
    };
  }
  const reports = asList(res);
  return { reports, next_cursor: null, has_more: false, total: reports.length, important_count: reports.filter(isImportant).length, category_counts: {} };
}
// 정렬은 같은 방향으로 어긋나면 순서가 살아남지만, ★DB 형식과 ISO 가 섞이면 9시간짜리 오정렬이 난다.★
// 같은 파서를 쓰면 그 위험 자체가 없어진다.
function byNewest(a: Report, b: Report): number {
  const t = (s: string | null | undefined) => parseSqliteDate(s ?? null)?.getTime() ?? 0;
  return t(b.created_at) - t(a.created_at);
}

function detailIdFromHash(): string | null {
  const m = window.location.hash.match(/^#\/r\/(.+)$/);
  return m ? decodeURIComponent(m[1]!) : null;
}
function setDetailHash(id: string): void {
  const next = `#/r/${encodeURIComponent(id)}`;
  if (window.location.hash !== next) window.history.replaceState(null, "", next);
}
function setListHash(): void {
  if (/^#\/r\//.test(window.location.hash)) window.history.replaceState(null, "", "#/");
}

// ── 미니 마크다운 렌더러 (헤딩·리스트·표·인용·코드·링크·강조, HTML 이스케이프) ──
function mdToHtml(src: string): string {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const inline = (t: string): string => {
    let s = escape(t);
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, href) => `<a href="${escape(href)}" target="_blank" rel="noopener">${txt}</a>`);
    return s;
  };
  while (i < lines.length) {
    const ln = lines[i]!;
    if (/^\s*$/.test(ln)) { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = ln.match(/^(#{1,4})\s+(.*)$/))) { const lv = m[1]!.length; out.push(`<h${lv}>${inline(m[2]!)}</h${lv}>`); i++; continue; }
    if (/^\s*```/.test(ln)) { i++; const code: string[] = []; while (i < lines.length && !/^\s*```/.test(lines[i]!)) { code.push(escape(lines[i]!)); i++; } i++; out.push(`<pre><code>${code.join("\n")}</code></pre>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) { out.push("<hr>"); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
      const head = ln.split("|").slice(1, -1).map((c) => `<th>${inline(c.trim())}</th>`).join("");
      i += 2; const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        rows.push("<tr>" + lines[i]!.split("|").slice(1, -1).map((c) => `<td>${inline(c.trim())}</td>`).join("") + "</tr>");
        i++;
      }
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*>\s?/.test(ln)) { const q: string[] = []; while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) { q.push(inline(lines[i]!.replace(/^\s*>\s?/, ""))); i++; } out.push(`<blockquote>${q.join("<br>")}</blockquote>`); continue; }
    if (/^\s*[-*]\s+/.test(ln)) { const li: string[] = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) { li.push(`<li>${inline(lines[i]!.replace(/^\s*[-*]\s+/, ""))}</li>`); i++; } out.push(`<ul>${li.join("")}</ul>`); continue; }
    if (/^\s*\d+\.\s+/.test(ln)) { const ol: string[] = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) { ol.push(`<li>${inline(lines[i]!.replace(/^\s*\d+\.\s+/, ""))}</li>`); i++; } out.push(`<ol>${ol.join("")}</ol>`); continue; }
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]!) && !/^\s*(#{1,4}\s|>|[-*]\s|\d+\.\s|```|\|)/.test(lines[i]!)) { para.push(inline(lines[i]!)); i++; }
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  return out.join("\n");
}

// 마크다운 prose 스타일 1회 주입 (Tailwind 유틸로 표현하기 번거로운 본문 타이포)
function injectProseStyle(): void {
  if (document.getElementById("reports-prose-style")) return;
  const st = document.createElement("style");
  st.id = "reports-prose-style";
  // 색은 var 토큰 백킹 → 라이트/다크 자동 적응(다크 하드코딩 #cbd5e1/#f1f5f9 제거 = 라이트서 안 보이던 문제 픽스).
  st.textContent = `
.reports-prose{font-size:14.5px;line-height:1.75;color:rgb(var(--slate-200))}
.reports-prose h1,.reports-prose h2,.reports-prose h3,.reports-prose h4{color:rgb(var(--slate-50));font-weight:700;line-height:1.3;margin:1.4em 0 .5em;letter-spacing:-.01em}
.reports-prose h1{font-size:1.6em;border-bottom:1px solid rgb(var(--border));padding-bottom:.3em}
.reports-prose h2{font-size:1.35em}.reports-prose h3{font-size:1.15em}.reports-prose h4{font-size:1em}
.reports-prose h1:first-child,.reports-prose h2:first-child,.reports-prose h3:first-child{margin-top:0}
.reports-prose p{margin:.7em 0}
.reports-prose ul,.reports-prose ol{margin:.7em 0;padding-left:1.5em}
.reports-prose li{margin:.3em 0}
.reports-prose a{color:var(--accent-soft-text);text-decoration:underline;text-underline-offset:2px}
.reports-prose code{background:rgb(var(--surface-0));border:1px solid rgb(var(--border));border-radius:5px;padding:.1em .4em;font-size:.88em;font-family:ui-monospace,Menlo,monospace;color:var(--accent-soft-text)}
.reports-prose pre{background:rgb(var(--surface-0));border:1px solid rgb(var(--border));border-radius:10px;padding:14px 16px;overflow-x:auto;margin:1em 0}
.reports-prose pre code{background:none;border:0;padding:0;color:rgb(var(--slate-200))}
.reports-prose blockquote{border-left:3px solid rgb(var(--accent) / .5);padding:.2em 0 .2em 14px;margin:1em 0;color:rgb(var(--slate-400))}
.reports-prose strong{color:rgb(var(--slate-50));font-weight:600}
.reports-prose hr{border:0;border-top:1px solid rgb(var(--border));margin:1.6em 0}
.reports-prose table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.92em}
.reports-prose th,.reports-prose td{border:1px solid rgb(var(--border));padding:7px 11px;text-align:left}
.reports-prose th{background:rgb(var(--surface-1));color:rgb(var(--slate-50));font-weight:600}`;
  document.head.appendChild(st);
}

// category별 배지 색 (미지정 타입은 기본)
const BADGE_CLASS: Record<string, string> = {
  md: "text-txt-green border-accent-green/30 bg-accent-green/10",
  html: "text-txt-blue border-blue-400/25 bg-blue-400/10",
  pdf: "text-txt-red border-red-400/25 bg-red-400/10",
  pptx: "text-txt-amber border-amber-400/25 bg-amber-400/10",
  audio: "text-txt-violet border-purple-400/25 bg-purple-400/10",
};
function badgeClass(t: string): string {
  return BADGE_CLASS[t] || "text-slate-400 border-surface-3 bg-surface-0";
}

async function fetchJson(path: string): Promise<unknown> {
  const r = await fetch(REPORTS_BASE + path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
function pageQuery(reset: boolean): string {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (!reset && _nextCursor) params.set("cursor", _nextCursor);
  if (_cat === IMPORTANT_FILTER) params.set("important", "1");
  else if (_cat !== ALL_FILTER) params.set("category", _cat);
  if (_query.trim()) params.set("q", _query.trim());
  return "/api/list?" + params.toString();
}
async function loadReportsPage(reset: boolean): Promise<void> {
  if (_loading) return;
  if (!reset && !_hasMore) return;
  _loading = true;
  try {
    const page = asPage(await fetchJson(pageQuery(reset)));
    const incoming = page.reports ?? [];
    if (reset) {
      _all = incoming;
    } else {
      const seen = new Set(_all.map((r) => r.id));
      _all = _all.concat(incoming.filter((r) => !seen.has(r.id)));
    }
    _nextCursor = page.next_cursor ?? null;
    _hasMore = Boolean(page.has_more);
    _totalCount = page.total ?? _all.length;
    _importantCount = page.important_count ?? _all.filter(isImportant).length;
    _categoryCounts = page.category_counts ?? {};
    _loaded = true;
    _loadError = null;
  } catch (err) {
    console.error("[reports] load page", err);
    if (reset) {
      _all = [];
      _nextCursor = null;
      _hasMore = false;
      _totalCount = 0;
      _importantCount = 0;
      _categoryCounts = {};
      _loaded = true;
      _loadError = (err as Error).message || "load failed";
    }
  } finally {
    _loading = false;
  }
}
async function reloadList(opts: { preserveScroll?: boolean; restoreSearchFocus?: boolean } = {}): Promise<void> {
  if (opts.preserveScroll) rememberListScroll();
  else _listScrollTop = 0;
  if (opts.restoreSearchFocus) _restoreSearchFocus = true;
  _nextCursor = null;
  _hasMore = false;
  _loaded = false;
  renderList();
  await loadReportsPage(true);
  if (opts.restoreSearchFocus) _restoreSearchFocus = true;
  renderList();
  if (opts.restoreSearchFocus) {
    const q = _root?.querySelector<HTMLInputElement>("#reports-q");
    if (q) {
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
  }
}
async function deleteReport(id: string): Promise<void> {
  const r = await fetch(`${REPORTS_BASE}/api/${encodeURIComponent(id)}`, { method: "DELETE", headers: { accept: "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j || (j as { ok?: boolean }).ok !== true) throw new Error((j as { error?: string })?.error || "HTTP " + r.status);
  _all = _all.filter((rep) => rep.id !== id);
  if (_curId === id) _curId = null;
}
async function setReportImportant(id: string, important: boolean): Promise<Report> {
  const r = await fetch(`${REPORTS_BASE}/api/${encodeURIComponent(id)}/important`, {
    method: "PATCH",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ important }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j || (j as { ok?: boolean }).ok !== true) throw new Error((j as { error?: string })?.error || "HTTP " + r.status);
  const report = (j as { report?: Report }).report;
  if (!report) throw new Error("missing report");
  _all = _all.map((rep) => (rep.id === id ? { ...rep, is_important: report.is_important } : rep));
  return report;
}
function fileUrl(id: string, type: string): string {
  return `${REPORTS_BASE}/file/${encodeURIComponent(id)}/${encodeURIComponent(type)}`;
}
function absoluteUrl(path: string): string {
  return new URL(path, window.location.href).toString();
}
function openInSystemBrowser(url: string): boolean {
  const bridge = (window as unknown as {
    webkit?: { messageHandlers?: { bridge?: { postMessage: (body: unknown) => void } } };
  }).webkit?.messageHandlers?.bridge;
  if (!bridge) return false;
  bridge.postMessage({
    command: "shell.openExternal",
    payload: { url },
  });
  return true;
}
function rememberListScroll(): void {
  const scroller = _root?.querySelector<HTMLElement>("[data-reports-list-scroll]");
  if (scroller) _listScrollTop = scroller.scrollTop;
}

function rememberDetailScroll(): void {
  const scroller = _root?.querySelector<HTMLElement>("[data-reports-detail-scroll]");
  if (scroller) _detailScrollTop = scroller.scrollTop;
}

function isParentDarkMode(): boolean {
  const bg = getComputedStyle(document.body).backgroundColor.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
  if (bg.length < 3) return true;
  const r = bg[0] ?? 0;
  const g = bg[1] ?? 0;
  const b = bg[2] ?? 0;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
}

function toneDownHtmlFrame(frame: HTMLIFrameElement): void {
  frame.addEventListener("load", () => {
    try {
      if (!isParentDarkMode()) return;
      const doc = frame.contentDocument;
      if (!doc || doc.getElementById("b3os-dark-frame-soften")) return;
      const st = doc.createElement("style");
      st.id = "b3os-dark-frame-soften";
      st.textContent = `
        html, body { background: #0b1118 !important; }
        :not(svg):not(path):not(text)[style*="background:#fff"],
        :not(svg):not(path):not(text)[style*="background: #fff"],
        :not(svg):not(path):not(text)[style*="background-color:#fff"],
        :not(svg):not(path):not(text)[style*="background-color: #fff"],
        :not(svg):not(path):not(text)[style*="background:#ffffff"],
        :not(svg):not(path):not(text)[style*="background: #ffffff"],
        :not(svg):not(path):not(text)[style*="background-color:#ffffff"],
        :not(svg):not(path):not(text)[style*="background-color: #ffffff"],
        :not(svg):not(path):not(text)[style*="background:rgb(255,255,255)"],
        :not(svg):not(path):not(text)[style*="background: rgb(255, 255, 255)"],
        :not(svg):not(path):not(text)[style*="background-color:rgb(255,255,255)"],
        :not(svg):not(path):not(text)[style*="background-color: rgb(255, 255, 255)"] { background: #182334 !important; background-color: #182334 !important; }
        svg rect[fill="#fff"], svg rect[fill="#FFF"], svg rect[fill="#ffffff"], svg rect[fill="#FFFFFF"], svg rect[fill="white"],
        svg path[fill="#fff"], svg path[fill="#FFF"], svg path[fill="#ffffff"], svg path[fill="#FFFFFF"], svg path[fill="white"],
        svg [fill="#f8fafc"], svg [fill="#F8FAFC"], svg [fill="#f1f5f9"], svg [fill="#F1F5F9"], svg [fill="#f9fafb"], svg [fill="#F9FAFB"],
        svg [fill="#eff6ff"], svg [fill="#EFF6FF"], svg [fill="#f0fdf4"], svg [fill="#F0FDF4"], svg [fill="#fffbeb"], svg [fill="#FFFBEB"],
        svg [fill="#fef2f2"], svg [fill="#FEF2F2"], svg [fill="#eef2ff"], svg [fill="#EEF2FF"], svg [fill="#ecfeff"], svg [fill="#ECFEFF"] { fill: #d7e0ec !important; }`;
      doc.head.appendChild(st);
    } catch {
      // Cross-origin or sandbox restrictions: leave the report as-is rather than breaking preview.
    }
  }, { once: true });
}
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button,a,input,textarea,select,[role='button']"));
}
function starIcon(active: boolean): string {
  return `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="${active ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>`;
}
function importantFilterLabel(count: number): string {
  return `<span class="inline-flex items-center gap-1.5" title="${pick("중요 표시", "Important")}">${starIcon(true)}<span class="text-[11px] text-slate-500">${count}</span></span>`;
}
function starButton(r: Report, placement: "card" | "detail"): string {
  const active = isImportant(r);
  const title = active ? pick("중요 표시 해제", "Unmark important") : pick("중요 표시", "Mark important");
  const base = placement === "card"
    ? "reports-star absolute right-12 top-3 inline-flex h-8 w-8 items-center justify-center rounded-lg border bg-surface-1/90 shadow-sm transition-all"
    : "reports-star-detail inline-flex h-9 w-9 items-center justify-center rounded-lg border cursor-pointer transition-colors";
  const tone = active
    ? "border-amber-400/40 text-txt-amber bg-amber-400/12 hover:bg-amber-400/18"
    : "border-surface-3 text-slate-400/80 bg-surface-1/70 hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-txt-amber";
  return `<button class="${base} ${tone}" data-id="${escape(r.id)}" data-important="${active ? "1" : "0"}" title="${title}" aria-label="${title}">${starIcon(active)}</button>`;
}

// ── 렌더: 목록 ────────────────────────────────────────────────────
function renderList(): void {
  if (!_root) return;
  const counts = _categoryCounts;
  const allCount = Object.values(counts).reduce((sum, n) => sum + n, 0) || _totalCount || _all.length;
  const cats = Object.keys(counts).sort((a, b) => (a === DEFAULT_CAT ? -1 : b === DEFAULT_CAT ? 1 : a.localeCompare(b, "ko")));

  const pillCls = (active: boolean) =>
    `reports-pill px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${active
      ? "text-accent-green border-accent-green/35 bg-accent-green/10"
      : "text-slate-400 border-surface-3 bg-surface-2 hover:text-slate-200"}`;
  const pills =
    `<button class="${pillCls(_cat === ALL_FILTER)}" data-cat="${ALL_FILTER}">${pick("전체", "All")}<span class="ml-1.5 text-[11px] text-slate-500">${allCount}</span></button>` +
    `<button class="${pillCls(_cat === IMPORTANT_FILTER)}" data-cat="${IMPORTANT_FILTER}" title="${pick("중요 표시만 보기", "Show important only")}" aria-label="${pick("중요 표시만 보기", "Show important only")}">${importantFilterLabel(_importantCount)}</button>` +
    cats.map((c) => `<button class="${pillCls(_cat === c)}" data-cat="${escape(c)}">${escape(c)}<span class="ml-1.5 text-[11px] text-slate-500">${counts[c]}</span></button>`).join("");

  const items = _all.slice().sort(byNewest);

  const cards = items.map((r) => {
    const badges = (r.forms || []).map((t) => {
      const ft = formType(t);
      return `<button class="reports-form-badge px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${badgeClass(ft)} hover:brightness-110" data-id="${escape(r.id)}" data-type="${escape(ft)}" title="${pick(`${escape(ft)} 형식으로 열기`, `Open as ${escape(ft)}`)}">${escape(ft)}</button>`;
    }).join("");
    return `
      <div class="reports-card group relative w-full text-left rounded-xl border border-surface-3 bg-surface-2 p-4 hover:bg-surface-3/60 transition-colors overflow-hidden" data-id="${escape(r.id)}" role="button" tabindex="0">
        <span class="absolute left-0 top-0 bottom-0 w-[3px] bg-accent-green opacity-0 group-hover:opacity-100 transition-opacity"></span>
        ${starButton(r, "card")}
        <button class="reports-delete absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-surface-3 bg-surface-1/90 text-slate-500 shadow-sm transition-all hover:border-red-400/40 hover:bg-red-400/10 hover:text-txt-red" data-id="${escape(r.id)}" data-title="${escape(r.title)}" title="${pick("보고서 삭제", "Delete report")}" aria-label="${pick("보고서 삭제", "Delete report")}">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
        </button>
        <span class="inline-block mb-2 px-2 py-0.5 rounded text-[10px] font-semibold border text-txt-green border-accent-green/30 bg-accent-green/10">${escape(catOf(r))}</span>
        <div class="pr-20 text-[15px] font-semibold text-slate-100 leading-snug">${escape(r.title)}</div>
        <div class="flex items-center gap-2 flex-wrap text-xs text-slate-500 mt-1.5"><span class="text-accent-greenSoft font-medium">${escape(r.author || "—")}</span><span>·</span><span>${fmtDate(r.created_at)}</span></div>
        ${r.summary ? `<div class="text-[13px] text-slate-400 leading-relaxed mt-2 line-clamp-2">${escape(r.summary)}</div>` : ""}
        ${badges ? `<div class="flex gap-1.5 flex-wrap mt-3">${badges}</div>` : ""}
      </div>`;
  }).join("");

  const emptyLabel = !_loaded || _loading ? pick("불러오는 중…", "Loading…") : _cat === IMPORTANT_FILTER ? pick("중요 표시된 보고서가 없습니다", "No important reports") : _cat !== ALL_FILTER ? pick(`'${escape(_cat)}' 분류의 보고서가 없습니다`, `No reports in the '${escape(_cat)}' category`) : _query ? pick("검색 결과가 없습니다", "No search results") : pick("아직 보고서가 없습니다", "No reports yet");
  const empty = `<div class="text-center text-slate-500 py-16"><div class="text-slate-300 font-medium mb-1">${emptyLabel}</div></div>`;
  const error = `<div class="text-center text-txt-red py-16">
    <div class="font-semibold mb-1">${pick("보고서 목록을 불러오지 못했습니다", "Failed to load reports")}</div>
    <div class="text-xs text-slate-500 mb-4">${escape(_loadError || "unknown error")}</div>
    <button id="reports-retry" class="px-3 py-1.5 rounded-lg border border-surface-3 bg-surface-2 text-sm text-slate-200 hover:bg-surface-3">${pick("다시 시도", "Retry")}</button>
  </div>`;
  const loadMore = items.length
    ? `<div class="py-4 text-center text-[12px] text-slate-500" data-reports-page-status>${_loading ? pick("더 불러오는 중…", "Loading more…") : _hasMore ? pick("아래로 스크롤하면 더 불러옵니다", "Scroll down to load more") : pick("마지막 보고서입니다", "End of reports")}</div>`
    : "";

  _root.innerHTML = `
    <div data-reports-list-scroll class="h-full overflow-y-auto">
      <div class="max-w-3xl mx-auto px-4 md:px-6 py-5 pb-20">
        <div class="text-sm text-slate-500 mb-4">${pick("b3rys 팀 보고서 — 클릭하면 본문을 봅니다.", "b3rys team reports — click to read the full text.")}</div>
        <div class="flex gap-2 flex-wrap mb-3">${pills}</div>
        <div class="relative mb-4">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="reports-q" type="search" placeholder="${pick("제목·작성자·요약 검색", "Search title · author · summary")}" value="${escape(_query)}"
            class="w-full bg-surface-2 border border-surface-3 rounded-xl text-sm text-slate-200 pl-9 pr-3 py-2.5 outline-none focus:border-accent-green/40 placeholder:text-slate-600" />
        </div>
        ${_loadError ? error : items.length ? `<div class="flex flex-col gap-2.5">${cards}</div>${loadMore}` : empty}
      </div>
    </div>`;
  const scroller = _root.querySelector<HTMLElement>("[data-reports-list-scroll]");
  if (scroller) scroller.scrollTop = _listScrollTop;

  _root.querySelectorAll<HTMLButtonElement>(".reports-pill").forEach((el) => {
    el.addEventListener("click", () => { _cat = el.dataset.cat || ALL_FILTER; void reloadList(); });
  });
  _root.querySelectorAll<HTMLElement>(".reports-card").forEach((el) => {
    el.addEventListener("click", () => { rememberListScroll(); _curId = el.dataset.id || null; if (_curId) setDetailHash(_curId); _curType = null; _view = "detail"; renderDetail(); });
    el.addEventListener("keydown", (e) => {
      if (isInteractiveTarget(e.target)) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); rememberListScroll(); _curId = el.dataset.id || null; if (_curId) setDetailHash(_curId); _curType = null; _view = "detail"; void renderDetail(); }
    });
  });
  _root.querySelectorAll<HTMLButtonElement>(".reports-form-badge").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      rememberListScroll();
      _curId = el.dataset.id || null;
      if (_curId) setDetailHash(_curId);
      _curType = el.dataset.type || null;
      _view = "detail";
      void renderDetail();
    });
  });
  _root.querySelectorAll<HTMLButtonElement>(".reports-star").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = el.dataset.id || "";
      if (!id) return;
      const next = el.dataset.important !== "1";
      el.disabled = true;
      try {
        await setReportImportant(id, next);
        await reloadList({ preserveScroll: true });
      } catch (err) {
        await showAlert(pick(`중요 표시 변경 실패: ${(err as Error).message}`, `Failed to update important mark: ${(err as Error).message}`));
        el.disabled = false;
      }
    });
  });
  _root.querySelectorAll<HTMLButtonElement>(".reports-delete").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = el.dataset.id || "";
      const title = el.dataset.title || id;
      if (!id || !await showConfirm({ message: pick(`보고서 "${title}"을(를) 목록에서 삭제할까요?\n\n첨부 파일은 디스크에 남고, 대시보드 등록 정보만 삭제됩니다.`, `Delete report "${title}" from the list?\n\nThe attached files stay on disk; only the dashboard registration is removed.`), danger: true })) return;
      el.disabled = true;
      try {
        await deleteReport(id);
        await reloadList({ preserveScroll: true });
      } catch (err) {
        await showAlert(pick(`삭제 실패: ${(err as Error).message}`, `Delete failed: ${(err as Error).message}`));
        el.disabled = false;
      }
    });
  });
  const q = _root.querySelector<HTMLInputElement>("#reports-q");
  _root.querySelector<HTMLButtonElement>("#reports-retry")?.addEventListener("click", () => void reloadList());
  if (q) {
    let t: ReturnType<typeof setTimeout>;
    let composing = false;
    const stopKeys = (e: KeyboardEvent) => e.stopPropagation();
    q.addEventListener("keydown", stopKeys);
    q.addEventListener("keypress", stopKeys);
    q.addEventListener("keyup", stopKeys);
    q.addEventListener("compositionstart", () => { composing = true; });
    q.addEventListener("compositionend", () => {
      composing = false;
      clearTimeout(t);
      const v = q.value;
      _restoreSearchFocus = true;
      t = setTimeout(() => { _query = v; void reloadList({ restoreSearchFocus: true }); }, 900);
    });
    q.addEventListener("input", (e) => {
      if (composing || (e as InputEvent).isComposing) return;
      clearTimeout(t);
      const v = q.value;
      _restoreSearchFocus = true;
      t = setTimeout(() => { _query = v; void reloadList({ restoreSearchFocus: true }); }, 900);
    });
    if (_restoreSearchFocus || _query) {
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
      _restoreSearchFocus = false;
    }
  }
  scroller?.addEventListener("scroll", () => {
    if (!_hasMore || _loading) return;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 420) {
      _listScrollTop = scroller.scrollTop;
      void loadReportsPage(false).then(renderList);
    }
  });
}

// ── 렌더: 상세 ────────────────────────────────────────────────────
async function renderDetail(): Promise<void> {
  if (!_root || !_curId) return;
  const id = _curId;
  _root.innerHTML = `<div class="h-full overflow-y-auto"><div class="max-w-3xl mx-auto px-4 md:px-6 py-5"><div class="text-slate-500 py-16 text-center">${pick("불러오는 중…", "Loading…")}</div></div></div>`;

  let meta: Report | null;
  try {
    const raw = await fetchJson("/api/" + encodeURIComponent(id));
    meta = (raw && typeof raw === "object" && (raw as { report?: Report }).report) ? (raw as { report: Report }).report : (raw as Report);
  } catch {
    meta = _all.find((r) => r.id === id) || null;
  }
  if (!_root) return;
  if (!meta) {
    _root.innerHTML = `<div class="h-full overflow-y-auto"><div class="max-w-3xl mx-auto px-4 md:px-6 py-5"><button id="reports-back" class="text-slate-400 hover:text-accent-green text-sm py-2">${pick("← 목록으로", "← Back to list")}</button><div class="text-center text-txt-red py-16"><div class="font-medium">${pick("보고서를 찾을 수 없습니다", "Report not found")}</div><div class="text-xs text-slate-500 mt-1">id: ${escape(id)}</div></div></div></div>`;
    _root.querySelector("#reports-back")?.addEventListener("click", goList);
    return;
  }
  _all = _all.map((r) => (r.id === meta!.id ? { ...r, is_important: meta!.is_important } : r));

  const forms = (meta.forms || []).map(formType);
  const activeType = preferredFormType(forms);
  const author = meta.author || pick("담당자", "Assignee");
  const tabs = forms.map((t) =>
    `<button class="reports-tab px-3.5 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wide border transition-colors ${t === activeType ? "text-accent-green border-accent-green/35 bg-accent-green/10" : "text-slate-400 border-surface-3 bg-surface-2 hover:text-slate-200"}" data-type="${escape(t)}">${escape(t)}</button>`
  ).join("");

  _root.innerHTML = `
    <div data-reports-detail-scroll class="h-full overflow-y-auto">
      <div class="max-w-3xl mx-auto px-4 md:px-6 pb-20">
        <!-- 상단 sticky 헤더: 스크롤해도 돌아가기·제목·폼토글 항상 노출 -->
        <div class="sticky top-0 z-20 -mx-4 md:-mx-6 px-4 md:px-6 bg-surface-1/95 backdrop-blur border-b border-surface-3">
          <div class="flex items-center gap-3 py-2.5">
            <button id="reports-back" title="${pick("보고서 목록으로", "Back to report list")}" class="inline-flex items-center gap-1.5 shrink-0 text-txt-green text-sm font-semibold px-3 py-1.5 rounded-lg border border-accent-green/45 bg-accent-green/12 hover:bg-accent-green/20 hover:border-accent-green/70 transition-colors"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>${pick("목록", "List")}</button>
            <div class="text-[15px] font-semibold text-slate-100 truncate flex-1" title="${escape(meta.title)}">${escape(meta.title)}</div>
          </div>
          <div class="flex items-center gap-2 flex-wrap pb-2.5">
            ${forms.length ? `<div class="flex gap-1.5 flex-wrap">${tabs}</div>
            <a id="reports-open" target="_blank" rel="noopener" title="${pick("새 탭에서 크게 보기 — 보고서를 브라우저 새 창으로 엽니다", "Open larger in a new tab — opens the report in a new browser window")}" class="ml-auto inline-flex items-center gap-1.5 text-[13px] font-semibold px-3.5 py-2 rounded-lg border border-surface-3 text-slate-200 bg-surface-2 hover:text-slate-100 hover:border-accent-green/45 hover:bg-surface-0 cursor-pointer transition-colors"><svg class="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>${pick("새창보기", "New window")}</a>
            <a id="reports-dl" class="inline-flex items-center gap-1.5 text-[13px] font-semibold px-3.5 py-2 rounded-lg border border-accent-green/35 text-accent-green bg-accent-green/10 hover:bg-accent-green/20 cursor-pointer transition-colors"><svg class="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 21h16"/></svg>${pick("다운로드", "Download")}</a>` : `<span class="ml-auto"></span>`}
            ${starButton(meta, "detail")}
            <button id="reports-delete-detail" class="inline-flex items-center gap-1.5 text-[13px] font-semibold px-3.5 py-2 rounded-lg border border-red-400/25 text-txt-red bg-red-400/10 hover:bg-red-400/15 cursor-pointer transition-colors"><svg class="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>${pick("삭제", "Delete")}</button>
          </div>
        </div>

        <div class="pt-4">
          <span class="inline-block mb-2 px-2 py-0.5 rounded text-[10px] font-semibold border text-txt-green border-accent-green/30 bg-accent-green/10">${escape(catOf(meta))}</span>
          <div class="flex items-center gap-2 flex-wrap text-[13px] text-slate-500"><span class="text-accent-greenSoft font-medium">${escape(author)}</span><span>·</span><span>${fmtDate(meta.created_at)}</span></div>
          ${meta.summary ? `<div class="text-sm text-slate-400 leading-relaxed mt-3 pl-3 border-l-2 border-surface-3">${escape(meta.summary)}</div>` : ""}

          <div class="reports-reqbox mt-5">
            <button id="reports-reqtoggle" class="inline-flex items-center gap-2 text-[13px] font-semibold px-4 py-2 rounded-lg border border-accent-green/35 text-accent-green bg-accent-green/10 hover:bg-accent-green/20 transition-colors">${pick("✉ 요청하기", "✉ Request")}</button>
            <div id="reports-reqform" class="hidden mt-3 bg-surface-2 border border-surface-3 rounded-xl p-4">
              <div class="text-[13px] text-slate-500 mb-2">${pick("담당자:", "Assignee:")} <b class="text-accent-greenSoft">${escape(author)}</b> <span class="text-slate-600">${pick("(보고서 작성자 기본)", "(defaults to report author)")}</span></div>
              <textarea id="reports-reqtext" placeholder="${pick("요청 내용을 입력하세요 — 예: 3장 수치 최신화 부탁드려요", "Enter your request — e.g. please refresh the figures in section 3")}"
                class="w-full min-h-[88px] resize-y bg-surface-0 border border-surface-3 rounded-lg text-sm text-slate-200 px-3 py-2.5 outline-none focus:border-accent-green/40 placeholder:text-slate-600 leading-relaxed"></textarea>
              <div class="flex items-center gap-3 mt-3">
                <span id="reports-reqmsg" class="text-[13px] text-slate-500 flex-1 leading-snug"></span>
                <button id="reports-reqsend" class="text-[13px] font-semibold px-4 py-2 rounded-lg bg-accent-btn text-accent-on hover:bg-accent-btnHover transition-colors disabled:opacity-50">${pick("보내기", "Send")}</button>
              </div>
            </div>
          </div>

          <div id="reports-viewer" class="mt-5 bg-surface-2 border border-surface-3 rounded-xl overflow-hidden"></div>
        </div>
      </div>
    </div>`;

  _root.querySelector("#reports-back")?.addEventListener("click", goList);
  const detailScroller = _root.querySelector<HTMLElement>("[data-reports-detail-scroll]");
  if (detailScroller && _detailScrollTop) detailScroller.scrollTop = _detailScrollTop;
  _root.querySelector<HTMLButtonElement>(".reports-star-detail")?.addEventListener("click", async () => {
    const btn = _root?.querySelector<HTMLButtonElement>(".reports-star-detail");
    if (!btn) return;
    const next = btn.dataset.important !== "1";
    rememberDetailScroll();
    btn.disabled = true;
    try {
      await setReportImportant(id, next);
      await loadReportsPage(true);
      void renderDetail();
    } catch (err) {
      await showAlert(pick(`중요 표시 변경 실패: ${(err as Error).message}`, `Failed to update important mark: ${(err as Error).message}`));
      btn.disabled = false;
    }
  });
  _root.querySelector<HTMLButtonElement>("#reports-delete-detail")?.addEventListener("click", async () => {
    const btn = _root?.querySelector<HTMLButtonElement>("#reports-delete-detail");
    if (!await showConfirm({ message: pick(`보고서 "${meta.title}"을(를) 목록에서 삭제할까요?\n\n첨부 파일은 디스크에 남고, 대시보드 등록 정보만 삭제됩니다.`, `Delete report "${meta.title}" from the list?\n\nThe attached files stay on disk; only the dashboard registration is removed.`), danger: true })) return;
    if (btn) btn.disabled = true;
    try {
      rememberDetailScroll();
      await deleteReport(id);
      _view = "list";
      setListHash();
      await reloadList({ preserveScroll: true });
    } catch (err) {
      await showAlert(pick(`삭제 실패: ${(err as Error).message}`, `Delete failed: ${(err as Error).message}`));
      if (btn) btn.disabled = false;
    }
  });

  // 요청하기
  const rToggle = _root.querySelector<HTMLButtonElement>("#reports-reqtoggle");
  const rForm = _root.querySelector<HTMLDivElement>("#reports-reqform");
  rToggle?.addEventListener("click", () => {
    if (!rForm) return;
    const hidden = rForm.classList.toggle("hidden");
    if (!hidden) _root?.querySelector<HTMLTextAreaElement>("#reports-reqtext")?.focus();
  });
  const reqSend = _root.querySelector<HTMLButtonElement>("#reports-reqsend");
  reqSend?.addEventListener("click", async () => {
    const ta = _root?.querySelector<HTMLTextAreaElement>("#reports-reqtext");
    const msg = _root?.querySelector<HTMLSpanElement>("#reports-reqmsg");
    if (!ta || !msg) return;
    const txt = ta.value.trim();
    if (!txt) { msg.className = "text-[13px] text-txt-red flex-1 leading-snug"; msg.textContent = pick("요청 내용을 입력하세요.", "Enter your request."); return; }
    reqSend.disabled = true;
    msg.className = "text-[13px] text-slate-500 flex-1 leading-snug"; msg.textContent = pick("전송 중…", "Sending…");
    try {
      const r = await fetch(`${REPORTS_BASE}/api/${encodeURIComponent(id)}/request`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: txt }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j && j.ok) {
        msg.className = "text-[13px] text-accent-greenSoft flex-1 leading-snug";
        msg.textContent = pick(`✅ 요청 전송됨 — 담당자: ${j.assignee || author}`, `✅ Request sent — assignee: ${j.assignee || author}`);
        ta.value = "";
      } else {
        msg.className = "text-[13px] text-txt-red flex-1 leading-snug";
        msg.textContent = pick(`전송 실패: ${(j && j.error) || "HTTP " + r.status}`, `Send failed: ${(j && j.error) || "HTTP " + r.status}`);
      }
    } catch (e) {
      msg.className = "text-[13px] text-txt-red flex-1 leading-snug";
      msg.textContent = pick(`전송 실패: ${(e as Error).message}`, `Send failed: ${(e as Error).message}`);
    } finally {
      reqSend.disabled = false;
    }
  });

  // form 토글 + 뷰어
  const showForm = async (type: string): Promise<void> => {
    const viewer = _root?.querySelector<HTMLDivElement>("#reports-viewer");
    if (!viewer) return;
    _root?.querySelectorAll<HTMLButtonElement>(".reports-tab").forEach((el) => {
      const active = el.dataset.type === type;
      el.className = `reports-tab px-3.5 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wide border transition-colors ${active ? "text-accent-green border-accent-green/35 bg-accent-green/10" : "text-slate-400 border-surface-3 bg-surface-2 hover:text-slate-200"}`;
    });
    // 새창보기 — 현재 form 타입을 새 탭에서 전체화면으로(좁은 대시보드 뷰 대신, GD 2026-06-22).
    const open = _root?.querySelector<HTMLAnchorElement>("#reports-open");
    if (open) {
      const href = absoluteUrl(fileUrl(id, type));
      open.href = href;
      open.onclick = (e) => {
        if (!openInSystemBrowser(href)) return;
        e.preventDefault();
      };
    }
    const dl = _root?.querySelector<HTMLAnchorElement>("#reports-dl");
    if (dl) {
      const dlHref = absoluteUrl(fileUrl(id, type));
      dl.href = dlHref;
      // 다운로드 파일명 = 제목 슬러그 + 확장자(60자 제한). 빈 download면 브라우저가 URL 끝('md'/'html')만
      // 써서 형식이름으로 떨어지던 버그 fix (GD R5 4737). 한글 보존(\p{L}).
      const slug = String(meta?.title ?? id).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
      dl.setAttribute("download", `${slug}.${type}`);
      // 맥앱(WKWebView): download 속성이 무시되고 webview가 파일로 네비게이션 → 보고서가 전체화면으로 뜨고
      // 복귀 불가(GD 2026-07-02). 새창보기와 동일하게 시스템 브라우저로 넘겨 다운로드(대시보드 화면 유지).
      // 일반 브라우저는 bridge 없음 → false → 기본 download 속성 동작.
      dl.onclick = (e) => {
        if (!openInSystemBrowser(dlHref)) return;
        e.preventDefault();
      };
    }
    if (type === "html") {
      viewer.innerHTML = `<iframe class="w-full border-0 block bg-surface-1 min-h-[70vh]" sandbox="allow-same-origin allow-popups" src="${fileUrl(id, type)}"></iframe>`;
      const frame = viewer.querySelector<HTMLIFrameElement>("iframe");
      if (frame) toneDownHtmlFrame(frame);
      return;
    }
    if (type === "md") {
      viewer.innerHTML = `<div class="reports-prose p-5 md:p-8 text-slate-500">${pick("불러오는 중…", "Loading…")}</div>`;
      try {
        const r = await fetch(fileUrl(id, type));
        if (!r.ok) throw new Error("HTTP " + r.status);
        const txt = await r.text();
        viewer.innerHTML = `<div class="reports-prose p-5 md:p-8">${mdToHtml(txt)}</div>`;
      } catch (e) {
        viewer.innerHTML = `<div class="reports-prose p-5 md:p-8 text-txt-red">${pick(`불러오기 실패: ${escape((e as Error).message)}`, `Failed to load: ${escape((e as Error).message)}`)}</div>`;
      }
      return;
    }
    // 기타 형식(pdf/pptx/audio…) — 미리보기 대신 다운로드 안내 (동적, 하드코딩 X)
    viewer.innerHTML = `<div class="reports-prose p-5 md:p-8"><p class="text-slate-400">${pick(`이 형식(<code>${escape(type)}</code>)은 미리보기를 지원하지 않습니다. 위 <b>다운로드</b>로 받으세요.`, `This format (<code>${escape(type)}</code>) does not support preview. Download it above with <b>Download</b>.`)}</p></div>`;
  };
  _root.querySelectorAll<HTMLButtonElement>(".reports-tab").forEach((el) => {
    el.addEventListener("click", () => { _curType = el.dataset.type || null; void showForm(el.dataset.type || ""); });
  });
  if (activeType) void showForm(activeType);
  else { const v = _root.querySelector<HTMLDivElement>("#reports-viewer"); if (v) v.innerHTML = `<div class="reports-prose p-5 md:p-8 text-slate-400">${pick("첨부된 형식이 없습니다.", "No attached formats.")}</div>`; }
}

function goList(): void {
  _view = "list";
  _curId = null;
  _curType = null;
  setListHash();
  renderList();
}

async function ensureLoaded(): Promise<void> {
  if (_loaded) return;
  await loadReportsPage(true);
}

export function renderReports(root: HTMLElement): void {
  _root = root;
  injectProseStyle();
  const hashId = detailIdFromHash();
  if (hashId) {
    _view = "detail";
    _curId = hashId;
    _curType = null;
  }
  root.innerHTML = `<div class="h-full overflow-y-auto"><div class="max-w-3xl mx-auto px-4 md:px-6 py-5"><div class="text-slate-500 py-16 text-center">${pick("보고서 목록 불러오는 중…", "Loading report list…")}</div></div></div>`;
  void ensureLoaded().then(() => {
    if (!_root) return;
    if (_view === "detail" && _curId) void renderDetail();
    else renderList();
  });
}

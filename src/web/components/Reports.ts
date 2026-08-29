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
import { mdInlineToHtml } from "../lib/mdInline";
import { humanizeApiError } from "../lib/apiErrorMessage";
import { showAlert, showConfirm, showForm, showPrompt } from "./dialogs";

const REPORTS_BASE = "/reports";
const DEFAULT_CAT = "보고서";
const ALL_FILTER = "전체";
const IMPORTANT_FILTER = "__important";
const PAGE_SIZE = 30;

interface ReportForm {
  type: string;
  path?: string;
}
interface ReportTag {
  id: string;
  name: string;
  color: string;
  report_count?: number;
}
interface Report {
  id: string;
  title: string;
  author?: string | null;
  summary?: string | null;
  category?: string | null;
  is_important?: boolean | number | null;
  tags?: ReportTag[];
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
  tags?: ReportTag[];
}

// 컴포넌트 로컬 상태 (대시보드는 store.mainView 기반, Reports 내부 list↔detail 은 자체 상태)
let _root: HTMLElement | null = null;
let _all: Report[] = [];
let _loaded = false;
let _loading = false;
// ★목록을 다시 받는 중인지 — 로딩 띠 전용 플래그★
//   _loading 을 그대로 쓸 수 없다: loadReportsPage 가 그것을 ★재진입 가드★ 로도 쓰고(`if (_loading) return`),
//   값을 켜는 시점도 renderList 다음이다. 그래서 _loading 으로 띠를 그리면 ★첫 페인트에 꺼져 있고,
//   미리 켜면 로딩 자체가 막힌다.★ 신호가 판정부에 도달하지 않는 그 형태라 플래그를 따로 둔다.
let _reloading = false;
let _loadError: string | null = null;
let _hasMore = false;
let _nextCursor: string | null = null;
let _totalCount = 0;
let _importantCount = 0;
let _categoryCounts: Record<string, number> = {};
let _tags: ReportTag[] = [];
let _selectedTagIds = new Set<string>();
let _view: "list" | "detail" = "list";
let _curId: string | null = null;
let _curType: string | null = null;
let _query = "";
let _cat = ALL_FILTER;
let _listScrollTop = 0;
let _detailScrollTop = 0;
let _restoreSearchFocus = false;
let _selectionMode = false;
let _selectedReportIds = new Set<string>();

function clearReportSelection(): void {
  _selectionMode = false;
  _selectedReportIds.clear();
}

function escape(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// ★DB 시각은 UTC 인데 Z 가 없다.★ 옛 주석은 이걸 '로컬' 이라 적어 두고 Z 를 안 붙였다 →
//   ★화면에 9시간 이른 시각이 찍혔다★ (DB 04:48 → 화면 04:48, 실제 13:48 KST).
// parseSqliteDate 가 Z 를 붙여 UTC 로 고정한다 — GD 가 2026-07-04 에 만든 단일 출처인데 ★여기만 안 썼다.★
function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  const d = parseSqliteDate(s);
  if (!d) return escape(s);
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function catOf(r: Report): string {
  const c = r && r.category != null ? String(r.category).trim() : "";
  return c;
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
      tags: page.tags ?? [],
    };
  }
  const reports = asList(res);
  return { reports, next_cursor: null, has_more: false, total: reports.length, important_count: reports.filter(isImportant).length, category_counts: {}, tags: [] };
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
  // 인라인 처리 = lib/mdInline 공유 헬퍼 (Chat/ThreadView 와 단일 출처).
  // 원본 대비 강화 2건이 여기에도 적용된다: javascript: 링크 차단(http/https 만), 공백 경계 이탤릭 오변환 방지.
  const inline = (t: string): string => mdInlineToHtml(t);
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
  if (_selectedTagIds.size) params.set("tags", [..._selectedTagIds].join(","));
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
    _tags = page.tags ?? _tags;
    const availableTagIds = new Set(_tags.map((t) => t.id));
    _selectedTagIds = new Set([..._selectedTagIds].filter((id) => availableTagIds.has(id)));
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
      _tags = [];
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
  _reloading = true;
  renderList();
  try {
    await loadReportsPage(true);
  } finally {
    _reloading = false;
  }
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
async function mutateJson(path: string, method: string, body?: unknown): Promise<any> {
  const r = await fetch(REPORTS_BASE + path, {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) throw new Error(j?.error || "HTTP " + r.status);
  return j;
}
/**
 * 보고서에 붙일 태그를 ★목록에서 골라★ 정한다.
 *
 * ★왜 바꿨나★: 전에는 쉼표로 이름을 적는 칸 하나였다.
 * "이미 추가된 태그가 없으니 외워서 넣기도 그렇고.. 이 추가된 태그를 좀 보여주면 좋지 안나? 선택해서 넣을 수 있게?"
 * ★맞는 지적이다.★ 있는 것을 보여주지 않으면 사람은 외워야 하고, 오타를 내면 같은 뜻의 태그가 하나 더 생긴다
 * (오늘 카테고리에서 리서치/research/AI 리서치/AI Research 로 갈린 것이 그 결과다).
 *
 * 체크박스를 쓴 이유: 칩을 눌러 켜고 끄려면 이벤트를 걸어야 하는데, shell 은 본문에 리스너를 안 걸어준다.
 * `peer` + 숨긴 checkbox 면 ★자바스크립트 없이★ 켜짐/꺼짐이 되고, 확인 시 :checked 만 읽으면 된다.
 */
export function tagChoiceBodyHtml(all: ReportTag[], selected: Set<string>): string {
  const chip = "inline-flex cursor-pointer items-center rounded-full border border-surface-3 bg-surface-2 px-2.5 py-1 text-xs text-slate-400 transition-colors peer-checked:border-accent-green/50 peer-checked:bg-accent-green/10 peer-checked:text-accent-green";
  const choices = all.length
    ? all.map((t) => `<label class="inline-flex">
        <input type="checkbox" class="peer sr-only" data-tag-choice value="${escape(t.id)}"${selected.has(t.id) ? " checked" : ""} />
        <span class="${chip}">#${escape(t.name)}</span>
      </label>`).join("")
    : `<span class="text-xs text-slate-600">${pick("아직 만들어진 태그가 없습니다. 아래에 이름을 적으면 새로 만들어집니다.", "No tags yet. Type a name below to create one.")}</span>`;
  return `<div class="mt-3 flex flex-wrap gap-1.5">${choices}</div>
    <input type="text" data-tag-new class="mt-3 w-full rounded-md border border-surface-3 bg-surface-2 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent-green/40 placeholder:text-slate-600"
      placeholder="${escape(pick("새 태그로 만들 이름 (쉼표로 여러 개)", "New tag names (comma separated)"))}" />`;
}

/** 위 본문에서 고른 태그 id 와 새로 만들 이름을 읽어낸다. */
export function collectTagChoice(root: HTMLElement): { ids: string[]; newNames: string[] } {
  const ids = [...root.querySelectorAll<HTMLInputElement>("input[data-tag-choice]")]
    .filter((el) => el.checked)
    .map((el) => el.value);
  const raw = root.querySelector<HTMLInputElement>("input[data-tag-new]")?.value ?? "";
  const newNames = [...new Set(raw.split(",").map((x) => x.trim()).filter(Boolean))];
  return { ids, newNames };
}

async function editReportTags(report: Report): Promise<Report | null> {
  const selected = new Set((report.tags ?? []).map((t) => t.id));
  const picked = await showForm<{ ids: string[]; newNames: string[] }>({
    title: pick("이 보고서의 태그", "Tags for this report"),
    message: pick(
      "붙일 태그를 눌러서 켜고 끄세요. 끄면 이 보고서에서만 떨어집니다 — 태그 자체와 보고서는 그대로 있습니다.",
      "Tap tags to turn them on or off. Turning one off only unlabels this report — the tag and the report both stay.",
    ),
    bodyHtml: tagChoiceBodyHtml(_tags, selected),
    collect: collectTagChoice,
    okLabel: pick("저장", "Save"),
  });
  if (picked == null) return null;
  const ids = [...picked.ids];
  const known = new Map(_tags.map((t) => [t.name.toLocaleLowerCase(), t]));
  for (const name of picked.newNames) {
    const hit = known.get(name.toLocaleLowerCase());
    if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); continue; }
    const created = (await mutateJson("/api/tags", "POST", { name })).tag as ReportTag;
    _tags.push(created);
    known.set(created.name.toLocaleLowerCase(), created);
    ids.push(created.id);
  }
  const saved = await mutateJson(`/api/${encodeURIComponent(report.id)}/tags`, "PUT", { tag_ids: [...new Set(ids)] });
  const updated = (saved as { report?: Report }).report;
  if (!updated) throw new Error("missing report");
  _all = _all.map((rep) => (rep.id === updated.id ? { ...rep, tags: updated.tags } : rep));
  return updated;
}
/**
 * 태그 알약 + ★마우스 올리면 나오는 이름바꾸기·삭제 아이콘★.
 *
 * 전에는 이 두 동작이 팝업 안의 ★문법★ 이었다 — `기존 -> 새이름` 으로 바꾸고 `-이름` 으로 지웠다.
 * 그래서 팀장님이 `aaa->bbb` 를 넣었을 때 이름이 바뀌는 대신 그 이름의 태그가 새로 생겼다.
 * 동작을 그 태그 옆에 두면 ★문법이 필요 없어지고 그 사고가 구조적으로 불가능해진다.★
 *
 * 아이콘은 알약과 ★형제★ 다 — 알약이 button 이라 그 안에 button 을 넣을 수 없다(중첩 금지).
 * 렌더를 모듈 수준으로 올린 이유: 이 마크업이 ★유일한 진입점★ 이라 테스트가 여기밖에 붙을 곳이 없다.
 * 태그 이름은 사용자 입력이므로 ★속성에 넣을 때 반드시 escape★ 한다.
 */
export function tagPillsHtml(
  tags: ReportTag[],
  selected: Set<string>,
  pillCls: (active: boolean) => string,
): string {
  // ★알약은 오직 필터다.★ 이름 바꾸기·지우기는 "태그 편집" 버튼 → 팝업으로 간다.
  //
  // 여기 hover 아이콘을 붙였다가 두 번 실패하고 걷어냈다:
  //   1차 — 흐름 안에 두니 ★마우스를 안 올려도 아이콘 두 개 만큼 빈칸이 항상 남았다★
  //   2차 — absolute 로 빼니 알약과 아이콘 사이 4px 틈에서 hover 가 풀려 ★누를 수가 없었다★
  // ★두 번 다 마크업 시험은 통과했다.★ "자리를 차지하나" 는 잴 수 있어도 "실제로 누를 수 있나" 는
  // 마크업만 봐서는 못 잰다. hover 로만 나타나는 조작은 그 간극이 구조적으로 크므로 쓰지 않는다.
  return tags.map((t) =>
    `<button class="${pillCls(selected.has(t.id))} reports-tag-pill" data-tag-id="${escape(t.id)}" data-tag-name="${escape(t.name)}">#${escape(t.name)}<span class="ml-1 text-txt-amber/60">${t.report_count ?? 0}</span></button>`
  ).join("");
}

/** 태그 동작 실패는 인페이지 창으로 — 네이티브 alert 는 앱 웹뷰에서 억제된다. */
function reportTagFailure(err: unknown): void {
  void showAlert({
    title: pick("태그를 저장하지 못했습니다", "Could not save the tag"),
    // ★코드가 아니라 사람 말로 보여준다★ — `x_actor_id_required` 만 뜨면 원인도 해결도 알 수 없다.
    message: humanizeApiError(err),
  });
}

/**
 * ★태그 만들기 — 문법 없이 이름만 받는다.★
 *
 * 예전에는 이 팝업 하나가 만들기·이름바꾸기·삭제를 다 받았고, 그래서 한 입력칸에 문법 세 가지가
 * 섞여 있었다("이름" / "기존 -> 새이름" / "-이름"). 팀장님 실측(2026-07-30)에서 `aaa->bbb` 가
 * 이름 변경이 아니라 ★그 이름의 새 태그★ 로 만들어졌다 — 화살표를 U+2192 한 종류만 봤기 때문이다.
 * 지금은 ★고르는 것과 적는 것을 분리★ 했다(무엇을 할지는 고르고, 이름만 적는다). 그래서 여기 들어오는
 * 값은 항상 ★이름 그대로★ 다 — `aaa->bbb` 를 적으면 그 이름의 태그가 만들어지는 게 맞는 동작이 된다.
 */
async function createTag(name: string): Promise<void> {
  if (!name.trim()) return;
  await mutateJson("/api/tags", "POST", { name: name.trim() });
  await reloadList();
}

/**
 * ★태그 편집 — 한 팝업에서 만들기·이름 바꾸기·지우기를 다 받는다.★
 *
 * ■ 왜 hover 아이콘을 버렸나
 * 태그 옆에 연필·휴지통을 띄우는 방식을 두 번 고쳤는데 두 번 다 못 쓰는 물건이 나왔다.
 *   1차 — 아이콘을 흐름 안에 두니 ★마우스를 안 올려도 빈칸이 항상 남았다★ ("이럴 바엔 예전 UI 가 더 나아")
 *   2차 — 흐름 밖으로 빼니 알약과 아이콘 사이 4px 틈에서 hover 가 풀려 ★도달 자체가 불가능했다★
 *          ("옆에 태그가 없어도 마우스를 옮기면 바로 삭제/수정이 없어짐")
 * ★두 번 다 우리 시험은 통과한 상태였다.★ 마크업만 보는 시험은 "자리를 차지하나" 는 재도
 * "사람이 실제로 누를 수 있나" 는 재지 못한다. 그래서 hover 에 기대는 UI 자체를 그만둔다 —
 * 팝업은 마우스 위치와 무관해서 이 실패 모드가 아예 없다.
 */
export function tagEditBodyHtml(all: ReportTag[]): string {
  const chip = "inline-flex cursor-pointer items-center rounded-full border border-surface-3 bg-surface-2 px-2.5 py-1 text-xs text-slate-400 transition-colors peer-checked:border-accent-green/50 peer-checked:bg-accent-green/10 peer-checked:text-accent-green";
  // ★작은 회색 글씨를 쓰지 않는다★ — 이 라벨은 "무엇을 하는 칸인가" 를 알려주는
  // 핵심 안내다. 흐리게 두면 고를 것만 보이고 무엇을 고르는지가 안 보인다.
  // uppercase·tracking 도 뺐다 — 한글에는 효과가 없고 ①② 같은 기호는 11px 에서 읽히지 않았다(실측).
  const label = "text-xs font-semibold text-slate-300";
  const tagChoices = all.length
    ? all.map((t, i) => `<label class="inline-flex">
        <input type="radio" name="tag-edit-target" class="peer sr-only" data-tag-target value="${escape(t.id)}" data-tag-name="${escape(t.name)}"${i === 0 ? " checked" : ""} />
        <span class="${chip}">#${escape(t.name)}</span>
      </label>`).join("")
    : `<span class="text-xs text-slate-600">${escape(pick("아직 만들어진 태그가 없습니다.", "No tags yet."))}</span>`;
  const action = (value: string, ko: string, en: string, checked: boolean) =>
    `<label class="inline-flex">
      <input type="radio" name="tag-edit-action" class="peer sr-only" data-tag-action value="${value}"${checked ? " checked" : ""} />
      <span class="${chip}">${escape(pick(ko, en))}</span>
    </label>`;
  return `<div class="mt-4 space-y-4 text-left">
      <div>
        <div class="${label}">${escape(pick("어떤 태그를", "Which tag"))}</div>
        <div class="mt-1.5 flex flex-wrap gap-1.5">${tagChoices}</div>
      </div>
      <div>
        <div class="${label}">${escape(pick("어떻게 할까요", "Do what"))}</div>
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          ${action("rename", "이름 바꾸기", "Rename", true)}
          ${action("delete", "지우기", "Delete", false)}
        </div>
      </div>
      <div class="border-t border-surface-3 pt-3">
        <div class="${label}">${escape(pick("또는 — 새 태그 만들기", "Or — create a new tag"))}</div>
        <input type="text" data-tag-new class="mt-1.5 w-full rounded-md border border-surface-3 bg-surface-2 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent-green/40 placeholder:text-slate-600"
          placeholder="${escape(pick("여기에 이름을 적으면 위 선택 대신 새로 만듭니다", "Type a name here to create one instead"))}" />
      </div>
    </div>`;
}

/** 위 본문에서 고른 태그·동작과 새로 적은 이름을 읽어낸다. */
export function collectTagEdit(root: HTMLElement): { tagId: string; tagName: string; action: string; newName: string } {
  const target = root.querySelector<HTMLInputElement>("input[data-tag-target]:checked");
  const action = root.querySelector<HTMLInputElement>("input[data-tag-action]:checked");
  return {
    tagId: target?.value ?? "",
    tagName: target?.dataset.tagName ?? "",
    action: action?.value ?? "",
    newName: (root.querySelector<HTMLInputElement>("input[data-tag-new]")?.value ?? "").trim(),
  };
}

/**
 * ★아무것도 고르지 않고 '다음' 을 눌렀을 때 보여줄 안내★ — 조용히 닫지 않기 위한 것.
 *
 * 눌렀는데 아무 일도 안 나면 사용자는 무엇이 잘못됐는지 알 수 없고 ★취소한 것과 구분도 안 된다.★
 * 공용 다이얼로그에 버튼 비활성 옵션이 없어(`DialogOptions` 에 disabled 없음) 안내로 대신한다.
 *
 * ★태그가 하나도 없을 때와 있을 때는 할 수 있는 일이 다르므로 문구도 달라야 한다★ —
 * 태그가 0개인데 "태그를 고르세요" 라고 하면 ★없는 것을 고르라고 시키는 것★ 이다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★`tagCount > 0` 갈래는 지금 UI 에서 도달할 수 없다 — 그래도 지우지 말 것★
 * (2026-08-10 배포본 실측: steve 확인 · bill 판단)
 *
 * 목록이 `<input type="radio" name="tag-edit-target">` 이고 ★첫 항목이 기본 선택★ 이다(:473).
 * radio 는 클릭으로 해제되지 않으므로 ★태그가 1개라도 있으면 `picked.tagId` 는 비지 않는다.★
 * 즉 `!picked.tagId` 가 참이 되는 건 ★태그가 0개일 때뿐★ 이다.
 *
 * ★그런데 지우면 '죽은 분기' 가 '틀린 분기' 가 된다.★ 나중에 checkbox 나 '선택 안 함' 이
 * 들어오면 `!picked.tagId` 가 태그가 있는 상태에서도 참이 되는데, 남은 문구가 하나면
 * ★태그가 7개 있는데 "아직 만들어진 태그가 없습니다" 라고 말하게 된다.★
 * → 지금은 안 쓰이더라도 ★UI 가 바뀌는 순간 필요한 갈래★ 다.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function tagEditEmptyNotice(tagCount: number): string {
  return tagCount === 0
    ? pick("아직 만들어진 태그가 없습니다. 맨 아래 칸에 새 태그 이름을 적어 주세요.",
           "No tags exist yet. Type a new tag name in the bottom field.")
    : pick("고른 태그가 없습니다. 태그를 고르거나, 맨 아래 칸에 새 이름을 적어 주세요.",
           "No tag selected. Pick a tag, or type a new name in the bottom field.");
}

async function manageTags(): Promise<void> {
  const picked = await showForm<{ tagId: string; tagName: string; action: string; newName: string }>({
    title: pick("태그 편집", "Edit tags"),
    message: pick(
      "태그를 고르고 무엇을 할지 고르세요. 새로 만들려면 맨 아래에 이름만 적으면 됩니다.",
      "Pick a tag and what to do with it. To create one instead, just type a name at the bottom.",
    ),
    bodyHtml: tagEditBodyHtml(_tags),
    collect: collectTagEdit,
    okLabel: pick("다음", "Next"),
  });
  if (picked == null) return;
  // ★새 이름을 적었으면 그게 우선★ — 태그가 하나도 없을 때는 고를 것 자체가 없다.
  if (picked.newName) { await createTag(picked.newName); return; }
  // ★아무것도 안 고르고 눌렀을 때 조용히 닫지 않는다★ (문구·근거 = tagEditEmptyNotice)
  if (!picked.tagId) {
    await showAlert({ title: pick("태그 편집", "Edit tags"), message: tagEditEmptyNotice(_tags.length) });
    return;
  }
  if (picked.action === "delete") { await deleteTag(picked.tagId, picked.tagName); return; }
  await renameTag(picked.tagId, picked.tagName);
}

/** 태그 이름 바꾸기 — 지금 이름을 채워서 띄운다(다시 타이핑하지 않게). */
async function renameTag(tagId: string, currentName: string): Promise<void> {
  if (!tagId) return;
  const next = await showPrompt({
    title: pick("태그 이름 바꾸기", "Rename tag"),
    message: pick(`‘${currentName}’ 의 새 이름을 적어 주세요.`, `New name for '${currentName}'.`),
    defaultValue: currentName,
    placeholder: pick("예: 주간리포트", "e.g. weekly report"),
    okLabel: pick("저장", "Save"),
  });
  const name = next?.trim();
  if (!name || name === currentName) return;
  await mutateJson(`/api/tags/${encodeURIComponent(tagId)}`, "PATCH", { name });
  await reloadList();
}

/** 태그 삭제 — 보고서는 남는다는 것을 확인창에서 먼저 말한다. */
async function deleteTag(tagId: string, name: string): Promise<void> {
  if (!tagId) return;
  const yes = await showConfirm({
    title: pick("태그를 지울까요?", "Delete this tag?"),
    message: pick(
      `‘${name}’ 태그를 지웁니다. 이 태그가 붙어 있던 보고서는 그대로 남고, 이름표만 떨어집니다.`,
      `'${name}' will be removed. The reports keep existing — they just lose this label.`,
    ),
    okLabel: pick("지우기", "Delete"),
    cancelLabel: pick("그대로 두기", "Keep it"),
    danger: true,
  });
  if (!yes) return;
  await mutateJson(`/api/tags/${encodeURIComponent(tagId)}`, "DELETE");
  _selectedTagIds.delete(tagId);
  await reloadList();
}

function categoryChoiceBodyHtml(categories: string[], selected = ""): string {
  const chip = "inline-flex cursor-pointer items-center rounded-md border border-surface-3 bg-surface-2 px-2.5 py-1 text-xs text-slate-400 transition-colors peer-checked:border-accent-green/50 peer-checked:bg-accent-green/10 peer-checked:text-accent-green";
  return `<div class="mt-3 flex flex-wrap gap-1.5">${categories.map((category, i) => `<label class="inline-flex">
    <input type="radio" name="category-choice" class="peer sr-only" data-category-choice value="${escape(category)}"${category === selected || (!selected && i === 0) ? " checked" : ""} />
    <span class="${chip}">${folderIcon()}${escape(category)}</span>
  </label>`).join("")}</div>`;
}

function collectCategoryChoice(root: HTMLElement): string {
  return root.querySelector<HTMLInputElement>("input[data-category-choice]:checked")?.value ?? "";
}

async function manageCategories(categories: string[]): Promise<void> {
  const body = `${categories.length ? categoryChoiceBodyHtml(categories) : `<div class="mt-3 text-xs text-slate-500">${pick("아직 만든 분류가 없습니다.", "No categories yet.")}</div>`}
    <div class="mt-4 flex gap-2">
      <label class="inline-flex"><input type="radio" name="category-action" class="peer sr-only" value="rename" checked /><span class="cursor-pointer rounded-md border border-surface-3 px-2.5 py-1 text-xs text-slate-400 peer-checked:border-accent-green/50 peer-checked:text-accent-green">${pick("이름 바꾸기", "Rename")}</span></label>
      <label class="inline-flex"><input type="radio" name="category-action" class="peer sr-only" value="delete" /><span class="cursor-pointer rounded-md border border-surface-3 px-2.5 py-1 text-xs text-slate-400 peer-checked:border-red-400/40 peer-checked:text-txt-red">${pick("삭제", "Delete")}</span></label>
    </div>
    <div class="mt-4 border-t border-surface-3 pt-3">
      <div class="text-xs font-semibold text-slate-300">${pick("새 분류 만들기", "Create a category")}</div>
      <input type="text" data-category-new class="mt-1.5 w-full rounded-md border border-surface-3 bg-surface-2 px-3 py-2 text-sm text-slate-100" />
    </div>`;
  const picked = await showForm<{ category: string; action: string; newName: string }>({
    title: pick("분류 편집", "Edit categories"),
    message: pick("분류와 작업을 고르세요.", "Choose a category and an action."),
    bodyHtml: body,
    collect: (root) => ({ category: collectCategoryChoice(root), action: root.querySelector<HTMLInputElement>('input[name="category-action"]:checked')?.value ?? "", newName: (root.querySelector<HTMLInputElement>('[data-category-new]')?.value ?? "").trim() }),
    okLabel: pick("다음", "Next"),
  });
  if (!picked) return;
  if (picked.newName) { await mutateJson("/api/categories", "POST", { name: picked.newName }); await reloadList(); return; }
  if (!picked.category) return;
  if (picked.action === "delete") {
    const yes = await showConfirm({
      title: pick("분류를 삭제할까요?", "Delete this category?"),
      message: pick(`‘${picked.category}’ 분류를 삭제합니다. 안의 보고서는 분류 없음으로 바뀌어 ‘전체’에서만 보입니다.`, `Delete '${picked.category}'. Its reports become uncategorized and appear only in All.`),
      okLabel: pick("삭제", "Delete"), danger: true,
    });
    if (!yes) return;
    await mutateJson(`/api/categories/${encodeURIComponent(picked.category)}`, "DELETE");
  } else {
    const next = await showPrompt({ title: pick("분류 이름 바꾸기", "Rename category"), defaultValue: picked.category, okLabel: pick("저장", "Save") });
    const name = next?.trim();
    if (!name || name === picked.category) return;
    await mutateJson(`/api/categories/${encodeURIComponent(picked.category)}`, "PATCH", { name });
  }
  if (_cat === picked.category) _cat = ALL_FILTER;
  await reloadList();
}

async function moveSelectedReports(categories: string[]): Promise<void> {
  if (!_selectedReportIds.size || !categories.length) return;
  const category = await showForm<string>({
    title: pick("분류로 이동", "Move to category"),
    message: pick(`${_selectedReportIds.size}건을 옮길 분류를 고르세요.`, `Choose a category for ${_selectedReportIds.size} reports.`),
    bodyHtml: categoryChoiceBodyHtml(categories, _cat !== ALL_FILTER && _cat !== IMPORTANT_FILTER ? _cat : ""),
    collect: collectCategoryChoice,
    okLabel: pick("이동", "Move"),
  });
  if (!category) return;
  const failures: string[] = [];
  for (const id of [..._selectedReportIds]) {
    try {
      await mutateJson(`/api/${encodeURIComponent(id)}/category`, "PUT", { category });
      _selectedReportIds.delete(id);
    } catch {
      failures.push(id);
    }
  }
  _selectionMode = failures.length > 0;
  await reloadList();
  if (failures.length) throw new Error(pick(`${failures.length}건을 옮기지 못했습니다. 실패한 보고서는 선택 상태로 남겼습니다.`, `${failures.length} reports could not be moved and remain selected.`));
}

function folderIcon(): string {
  return `<svg class="mr-1.5 inline h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
}

function tagBadge(tag: ReportTag, interactive = false): string {
  const tagName = interactive ? "button" : "span";
  return `<${tagName} class="${interactive ? "reports-tag-filter " : ""}inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium border border-txt-amber/40 text-txt-amber" data-tag-id="${escape(tag.id)}">#${escape(tag.name)}</${tagName}>`;
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

function renderListPreservingScroll(): void {
  rememberListScroll();
  renderList();
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
function starButton(r: Report, placement: "card" | "detail"): string {
  const active = isImportant(r);
  const title = active ? pick("중요 표시 해제", "Unmark important") : pick("중요 표시", "Mark important");
  const base = placement === "card"
    ? "reports-star inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border bg-surface-1/70 transition-colors"
    : "reports-star-detail inline-flex h-9 w-9 items-center justify-center rounded-lg border cursor-pointer transition-colors";
  const tone = active
    ? "border-amber-400/40 text-txt-amber bg-amber-400/12 hover:bg-amber-400/18"
    : "border-surface-3 text-slate-400/80 bg-surface-1/70 hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-txt-amber";
  return `<button class="${base} ${tone}" data-id="${escape(r.id)}" data-important="${active ? "1" : "0"}" title="${title}" aria-label="${title}">${starIcon(active)}</button>`;
}

function updateListCount(selector: string, count: number): void {
  const el = _root?.querySelector<HTMLElement>(selector);
  if (el) el.textContent = String(Math.max(0, count));
}

function updateCardStarButton(el: HTMLButtonElement, r: Report): void {
  const replacement = document.createRange().createContextualFragment(starButton(r, "card")).firstElementChild;
  if (!(replacement instanceof HTMLButtonElement)) return;
  replacement.addEventListener("click", handleCardStarClick);
  el.replaceWith(replacement);
}

async function handleCardStarClick(e: MouseEvent): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  const el = e.currentTarget as HTMLButtonElement;
  const id = el.dataset.id || "";
  if (!id) return;
  const next = el.dataset.important !== "1";
  el.disabled = true;
  try {
    const report = await setReportImportant(id, next);
    _importantCount += next ? 1 : -1;
    updateListCount("[data-reports-important-count]", _importantCount);
    updateCardStarButton(el, _all.find((r) => r.id === id) ?? report);
  } catch (err) {
    await showAlert(pick(`중요 표시 변경 실패: ${(err as Error).message}`, `Failed to update important mark: ${(err as Error).message}`));
    el.disabled = false;
  }
}

// ── 렌더: 목록 ────────────────────────────────────────────────────
function renderList(): void {
  if (!_root) return;
  const counts = _categoryCounts;
  const allCount = _totalCount || _all.length;
  const cats = Object.keys(counts).sort((a, b) => (a === DEFAULT_CAT ? -1 : b === DEFAULT_CAT ? 1 : a.localeCompare(b, "ko")));

  const pillCls = (active: boolean) =>
    `reports-pill inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors ${active
      ? "text-accent-green border-accent-green/35 bg-accent-green/10"
      : "text-slate-300 border-surface-3 bg-surface-2 hover:text-slate-100"}`;
  const tagPillCls = (active: boolean) =>
    `reports-pill inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border transition-colors ${active
      ? "text-amber-900 border-amber-500 bg-amber-200"
      : "text-txt-amber border-amber-300 bg-transparent hover:border-amber-500"}`;
  const pills =
    `<button class="${pillCls(_cat === ALL_FILTER)}" data-cat="${ALL_FILTER}">${pick("전체", "All")}<span class="ml-1.5 text-[11px] text-slate-500" data-reports-all-count>${allCount}</span></button>` +
    `<button class="${pillCls(_cat === IMPORTANT_FILTER)}" data-cat="${IMPORTANT_FILTER}" title="${pick("중요 표시만 보기", "Show important only")}" aria-label="${pick("중요 표시만 보기", "Show important only")}"><span class="text-rose-300">${starIcon(true)}</span><span class="text-[11px] text-slate-500" data-reports-important-count>${_importantCount}</span></button>` +
    cats.map((c) => `<button class="${pillCls(_cat === c)}" data-cat="${escape(c)}">${folderIcon()}${escape(c)}<span class="ml-1.5 text-[11px] text-slate-500" data-reports-category-count="${escape(c)}">${counts[c]}</span></button>`).join("");
  const tagPills = tagPillsHtml(_tags, _selectedTagIds, tagPillCls);

  const items = _all.slice().sort(byNewest);

  const cards = items.map((r) => {
    const badges = (r.forms || []).map((t) => {
      const ft = formType(t);
      return `<button class="reports-form-badge px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${badgeClass(ft)} hover:brightness-110" data-id="${escape(r.id)}" data-type="${escape(ft)}" title="${pick(`${escape(ft)} 형식으로 열기`, `Open as ${escape(ft)}`)}">${escape(ft)}</button>`;
    }).join("");
    const selected = _selectedReportIds.has(r.id);
    return `
      <div class="reports-card group relative w-full text-left rounded-xl border ${selected ? "border-accent-green/50 bg-accent-green/[0.05]" : "border-surface-3 bg-surface-2"} px-4 py-3 hover:bg-surface-3/60 transition-colors overflow-hidden" data-id="${escape(r.id)}" data-category="${escape(catOf(r))}" role="button" tabindex="0">
        <span class="absolute left-0 top-0 bottom-0 w-[3px] bg-accent-green opacity-0 group-hover:opacity-100 transition-opacity"></span>
        <div class="flex items-start gap-2">
          ${_selectionMode ? `<button class="reports-select mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 ${selected ? "border-accent-green bg-accent-green/20 text-accent-green" : "border-surface-3 text-transparent"}" data-id="${escape(r.id)}" aria-label="${pick("보고서 선택", "Select report")}" aria-pressed="${selected}"><span class="text-[10px] leading-none">✓</span></button>` : ""}
          <div class="min-w-0 flex-1 text-[15px] font-semibold text-slate-100 leading-snug">${escape(r.title)}</div>
          <div class="flex shrink-0 items-center gap-1">
            ${starButton(r, "card")}
            <button class="reports-delete inline-flex h-7 w-7 items-center justify-center rounded-lg border border-surface-3 bg-surface-1/70 text-slate-500 transition-colors hover:border-red-400/40 hover:bg-red-400/10 hover:text-txt-red" data-id="${escape(r.id)}" data-title="${escape(r.title)}" title="${pick("보고서 삭제", "Delete report")}" aria-label="${pick("보고서 삭제", "Delete report")}">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
            </button>
          </div>
        </div>
        ${r.summary ? `<div class="text-[13px] text-slate-400 leading-relaxed mt-1.5 line-clamp-1">${escape(r.summary)}</div>` : ""}
        <div class="flex items-center gap-2 flex-wrap text-xs text-slate-500 mt-1"><span class="text-accent-greenSoft font-medium">${escape(r.author || "—")}</span><span>·</span><span>${fmtDate(r.created_at)}</span>${(r.tags ?? []).map((t) => tagBadge(t, true)).join("")}${badges}</div>
      </div>`;
  }).join("");

  const emptyLabel = !_loaded || _loading ? pick("불러오는 중…", "Loading…") : _cat === IMPORTANT_FILTER ? pick("중요 표시된 보고서가 없습니다", "No important reports") : _cat !== ALL_FILTER ? pick(`'${escape(_cat)}' 분류의 보고서가 없습니다`, `No reports in the '${escape(_cat)}' category`) : _query ? pick("검색 결과가 없습니다", "No search results") : pick("아직 보고서가 없습니다", "No reports yet");
  const empty = `<div class="text-center text-slate-500 py-16"><div class="text-slate-300 font-medium mb-1">${emptyLabel}</div></div>`;
  const error = `<div class="text-center text-txt-red py-16">
    <div class="font-semibold mb-1">${pick("보고서 목록을 불러오지 못했습니다", "Failed to load reports")}</div>
    <div class="text-xs text-slate-500 mb-4">${escape(_loadError || "unknown error")}</div>
    <button id="reports-retry" class="px-3 py-1.5 rounded-lg border border-surface-3 bg-surface-2 text-sm text-slate-200 hover:bg-surface-3">${pick("다시 시도", "Retry")}</button>
  </div>`;
  // ★분류·태그를 누르면 목록을 다시 받아오는데, 그 사이 화면이 예전 목록을 그대로 보여줬다★
  //. 눌렀는데 아무 반응이 없으면
  //   사람은 안 눌린 줄 알고 또 누른다 — 오늘 우리가 계속 만난 '무증상' 과 같은 모양이다.
  //   새 키프레임을 만들지 않고 이미 쓰는 animate-pulse 로 얇은 띠 하나만 둔다.
  const loadingBar = _reloading
    ? `<div class="mb-3 h-0.5 w-full overflow-hidden rounded-full bg-surface-3"><div class="h-full w-full animate-pulse bg-accent-green"></div></div>`
    : "";
  const loadMore = items.length
    ? `<div class="py-4 text-center text-[12px] text-slate-500" data-reports-page-status>${_loading ? pick("더 불러오는 중…", "Loading more…") : _hasMore ? pick("아래로 스크롤하면 더 불러옵니다", "Scroll down to load more") : pick("마지막 보고서입니다", "End of reports")}</div>`
    : "";
  const selectionBar = _selectionMode ? `<div class="mb-2 rounded-xl border border-accent-green/40 bg-accent-green/[0.07] px-4 py-2.5 text-[12px] flex items-center justify-between">
    <span class="text-accent-green font-semibold">${_selectedReportIds.size}${pick("건 선택됨", " selected")}</span>
    <span class="flex gap-1.5"><button id="reports-move-selected" class="px-2.5 py-1 rounded-md border border-surface-3 bg-surface-2 text-slate-300 text-[11px] disabled:opacity-40"${_selectedReportIds.size ? "" : " disabled"}>${pick("분류로 이동 ▾", "Move to category ▾")}</button><button id="reports-cancel-selection" class="px-2.5 py-1 rounded-md text-slate-500 text-[11px]">${pick("취소", "Cancel")}</button></span>
  </div>` : "";

  _root.innerHTML = `
    <div data-reports-list-scroll class="h-full overflow-y-auto">
      <div class="max-w-3xl mx-auto px-4 md:px-6 py-5 pb-20">
        <div class="flex items-center gap-2 flex-wrap mb-3">
          <span class="w-7 shrink-0 text-[11px] font-semibold text-slate-500">${pick("분류", "Category")}</span>
          <div class="flex flex-1 items-center gap-1.5 flex-wrap">${pills}</div>
          <button id="reports-manage-categories" class="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-slate-500 border border-dashed border-surface-3 hover:text-slate-300">✎ ${pick("편집", "Edit")}</button>
        </div>
        <div class="flex items-center gap-2 flex-wrap mb-3">
          <span class="w-7 shrink-0 text-[11px] font-semibold text-slate-500">${pick("태그", "Tags")}</span>
          <div class="flex flex-1 items-center gap-1.5 flex-wrap">${tagPills || `<span class="text-xs text-slate-600">${pick("등록된 태그 없음", "No tags yet")}</span>`}</div>
          <button id="reports-manage-tags" class="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-slate-500 border border-dashed border-surface-3 hover:text-slate-300">✎ ${pick("편집", "Edit")}</button>
        </div>
        <div class="flex gap-2 mb-2">
          <div class="relative flex-1"><svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
            <input id="reports-q" type="search" placeholder="${pick("제목·작성자·요약 검색", "Search title · author · summary")}" value="${escape(_query)}" class="w-full bg-surface-2 border border-surface-3 rounded-xl text-sm text-slate-200 pl-9 pr-3 py-2.5 outline-none focus:border-accent-green/40 placeholder:text-slate-600" />
          </div>
          <button id="reports-selection-mode" class="shrink-0 px-3 py-2 rounded-lg text-[12px] font-semibold border border-surface-3 bg-surface-2 text-slate-400">${_selectionMode ? pick("선택 해제", "Deselect") : pick("선택", "Select")}</button>
        </div>
        ${selectionBar}
        ${loadingBar}
        <div class="${_reloading ? "opacity-50 transition-opacity" : "transition-opacity"}">
        ${_loadError ? error : items.length ? `<div class="flex flex-col gap-2.5">${cards}</div>${loadMore}` : empty}
        </div>
      </div>
    </div>`;
  const scroller = _root.querySelector<HTMLElement>("[data-reports-list-scroll]");
  if (scroller) scroller.scrollTop = _listScrollTop;

  _root.querySelectorAll<HTMLButtonElement>(".reports-pill:not(.reports-tag-pill)").forEach((el) => {
    el.addEventListener("click", () => { clearReportSelection(); _cat = el.dataset.cat || ALL_FILTER; void reloadList(); });
  });
  _root.querySelectorAll<HTMLButtonElement>(".reports-tag-pill").forEach((el) => {
    el.addEventListener("click", () => {
      clearReportSelection();
      const id = el.dataset.tagId || "";
      if (_selectedTagIds.has(id)) _selectedTagIds.delete(id); else _selectedTagIds.add(id);
      void reloadList();
    });
  });
  _root.querySelectorAll<HTMLButtonElement>(".reports-tag-filter").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      clearReportSelection();
      _selectedTagIds = new Set([el.dataset.tagId || ""]);
      void reloadList();
    });
  });
  _root.querySelector<HTMLButtonElement>("#reports-manage-tags")?.addEventListener("click", () => {
    void manageTags().catch(reportTagFailure);
  });
  _root.querySelector<HTMLButtonElement>("#reports-manage-categories")?.addEventListener("click", () => {
    void manageCategories(cats).catch(reportTagFailure);
  });
  _root.querySelector<HTMLButtonElement>("#reports-selection-mode")?.addEventListener("click", () => {
    _selectionMode = !_selectionMode;
    if (!_selectionMode) clearReportSelection();
    renderListPreservingScroll();
  });
  _root.querySelector<HTMLButtonElement>("#reports-cancel-selection")?.addEventListener("click", () => {
    clearReportSelection();
    renderListPreservingScroll();
  });
  _root.querySelector<HTMLButtonElement>("#reports-move-selected")?.addEventListener("click", () => {
    void moveSelectedReports(cats).catch(reportTagFailure);
  });
  _root.querySelectorAll<HTMLButtonElement>(".reports-select").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = button.dataset.id || "";
      if (_selectedReportIds.has(id)) _selectedReportIds.delete(id); else _selectedReportIds.add(id);
      renderListPreservingScroll();
    });
  });
  _root.querySelectorAll<HTMLElement>(".reports-card").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.id || "";
      if (_selectionMode) {
        if (_selectedReportIds.has(id)) _selectedReportIds.delete(id); else _selectedReportIds.add(id);
        renderListPreservingScroll();
        return;
      }
      rememberListScroll(); _curId = id || null; if (_curId) setDetailHash(_curId); _curType = null; _view = "detail"; renderDetail();
    });
    el.addEventListener("keydown", (e) => {
      if (e.target !== el && isInteractiveTarget(e.target)) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const id = el.dataset.id || "";
        if (_selectionMode) { if (_selectedReportIds.has(id)) _selectedReportIds.delete(id); else _selectedReportIds.add(id); renderListPreservingScroll(); return; }
        rememberListScroll(); _curId = id || null; if (_curId) setDetailHash(_curId); _curType = null; _view = "detail"; void renderDetail();
      }
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
    el.addEventListener("click", handleCardStarClick);
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
        const removed = _all.find((r) => r.id === id);
        await deleteReport(id);
        _totalCount = Math.max(0, _totalCount - 1);
        updateListCount("[data-reports-all-count]", _totalCount);
        if (removed) {
          const category = catOf(removed);
          _categoryCounts[category] = Math.max(0, (_categoryCounts[category] || 0) - 1);
          updateListCount(`[data-reports-category-count="${CSS.escape(category)}"]`, _categoryCounts[category]!);
          if (isImportant(removed)) {
            _importantCount = Math.max(0, _importantCount - 1);
            updateListCount("[data-reports-important-count]", _importantCount);
          }
        }
        el.closest(".reports-card")?.remove();
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
      t = setTimeout(() => { clearReportSelection(); _query = v; void reloadList({ restoreSearchFocus: true }); }, 900);
    });
    q.addEventListener("input", (e) => {
      if (composing || (e as InputEvent).isComposing) return;
      clearTimeout(t);
      const v = q.value;
      _restoreSearchFocus = true;
      t = setTimeout(() => { clearReportSelection(); _query = v; void reloadList({ restoreSearchFocus: true }); }, 900);
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
  _all = _all.map((r) => (r.id === meta!.id ? { ...r, is_important: meta!.is_important, tags: meta!.tags } : r));

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
          <div id="reports-detail-tags" class="flex items-center gap-2 flex-wrap mt-3">
            ${(meta.tags ?? []).map((t) => tagBadge(t)).join("")}
            <button id="reports-edit-tags" class="px-2.5 py-1 rounded-full text-[11px] font-semibold border border-surface-3 text-slate-400 hover:text-slate-200">＋ ${pick("태그 편집", "Edit tags")}</button>
          </div>

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
  const renderDetailTags = (report: Report) => {
    const tagRow = _root?.querySelector<HTMLElement>("#reports-detail-tags");
    if (!tagRow) return;
    tagRow.innerHTML = `${(report.tags ?? []).map((t) => tagBadge(t)).join("")}
            <button id="reports-edit-tags" class="px-2.5 py-1 rounded-full text-[11px] font-semibold border border-surface-3 text-slate-400 hover:text-slate-200">＋ ${pick("태그 편집", "Edit tags")}</button>`;
    tagRow.querySelector<HTMLButtonElement>("#reports-edit-tags")?.addEventListener("click", handleEditTags);
  };
  const handleEditTags = async () => {
    try {
      const updated = await editReportTags(meta);
      if (!updated) return;
      meta.tags = updated.tags;
      renderDetailTags(meta);
    } catch (err) {
      await showAlert(pick(`태그 변경 실패: ${(err as Error).message}`, `Failed to update tags: ${(err as Error).message}`));
    }
  };
  _root.querySelector<HTMLButtonElement>("#reports-edit-tags")?.addEventListener("click", handleEditTags);
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
    // 새창보기 — 현재 form 타입을 새 탭에서 전체화면으로(좁은 대시보드 뷰 대신).
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
      // 써서 형식이름으로 떨어지던 버그 fix. 한글 보존(\p{L}).
      const slug = String(meta?.title ?? id).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
      dl.setAttribute("download", `${slug}.${type}`);
      // 맥앱(WKWebView): download 속성이 무시되고 webview가 파일로 네비게이션 → 보고서가 전체화면으로 뜨고
      // 복귀 불가. 새창보기와 동일하게 시스템 브라우저로 넘겨 다운로드(대시보드 화면 유지).
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

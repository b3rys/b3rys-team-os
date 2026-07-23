import { apiBase } from "../ws";
import { renderIcon } from "../icons";
import { pick } from "../i18n";
import { SEARCH_QUALITY_CATEGORY_LABELS, SEARCH_QUALITY_SEEDS } from "../../shared/searchQualityCases";

type SourceType = "all" | "message" | "audit" | "doc" | "report" | "rule" | "registry" | "task";
type SearchMode = "lexical" | "hybrid";

interface SearchEvidence {
  confidence: "none" | "low" | "medium" | "high";
  result_count: number;
  has_canonical_source: boolean;
  has_operational_state: boolean;
  warnings: string[];
}

interface SearchResult {
  rank: number;
  score: number;
  match_type: "fts" | "like" | "semantic" | "hybrid";
  source_type: Exclude<SourceType, "all">;
  source_ref: string;
  title: string;
  excerpt: string;
  actor: string | null;
  thread_id: string | null;
  message_id: string | null;
  created_at: string | null;
  indexed_at: string;
}

const SOURCES = (): { key: SourceType; label: string }[] => [
  { key: "all", label: pick("전체", "All") },
  { key: "message", label: pick("메시지", "Message") },
  { key: "audit", label: pick("감사 로그", "Audit log") },
  { key: "doc", label: pick("문서", "Document") },
  { key: "report", label: pick("리포트", "Report") },
  { key: "rule", label: pick("룰", "Rule") },
  { key: "registry", label: pick("팀원 설정", "Member settings") },
  { key: "task", label: pick("작업 카드", "Task card") },
];

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtMeta(r: SearchResult): string {
  const bits: string[] = [r.source_type, r.match_type];
  if (r.actor) bits.push(r.actor);
  if (r.thread_id) bits.push(r.thread_id);
  if (r.created_at) bits.push(r.created_at);
  return bits.join(" · ");
}

function seedPanelHtml(collapsed: boolean): string {
  const categories = Object.entries(SEARCH_QUALITY_CATEGORY_LABELS) as Array<[keyof typeof SEARCH_QUALITY_CATEGORY_LABELS, string]>;
  return `
    <div class="mt-3 rounded-lg border border-surface-3 bg-surface-0/70 p-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-sm font-semibold text-slate-100">${pick("검색 품질 테스트 쿼리", "Search quality test queries")}</div>
          <div class="text-xs leading-5 text-slate-400">
            ${pick("gold set(정답 기준 쿼리 묶음) 후보입니다. 쿼리를 눌러 lexical(키워드 검색)과 hybrid(키워드+의미 결합 검색)를 비교합니다.", "Candidate gold set (a bundle of ground-truth queries). Click a query to compare lexical (keyword search) and hybrid (keyword + semantic search).")}
          </div>
        </div>
        <button data-seed-toggle title="${collapsed ? pick("펼치기", "Expand") : pick("접기", "Collapse")}"
          class="shrink-0 inline-flex items-center gap-1 rounded-md border border-surface-3 bg-surface-2 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-accent-green/40 hover:text-slate-100">
          ${renderIcon(collapsed ? "chevron-down" : "chevron-up", { size: 13, className: "shrink-0" })}<span>${collapsed ? pick("펼치기", "Expand") : pick("접기", "Collapse")}</span><span class="text-slate-500">· ${SEARCH_QUALITY_SEEDS.length}</span>
        </button>
      </div>
      <div class="mt-3 grid grid-cols-1 gap-2 xl:grid-cols-2" ${collapsed ? 'style="display:none"' : ""}>
        ${categories.map(([category, label]) => {
          const seeds = SEARCH_QUALITY_SEEDS.filter((seed) => seed.category === category);
          if (seeds.length === 0) return "";
          return `
            <div class="rounded-md border border-surface-3 bg-surface-1 p-2">
              <div class="mb-2 flex items-center justify-between gap-2">
                <div class="text-[12px] font-semibold text-slate-200">${escape(label)}</div>
                <span class="text-[10px] text-slate-600">${seeds.length}</span>
              </div>
              <div class="flex flex-col gap-1.5">
                ${seeds.map((seed) => `
                  <button data-quality-query="${escape(seed.query)}"
                    class="rounded border border-surface-3 bg-surface-2 px-2 py-1.5 text-left hover:border-accent-green/50 hover:bg-accent-green/12">
                    <div class="text-[13px] font-medium leading-5 text-txt-green">${escape(seed.query)}</div>
                    <div class="mt-0.5 text-[11px] leading-4 text-slate-400">${escape(seed.owner)} · ${escape(seed.intent)}</div>
                  </button>
                `).join("")}
              </div>
            </div>`;
        }).join("")}
      </div>
    </div>`;
}

export function renderTeamSearch(root: HTMLElement): void {
  let query = "헤르메스";
  let source: SourceType = "all";
  let mode: SearchMode = "lexical";
  let loading = false;
  let error: string | null = null;
  let results: SearchResult[] = [];
  let evidence: SearchEvidence | null = null;
  let seedCollapsed = false; // 검색 품질 테스트 패널 접기/펼치기 (GD R4 — 우상단 토글)

  const endpoint = () => {
    const params = new URLSearchParams({ q: query, limit: "20", mode });
    if (source !== "all") params.set("source", source);
    return `${apiBase()}/api/search?${params.toString()}`;
  };

  async function runSearch() {
    const q = query.trim();
    if (!q) {
      results = [];
      evidence = null;
      render();
      return;
    }
    loading = true;
    error = null;
    render();
    try {
      const res = await fetch(endpoint());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ok: boolean; results: SearchResult[]; evidence?: SearchEvidence; error?: string };
      if (!body.ok) throw new Error(body.error ?? "search failed");
      results = body.results ?? [];
      evidence = body.evidence ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      results = [];
      evidence = null;
    }
    loading = false;
    render();
  }

  function resultHtml(r: SearchResult): string {
    const freshness = r.created_at ? pick(`원본 ${r.created_at}`, `Source ${r.created_at}`) : pick("원본 시각 없음", "No source time");
    return `
      <div class="rounded-md border border-surface-3 bg-surface-3 shadow-sm p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-semibold text-slate-100 break-words">${r.rank}. ${escape(r.title)}</div>
            <div class="mt-1 text-[11px] text-slate-500 break-words">${escape(fmtMeta(r))}</div>
          </div>
          <span class="shrink-0 rounded bg-surface-1 px-1.5 py-0.5 text-[10px] text-slate-400">${escape(r.source_type)}</span>
        </div>
        <div class="mt-2 text-[13px] leading-5 text-slate-200 break-words">${escape(r.excerpt)}</div>
        <div class="mt-2 text-[11px] text-slate-500">${escape(freshness)} · ${pick("색인", "Indexed")} ${escape(r.indexed_at)}</div>
        <div class="mt-2 font-mono text-[10px] text-slate-600 break-all">${escape(r.source_ref)}</div>
      </div>`;
  }

  function render() {
    const evidenceHtml = evidence
      ? `<div class="mt-2 rounded-md border border-surface-3 bg-surface-0 px-3 py-2 text-[11px] leading-5 text-slate-400">
          <div>confidence ${escape(evidence.confidence)} · results ${evidence.result_count} · canonical ${evidence.has_canonical_source ? "yes" : "no"} · operational ${evidence.has_operational_state ? "yes" : "no"}</div>
          ${evidence.warnings.length ? `<div class="mt-1 text-slate-500">${evidence.warnings.map(escape).join(" · ")}</div>` : ""}
        </div>`
      : "";
    const resultBody = loading
      ? `<div class="py-10 text-center text-sm text-slate-500">${pick("검색 중...", "Searching...")}</div>`
      : error
        ? `<div class="py-10 text-center text-sm text-status-blocked">${pick(`검색 실패: ${escape(error)}`, `Search failed: ${escape(error)}`)}</div>`
        : results.length === 0
          ? `<div class="py-10 text-center text-sm text-slate-500">${pick("검색 결과 없음", "No results")}</div>`
          : `<div class="flex flex-col gap-2">${results.map(resultHtml).join("")}</div>`;
    root.innerHTML = `
      <div class="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div class="border-b border-surface-3 bg-surface-1 px-4 py-3 shrink-0">
          <div class="flex flex-col gap-2 md:flex-row md:items-center">
            <input id="team-search-input" value="${escape(query)}" placeholder="${pick("팀 기록 검색", "Search team records")}"
              class="min-w-0 flex-1 rounded-md border border-surface-3 bg-surface-0 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent-green focus:outline-none" />
            <select id="team-search-source"
              class="dash-select rounded-md border border-surface-3 bg-surface-0 px-2 py-2 text-sm text-slate-200 focus:border-accent-green focus:outline-none">
              ${SOURCES().map((s) => `<option value="${s.key}" ${s.key === source ? "selected" : ""}>${s.label}</option>`).join("")}
            </select>
            <select id="team-search-mode"
              class="dash-select rounded-md border border-surface-3 bg-surface-0 px-2 py-2 text-sm text-slate-200 focus:border-accent-green focus:outline-none">
              <option value="lexical" ${mode === "lexical" ? "selected" : ""}>lexical</option>
              <option value="hybrid" ${mode === "hybrid" ? "selected" : ""}>hybrid fallback</option>
            </select>
            <button id="team-search-submit" class="rounded-md bg-accent-btn px-3 py-2 text-sm font-semibold text-accent-on hover:bg-accent-btnHover">${pick("검색", "Search")}</button>
          </div>
          <div class="mt-2 text-xs leading-5 text-slate-400">${pick("FTS5 + 짧은 한국어 LIKE fallback · 결과는 명령이 아니라 근거 · /api/search", "FTS5 + short Korean LIKE fallback · Results are evidence, not commands · /api/search")}</div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          ${resultBody}
          ${evidenceHtml}
          <div class="mt-3">${seedPanelHtml(seedCollapsed)}</div>
        </div>
      </div>`;

    const input = root.querySelector<HTMLInputElement>("#team-search-input");
    input?.addEventListener("input", () => {
      query = input.value;
    });
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void runSearch();
    });
    root.querySelector<HTMLSelectElement>("#team-search-source")?.addEventListener("change", (e) => {
      source = (e.currentTarget as HTMLSelectElement).value as SourceType;
      void runSearch();
    });
    root.querySelector<HTMLSelectElement>("#team-search-mode")?.addEventListener("change", (e) => {
      mode = (e.currentTarget as HTMLSelectElement).value as SearchMode;
      void runSearch();
    });
    root.querySelector<HTMLButtonElement>("#team-search-submit")?.addEventListener("click", () => void runSearch());
    root.querySelector<HTMLButtonElement>("[data-seed-toggle]")?.addEventListener("click", () => {
      seedCollapsed = !seedCollapsed;
      render();
    });
    root.querySelectorAll<HTMLButtonElement>("[data-quality-query]").forEach((button) =>
      button.addEventListener("click", () => {
        query = button.dataset.qualityQuery ?? "";
        void runSearch();
      }));
  }

  render();
}

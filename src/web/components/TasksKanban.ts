// TasksKanban — 3-column team task board (계획 / 실행 중 / 완료). b3rys 팀 업무현황.
// Real backend: GET /api/tasks, POST, PATCH /:id, DELETE /:id. Owner options auto-loaded
// from /api/agents (담당자 목록은 팀 로스터에서 자동 반영).
// Card fields: title / owner / status(column) / description(카드 펼침·편집). + 담당자 필터.
// 입력=OWNER 컨펌 후 오너가, 갱신=오너 책임 (프로세스는 TEAM-OS 4장 + task 관리 스킬).

import { apiBase } from "../ws";
import { pick } from "../i18n";
import { parseSqliteDate } from "../lib/datetime";

type ColKey = "plan" | "doing" | "done";

interface KanbanTask {
  id: string;
  title: string;
  owner: string | null;
  description: string | null;
  column: ColKey;
  sort_order?: number;
  created_at?: string;
  updated_at?: string;
}

// dot 의미(승인 프로토) = 계획:중립회색 · 실행중:accent green · 완료:blue. 시맨틱 토큰으로 라이트/다크 적응.
const COLUMNS: { key: ColKey; label: string; accent: string }[] = [
  { key: "plan", label: pick("계획", "Plan"), accent: "rgb(var(--status-offline))" },
  { key: "doing", label: pick("실행 중", "In progress"), accent: "rgb(var(--accent))" },
  { key: "done", label: pick("완료", "Done"), accent: "rgb(var(--status-info))" },
];

const COL_ORDER: ColKey[] = ["plan", "doing", "done"];
const LANE_PAGE_SIZE = 40;

/** 칼럼별 "표시 개수" 초기값 — 세 칼럼 모두 동일 페이지 크기로 시작. */
const initialVisible = (): Record<ColKey, number> =>
  Object.fromEntries(COL_ORDER.map((k) => [k, LANE_PAGE_SIZE])) as Record<ColKey, number>;

/** 세 칼럼 공통 정렬 — 최신순. sort_order 는 생성 시 lane 끝(max+1)이라 동시각 tie 에서만 보조키로 쓴다. */
function byNewestFirst(a: KanbanTask, b: KanbanTask): number {
  const byTime = taskTimeMs(b.updated_at ?? b.created_at) - taskTimeMs(a.updated_at ?? a.created_at);
  return byTime || (b.sort_order ?? 0) - (a.sort_order ?? 0);
}

const DESC_TEMPLATE = pick(
  ["목표:", "범위:", "계획:", "- ", "완료 기준:", "다음 액션:", "재개 시각:", "fallback:", "stop_rule:", "메모:"].join("\n"),
  ["Goal:", "Scope:", "Plan:", "- ", "Done criteria:", "Next action:", "Resume at:", "fallback:", "stop_rule:", "Notes:"].join("\n"),
);

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function taskTimeMs(value?: string): number {
  // SQLite 타임스탬프는 타임존 없는 UTC 문자열이라 반드시 정규화(공백→T, Z 부착) 후 파싱해야
  // UTC 로 해석된다. 안 하면 로컬(KST) 로 오해석되거나(9h 오차) Safari 에서 NaN → 정렬 붕괴.
  const d = parseSqliteDate(value ?? null);
  return d ? d.getTime() : 0;
}

function trashIcon(cls = "h-3.5 w-3.5"): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>`;
}

function detailsIcon(cls = "h-3.5 w-3.5", add = false): string {
  const plus = add ? `<path d="M12 8v8"/><path d="M8 12h8"/>` : "";
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h10"/>${plus}</svg>`;
}

export function renderTasksKanban(root: HTMLElement): void {
  let tasks: KanbanTask[] = [];
  let owners: { id: string; name: string }[] = [];
  let loaded = false;
  let loadError = false;
  let editingId: string | null = null; // 제목 인라인 수정
  let expandedId: string | null = null; // description 펼침/편집
  let filterOwner: string | null = null; // 담당자 필터 (null=전체)
  let visibleCount = initialVisible(); // 칼럼별 표시 개수(더보기로 증가)

  const base = () => `${apiBase()}/api/tasks`;

  async function loadOwners() {
    try {
      const res = await fetch(`${apiBase()}/api/agents`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { agents: { id: string; display_name?: string }[] };
      owners = (body.agents ?? []).map((a) => ({ id: a.id, name: a.display_name || a.id }));
    } catch (e) {
      console.error("[loadOwners]", e);
      owners = [];
    }
  }

  async function loadTasks() {
    try {
      const res = await fetch(base());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tasks: KanbanTask[] };
      tasks = body.tasks ?? [];
      visibleCount = initialVisible();
      loadError = false;
    } catch (e) {
      console.error("[loadTasks]", e);
      loadError = true;
    }
    loaded = true;
    render();
  }

  async function addTask(col: ColKey, title: string, owner: string) {
    const t = title.trim();
    if (!t) return;
    try {
      const res = await fetch(base(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t, column: col, ...(owner ? { owner } : {}) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.error("[addTask]", e);
    }
    await loadTasks();
  }

  async function patchTask(id: string, patch: Record<string, unknown>) {
    try {
      const res = await fetch(`${base()}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.error("[patchTask]", e);
      await loadTasks();
    }
  }

  async function delTask(id: string) {
    tasks = tasks.filter((x) => x.id !== id);
    render();
    try {
      const res = await fetch(`${base()}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.error("[delTask]", e);
      await loadTasks();
    }
  }

  async function moveTask(id: string, dir: -1 | 1) {
    const task = tasks.find((x) => x.id === id);
    if (!task) return;
    const next = COL_ORDER[COL_ORDER.indexOf(task.column) + dir];
    if (!next) return;
    task.column = next;
    task.updated_at = new Date().toISOString();
    render();
    await patchTask(id, { column: next });
  }

  async function commitTitle(id: string, value: string) {
    const v = value.trim();
    editingId = null;
    const task = tasks.find((x) => x.id === id);
    if (!task || !v || v === task.title) { render(); return; }
    task.title = v;
    render();
    await patchTask(id, { title: v });
  }

  async function setOwner(id: string, owner: string) {
    const task = tasks.find((x) => x.id === id);
    if (!task) return;
    task.owner = owner || null;
    await patchTask(id, { owner: owner || null });
  }

  async function commitDescription(id: string, value: string) {
    const task = tasks.find((x) => x.id === id);
    if (!task) return;
    const v = value.trim() || null;
    if (v === (task.description ?? null)) return;
    task.description = v;
    await patchTask(id, { description: v });
  }

  function ownerSelectHtml(selected: string | null, attr: string): string {
    const opts = [`<option value=""${!selected ? " selected" : ""}>${pick("미할당", "Unassigned")}</option>`]
      .concat(
        owners.map(
          (o) => `<option value="${escape(o.id)}"${selected === o.id ? " selected" : ""}>${escape(o.name)}</option>`,
        ),
      )
      .join("");
    return `<select ${attr} class="bg-surface-3 text-slate-300 text-[12.5px] rounded-[8px] px-2 py-1 border border-surface-3 focus:outline-none focus:border-accent-green">${opts}</select>`;
  }

  function filterBarHtml(): string {
    const chip = (id: string | null, label: string) => {
      const active = filterOwner === id;
      return `<button data-filter="${id ?? ""}" class="px-3 py-1 rounded-full text-[12.5px] font-medium border transition-colors ${active ? "bg-slate-100 text-surface-0 border-slate-100" : "bg-surface-3 border-surface-3 text-slate-400 hover:text-slate-200"}">${escape(label)}</button>`;
    };
    const chips = [chip(null, pick("전체", "All"))].concat(owners.map((o) => chip(o.id, o.name))).join("");
    return `<div class="flex items-center gap-1.5 flex-wrap px-1 pb-5">${chips}</div>`;
  }

  function cardHtml(t: KanbanTask): string {
    const idx = COL_ORDER.indexOf(t.column);
    const left = idx > 0
      ? `<button data-move="-1" data-id="${t.id}" class="text-slate-500 hover:text-slate-200 px-1" title="${pick("왼쪽 컬럼으로", "To left column")}">◀</button>`
      : `<span class="px-1 opacity-0">◀</span>`;
    const right = idx < COL_ORDER.length - 1
      ? `<button data-move="1" data-id="${t.id}" class="text-slate-500 hover:text-slate-200 px-1" title="${pick("오른쪽 컬럼으로", "To right column")}">▶</button>`
      : `<span class="px-1 opacity-0">▶</span>`;
    const titleHtml = editingId === t.id
      ? `<input data-edit-title="${t.id}" value="${escape(t.title)}" class="flex-1 bg-surface-0 border border-accent-green rounded px-1.5 py-0.5 text-[13px] text-slate-100 focus:outline-none"/>`
      : `<div data-title="${t.id}" class="w-full pr-6 text-[14px] font-medium leading-snug text-slate-100 break-words cursor-text hover:text-slate-50" title="${pick("클릭해서 제목 수정", "Click to edit title")}">${escape(t.title)}</div>`;
    const hasDesc = !!(t.description && t.description.trim());
    const expanded = expandedId === t.id;
    const detailLabel = expanded ? pick("접기", "Collapse") : hasDesc ? pick("상세보기", "View details") : pick("상세추가", "Add details");
    const detailLink = `<button data-expand="${t.id}" class="absolute right-3 top-3 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-slate-500 transition-colors hover:border-surface-3 hover:bg-surface-2 hover:text-slate-200" title="${detailLabel}" aria-label="${detailLabel}">${detailsIcon("h-3.5 w-3.5", !hasDesc)}</button>`;
    const descBlock = expanded
      ? `<textarea data-desc="${t.id}" rows="6" placeholder="${escape(DESC_TEMPLATE)}"
           class="w-full mt-2 bg-surface-0 border border-surface-3 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-accent-green resize-y">${escape(t.description ?? "")}</textarea>
         <div class="text-[9px] text-slate-600 mt-0.5">${pick("상세는 자동 저장 (포커스 벗어날 때)", "Details auto-save (on blur)")}</div>`
      : "";
    return `
      <div class="relative rounded-[14px] bg-surface-3 border border-surface-3 p-4 shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:shadow-[0_4px_16px_rgba(0,0,0,.08)] transition-shadow group">
        ${detailLink}
        <div class="min-w-0">${titleHtml}</div>
        ${descBlock}
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <div class="min-w-[7rem] flex-1">${ownerSelectHtml(t.owner, `data-owner="${t.id}"`)}</div>
          <div class="ml-auto flex shrink-0 items-center gap-1.5">
            <button data-del="${t.id}" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-slate-500 transition-colors hover:border-red-400/30 hover:bg-red-400/10 hover:text-status-blocked" title="${pick("삭제", "Delete")}" aria-label="${pick("삭제", "Delete")}">${trashIcon()}</button>
            <div class="flex items-center">${left}${right}</div>
          </div>
        </div>
      </div>`;
  }

  function columnHtml(col: { key: ColKey; label: string; accent: string }): string {
    const items = tasks
      .filter((t) => t.column === col.key)
      .filter((t) => filterOwner === null || t.owner === filterOwner)
      .sort(byNewestFirst);
    const visibleItems = items.slice(0, visibleCount[col.key]);
    const cards = visibleItems.map(cardHtml).join("") || `<div class="text-[11px] text-slate-600 px-1 py-4 text-center">${pick("비어 있음", "Empty")}</div>`;
    const remaining = items.length - visibleItems.length;
    const more = remaining > 0
      ? `<button data-show-more="${col.key}" class="mt-1 w-full rounded-[10px] border border-surface-3 bg-surface-2 px-3 py-2 text-[12px] font-semibold text-slate-300 transition-colors hover:border-accent-green/40 hover:bg-accent-green/10 hover:text-accent-green">
          ${pick(`더보기 ${Math.min(LANE_PAGE_SIZE, remaining)}`, `Show ${Math.min(LANE_PAGE_SIZE, remaining)} more`)}
        </button>`
      : "";
    return `
      <div class="flex-1 min-w-0 flex flex-col">
        <div class="flex items-center gap-2 px-1 pb-3">
          <span class="w-2 h-2 rounded-full" style="background:${col.accent}"></span>
          <span class="text-[14px] font-bold text-slate-200">${col.label}</span>
          <span class="ml-auto text-[12px] font-semibold text-slate-500 bg-surface-1 rounded-full px-2.5 py-0.5">${items.length}</span>
        </div>
        <div class="flex-1 overflow-y-auto flex flex-col gap-3">${cards}${more}</div>
        <div class="pt-3 flex flex-col gap-1.5">
          <input data-add-input="${col.key}" type="text" placeholder="${pick("+ 과제 추가", "+ Add task")}"
            class="w-full bg-surface-3 border border-surface-3 rounded-[12px] px-3 py-2 text-[13px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-accent-green"/>
          <div class="flex gap-1.5">
            ${ownerSelectHtml(null, `data-add-owner="${col.key}"`)}
            <button data-add-btn="${col.key}" class="flex-1 px-3 py-2 rounded-[12px] bg-surface-3 hover:bg-accent-green/10 hover:text-accent-green text-[13px] font-medium text-slate-200 border border-surface-3">${pick("추가", "Add")}</button>
          </div>
        </div>
      </div>`;
  }

  function bodyHtml(): string {
    if (!loaded) return `<div class="flex-1 flex items-center justify-center text-slate-500 text-sm">${pick("불러오는 중…", "Loading…")}</div>`;
    if (loadError) {
      return `<div class="flex-1 flex flex-col items-center justify-center gap-2 text-slate-500 text-sm">
        <div>${pick("과제를 불러오지 못했습니다.", "Failed to load tasks.")}</div>
        <button data-retry class="px-3 py-1 rounded bg-surface-3 hover:bg-surface-0 text-[12px] text-slate-200">${pick("다시 시도", "Retry")}</button>
      </div>`;
    }
    return `${filterBarHtml()}<div class="flex gap-5 min-h-full items-stretch flex-col md:flex-row">${COLUMNS.map(columnHtml).join("")}</div>`;
  }

  function render() {
    // render()는 innerHTML을 통째로 갈아끼우므로 overflow 스크롤 컨테이너가 매번 재생성되고
    // 브라우저가 scrollTop을 0으로 클램프한다(상세보기/필터/이동/삭제 등 모든 render 경로에서 발생).
    // 교체 전 스크롤 위치를 캡처해 교체 직후(페인트 전) 복원하면 위로 튀는 점프가 사라진다.
    const prevScroll = root.querySelector<HTMLElement>("[data-scroll-keep]")?.scrollTop ?? 0;

    root.innerHTML = `
      <div class="flex-1 flex flex-col min-h-0">
        <div class="flex items-baseline gap-3 px-6 pt-6 pb-0.5 shrink-0">
          <h1 class="text-[22px] font-bold tracking-tight text-slate-100">Tasks</h1>
          <span class="text-[13px] text-slate-500">${loadError ? pick("오프라인", "Offline") : pick("팀 업무현황 · 실시간", "Team status · live")}</span>
        </div>
        <div data-scroll-keep class="flex-1 overflow-y-auto px-6 pb-6 pt-3">${bodyHtml()}</div>
      </div>`;

    // 새로 생성된 스크롤 컨테이너에 직전 위치 복원 (페인트 전 동기 설정이라 깜빡임 없음)
    if (prevScroll) {
      const next = root.querySelector<HTMLElement>("[data-scroll-keep]");
      if (next) next.scrollTop = prevScroll;
    }

    root.querySelector<HTMLButtonElement>("[data-retry]")?.addEventListener("click", () => void loadTasks());
    root.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) =>
      b.addEventListener("click", () => void delTask(b.dataset.del!)));
    root.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((b) =>
      b.addEventListener("click", () => void moveTask(b.dataset.id!, Number(b.dataset.move) as -1 | 1)));

    // 담당자 필터
    root.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((b) =>
      b.addEventListener("click", () => { filterOwner = b.dataset.filter || null; visibleCount = initialVisible(); render(); }));

    root.querySelectorAll<HTMLButtonElement>("[data-show-more]").forEach((b) =>
      b.addEventListener("click", () => {
        const lane = b.dataset.showMore as ColKey;
        visibleCount = { ...visibleCount, [lane]: visibleCount[lane] + LANE_PAGE_SIZE };
        render();
      }));

    // 설명 펼침/접기
    root.querySelectorAll<HTMLButtonElement>("[data-expand]").forEach((b) =>
      b.addEventListener("click", () => { expandedId = expandedId === b.dataset.expand ? null : b.dataset.expand!; render(); }));
    const descArea = root.querySelector<HTMLTextAreaElement>("[data-desc]");
    if (descArea) descArea.addEventListener("blur", () => void commitDescription(descArea.dataset.desc!, descArea.value));

    // 제목 인라인 수정
    root.querySelectorAll<HTMLElement>("[data-title]").forEach((el) =>
      el.addEventListener("click", () => { editingId = el.dataset.title!; render(); }));
    const editInput = root.querySelector<HTMLInputElement>("[data-edit-title]");
    if (editInput) {
      editInput.focus();
      editInput.setSelectionRange(editInput.value.length, editInput.value.length);
      const done = () => void commitTitle(editInput.dataset.editTitle!, editInput.value);
      editInput.addEventListener("blur", done);
      editInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); done(); }
        else if (e.key === "Escape") { editingId = null; render(); }
      });
    }

    // 담당자 변경 → 즉시 저장
    root.querySelectorAll<HTMLSelectElement>("[data-owner]").forEach((sel) =>
      sel.addEventListener("change", () => void setOwner(sel.dataset.owner!, sel.value)));

    // 추가 (제목 + 담당자)
    const submit = (col: ColKey) => {
      const input = root.querySelector<HTMLInputElement>(`[data-add-input="${col}"]`);
      const ownerSel = root.querySelector<HTMLSelectElement>(`[data-add-owner="${col}"]`);
      if (input) void addTask(col, input.value, ownerSel?.value ?? "");
    };
    root.querySelectorAll<HTMLButtonElement>("[data-add-btn]").forEach((b) =>
      b.addEventListener("click", () => submit(b.dataset.addBtn as ColKey)));
    root.querySelectorAll<HTMLInputElement>("[data-add-input]").forEach((inp) =>
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit(inp.dataset.addInput as ColKey);
      }));
  }

  render();
  void loadOwners().then(loadTasks);
}

import { store, type Agent, type Status, type AgentStats, type AgentHealth } from "../store";
import { loadInitialLog } from "../ws";
import { formatDistanceToNow } from "date-fns";
import { ko } from "date-fns/locale/ko";
import { enUS } from "date-fns/locale/en-US";
import { agentIconName } from "../icons";
import { renderAgentIcon } from "../agentColors";
import { pick, getLocale } from "../i18n";
import { parseSqliteDate } from "../lib/datetime";

function safeRelative(s: string | null): string {
  const d = parseSqliteDate(s);
  if (!d) return "—";
  try {
    return formatDistanceToNow(d, { addSuffix: true, locale: getLocale() === "en" ? enUS : ko });
  } catch {
    return "—";
  }
}

export function renderAgentSidebar(root: HTMLElement): void {
  // Drag-aware render guard: the sidebar re-renders on every store tick (status/health/ctx%
  // updates arrive frequently via WS). A full innerHTML rebuild mid-drag destroys the card
  // being dragged (jank) and flashes the whole list (flicker). We suppress re-renders while
  // dragging and skip no-op rebuilds when the produced HTML is unchanged.
  let isDragging = false;
  let deferredRerender = false;
  let lastHtml = "";

  const buildHtml = (): string => {
    const { agents, statuses, selectedAgentId, agentStats } = store.getState();
    return `
      <div class="p-4 pb-2">
        <div class="text-xs font-semibold uppercase tracking-widest text-slate-500">TEAM</div>
      </div>
      <div class="p-2 flex flex-col gap-1" data-agent-list>
        ${agents
          .map((a) => cardHtml(a, statuses.get(a.id) ?? null, agentStats.get(a.id) ?? null, a.id === selectedAgentId))
          .join("")}
      </div>
    `;
  };

  const update = (force = false) => {
    const html = buildHtml();
    // Skip identical rebuilds: unrelated store changes (messages/tasks) would otherwise swap
    // innerHTML with the same markup and flicker the cards for no reason.
    if (!force && html === lastHtml) return;
    lastHtml = html;
    root.innerHTML = html;
    let draggingAgentId: string | null = null;
    let dropTarget: HTMLElement | null = null;
    let draggedCard: HTMLElement | null = null;
    let dragPointerId: number | null = null;
    let stopDocumentDragListeners: (() => void) | null = null;
    const listRoot = root.querySelector<HTMLElement>("[data-agent-list]");
    const agentCards = () => Array.from(listRoot?.querySelectorAll<HTMLElement>("[data-agent-id]") ?? []);
    const animateLayoutChange = (mutate: () => void) => {
      const before = new Map<HTMLElement, DOMRect>(agentCards().map((card) => [card, card.getBoundingClientRect()]));
      mutate();
      for (const card of agentCards()) {
        const from = before.get(card);
        if (!from) continue;
        const to = card.getBoundingClientRect();
        const dy = from.top - to.top;
        if (Math.abs(dy) < 1) continue;
        card.animate?.(
          [
            { transform: `translateY(${dy}px)` },
            { transform: "translateY(0)" },
          ],
          { duration: 130, easing: "cubic-bezier(0.2, 0, 0, 1)" },
        );
      }
    };
    const movePreviewTo = (target: HTMLElement | null) => {
      if (!listRoot || !draggedCard || !target || target === draggedCard) return;
      const cards = agentCards();
      const from = cards.indexOf(draggedCard);
      const to = cards.indexOf(target);
      if (from < 0 || to < 0 || from === to) return;
      const nextSibling = from < to ? target.nextElementSibling : target;
      if (nextSibling === draggedCard) return;
      if (draggedCard.nextElementSibling === nextSibling) return;
      const card = draggedCard;
      const root = listRoot;
      if (!card || !root) return;
      animateLayoutChange(() => {
        if (nextSibling) root.insertBefore(card, nextSibling);
        else root.appendChild(card);
      });
    };
    const clearDragState = (restorePreview = false) => {
      stopDocumentDragListeners?.();
      stopDocumentDragListeners = null;
      if (dragPointerId != null) {
        try {
          root.querySelector<HTMLElement>("[data-agent-drag-handle][data-drag-active='true']")?.releasePointerCapture(dragPointerId);
        } catch {
          // Pointer capture may already be gone after pointercancel/lostpointercapture.
        }
      }
      draggingAgentId = null;
      dropTarget = null;
      draggedCard = null;
      dragPointerId = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      root.querySelectorAll("[data-drag-active]").forEach((el) => el.removeAttribute("data-drag-active"));
      root.querySelectorAll(".agent-card-drop-target, .agent-card-dragging").forEach((el) => {
        el.classList.remove("agent-card-drop-target", "agent-card-dragging");
      });
      isDragging = false;
      // restorePreview: the live DOM was preview-reordered but the store never changed, so a
      // memo-guarded update() would skip — force it to restore the original order. Otherwise
      // flush any store updates that were deferred while the drag was in progress.
      const flush = deferredRerender;
      deferredRerender = false;
      if (restorePreview || flush) update(true);
    };
    const setDropTarget = (target: HTMLElement | null) => {
      if (target === dropTarget) return;
      dropTarget?.classList.remove("agent-card-drop-target");
      dropTarget = target;
      dropTarget?.classList.add("agent-card-drop-target");
      movePreviewTo(target);
    };
    const updateDropTargetFromPoint = (clientX: number, clientY: number) => {
      const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-agent-id]") ?? null;
      setDropTarget(target?.dataset.agentId === draggingAgentId ? null : target);
    };
    const finishDrag = () => {
      const activeId = draggingAgentId;
      const orderedIds = agentCards()
        .map((card) => card.dataset.agentId)
        .filter((id): id is string => Boolean(id));
      const stateIds = store.getState().agents.map((agent) => agent.id);
      const shouldReorder =
        Boolean(activeId) &&
        orderedIds.length === stateIds.length &&
        orderedIds.some((id, index) => id !== stateIds[index]);
      clearDragState(!shouldReorder);
      if (!shouldReorder) return;
      store.getState().setAgentOrder(orderedIds);
    };
    root.querySelectorAll<HTMLElement>("[data-agent-drag-handle]").forEach((handle) => {
      handle.addEventListener("click", (e) => e.stopPropagation());
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        draggingAgentId = handle.dataset.agentDragHandle ?? null;
        if (!draggingAgentId) return;
        clearDragState();
        draggingAgentId = handle.dataset.agentDragHandle ?? null;
        if (!draggingAgentId) return;
        draggedCard = handle.closest<HTMLElement>("[data-agent-id]");
        dragPointerId = e.pointerId;
        handle.dataset.dragActive = "true";
        handle.setPointerCapture(e.pointerId);
        draggedCard?.classList.add("agent-card-dragging");
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        isDragging = true;
        const onPointerMove = (ev: PointerEvent) => {
          if (!draggingAgentId || ev.pointerId !== dragPointerId) return;
          ev.preventDefault();
          updateDropTargetFromPoint(ev.clientX, ev.clientY);
        };
        const onPointerUp = (ev: PointerEvent) => {
          if (ev.pointerId !== dragPointerId) return;
          ev.preventDefault();
          finishDrag();
        };
        const onPointerCancel = (ev: PointerEvent) => {
          if (ev.pointerId !== dragPointerId) return;
          clearDragState(true);
        };
        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp, { passive: false });
        window.addEventListener("pointercancel", onPointerCancel);
        stopDocumentDragListeners = () => {
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
          window.removeEventListener("pointercancel", onPointerCancel);
        };
      });
      handle.addEventListener("pointermove", (e) => {
        if (!draggingAgentId) return;
        updateDropTargetFromPoint(e.clientX, e.clientY);
      });
      handle.addEventListener("pointerup", () => {
        if (draggingAgentId) finishDrag();
      });
      handle.addEventListener("pointercancel", () => clearDragState(true));
      handle.addEventListener("lostpointercapture", () => {
        // Keep document-level listeners alive; pointer capture can be lost when the
        // pointer leaves the small handle, but the drag should still be finishable.
      });
    });
    root.querySelectorAll<HTMLButtonElement>("[data-agent-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.agentId!;
        store.getState().selectAgent(id);
        void loadInitialLog(id);
      });
    });
  };

  update();
  store.subscribe(() => {
    // Never rebuild mid-drag — it destroys the dragged card and flashes the list. Defer until
    // the pointer is released (clearDragState flushes the deferred render).
    if (isDragging) {
      deferredRerender = true;
      return;
    }
    update();
  });
}

function cardHtml(a: Agent, st: Status | null, stats: AgentStats | null, selected: boolean): string {
  const state = st?.state ?? "offline";
  const health = store.getState().agentHealth.get(a.id) ?? null;
  const healthLoaded = store.getState().agentHealthLoaded;
  const stateMeta = activityLabel(state, a);
  const healthMeta = healthLabel(health, a, healthLoaded);
  const last = safeRelative(st?.last_activity_at ?? null);
  const runtimeBadge =
    ({ claude_channel: "claude", openclaw: "openclaw", hermes_agent: "hermes", b3os_native: "b3os", codex: "codex" } as Record<string, string>)[
      a.runtime
    ] ?? a.runtime;
  const icon = renderAgentIcon(a.icon || agentIconName(a.id), a.icon_color, 18);
  const ctx = st?.ctx_percent;
  const ctxBar =
    typeof ctx === "number"
      ? `<div class="mt-1.5 agent-card-ctxbar" title="${pick(`이 agent 세션의 문맥창 사용률입니다. Claude 계정 사용량과는 별도입니다. ${ctx}%`, `This agent session's context-window usage. Separate from your Claude account usage. ${ctx}%`)}">
           <div class="flex items-center gap-1.5 text-[10px] text-slate-500">
             <span>${pick("문맥", "Context")}</span>
             <div class="flex-1 h-1 bg-surface-0 rounded overflow-hidden">
               <div style="width:${ctx}%;background:${ctxBarColor(ctx)}" class="h-full"></div>
             </div>
             <span class="font-mono">${ctx}%</span>
           </div>
         </div>`
      : "";
  const statsStrip = stats ? renderStatsStrip(stats) : "";
  // pending backlog — best-effort: only present after topology has loaded busMembers (store-global
  // but topology-populated). Shown when available; never forces a fetch here.
  const member = store.getState().busMembers.find((m) => m.agent_id === a.id);
  const pending = member?.resolvable_pending ?? 0;
  const off = a.off ?? member?.off ?? false; // /onoff 로 의도적 정지(WS hello 의 a.off 우선) — '중지' 명확 표시
  // 정지면 health 표시('정상'·초록)를 '중지'·빨강으로 덮어쓴다(게이트웨이 떠있어도 그 팀원은 꺼짐).
  const healthDisplay = off ? { label: pick("중지", "Stopped"), level: "down", title: pick("/onoff 로 정지됨 — 🟢 기동 필요", "Stopped via /onoff — 🟢 needs to be brought up") } : healthMeta;
  // Compact one-glance row shown only on mobile (<768px) — state dot · last activity · ctx% · pending.
  const mobileMeta = `
    <div class="agent-card-mobile items-center gap-2 mt-1 text-[11px]">
      <span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${stateColor(state)}" title="${stateMeta.title}"></span>
      <span class="text-slate-400 truncate">${last}</span>
      ${typeof ctx === "number" ? `<span class="font-mono text-accent-greenSoft shrink-0">ctx ${ctx}%</span>` : ""}
      ${pending > 0 ? `<span class="px-1.5 rounded text-[10px] font-medium shrink-0" style="background:#f59e0b22;color:#f59e0b">${pick(`대기 ${pending}`, `Pending ${pending}`)}</span>` : ""}
    </div>`;
  return `
    <button data-agent-id="${a.id}"
      class="agent-card w-full text-left p-3 pl-4 rounded-lg transition-colors hover:bg-surface-1 ${off ? "border-l-2 border-status-blocked opacity-60" : selected ? "bg-surface-1 border-l-2 border-status-running" : "border-l-2 border-transparent"}">
      <span class="agent-card-drag-handle" data-agent-drag-handle="${a.id}" title="${pick("드래그하여 팀원 순서 변경", "Drag to reorder members")}" aria-label="${pick(`${a.display_name} 순서 변경`, `Reorder ${a.display_name}`)}"></span>
      <div class="flex items-start gap-3">
        <div class="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center rounded-md bg-surface-0 ${off ? "text-status-blocked grayscale" : "text-accent-greenSoft"}">${icon}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="text-sm font-semibold ${off ? "text-slate-400" : "text-slate-100"} truncate">${a.display_name}</span>
              ${off ? `<span class="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-status-blocked text-white">🔴 ${pick("중지", "Stopped")}</span>` : ""}
              <span class="shrink-0 text-[10px] ${off ? "text-status-blocked" : "text-slate-500"} uppercase tracking-wider" title="${a.runtime} · ${healthDisplay.title}">${runtimeBadge} · ${healthDisplay.label}</span>
            </div>
            <span class="health-dot ${healthDisplay.level}" title="${healthDisplay.title}" ${off ? 'style="background:#ef4444"' : ""}></span>
          </div>
          <div class="text-xs text-slate-400 truncate mt-0.5 agent-card-role">${a.role}</div>
          <div class="mt-1 text-[10px] text-slate-500 agent-card-lastline" title="${stateMeta.title}">${pick("최근 활동 시간", "Recent activity")} · ${last}</div>
          ${ctxBar}
          ${statsStrip}
          ${mobileMeta}
        </div>
      </div>
    </button>
  `;
}

function activityLabel(state: string, agent: Agent): { label: string; title: string } {
  if (agent.runtime === "openclaw" && state === "idle") {
    return {
      label: pick("최근 활동 시간", "Recent activity"),
      title: pick("OpenClaw 게이트웨이는 살아 있습니다. 현재는 agent별 작업/로그 상태까지는 읽지 못합니다.", "The OpenClaw gateway is alive. It cannot yet read per-agent task/log state."),
    };
  }
  if (state === "running") return { label: pick("최근 활동 시간", "Recent activity"), title: pick("최근 1분 안에 터미널 출력이 갱신됨", "Terminal output refreshed within the last minute") };
  if (state === "idle") return { label: pick("최근 활동 시간", "Recent activity"), title: pick("최근 1-5분 사이 터미널 출력 갱신 없음", "No terminal output refresh in the last 1–5 minutes") };
  if (state === "blocked") {
    return {
      label: pick("최근 활동 시간", "Recent activity"),
      title: pick("최근 5분 이상 터미널 출력 갱신 없음. 실제 작업 중단이나 문맥 포화라는 뜻은 아닙니다.", "No terminal output refresh for over 5 minutes. This does not necessarily mean the work stopped or the context is full."),
    };
  }
  return { label: pick("최근 활동 시간", "Recent activity"), title: pick("세션이 없거나 상태 확인 실패", "No session, or status check failed") };
}

function healthLabel(
  health: AgentHealth | null,
  agent: Agent,
  loaded: boolean,
): { level: "ok" | "warn" | "danger" | "pending"; label: string; title: string } {
  if (!loaded || !health) {
    return { level: "pending", label: pick("확인 중", "Checking"), title: pick("health check 결과를 아직 불러오는 중입니다.", "Still loading the health check result.") };
  }
  const reason = health.reasons.length ? ` · ${health.reasons.join(", ")}` : "";
  if (health.capacityLevel === "danger" && health.capacityStatus && health.capacityStatus !== "ok") {
    const label = health.capacityLabel ?? pick("용량 경고", "Capacity");
    return {
      level: "danger",
      label: pick(label, health.capacityStatus === "usage_credits" ? "Credits" : "Limit"),
      title: pick(`Claude capacity 문제입니다${reason}`, `Claude capacity problem${reason}`),
    };
  }
  if (
    health.level === "danger" &&
    agent.runtime === "openclaw" &&
    /OpenClaw|브리지|response timeout/i.test(health.reasons.join(" "))
  ) {
    return { level: "warn", label: pick("응답 지연", "Slow response"), title: pick(`OpenClaw 최근 응답이 지연됐습니다${reason}`, `The recent OpenClaw response was slow${reason}`) };
  }
  if (health.level === "danger") {
    return { level: "danger", label: pick("확인 필요", "Check needed"), title: pick(`세션 또는 주입 경로가 죽어 있을 수 있습니다${reason}`, `The session or injection path may be dead${reason}`) };
  }
  if (health.level === "warn") {
    return { level: "warn", label: pick("응답 어려움", "Slow to respond"), title: pick(`작업 중이거나 문맥/관측 상태를 확인해야 합니다${reason}`, `Busy working, or the context/observation state needs checking${reason}`) };
  }
  const base = agent.runtime === "openclaw" ? pick("OpenClaw 게이트웨이 정상", "OpenClaw gateway healthy") : pick("세션 정상", "Session healthy");
  return { level: "ok", label: pick("정상", "Healthy"), title: `${base}${reason}` };
}

function renderStatsStrip(s: AgentStats): string {
  const latency = formatLatency(s.avg_reply_ms_24h);
  const latencyTitle =
    s.avg_reply_ms_24h != null
      ? pick(`평균 응답 (24h): ${latency} · 샘플 ${s.reply_samples_24h}`, `Avg reply (24h): ${latency} · ${s.reply_samples_24h} samples`)
      : pick("응답 샘플 없음 (24h)", "No reply samples (24h)");
  return `
    <div class="mt-1.5 flex items-center gap-2 text-[10px] text-slate-500 font-mono agent-card-stats" title="${pick("24h ↓in ↑out · 7d ↓in ↑out · 평균 응답", "24h ↓in ↑out · 7d ↓in ↑out · avg reply")}">
      <span title="${pick(`24h: 받음 ${s.in_24h} / 보냄 ${s.out_24h}`, `24h: received ${s.in_24h} / sent ${s.out_24h}`)}">24h <span class="text-status-info">↓${s.in_24h}</span> <span class="text-accent-greenSoft">↑${s.out_24h}</span></span>
      <span class="text-slate-700">·</span>
      <span title="${pick(`7d: 받음 ${s.in_7d} / 보냄 ${s.out_7d}`, `7d: received ${s.in_7d} / sent ${s.out_7d}`)}">7d <span class="text-status-info">↓${s.in_7d}</span> <span class="text-accent-greenSoft">↑${s.out_7d}</span></span>
      ${latency ? `<span class="text-slate-700">·</span><span title="${latencyTitle}">${latency}</span>` : ""}
    </div>
  `;
}

function formatLatency(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function ctxBarColor(_pct: number): string {
  return "#86EFAC";
}

// Agent runtime-state color for the compact mobile dot. offline=red so GD spots "누가 막혔나" fast.
function stateColor(state: string): string {
  if (state === "running") return "#22c55e";
  if (state === "idle") return "#64748b";
  if (state === "blocked") return "#f59e0b";
  return "#ef4444"; // offline / unknown
}

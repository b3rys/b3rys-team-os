// TopologyView — bus↔member topology (busviz v1).
// SVG hub-and-spoke: the team bus at the center, registered agents as radial nodes.
// Each node shows pending backlog and in-flight state; nodes stuck in dispatching are
// drawn distinctly from a plain pending pile (Gemini #3 — "비웠는데 왜 빨강?" 방지).
// Clicking a node opens a guarded pending-management panel (expire/complete with a
// dry-run preview first). Data: store.busMembers (GET /api/bus/members), identity from
// store.agents. Live refresh is driven by main.ts polling loadBusMembers every 3s.

import { store, type BusMember, type ResolveResult } from "../store";
import { resolveMemberPending, loadBusMembers } from "../ws";
import { pick } from "../i18n";

// In-flight age windows. We only have inflight.oldest_age_sec (no recent_inflight_count),
// so we bucket by the oldest in-flight item's age:
//   < ACTIVE_MAX        → a fresh dispatch in motion (healthy, shown as animated edge)
//   [ACTIVE_MAX, RECENT_MAX) → recently stuck (red) — genuinely not progressing
//   >= RECENT_MAX       → historical leftover from a past wake (e.g. 45–98h old wake_dispatched
//                          rows that never completed). NOT "now stuck" — demoted to a gray
//                          "미완(오래됨)" sub-badge so it never paints the node red. (v1.1 GD fix)
// 90s was too sensitive: real Claude/OpenClaw replies and bus round-trips often exceed it,
// making active members look stopped. Use 10m before showing red "recent stuck".
const ACTIVE_MAX_SEC = 600;
const RECENT_STUCK_MAX_SEC = 3600; // 1h

// Mirror of BusFlow STATE_STYLE so the panel breakdown matches the flow view's colors.
const STATE_STYLE: Record<string, { label: string; color: string }> = {
  pending: { label: pick("대기", "Waiting"), color: "#94a3b8" },
  dispatching: { label: pick("전송중", "Sending"), color: "#3b82f6" },
  wake_dispatched: { label: pick("깨움", "Wake"), color: "#06b6d4" },
  agent_ack: { label: pick("확인", "Ack"), color: "#2dd4bf" },
  completed: { label: pick("완료", "Completed"), color: "#22c55e" },
  deferred: { label: pick("보류", "Deferred"), color: "#f59e0b" },
  blocked: { label: pick("차단", "Blocked"), color: "#ef4444" },
  dead_letter: { label: pick("실패", "Failed"), color: "#dc2626" },
  failed: { label: pick("실패", "Failed"), color: "#ef4444" },
  expired: { label: pick("만료", "Expired"), color: "#64748b" },
};

const COUNT_ORDER: (keyof BusMember["counts"])[] = [
  "pending", "deferred", "dispatching", "wake_dispatched",
  "agent_ack", "completed", "blocked", "dead_letter", "failed", "expired",
];

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Node PRIMARY color = the team member's reachability, per GD's v1.1 feedback
// ("노드 주색은 팀원 실제 상태로"). Pending/in-flight are traffic/backlog signals,
// so they stay as badges/edges instead of changing the node's primary color.
type NodeStatus = "offline" | "stuck" | "pending" | "healthy" | "idle";

function agentState(id: string): string | undefined {
  return store.getState().statuses.get(id)?.state;
}

// Old (≥1h) dispatching/wake_dispatched left over from earlier wakes — not a current problem.
// Best-effort without recent_inflight_count: if the OLDEST in-flight is ≥1h, the in-flight set is
// treated as residual (the common real case — a few ancient wake_dispatched rows never completed).
function residualInflight(m: BusMember | undefined): number {
  const c = m?.inflight?.count ?? 0;
  const age = m?.inflight?.oldest_age_sec ?? null;
  return c > 0 && age != null && age >= RECENT_STUCK_MAX_SEC ? c : 0;
}

// Recent in-flight sitting long enough to look genuinely stuck (not historical residual).
function isRecentStuck(m: BusMember | undefined): boolean {
  const c = m?.inflight?.count ?? 0;
  const age = m?.inflight?.oldest_age_sec ?? null;
  return c > 0 && age != null && age >= ACTIVE_MAX_SEC && age < RECENT_STUCK_MAX_SEC;
}

// Fresh dispatch still in motion (healthy) — drawn as an animated edge, not a node color.
function isActiveFlow(m: BusMember | undefined): boolean {
  const c = m?.inflight?.count ?? 0;
  const age = m?.inflight?.oldest_age_sec ?? null;
  return c > 0 && age != null && age < ACTIVE_MAX_SEC;
}

function nodeStatus(id: string, m: BusMember | undefined): NodeStatus {
  const state = agentState(id);
  if (m?.off || state === "offline") return "offline"; // member not reachable or intentionally off
  if (state === "running" || state === "idle" || state === "blocked") return "healthy"; // 응답가능
  if (!state) return "idle";                         // status not loaded yet; avoid scary first-paint colors
  if (isRecentStuck(m)) return "stuck";            // no reachable-state signal, but a wake looks stuck
  const backlog = m?.resolvable_pending ?? 0;
  if (backlog > 0) return "pending";               // waiting backlog, reachability unknown
  return "idle";
}

const STATUS_COLOR: Record<NodeStatus, string> = {
  offline: "#ef4444", // 응답불가
  stuck: "#ef4444",   // 최근 멈춤
  pending: "#f59e0b", // backlog 대기
  healthy: "#22c55e", // 정상(응답가능)
  idle: "#64748b",    // 유휴
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  offline: pick("오프라인(응답불가)", "Offline (unreachable)"),
  stuck: pick("멈춤(최근)", "Stuck (recent)"),
  pending: pick("대기 backlog", "Waiting backlog"),
  healthy: pick("정상", "Healthy"),
  idle: pick("유휴", "Idle"),
};

function fmtAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

// ── Panel (pending management) local UI state ───────────────────────────────
interface PanelState {
  agentId: string | null;
  busOpen: boolean; // BUS hub node selected → show bus-wide status instead of a member panel
  phase: "idle" | "preview" | "done";
  action: "expire" | "complete" | null;
  busy: boolean;
  preview: ResolveResult | null; // dry-run result
  result: ResolveResult | null;  // applied result
  error: string | null;
}

export function renderTopology(root: HTMLElement): void {
  const panel: PanelState = {
    agentId: null, busOpen: false, phase: "idle", action: null, busy: false,
    preview: null, result: null, error: null,
  };

  const memberOf = (id: string): BusMember | undefined =>
    store.getState().busMembers.find((m) => m.agent_id === id);

  const displayName = (id: string): string =>
    store.getState().agents.find((a) => a.id === id)?.display_name ?? id;

  function resetPanel(agentId: string | null) {
    panel.agentId = agentId;
    panel.busOpen = false;
    panel.phase = "idle";
    panel.action = null;
    panel.busy = false;
    panel.preview = null;
    panel.result = null;
    panel.error = null;
  }

  function openBus() {
    resetPanel(null);
    panel.busOpen = true;
  }

  // ── data-action handlers ──────────────────────────────────────────────────
  async function startPreview(action: "expire" | "complete") {
    if (!panel.agentId || panel.busy) return;
    panel.busy = true; panel.action = action; panel.error = null;
    render();
    const res = await resolveMemberPending(panel.agentId, action, true);
    panel.busy = false;
    if (!res) { panel.error = pick("미리보기 실패 (네트워크/서버)", "Preview failed (network/server)"); render(); return; }
    if (res.ok === false) { panel.error = res.error ?? pick("요청 거부됨", "Request rejected"); render(); return; }
    panel.preview = res; panel.phase = "preview";
    render();
  }

  async function applyAction() {
    if (!panel.agentId || !panel.action || panel.busy) return;
    panel.busy = true; panel.error = null;
    render();
    const res = await resolveMemberPending(panel.agentId, panel.action, false);
    panel.busy = false;
    if (!res || res.ok === false) {
      panel.error = res?.error ?? pick("처리 실패", "Action failed");
      render();
      return;
    }
    panel.result = res; panel.phase = "done";
    render();
    void loadBusMembers(); // refresh topology immediately
  }

  // ── render ────────────────────────────────────────────────────────────────
  // One member node (circle + emoji + name + pending/residual badges). Reuses the v1.1
  // status/color logic; returns its status+activeFlow so the bus→member edge can match.
  function memberNode(id: string, m: BusMember | undefined, x: number, y: number, nodeR: number): { node: string; status: NodeStatus; activeFlow: boolean } {
    const st = nodeStatus(id, m);
    const color = STATUS_COLOR[st];
    const age = m?.inflight?.oldest_age_sec ?? null;
    const activeFlow = isActiveFlow(m);
    const residual = residualInflight(m);
    const pending = m?.resolvable_pending ?? 0;
    const agent = store.getState().agents.find((a) => a.id === id);
    const emoji = agent?.avatar_emoji ?? "•";
    const name = agent?.display_name ?? id;
    const selected = panel.agentId === id;

    const pulse = st === "stuck"
      ? `<circle cx="${x}" cy="${y}" r="${nodeR}" fill="none" stroke="#ef4444" stroke-width="2" opacity="0.6">
           <animate attributeName="r" from="${nodeR}" to="${nodeR + 10}" dur="1.4s" repeatCount="indefinite"/>
           <animate attributeName="opacity" from="0.6" to="0" dur="1.4s" repeatCount="indefinite"/>
         </circle>` : "";
    const pendingBadge = pending > 0
      ? `<g transform="translate(${x + nodeR - 6},${y - nodeR + 6})">
           <circle r="11" fill="#f59e0b"/><text text-anchor="middle" dy="4" font-size="11" font-weight="700" fill="#1e293b">${pending}</text>
         </g>` : "";
    const subBadge = st === "stuck"
      ? `<text x="${x}" y="${y + nodeR + 15}" text-anchor="middle" font-size="10" font-weight="700" fill="#ef4444">⏱ ${fmtAge(age)} ${pick("멈춤", "stuck")}</text>`
      : residual > 0
        ? `<text x="${x}" y="${y + nodeR + 15}" text-anchor="middle" font-size="9" fill="#64748b">${pick(`미완 ${residual} (오래됨)`, `${residual} unfinished (old)`)}</text>`
        : "";
    const node = `
      <g class="topo-node" data-agent="${escape(id)}" style="cursor:pointer">
        ${pulse}
        <circle cx="${x}" cy="${y}" r="${nodeR}" fill="#0f172a" stroke="${color}" stroke-width="${selected ? 4 : 2.5}"/>
        <text x="${x}" y="${y - 3}" text-anchor="middle" font-size="18">${escape(emoji)}</text>
        <text x="${x}" y="${y + 13}" text-anchor="middle" font-size="9" fill="#cbd5e1" font-weight="600">${escape(name)}</text>
        ${pendingBadge}
        ${subBadge}
      </g>`;
    return { node, status: st, activeFlow };
  }

  // 3-layer vertical layout (v1.2, GD): ① interface (top) → ② bus (middle) → ③ members (bottom).
  // Top→down solid = inbound capture (interface→bus→member). Bottom→up dotted = reply mirror.
  function layeredSvg(members: BusMember[], agentIds: string[]): string {
    const W = 660, H = 540;
    const yTop = 70, yBus = 285, yMember = 470;
    const busH = 50, nodeR = 30;
    const cx = W / 2;
    const edges: string[] = [];

    // ① interface layer (static labels — capture/mirror path is the point, not live data)
    const interfaces = [
      { x: cx - 130, label: pick("텔레그램 그룹", "Telegram group"), sub: "TEAM OP capture" },
      { x: cx + 130, label: "Slack", sub: "team-collab" },
    ];
    const ifaceNodes = interfaces.map((it) =>
      `<g>
        <rect x="${it.x - 72}" y="${yTop - 22}" width="144" height="44" rx="8" fill="#0f172a" stroke="#475569" stroke-width="1.5"/>
        <text x="${it.x}" y="${yTop - 2}" text-anchor="middle" font-size="11" fill="#cbd5e1" font-weight="700">${it.label}</text>
        <text x="${it.x}" y="${yTop + 12}" text-anchor="middle" font-size="8" fill="#64748b">${it.sub}</text>
      </g>`).join("");

    // ② bus layer
    const busW = 210;
    const busNode = `
      <g class="topo-bus" style="cursor:pointer">
        <rect x="${cx - busW / 2}" y="${yBus - busH / 2}" width="${busW}" height="${busH}" rx="10" fill="#1e293b" stroke="#22c55e" stroke-width="${panel.busOpen ? 4 : 2.5}"/>
        <text x="${cx}" y="${yBus - 2}" text-anchor="middle" font-size="13" fill="#86efac" font-weight="800">TEAM BUS</text>
        <text x="${cx}" y="${yBus + 14}" text-anchor="middle" font-size="8" fill="#64748b">${pick("team-collab :7878 · 클릭=status", "team-collab :7878 · click=status")}</text>
      </g>`;

    // ③ member layer
    const n = agentIds.length;
    const spread = W - 100;
    const memberX = (i: number) => (n <= 1 ? W / 2 : 50 + (i * spread) / (n - 1));
    const built = agentIds.map((id, i) => ({ id, ...memberNode(id, members.find((mm) => mm.agent_id === id), memberX(i), yMember, nodeR) }));

    // interface → bus : solid down (capture) + dotted up (mirror)
    interfaces.forEach((it) => {
      edges.push(`<line x1="${it.x}" y1="${yTop + 22}" x2="${cx - 14}" y2="${yBus - busH / 2}" stroke="#64748b" stroke-width="1.5" marker-end="url(#arrow)"/>`);
      edges.push(`<line x1="${cx + 14}" y1="${yBus - busH / 2}" x2="${it.x + 10}" y2="${yTop + 22}" stroke="#475569" stroke-width="1" stroke-dasharray="3 4" marker-end="url(#arrow-up)"/>`);
    });
    // bus → member : solid down (colored by flow) + dotted up (mirror reply)
    built.forEach((b, i) => {
      const mx = memberX(i);
      const downColor = b.status === "stuck" ? "#ef4444" : b.activeFlow ? "#06b6d4" : "#64748b";
      const downW = (b.status === "stuck" || b.activeFlow) ? 2.5 : 1.2;
      const downMarker = b.status === "stuck" ? "arrow-stuck" : b.activeFlow ? "arrow-active" : "arrow";
      if (b.activeFlow) {
        edges.push(`<line x1="${cx}" y1="${yBus + busH / 2}" x2="${mx}" y2="${yMember - nodeR - 4}" stroke="${downColor}" stroke-width="${downW}" marker-end="url(#${downMarker})" stroke-dasharray="5 4"><animate attributeName="stroke-dashoffset" from="18" to="0" dur="0.9s" repeatCount="indefinite"/></line>`);
      } else {
        edges.push(`<line x1="${cx}" y1="${yBus + busH / 2}" x2="${mx}" y2="${yMember - nodeR - 4}" stroke="${downColor}" stroke-width="${downW}" marker-end="url(#${downMarker})"/>`);
      }
      edges.push(`<line x1="${mx + 10}" y1="${yMember - nodeR - 4}" x2="${cx + 16}" y2="${yBus + busH / 2}" stroke="#475569" stroke-width="1" stroke-dasharray="3 4" marker-end="url(#arrow-up)"/>`);
    });

    const layerLabels = `
      <text x="12" y="${yTop + 4}" font-size="9" fill="#475569" font-weight="700">${pick("인터페이스", "Interface")}</text>
      <text x="12" y="${yBus + 4}" font-size="9" fill="#475569" font-weight="700">${pick("버스", "Bus")}</text>
      <text x="12" y="${yMember + 4}" font-size="9" fill="#475569" font-weight="700">${pick("팀원", "Members")}</text>
      <text x="${cx + 120}" y="${(yTop + yBus) / 2}" font-size="8" fill="#475569">↓ capture · ⇡ mirror</text>`;

    return `
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:64vh" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
          <marker id="arrow-active" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#06b6d4"/></marker>
          <marker id="arrow-stuck" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#ef4444"/></marker>
          <marker id="arrow-up" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#475569"/></marker>
        </defs>
        ${edges.join("")}
        ${layerLabels}
        ${ifaceNodes}
        ${busNode}
        ${built.map((b) => b.node).join("")}
      </svg>`;
  }

  function legendHtml(): string {
    const items: NodeStatus[] = ["healthy", "pending", "stuck", "offline", "idle"];
    const chips = items.map((s) =>
      `<span class="inline-flex items-center gap-1 text-[10px] text-slate-400">
        <span class="w-2.5 h-2.5 rounded-full" style="background:${STATUS_COLOR[s]}"></span>${STATUS_LABEL[s]}</span>`
    ).join("");
    const note = `<span class="text-[10px] text-slate-500">${pick(`· 실선↓ 유입(capture) · 점선↑ 답변 미러 · <span style="color:#06b6d4">청록 점멸</span>=전송중 · <span style="color:#94a3b8">미완(오래됨)</span>=과거 잔여(정상)`, `· solid↓ inbound(capture) · dotted↑ reply mirror · <span style="color:#06b6d4">cyan blink</span>=Sending · <span style="color:#94a3b8">unfinished(old)</span>=past residual(Healthy)`)}</span>`;
    return chips + note;
  }

  // BUS hub status — aggregated from store.busMembers (read-only, no new fetch).
  function busPanelHtml(): string {
    const members = store.getState().busMembers;
    const at = store.getState().busMembersAt;
    const totals: Record<string, number> = {};
    for (const k of COUNT_ORDER) totals[k] = 0;
    let inflight = 0, resolvable = 0, reachable = 0;
    const stuckMembers: string[] = [];
    const offlineMembers: string[] = [];
    for (const m of members) {
      for (const k of COUNT_ORDER) totals[k] = (totals[k] ?? 0) + (m.counts[k] ?? 0);
      inflight += m.inflight?.count ?? 0;
      resolvable += m.resolvable_pending ?? 0;
      const st = nodeStatus(m.agent_id, m);
      if (st === "stuck") stuckMembers.push(m.agent_id);
      if (st === "offline") offlineMembers.push(m.agent_id);
      else reachable++;
    }
    const chips = COUNT_ORDER
      .filter((k) => (totals[k] ?? 0) > 0)
      .map((k) => {
        const sty = STATE_STYLE[k] ?? { label: k, color: "#94a3b8" };
        return `<span class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium" style="background:${sty.color}22;color:${sty.color}">${sty.label} ${totals[k] ?? 0}</span>`;
      }).join(" ") || `<span class="text-[10px] text-slate-600">${pick("메시지 없음", "No messages")}</span>`;
    const list = (ids: string[]) => ids.map((id) => escape(displayName(id))).join(", ");
    return `
      <div class="p-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-accent-green"></span>
            <span class="text-sm font-semibold text-slate-100">${pick("TEAM BUS 전체 status", "TEAM BUS overall status")}</span>
          </div>
          <button data-act="close" class="text-slate-500 hover:text-slate-300 text-sm">✕</button>
        </div>
        ${at ? `<div class="text-[10px] text-slate-600 mt-0.5">${pick(`${escape(at.slice(11, 19))} 기준`, `as of ${escape(at.slice(11, 19))}`)}</div>` : ""}
        <div class="mt-3 grid grid-cols-3 gap-2 text-center">
          <div class="rounded bg-surface-2 p-2"><div class="text-lg font-bold text-slate-100">${members.length}</div><div class="text-[10px] text-slate-500">${pick("등록 멤버", "Registered members")}</div></div>
          <div class="rounded bg-surface-2 p-2"><div class="text-lg font-bold text-slate-100">${reachable}</div><div class="text-[10px] text-slate-500">${pick("활성(응답가능)", "Active (reachable)")}</div></div>
          <div class="rounded bg-surface-2 p-2"><div class="text-lg font-bold text-cyan-400">${inflight}</div><div class="text-[10px] text-slate-500">${pick("전송중 합", "Sending total")}</div></div>
        </div>
        <div class="text-[11px] text-slate-400 mt-3 mb-1">${pick("delivery_state 전체 합", "delivery_state total")}</div>
        <div class="flex flex-wrap gap-1">${chips}</div>
        <div class="text-[11px] text-slate-400 mt-3">${pick(`처리 가능 pending 합: <b class="text-slate-200">${resolvable}건</b>`, `Resolvable pending total: <b class="text-slate-200">${resolvable}</b>`)}</div>
        ${stuckMembers.length
          ? `<div class="text-[11px] text-status-blocked mt-2">${pick(`⚠ 최근 멈춤: ${list(stuckMembers)}`, `⚠ Recently stuck: ${list(stuckMembers)}`)}</div>`
          : `<div class="text-[11px] text-accent-green mt-2">${pick("✓ 최근 멈춤 없음", "✓ No recent stuck")}</div>`}
        ${offlineMembers.length ? `<div class="text-[11px] text-status-blocked mt-1">${pick(`오프라인: ${list(offlineMembers)}`, `Offline: ${list(offlineMembers)}`)}</div>` : ""}
        <div class="text-[10px] text-slate-600 mt-3">${pick("멤버 노드를 클릭하면 개별 pending 관리로 전환됩니다.", "Click a member node to switch to individual pending management.")}</div>
      </div>`;
  }

  function panelHtml(): string {
    if (panel.busOpen) return busPanelHtml();
    if (!panel.agentId) {
      return `<div class="text-slate-500 text-sm p-4 text-center">${pick("멤버 노드 → pending 관리 패널 · BUS 노드 → 버스 전체 status", "Member node → pending management panel · BUS node → bus overall status")}</div>`;
    }
    const m = memberOf(panel.agentId);
    const agent = store.getState().agents.find((a) => a.id === panel.agentId);
    const name = agent?.display_name ?? panel.agentId;
    const st = nodeStatus(panel.agentId, m);
    const resolvable = m?.resolvable_pending ?? 0;
    const pending = resolvable;
    const residual = residualInflight(m);

    const breakdown = COUNT_ORDER
      .filter((k) => (m?.counts[k] ?? 0) > 0)
      .map((k) => {
        const sty = STATE_STYLE[k] ?? { label: k, color: "#94a3b8" };
        return `<span class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
          style="background:${sty.color}22;color:${sty.color}">${sty.label} ${m?.counts[k]}</span>`;
      }).join(" ") || `<span class="text-[10px] text-slate-600">${pick("메시지 없음", "No messages")}</span>`;

    const inflightNote = (m?.inflight?.count ?? 0) > 0
      ? `<div class="text-[11px] mt-1 ${st === "stuck" ? "text-status-blocked" : "text-slate-400"}">
           ${pick(`전송중 ${m?.inflight?.count}건 · 최고경과 ${fmtAge(m?.inflight?.oldest_age_sec ?? null)}`, `Sending ${m?.inflight?.count} · oldest ${fmtAge(m?.inflight?.oldest_age_sec ?? null)}`)}${
             st === "stuck" ? pick(" — ⚠ 최근 멈춤 의심", " — ⚠ suspected recent stuck")
             : residual > 0 ? pick(` — 그중 ${residual}건은 오래된 미완(historical, 정상 간주)`, ` — ${residual} of them are old unfinished (historical, treated as healthy)`)
             : ""}
         </div>` : "";

    // action area by phase
    let actionArea = "";
    if (panel.phase === "done" && panel.result) {
      const r = panel.result;
      actionArea = `
        <div class="mt-3 rounded-md bg-surface-2 border border-surface-3 p-3">
          <div class="text-sm font-semibold text-accent-green">${pick(`✓ ${r.applied_state} 처리 완료`, `✓ ${r.applied_state} processed`)}</div>
          <div class="text-[11px] text-slate-300 mt-1">${pick(`처리 ${r.affected_count}건 · 보호(30s미만) ${r.skipped_recent}건`, `Processed ${r.affected_count} · protected (<30s) ${r.skipped_recent}`)}${r.remaining > 0 ? pick(` · 남음 ${r.remaining}건`, ` · remaining ${r.remaining}`) : ""}</div>
          ${r.remaining > 0
            ? `<button data-act="more" class="mt-2 px-2.5 py-1 rounded bg-surface-3 hover:bg-surface-0 text-[11px] text-slate-200">${pick(`남은 ${r.remaining}건 한번 더`, `Once more for remaining ${r.remaining}`)}</button>`
            : ""}
          <button data-act="close" class="mt-2 ml-1 px-2.5 py-1 rounded text-[11px] text-slate-400 hover:bg-surface-3">${pick("닫기", "Close")}</button>
        </div>`;
    } else if (panel.phase === "preview" && panel.preview) {
      const p = panel.preview;
      const verb = panel.action === "expire" ? pick("만료(expire)", "Expire") : pick("완료(complete)", "Complete");
      actionArea = `
        <div class="mt-3 rounded-md bg-surface-2 border border-amber-500/40 p-3">
          <div class="text-sm font-semibold text-amber-400">${pick(`확인: ${name} → ${verb}`, `Confirm: ${name} → ${verb}`)}</div>
          <div class="text-[11px] text-slate-300 mt-1">${pick(`${p.affected_count}건이 <b>${panel.action === "expire" ? "expired" : "completed"}</b> 처리됩니다.`, `${p.affected_count} will be set to <b>${panel.action === "expire" ? "expired" : "completed"}</b>.`)}
            ${p.skipped_recent > 0 ? pick(`(30초 미만 ${p.skipped_recent}건은 보호되어 제외)`, `(${p.skipped_recent} under 30s protected & excluded)`) : ""}</div>
          <div class="text-[10px] text-slate-500 mt-0.5">${pick("전송중(dispatching/wake_dispatched)은 절대 건드리지 않습니다.", "Sending (dispatching/wake_dispatched) is never touched.")}</div>
          <div class="mt-2 flex gap-2">
            <button data-act="confirm" class="px-3 py-1 rounded bg-amber-500 hover:bg-amber-400 text-[11px] font-semibold text-slate-900" ${panel.busy ? "disabled" : ""}>${panel.busy ? pick("처리 중…", "Processing…") : pick(`확정 (${p.affected_count}건)`, `Apply (${p.affected_count})`)}</button>
            <button data-act="cancel" class="px-3 py-1 rounded text-[11px] text-slate-400 hover:bg-surface-3">${pick("취소", "Cancel")}</button>
          </div>
        </div>`;
    } else {
      const disabled = resolvable === 0 ? "disabled" : "";
      actionArea = `
        <div class="mt-3 flex flex-col gap-2">
          <div class="text-[11px] text-slate-400">${pick(`처리 가능(30초 지난 pending+deferred): <b class="text-slate-200">${resolvable}건</b>`, `Resolvable (pending+deferred >30s): <b class="text-slate-200">${resolvable}</b>`)}</div>
          <div class="flex gap-2">
            <button data-act="expire" class="px-3 py-1.5 rounded bg-surface-3 hover:bg-surface-0 text-[11px] font-semibold text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed" ${disabled}>${pick("만료 expire", "Expire")}</button>
            <button data-act="complete" class="px-3 py-1.5 rounded bg-surface-3 hover:bg-surface-0 text-[11px] font-semibold text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed" ${disabled}>${pick("완료 complete", "Complete")}</button>
          </div>
          ${resolvable === 0 ? `<div class="text-[10px] text-slate-600">${pick("처리 가능한 건이 없습니다 (방금 도착분은 30초간 보호).", "Nothing to resolve (just-arrived items are protected for 30s).")}</div>` : ""}
          ${panel.busy ? `<div class="text-[10px] text-slate-500">${pick("미리보기 중…", "Previewing…")}</div>` : ""}
        </div>`;
    }

    const errBox = panel.error
      ? `<div class="mt-2 text-[11px] text-status-blocked">⚠ ${escape(panel.error)}</div>` : "";

    return `
      <div class="p-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full" style="background:${STATUS_COLOR[st]}"></span>
            <span class="text-sm font-semibold text-slate-100">${escape(name)}</span>
            <span class="text-[10px] text-slate-500">${STATUS_LABEL[st]}</span>
          </div>
          <button data-act="close" class="text-slate-500 hover:text-slate-300 text-sm">✕</button>
        </div>
        <div class="mt-2 flex flex-wrap gap-1">${breakdown}</div>
        ${inflightNote}
        <div class="text-[11px] text-slate-400 mt-2">${pick(`대기 backlog ${pending}건`, `Waiting backlog ${pending}`)}</div>
        ${actionArea}
        ${errBox}
      </div>`;
  }

  function render() {
    const members = store.getState().busMembers;
    const agents = store.getState().agents;
    // node set = members from contract (zero-filled, all agents); fall back to store.agents before first load.
    const agentIds = members.length ? members.map((m) => m.agent_id) : agents.map((a) => a.id);
    const at = store.getState().busMembersAt;

    root.innerHTML = `
      <div class="flex-1 flex flex-col min-h-0">
        <div class="flex items-center justify-between px-4 py-2 border-b border-surface-3 shrink-0 bg-surface-1 gap-3 flex-wrap">
          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold">${pick("버스 토폴로지", "Bus topology")}</div>
            <span class="w-2 h-2 rounded-full bg-accent-green animate-pulse" title="live"></span>
            ${at ? `<span class="text-[10px] text-slate-600">${escape(at.slice(11, 19))}</span>` : ""}
          </div>
          <div class="flex items-center gap-2.5 flex-wrap">${legendHtml()}</div>
        </div>
        <div class="flex-1 overflow-y-auto flex flex-col lg:flex-row min-h-0">
          <div id="topo-svg" class="flex-1 flex items-center justify-center p-3 min-h-0">
            ${agentIds.length ? layeredSvg(members, agentIds) : `<div class="text-slate-500 py-16">${pick("팀원 데이터 로딩 중…", "Loading member data…")}</div>`}
          </div>
          ${(panel.busOpen || panel.agentId) ? `
          <div id="topo-panel" class="w-full lg:w-72 shrink-0 border-t lg:border-t-0 lg:border-l border-surface-3 overflow-y-auto">
            ${panelHtml()}
          </div>` : ""}
        </div>
      </div>`;

    // node click → open panel
    root.querySelectorAll<SVGGElement>(".topo-node").forEach((g) => {
      g.addEventListener("click", () => {
        const id = g.dataset.agent!;
        resetPanel(panel.agentId === id ? null : id); // toggle
        render();
      });
    });

    // BUS hub click → bus-wide status panel (toggle).
    const busEl = root.querySelector<SVGGElement>(".topo-bus");
    busEl?.addEventListener("click", () => {
      if (panel.busOpen) resetPanel(null); else openBus();
      render();
    });

    // panel actions
    root.querySelectorAll<HTMLButtonElement>("#topo-panel [data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.dataset.act!;
        if (act === "close") { resetPanel(null); render(); }
        else if (act === "expire") void startPreview("expire");
        else if (act === "complete") void startPreview("complete");
        else if (act === "cancel") { panel.phase = "idle"; panel.preview = null; panel.action = null; render(); }
        else if (act === "confirm") void applyAction();
        else if (act === "more") { panel.phase = "idle"; panel.preview = null; void startPreview(panel.result?.action ?? "expire"); }
      });
    });
  }

  // Re-render only when topology-relevant state changes. The store fires on every
  // log line / metric tick (~1/s); rebuilding the SVG each time would flicker and
  // interrupt panel interaction. Panel actions call render() directly, so they are
  // not gated here. (Same spirit as BusFlow's lastRef guard.)
  // Content signature: the 3s poll sets a new busMembers array + new busMembersAt timestamp
  // each time. A ref check re-rendered every 3s → SVG rebuild + scroll jump even when nothing
  // changed. Sign only the visible member data (counts/inflight/resolvable) + roster, EXCLUDING
  // the generated_at timestamp, so identical data skips the rebuild. (Bill UI fix 2026-05-31)
  const memberSig = (): string => {
    const s = store.getState();
    const m = s.busMembers
      .map((x) => `${x.agent_id}:${x.resolvable_pending}:${x.inflight.count}:${x.inflight.oldest_age_sec}:${Object.values(x.counts).join(",")}`)
      .join("|");
    const a = s.agents.map((x) => x.id).join(",");
    return `${m}#${a}`;
  };
  let lastSig = memberSig();
  render();
  store.subscribe(() => {
    const sig = memberSig();
    if (sig === lastSig) return;
    lastSig = sig;
    render();
  });
}

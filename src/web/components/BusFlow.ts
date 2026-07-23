// BusFlow — real-time view of team bus message flow.
// Shows recent messages (who → whom), their source, and where each recipient
// sits in the delivery state machine. Driven by store.busFlow, which ws.ts
// refreshes on new-message WS events and main.ts polls every few seconds while
// this view is open.

import { store, type BusFlowMessage, type BusFlowRecipient } from "../store";
import { pick } from "../i18n";
import { parseSqliteDate } from "../lib/datetime";

function hhmmss(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// delivery_state → label + color. Colors are inline so the component is
// self-contained and doesn't depend on Tailwind token names being present.
const STATE_STYLE = (): Record<string, { label: string; color: string }> => ({
  pending: { label: pick("대기", "Pending"), color: "#94a3b8" },
  dispatching: { label: pick("전송중", "Sending"), color: "#3b82f6" },
  wake_dispatched: { label: pick("깨움", "Wake"), color: "#06b6d4" },
  agent_ack: { label: pick("확인", "Confirm"), color: "#2dd4bf" },
  completed: { label: pick("완료", "Done"), color: "#22c55e" },
  deferred: { label: pick("보류", "Deferred"), color: "#f59e0b" },
  blocked: { label: pick("차단", "Blocked"), color: "#ef4444" },
  dead_letter: { label: pick("실패", "Failed"), color: "#dc2626" },
  failed: { label: pick("실패", "Failed"), color: "#ef4444" },
  expired: { label: pick("만료", "Expired"), color: "#64748b" },
});

function stateStyle(s: string): { label: string; color: string } {
  return STATE_STYLE()[s] ?? { label: s, color: "#94a3b8" };
}

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  user: { label: "USER", cls: "text-status-info" },
  agent: { label: "AGENT", cls: "text-accent-greenSoft" },
  system: { label: "SYS", cls: "text-slate-500" },
};

function chip(r: BusFlowRecipient): string {
  const { label, color } = stateStyle(r.delivery_state);
  const title = r.last_error ? ` title="${escape(r.last_error)}"` : "";
  // 상태색은 배경 틴트 + 보더에만(라이트/다크 양쪽서 유지). 글자색은 theme text라 작은 라벨도 대비 확보.
  return `<span class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[12px] font-medium text-slate-100"
    style="background:${color}28;border:1px solid ${color}55"${title}>
    <span class="font-bold">${escape(r.agent_id)}</span>
    <span class="text-slate-300">${label}</span>
  </span>`;
}

function legend(): string {
  const order = ["pending", "dispatching", "wake_dispatched", "agent_ack", "completed", "deferred", "blocked", "expired"];
  return order
    .map((s) => {
      const { label, color } = stateStyle(s);
      return `<span class="inline-flex items-center gap-1.5 text-[12px] text-slate-400">
        <span class="w-2.5 h-2.5 rounded-full" style="background:${color}"></span>${label}</span>`;
    })
    .join("");
}

function renderInto(root: HTMLElement, msgs: BusFlowMessage[]): void {
  const rows = msgs
    .map((m) => {
      const ts = parseSqliteDate(m.created_at);
      const tlabel = ts ? hhmmss(ts) : "—";
      const src = SOURCE_BADGE[m.source] ?? { label: "SYS", cls: "text-slate-500" };
      const to = m.to_agent_id === "broadcast" ? "📢 broadcast" : m.to_agent_id;
      const prio = m.priority === "high" ? `<span class="text-[11px] text-status-blocked font-semibold">HIGH</span>` : "";
      const chips = m.recipients.length
        ? m.recipients.map(chip).join(" ")
        : `<span class="text-[12px] text-slate-500">${pick("수신자 없음", "No recipients")}</span>`;
      return `
        <div class="px-6 py-3 border-b border-surface-3/70 hover:bg-surface-2 transition-colors">
          <div class="flex items-baseline gap-2.5 mb-1.5 flex-wrap">
            <span class="text-[13px] font-mono font-bold text-slate-200 w-[4.5rem] shrink-0 tabular-nums">${tlabel}</span>
            <span class="text-[12px] font-semibold ${src.cls}">${src.label}</span>
            <span class="text-[14px] text-slate-100 font-semibold">${escape(m.from_agent_id)}</span>
            <span class="text-slate-500">→</span>
            <span class="text-[14px] text-slate-100 font-semibold">${escape(to)}</span>
            <span class="text-[12px] text-slate-500">thread ${escape(m.thread_id.slice(0, 6))}</span>
            ${prio}
          </div>
          <div class="text-[15px] leading-relaxed text-slate-200 whitespace-pre-wrap break-words mb-2 pl-[4.5rem]">${escape(m.body)}</div>
          <div class="flex flex-wrap gap-1.5 pl-[4.5rem]">${chips}</div>
        </div>`;
    })
    .join("");

  const newest = msgs[0] ? parseSqliteDate(msgs[0].created_at) : null;
  root.innerHTML = `
    <div class="flex-1 flex flex-col min-h-0">
      <div class="px-6 pt-6 pb-3 border-b border-surface-3 shrink-0 flex items-end justify-between gap-3 flex-wrap">
        <div class="flex items-baseline gap-3 flex-wrap">
          <h1 class="text-[22px] font-bold tracking-tight text-slate-100">Bus</h1>
          <span class="inline-flex items-center gap-1.5 text-[13px] text-slate-500">
            ${pick("실시간 팀 메시지 흐름", "Real-time team message flow")}
            <span class="w-2 h-2 rounded-full bg-accent-green animate-pulse" title="${pick("이 탭을 보는 동안만 3초마다 갱신", "Refreshes every 3s only while this tab is open")}"></span>
            ${newest ? `<span title="${pick("가장 최근 버스 메시지 시각", "Time of the most recent bus message")}">· ${pick("최신", "Latest")} ${hhmmss(newest)}</span>` : ""}
          </span>
        </div>
        <div class="flex items-center gap-2.5 flex-wrap">${legend()}</div>
      </div>
      <div class="flex-1 overflow-y-auto" id="bus-flow-body"></div>
    </div>`;
  const body = root.querySelector<HTMLElement>("#bus-flow-body");
  if (body) {
    body.innerHTML = msgs.length
      ? rows
      : `<div class="flex-1 flex items-center justify-center text-slate-500 py-16">${pick("아직 버스 메시지 없음 — 메시지가 오가면 여기에 실시간으로 표시됩니다", "No bus messages yet — they'll appear here in real time as messages flow")}</div>`;
  }
}

export function renderBusFlow(root: HTMLElement): void {
  let lastSig: string | null = null;
  // Content signature: re-render only when messages/states actually change. The 3s poll
  // sets a NEW array each time (new ref), so a ref check always fired and rebuilt innerHTML
  // → scroll jumped to top every 3s. Skipping identical content stops the jump at the source.
  const sig = (msgs: BusFlowMessage[]) =>
    msgs.map((m) => `${m.id}:${m.recipients.map((r) => r.agent_id + r.delivery_state).join(",")}`).join("|");
  const sync = () => {
    const cur = store.getState().busFlow;
    const s = sig(cur);
    if (s === lastSig) return;
    lastSig = s;
    // Preserve scroll across the rebuild (in case content did change while scrolled down).
    const prevBody = root.querySelector<HTMLElement>("#bus-flow-body");
    const prevScroll = prevBody ? prevBody.scrollTop : 0;
    renderInto(root, cur);
    const newBody = root.querySelector<HTMLElement>("#bus-flow-body");
    if (newBody) newBody.scrollTop = prevScroll;
  };
  sync();
  store.subscribe(sync);
}

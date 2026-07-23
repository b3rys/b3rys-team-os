// AgentActivity — flat time-ordered feed of all messages involving the selected agent (in OR out).
// Replaces the old per-thread ThreadView when "Activity" tab is selected.
// Per-agent context: switching agents in the sidebar updates this view to that agent's activity.

import { store, type Agent, type Message } from "../store";
import { apiBase } from "./../ws";
import { pick } from "../i18n";
import { parseSqliteDate } from "../lib/datetime";

function hhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SOURCE_BORDER: Record<string, string> = {
  agent: "border-l-status-idle",
  user: "border-l-status-info",
  system: "border-l-status-offline",
};

async function fetchActivity(agentId: string): Promise<Message[]> {
  try {
    const res = await fetch(`${apiBase()}/api/agents/${agentId}/activity?limit=100`);
    if (!res.ok) return [];
    const body = (await res.json()) as { messages: Message[] };
    return body.messages;
  } catch {
    return [];
  }
}

export function renderAgentActivity(root: HTMLElement): void {
  let lastAgentId: string | null = null;
  let cachedMessages: Message[] = [];
  let isLoading = false;

  const render = async (force = false) => {
    const { selectedAgentId, agents, threadMessages } = store.getState();
    if (!selectedAgentId) {
      root.innerHTML = `<div class="flex-1 flex items-center justify-center text-slate-500">${pick("좌측에서 agent 선택", "Select an agent on the left")}</div>`;
      lastAgentId = null;
      return;
    }
    const agent = agents.find((a) => a.id === selectedAgentId);
    if (!agent) return;

    const needRefetch = force || lastAgentId !== selectedAgentId;
    if (needRefetch && !isLoading) {
      isLoading = true;
      try {
        cachedMessages = await fetchActivity(selectedAgentId);
      } finally {
        isLoading = false;
      }
      lastAgentId = selectedAgentId;
    }

    // Merge in any newer messages that arrived via WS (in threadMessages) involving this agent.
    const wsMsgs: Message[] = [];
    for (const [, msgs] of threadMessages) {
      for (const m of msgs) {
        if (m.from_agent_id === selectedAgentId || m.to_agent_id === selectedAgentId) {
          wsMsgs.push(m);
        }
      }
    }
    const byId = new Map<string, Message>();
    for (const m of cachedMessages) byId.set(m.id, m);
    for (const m of wsMsgs) byId.set(m.id, m);
    const merged = Array.from(byId.values()).sort(
      (a, b) => (parseSqliteDate(b.created_at)?.getTime() ?? 0) - (parseSqliteDate(a.created_at)?.getTime() ?? 0),
    );

    renderInto(root, agent, merged, selectedAgentId);
  };

  // Initial render + subscribe.
  void render(true);
  let lastObservedAgent: string | null = null;
  store.subscribe(() => {
    const cur = store.getState().selectedAgentId;
    if (cur !== lastObservedAgent) {
      lastObservedAgent = cur;
      void render(true);
    } else {
      // Non-agent state change (e.g., new WS message) — re-render without refetch.
      void render(false);
    }
  });
}

function renderInto(root: HTMLElement, agent: Agent, msgs: Message[], myId: string) {
  if (msgs.length === 0) {
    root.innerHTML = `
      <div class="flex-1 flex flex-col min-h-0">
        <div class="h-10 flex items-center justify-between px-4 border-b border-surface-3 shrink-0 bg-surface-1">
          <div class="text-sm font-semibold">${escape(agent.display_name)} · Activity</div>
          <div class="text-xs text-slate-500">0 messages</div>
        </div>
        <div class="flex-1 flex items-center justify-center text-slate-500">
          ${pick("아직 활동 없음 — 메시지를 보내거나 받으면 여기 시간순으로 표시됨", "No activity yet — messages you send or receive will appear here in chronological order")}
        </div>
      </div>`;
    return;
  }

  const items = msgs
    .map((m: Message) => {
      const borderClass = SOURCE_BORDER[m.source] ?? "border-l-status-offline";
      const ts = parseSqliteDate(m.created_at);
      const tlabel = ts ? hhmm(ts) : "—";
      const dir = m.from_agent_id === myId ? "out" : "in";
      const arrow = dir === "out" ? "→" : "←";
      const counterpart = dir === "out" ? m.to_agent_id : m.from_agent_id;
      const dirBadge =
        dir === "out"
          ? `<span class="text-[10px] text-accent-greenSoft">OUT</span>`
          : `<span class="text-[10px] text-status-info">IN</span>`;
      const hopBadge =
        m.hop_count >= 3 ? `<span class="text-[10px] text-status-idle">↻${m.hop_count}</span>` : "";
      const expiredBadge =
        m.delivery_status === "expired"
          ? `<span class="text-[10px] text-status-blocked">${pick("만료", "Expired")}</span>`
          : "";
      return `
        <div class="flex gap-3 border-l-4 ${borderClass} pl-3 py-2 hover:bg-surface-2 transition-colors">
          <div class="text-[10px] text-slate-500 mt-1 w-12 shrink-0 font-mono">${tlabel}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-2 mb-0.5 flex-wrap">
              ${dirBadge}
              <span class="text-xs text-slate-400">${arrow} ${escape(counterpart)}</span>
              <span class="text-[10px] text-slate-600">thread ${m.thread_id.slice(0, 6)}</span>
              ${hopBadge}${expiredBadge}
            </div>
            <div class="text-sm text-slate-200 whitespace-pre-wrap break-words">${escape(m.body)}</div>
          </div>
        </div>`;
    })
    .join("");

  root.innerHTML = `
    <div class="flex-1 flex flex-col min-h-0">
      <div class="h-10 flex items-center justify-between px-4 border-b border-surface-3 shrink-0 bg-surface-1">
        <div class="text-sm font-semibold">${escape(agent.display_name)} · Activity</div>
        <div class="text-xs text-slate-500">${msgs.length} messages (newest first)</div>
      </div>
      <div class="flex-1 overflow-y-auto" id="agent-activity-body"></div>
    </div>`;
  // 메시지 전송 입력창은 제거(GD 2026-07-23) — Thread 뷰는 활동 열람 전용.
  const body = root.querySelector<HTMLElement>("#agent-activity-body");
  if (body) body.innerHTML = items;
}

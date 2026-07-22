import {
  store,
  type Agent,
  type Status,
  type MetricRow,
  type Message,
  type Thread,
  type AgentStats,
  type AlertEvent,
  type ClaudePoolUsage,
  type AgentHealth,
  type BusFlowMessage,
  type TeamOsSnapshot,
  type BusMember,
  type ResolveResult,
} from "./store";

type Hello = { type: "hello"; agents: Agent[]; statuses: Status[] };
type AgentStatusMsg = { type: "agent_status"; agent_id: string; status: Status };
type LogLineMsg = { type: "log_line"; agent_id: string; line: string; captured_at: string };
type MetricMsg = { type: "metric"; metric: MetricRow };
type MessageMsg = { type: "message"; message: Message };
type MessageReadMsg = { type: "message_read"; message_id: string };
type WsMsg = Hello | AgentStatusMsg | LogLineMsg | MetricMsg | MessageMsg | MessageReadMsg;

const BASE_PATH = (import.meta.env.BASE_URL ?? "/team/").replace(/\/$/, "");

export function apiBase(): string {
  return BASE_PATH;
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${BASE_PATH}/ws`;
}

export function connectWs(): void {
  let attempt = 0;
  let ws: WebSocket | null = null;

  const connect = () => {
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      console.error("[ws] connect failed", e);
      schedule();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      store.getState().setConnected(true);
    };
    ws.onclose = () => {
      store.getState().setConnected(false);
      schedule();
    };
    ws.onerror = () => {
      ws?.close();
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as WsMsg;
        handle(msg);
      } catch (e) {
        console.error("[ws] parse error", e);
      }
    };
  };

  const schedule = () => {
    const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
    attempt++;
    setTimeout(connect, delay);
  };

  connect();
}

function handle(msg: WsMsg) {
  const s = store.getState();
  switch (msg.type) {
    case "hello":
      // hello 는 매 WS 연결(최초·재연결 모두)마다 서버가 push(index.ts onOpen) → 재연결 시 전체 상태 re-sync 되어
      //   다운타임/끊김 후 자동 최신화된다(IMPROVE7 리포트는 "재연결 re-sync 없음"이라 했으나, onopen 자체는 아니어도
      //   server-push hello 로 이미 커버됨을 코드검증으로 확인 — OWNER 2026-07-03). hello 에 빠져 있던 metric 만 보완.
      s.setAgents(msg.agents);
      s.setStatuses(msg.statuses);
      void loadThreads();
      void loadAllAgentStats();
      void loadAlerts();
      void loadClaudeUsage();
      void loadAgentHealth();
      void loadInitialMetric();
      break;
    case "agent_status":
      s.upsertStatus(msg.status);
      void loadAgentHealth();
      break;
    case "log_line":
      s.appendLog(msg.agent_id, msg.line, msg.captured_at);
      break;
    case "metric":
      s.setMetric(msg.metric);
      break;
    case "message":
      s.appendThreadMessage(msg.message.thread_id, msg.message);
      // If this is the first message of a new thread, refresh thread list
      if (!s.threads.find((t) => t.id === msg.message.thread_id)) {
        void loadThreads();
      }
      // Refresh stats for the involved agents (debounced via scheduleStatsRefresh).
      scheduleStatsRefresh(msg.message.from_agent_id);
      scheduleStatsRefresh(msg.message.to_agent_id);
      // If the bus flow view is open, pull the fresh snapshot so a new message
      // appears immediately (delivery-state transitions are caught by the poll).
      if (s.mainView === "busflow") void loadBusFlow();
      break;
    case "message_read":
      s.markMessageRead(msg.message_id);
      break;
  }
}

export async function loadInitialLog(agentId: string): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/agents/${agentId}/log?limit=200`);
    if (!res.ok) return;
    const body = (await res.json()) as { lines: { line: string; captured_at: string }[] };
    store.getState().setInitialLog(agentId, body.lines);
  } catch (e) {
    console.error("[loadInitialLog]", e);
  }
}

export async function loadInitialMetric(): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/metrics?limit=1`);
    if (!res.ok) return;
    const body = (await res.json()) as { latest: MetricRow | null };
    if (body.latest) store.getState().setMetric(body.latest);
  } catch (e) {
    console.error("[loadInitialMetric]", e);
  }
}

export async function loadThreads(): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/threads?limit=50`);
    if (!res.ok) return;
    const body = (await res.json()) as { threads: Thread[] };
    store.getState().setThreads(body.threads);
  } catch (e) {
    console.error("[loadThreads]", e);
  }
}

export async function loadThread(threadId: string): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/threads/${threadId}`);
    if (!res.ok) return;
    const body = (await res.json()) as { thread: Thread; messages: Message[] };
    store.getState().setThreadMessages(threadId, body.messages);
  } catch (e) {
    console.error("[loadThread]", e);
  }
}

// Debounce per-agent stats refresh to avoid hammering the API when many messages arrive.
const statsRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleStatsRefresh(agentId: string): void {
  // Skip non-agent ids (user/system/moderator/broadcast).
  if (!store.getState().agents.find((a) => a.id === agentId)) return;
  const existing = statsRefreshTimers.get(agentId);
  if (existing) clearTimeout(existing);
  statsRefreshTimers.set(
    agentId,
    setTimeout(() => {
      statsRefreshTimers.delete(agentId);
      void loadAgentStats(agentId);
    }, 2000),
  );
}

export async function loadAgentStats(agentId: string): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/agents/${agentId}/stats`);
    if (!res.ok) return;
    const body = (await res.json()) as AgentStats;
    store.getState().setAgentStats(body);
  } catch (e) {
    console.error("[loadAgentStats]", agentId, e);
  }
}

export async function loadAllAgentStats(): Promise<void> {
  const ids = store.getState().agents.map((a) => a.id);
  await Promise.all(ids.map(loadAgentStats));
}

export async function loadAlerts(hours = 6, limit = 20): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/alerts?hours=${hours}&limit=${limit}`);
    if (!res.ok) return;
    const body = (await res.json()) as { alerts: AlertEvent[] };
    store.getState().setAlerts(body.alerts);
  } catch (e) {
    console.error("[loadAlerts]", e);
  }
}

export async function loadClaudeUsage(): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/usage/claude`);
    if (!res.ok) return;
    const body = (await res.json()) as ClaudePoolUsage;
    store.getState().setClaudeUsage(body);
  } catch (e) {
    console.error("[loadClaudeUsage]", e);
  }
}

export async function loadBusFlow(limit = 40): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/bus/flow?limit=${limit}`);
    if (!res.ok) return;
    const body = (await res.json()) as { messages: BusFlowMessage[] };
    store.getState().setBusFlow(body.messages);
  } catch (e) {
    console.error("[loadBusFlow]", e);
  }
}

export async function loadTeamOs(): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/teamos`);
    if (!res.ok) return;
    const body = (await res.json()) as TeamOsSnapshot;
    store.getState().setTeamOs(body);
  } catch (e) {
    console.error("[loadTeamOs]", e);
  }
}

// Bus topology — per-member delivery_state aggregation (read-only). Contract: busviz-v1.
export async function loadBusMembers(): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/bus/members`);
    if (!res.ok) return;
    const body = (await res.json()) as { generated_at: string; members: BusMember[] };
    store.getState().setBusMembers(body.members ?? [], body.generated_at ?? null);
  } catch (e) {
    console.error("[loadBusMembers]", e);
  }
}

// Guarded pending action. dry_run=true previews affected_count without writing.
// Backend only touches pending/deferred older than 30s; dispatching/wake_dispatched are never
// touched (race-safe with the dispatcher's claim). Returns the affected set for audit/refresh.
export async function resolveMemberPending(
  agentId: string,
  action: "expire" | "complete",
  dryRun: boolean,
): Promise<ResolveResult | null> {
  try {
    const res = await fetch(`${BASE_PATH}/api/bus/members/${encodeURIComponent(agentId)}/pending/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, dry_run: dryRun }),
    });
    const body = (await res.json()) as ResolveResult;
    if (!res.ok || !body.ok) {
      console.error("[resolveMemberPending]", res.status, body?.error);
      return body?.ok === false ? body : null;
    }
    return body;
  } catch (e) {
    console.error("[resolveMemberPending]", e);
    return null;
  }
}

export async function loadAgentHealth(): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/health/agents`);
    if (!res.ok) return;
    const body = (await res.json()) as { agents: AgentHealth[] };
    store.getState().setAgentHealth(body.agents);
  } catch (e) {
    console.error("[loadAgentHealth]", e);
  }
}

export async function sendMessage(payload: {
  from_agent_id: string;
  to_agent_id: string;
  body: string;
  thread_id?: string;
  source?: "user" | "agent" | "system";
  type?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${BASE_PATH}/api/inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "user", type: "dm", ...payload }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      return { ok: false, error: err.error ?? `http_${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

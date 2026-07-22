import { createStore } from "zustand/vanilla";

export type AgentRuntime = "claude_channel" | "openclaw" | "hermes_agent" | "b3os_native" | "codex";
export type AgentState = "running" | "idle" | "blocked" | "offline";

export interface Agent {
  id: string;
  display_name: string;
  role: string;
  response_mode?: "mention-only" | "default-intake" | "proactive" | null;
  default_intake_scope?: "none" | "general_pm" | "infra_ops" | "custom" | null;
  default_intake_description?: string | null;
  runtime: AgentRuntime;
  status_provider: "claude_tmux" | "openclaw_gateway" | "hermes_gateway" | "b3os_native_runner" | "codex_cli";
  tmux_session: string | null;
  telegram_bot_username: string | null;
  workspace_path: string;
  persona_file: string;
  moderator_eligible: boolean;
  avatar_emoji: string;
  icon?: string | null;
  icon_color?: string | null; // 아이콘 색 키 (green/orange/yellow/blue/red/violet)
  nicknames?: string[] | null; // @로 부를 추가 멘션 별칭(id·display_name 외). 라우터 owner 매칭에 사용.
  off?: boolean; // /onoff 로 의도적 정지 — '🔴 중지' 표시(WS hello 에 실림)
  hermes_profile?: string | null;
  hermes_alias?: string | null;
  gateway_service?: string | null;
}

export interface Status {
  agent_id: string;
  state: AgentState;
  last_activity_at: string | null;
  last_log_line: string | null;
  tmux_pid: number | null;
  ctx_percent: number | null;
  probed_at: string;
}

export interface MetricRow {
  id: number;
  cpu_percent: number | null;
  mem_used_mb: number | null;
  load_1min: number | null;
  ollama_running: number;
  probed_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: string;
  body: string;
  source: "agent" | "user" | "system";
  hop_count: number;
  in_reply_to: string | null;
  read_at: string | null;
  delivery_status: "pending" | "delivered" | "failed" | "expired";
  retry_count: number;
  expires_at: string | null;
  priority: "low" | "normal" | "high";
  dedupe_key: string | null;
  created_at: string;
}

export interface BusFlowRecipient {
  agent_id: string;
  delivery_state: string;
  recipient_state?: string; // SLG A semantic closure — Inbox screen renders this
  close_reason?: string | null;
  last_error: string | null;
  updated_at: string | null;
}

export interface BusFlowMessage {
  id: string;
  thread_id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: string;
  source: "agent" | "user" | "system";
  priority: "low" | "normal" | "high";
  body: string;
  created_at: string;
  recipients: BusFlowRecipient[];
}

// Bus topology view — per-member delivery_state aggregation.
// Shape locked by Steve's backend contract (GET /api/bus/members), busviz-v1.
// counts keys are identical to BusFlow STATE_STYLE keys so colors are reused.
export interface BusMemberCounts {
  pending: number;
  dispatching: number;
  wake_dispatched: number;
  agent_ack: number;
  completed: number;
  deferred: number;
  blocked: number;
  dead_letter: number;
  expired: number;
  failed: number;
}

export interface BusMember {
  agent_id: string;
  counts: BusMemberCounts;
  // pending+deferred older than the 30s just-arrived guard = what resolve will actually touch.
  resolvable_pending: number;
  // dispatching+wake_dispatched. oldest_age_sec lets the front decide stuck/zombie (Gemini #3).
  inflight: { count: number; oldest_age_sec: number | null };
  off?: boolean; // /onoff 로 의도적 정지 — '🔴 중지' 표시
}

// POST /api/bus/members/:agentId/pending/resolve response.
export interface ResolveResult {
  ok: boolean;
  agent_id: string;
  action: "expire" | "complete";
  applied_state: "expired" | "completed";
  affected_count: number;
  affected_message_ids: string[];
  skipped_recent: number; // protected (<30s) — just-arrived nuke guard
  remaining: number; // left after batch LIMIT; >0 means call again
  error?: string;
}

export interface Thread {
  id: string;
  title: string;
  kind: "dm" | "meeting" | "broadcast";
  participants: string[];
  moderator_agent_id: string | null;
  status: "open" | "paused" | "closed" | "failed";
  state: string;
  round_no: number;
  last_message_at: string | null;
  opened_by: string;
  opened_at: string;
  closed_at: string | null;
  summary: string | null;
}

export interface AgentStats {
  agent_id: string;
  out_24h: number;
  in_24h: number;
  out_7d: number;
  in_7d: number;
  last_out_at: string | null;
  last_in_at: string | null;
  avg_reply_ms_24h: number | null;
  reply_samples_24h: number;
}

export interface AlertEvent {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
  at: string;
}

export interface AgentUsage {
  agent_id: string;
  requests_5h: number;
  requests_7d: number;
  tokens_5h: number;
  tokens_7d: number;
  last_activity_at: string | null;
}

export interface ClaudePoolUsage {
  generated_at: string;
  ceiling_5h: number;
  total_requests_5h: number;
  total_tokens_5h: number;
  total_requests_7d: number;
  total_tokens_7d: number;
  pct_5h_estimate: number;
  agents: AgentUsage[];
}

export type HealthLevel = "ok" | "warn" | "danger";

export interface AgentHealth {
  agentId: string;
  level: HealthLevel;
  livenessLevel?: HealthLevel;
  capacityLevel?: HealthLevel;
  capacityStatus?: "ok" | "limit" | "usage_credits";
  capacityLabel?: string | null;
  reasons: string[];
  ctxPercent: number | null;
  state: string;
}

export interface TeamOsScript {
  name: string;
  desc: string;
}

export interface TeamOsScheduled {
  label: string;
  kind: "service" | "scheduled" | "on-demand";
  detail: string;
  description: string;
  source: "launchd" | "openclaw_cron" | "scheduled_job";
  running: boolean | null;
  enabled: boolean;
}

export interface TeamOsTask {
  state: "in_progress" | "pending";
  text: string;
}

export interface TeamOsOpenClawTelegramIngress {
  generated_at: string;
  as_of: string;
  account: string;
  bot_username: string;
  state: string;
  last_state_at: string;
  last_inbound_at: string;
  last_inbound_age_sec: number;
  restart_count: number;
  backlog_latency_sec: number;
  stale_threshold_sec: number;
  cooldown_sec: number;
  auto_recover_enabled: number;
  detected: boolean;
  reason: string;
  source_log: string;
}

export interface TeamOsSnapshot {
  generated_at: string;
  scripts: TeamOsScript[];
  scheduled: TeamOsScheduled[];
  tasks: TeamOsTask[];
  tasks_pending_total: number;
  openclaw_telegram_ingress: TeamOsOpenClawTelegramIngress | null;
}

export type MainView = "log" | "thread" | "config" | "chat" | "doc" | "busflow" | "teamos" | "topology" | "tasks" | "jobs" | "monitoring" | "search" | "reports" | "settings" | "inbox" | "audit" | "proposals";
export type MobilePane = "agents" | "main" | "threads";
export type DocSection = "policy" | "architecture" | "routing" | "learning" | "qa" | "search";

export interface AppState {
  connected: boolean;
  agents: Agent[];
  agentsLoaded: boolean; // 첫 setAgents 호출 전까지 false — 부팅 시 빈 배열을 '빈 팀'으로 오인하지 않게(온보딩 flash 방지)
  statuses: Map<string, Status>;
  logsByAgent: Map<string, { line: string; captured_at: string }[]>;
  metric: MetricRow | null;
  selectedAgentId: string | null;

  // Phase 2a
  mainView: MainView;
  docSection: DocSection;
  threads: Thread[];
  selectedThreadId: string | null;
  threadMessages: Map<string, Message[]>;
  mobilePane: MobilePane;

  // Phase 2c — dashboard cleanup
  agentStats: Map<string, AgentStats>;
  alerts: AlertEvent[];
  claudeUsage: ClaudePoolUsage | null;
  agentHealth: Map<string, AgentHealth>;
  agentHealthLoaded: boolean;

  // Bus flow view — recent messages + per-recipient delivery state
  busFlow: BusFlowMessage[];

  // Team OS view — scripts, scheduled tasks, in-flight TODO
  teamOs: TeamOsSnapshot | null;

  // Bus topology view — per-member delivery_state aggregation
  busMembers: BusMember[];
  busMembersAt: string | null;

  setConnected(v: boolean): void;
  setAgents(agents: Agent[]): void;
  reorderAgents(activeId: string, overId: string): void;
  setAgentOrder(ids: string[]): void;
  setStatuses(statuses: Status[]): void;
  upsertStatus(s: Status): void;
  appendLog(agent_id: string, line: string, captured_at: string): void;
  setInitialLog(agent_id: string, lines: { line: string; captured_at: string }[]): void;
  setMetric(m: MetricRow): void;
  selectAgent(id: string | null): void;

  setAgentStats(s: AgentStats): void;
  setAlerts(a: AlertEvent[]): void;
  setClaudeUsage(u: ClaudePoolUsage): void;
  setAgentHealth(v: AgentHealth[]): void;
  setBusFlow(m: BusFlowMessage[]): void;
  setTeamOs(s: TeamOsSnapshot): void;
  setBusMembers(m: BusMember[], generatedAt: string | null): void;

  // Phase 2a
  setMainView(v: MainView): void;
  setDocSection(v: DocSection): void;
  setThreads(threads: Thread[]): void;
  selectThread(id: string | null): void;
  setThreadMessages(thread_id: string, messages: Message[]): void;
  appendThreadMessage(thread_id: string, message: Message): void;
  markMessageRead(message_id: string): void;
  setMobilePane(p: MobilePane): void;
}

export const store = createStore<AppState>((set) => ({
  connected: false,
  agents: [],
  agentsLoaded: false,
  statuses: new Map(),
  logsByAgent: new Map(),
  metric: null,
  selectedAgentId: null,

  mainView: "tasks", // landing = team Tasks kanban (OWNER: 첫화면에 진행 중 과제가 보이게)
  docSection: "policy",
  threads: [],
  selectedThreadId: null,
  threadMessages: new Map(),
  mobilePane: "agents",

  agentStats: new Map(),
  alerts: [],
  claudeUsage: null,
  agentHealth: new Map(),
  agentHealthLoaded: false,
  busFlow: [],
  teamOs: null,
  busMembers: [],
  busMembersAt: null,

  setConnected(v) {
    set({ connected: v });
  },
  setAgents(agents) {
    set({ agents: applySavedAgentOrder(agents), agentsLoaded: true });
    set((s) => {
      if (s.selectedAgentId) return s;
      const first = s.agents[0];
      return first ? { selectedAgentId: first.id } : s;
    });
  },
  reorderAgents(activeId, overId) {
    if (activeId === overId) return;
    set((state) => {
      const from = state.agents.findIndex((a) => a.id === activeId);
      const to = state.agents.findIndex((a) => a.id === overId);
      if (from < 0 || to < 0) return state;
      const next = [...state.agents];
      const [moved] = next.splice(from, 1);
      if (!moved) return state;
      next.splice(to, 0, moved);
      saveAgentOrder(next.map((a) => a.id));
      return { agents: next };
    });
  },
  setAgentOrder(ids) {
    set((state) => {
      const currentIds = state.agents.map((a) => a.id);
      const known = ids.filter((id) => currentIds.includes(id));
      const missing = state.agents.filter((a) => !known.includes(a.id)).map((a) => a.id);
      const nextIds = [...known, ...missing];
      if (nextIds.length !== currentIds.length || nextIds.every((id, index) => id === currentIds[index])) return state;
      const byId = new Map(state.agents.map((a) => [a.id, a]));
      const next = nextIds.map((id) => byId.get(id)).filter((a): a is Agent => Boolean(a));
      saveAgentOrder(next.map((a) => a.id));
      return { agents: next };
    });
  },
  setStatuses(arr) {
    const m = new Map<string, Status>();
    for (const s of arr) m.set(s.agent_id, s);
    set({ statuses: m });
  },
  upsertStatus(s) {
    set((state) => {
      const next = new Map(state.statuses);
      next.set(s.agent_id, s);
      return { statuses: next };
    });
  },
  appendLog(agent_id, line, captured_at) {
    set((state) => {
      const next = new Map(state.logsByAgent);
      const existing = next.get(agent_id) ?? [];
      const updated = [...existing, { line, captured_at }];
      if (updated.length > 500) updated.splice(0, updated.length - 500);
      next.set(agent_id, updated);
      return { logsByAgent: next };
    });
  },
  setInitialLog(agent_id, lines) {
    set((state) => {
      const next = new Map(state.logsByAgent);
      next.set(agent_id, lines);
      return { logsByAgent: next };
    });
  },
  setMetric(m) {
    set({ metric: m });
  },
  selectAgent(id) {
    // Keep the currently-selected per-agent tab (Live/Thread/Settings) when switching members —
    // switching from Settings to another member used to snap back to Live. (OWNER 2026-05-31)
    // If we're on a global view (doc/bus/teamos/topology, not agent-specific), default to Live.
    set((state) => {
      const perAgentTab =
        state.mainView === "log" || state.mainView === "thread" || state.mainView === "config" || state.mainView === "chat";
      return {
        selectedAgentId: id,
        mainView: perAgentTab ? state.mainView : "log",
        mobilePane: "main",
      };
    });
  },

  setMainView(v) {
    set({ mainView: v });
  },
  setDocSection(v) {
    set({ docSection: v, mainView: "doc", mobilePane: "main" });
  },
  setThreads(threads) {
    set({ threads });
  },
  selectThread(id) {
    // The "thread" main view renders AgentActivity, which is keyed by selectedAgentId.
    // Selecting a thread must therefore also switch selectedAgentId to that thread's member,
    // otherwise clicking a second (different-member) thread changed nothing on screen
    // (selectedThreadId moved but the per-agent center didn't re-render). (bug fix 2026-05-31)
    set((state) => {
      let agentId = state.selectedAgentId;
      if (id) {
        const t = state.threads.find((th) => th.id === id);
        const known = new Set(state.agents.map((a) => a.id));
        const member = t?.participants.find((p) => known.has(p) && p !== "user");
        if (member) agentId = member;
      }
      return {
        selectedThreadId: id,
        selectedAgentId: agentId,
        mainView: id ? "thread" : "log",
        mobilePane: id ? "main" : "threads",
      };
    });
  },
  setMobilePane(p) {
    set({ mobilePane: p });
  },
  setThreadMessages(thread_id, messages) {
    set((state) => {
      const next = new Map(state.threadMessages);
      next.set(thread_id, messages);
      return { threadMessages: next };
    });
  },
  appendThreadMessage(thread_id, message) {
    set((state) => {
      const next = new Map(state.threadMessages);
      const existing = next.get(thread_id) ?? [];
      // Avoid duplicate by id
      if (existing.some((m) => m.id === message.id)) return state;
      next.set(thread_id, [...existing, message]);
      // Also move/insert thread to top of threads list with updated last_message_at
      const threads = [...state.threads];
      const idx = threads.findIndex((t) => t.id === thread_id);
      if (idx >= 0) {
        const t = threads.splice(idx, 1)[0]!;
        t.last_message_at = message.created_at;
        threads.unshift(t);
      }
      return { threadMessages: next, threads };
    });
  },
  setAgentStats(s) {
    set((state) => {
      const next = new Map(state.agentStats);
      next.set(s.agent_id, s);
      return { agentStats: next };
    });
  },
  setAlerts(a) {
    set({ alerts: a });
  },
  setClaudeUsage(u) {
    set({ claudeUsage: u });
  },
  setAgentHealth(v) {
    const next = new Map<string, AgentHealth>();
    for (const h of v) next.set(h.agentId, h);
    set({ agentHealth: next, agentHealthLoaded: true });
  },
  setBusFlow(m) {
    set({ busFlow: m });
  },
  setTeamOs(s) {
    set({ teamOs: s });
  },
  setBusMembers(m, generatedAt) {
    set({ busMembers: m, busMembersAt: generatedAt });
  },
  markMessageRead(message_id) {
    set((state) => {
      const next = new Map(state.threadMessages);
      for (const [tid, msgs] of next) {
        const idx = msgs.findIndex((m) => m.id === message_id);
        if (idx >= 0) {
          const updated = [...msgs];
          updated[idx] = { ...updated[idx]!, read_at: new Date().toISOString() };
          next.set(tid, updated);
        }
      }
      return { threadMessages: next };
    });
  },
}));

export type Store = typeof store;

const AGENT_ORDER_STORAGE_KEY = "bill-dash-agent-order";

function savedAgentOrder(): string[] {
  try {
    const raw = localStorage.getItem(AGENT_ORDER_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveAgentOrder(ids: string[]): void {
  try {
    localStorage.setItem(AGENT_ORDER_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage may be unavailable in hardened/private browser contexts; keep in-memory order.
  }
}

function applySavedAgentOrder(agents: Agent[]): Agent[] {
  const order = savedAgentOrder();
  if (!order.length) return agents;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const sorted: Agent[] = [];
  for (const id of order) {
    const agent = byId.get(id);
    if (!agent) continue;
    sorted.push(agent);
    byId.delete(id);
  }
  sorted.push(...agents.filter((a) => byId.has(a.id)));
  return sorted;
}

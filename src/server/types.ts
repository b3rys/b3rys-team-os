export type AgentRuntime = "claude_channel" | "openclaw" | "hermes_agent" | "b3os_native" | "codex";
export type StatusProvider = "claude_tmux" | "openclaw_gateway" | "hermes_gateway" | "b3os_native_runner" | "codex_cli";
export type AgentState = "running" | "idle" | "blocked" | "offline";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface AgentRecord {
  id: string;
  display_name: string;
  /** @멘션 별칭 (한글 이름·단축형). 라우터가 자동 로드 — 추가 시 코드 수정 불필요. */
  nicknames?: string[];
  role: string;
  /**
   * 동작 capability 플래그 (additive — 없으면 빈 배열). 코드의 하드코딩 agent-id 비교를 대체.
   * 정의: coordinator · restricted_mention · native_routing · full_context · recovery · non_interactive · learning_loop_pm
   * (의미는 lib/capabilities.ts 참조). 정본 = agents.json.
   */
  capabilities?: string[];
  /** 운영상 비활성 팀원. false면 스케줄/라우팅 대상에서 제외한다. */
  enabled?: boolean;
  /** 정식 팀원 여부. false면 coach/cron/비정식 보조 agent로 보고 리뷰·운영 후보에서 제외한다. */
  team_official_member?: boolean;
  /** @deprecated legacy alias for team_official_member:false. New configs should not write this. */
  lead_eligible?: boolean;
  response_mode?: "mention-only" | "default-intake" | "proactive" | null;
  default_intake_scope?: "none" | "general_pm" | "infra_ops" | "custom" | null;
  default_intake_description?: string | null;
  runtime: AgentRuntime;
  status_provider: StatusProvider;
  tmux_session: string | null;
  telegram_bot_username: string | null;
  workspace_path: string;
  persona_file: string;
  moderator_eligible: boolean;
  avatar_emoji: string;
  icon?: string | null; // 대시보드 SVG 아이콘 (icons.ts ICONS 키). 없으면 id 기본 매핑.
  icon_color?: string | null; // 아이콘 색 키 (green/orange/yellow/blue/red/violet). 없으면 green 기본.
  slack_bot_user_id?: string | null;
  slack_app_name?: string | null;
  slack_connection_mode?: "webhook" | "socket" | null;
  /**
   * 채널별 외부 신원 매핑 (additive — P3 채널 어댑터 seam). kind → 외부 식별자.
   * 예: { telegram: "example_bill_bot", slack: "U0123" }. 없으면 legacy 평면필드
   * (telegram_bot_username·slack_bot_user_id)로 폴백 → 기존 동작 byte-동일. 새 채널(kakao 등)은
   * 평면필드 추가 없이 이 맵 한 줄로 신원 등록. 정본 = agents.json.
   */
  channel_identities?: Record<string, string> | null;
  openclaw_agent_id?: string | null;
  hermes_profile?: string | null;
  state_db_path?: string | null;
  hermes_alias?: string | null;
  gateway_service?: string | null;
  // b3os_native 런타임: 어떤 LLM 두뇌를 쓸지. provider=벤더("anthropic"·"openai"), model_id=모델명.
  // 없으면 runner 기본값(anthropic / claude-sonnet-4-6). API 키는 env에서만(여기 저장 X).
  model_provider?: string | null;
  model_id?: string | null;
  // codex 런타임: 멤버별 실행 권한. 없으면 보수적 기본값(read-only, network 기본값)을 쓴다.
  codex_sandbox?: CodexSandboxMode | null;
  codex_network_access?: boolean | null;
}

export interface AgentStatus {
  agent_id: string;
  state: AgentState;
  last_activity_at: string | null;
  last_log_line: string | null;
  tmux_pid: number | null;
  ctx_percent: number | null;
  probed_at: string;
}

export interface LogLine {
  id: number;
  agent_id: string;
  line: string;
  captured_at: string;
}

export interface MetricRow {
  id: number;
  cpu_percent: number | null;
  mem_used_mb: number | null;
  load_1min: number | null;
  ollama_running: number;
  probed_at: string;
}

export type WsEvent =
  | { type: "agent_status"; agent_id: string; status: AgentStatus }
  | { type: "log_line"; agent_id: string; line: string; captured_at: string }
  | { type: "metric"; metric: MetricRow }
  | { type: "hello"; agents: (AgentRecord & { off?: boolean })[]; statuses: AgentStatus[] }
  | { type: "message"; message: import("../shared/envelopeSchema").EnvelopeStored }
  | { type: "message_read"; message_id: string };

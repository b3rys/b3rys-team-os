import type { Database } from "bun:sqlite";
import type {
  AgentRecord,
  AgentState,
  AgentStatus,
  LogLine,
  MetricRow,
} from "../types";

const MAX_LOG_LINES_PER_AGENT = 1000;
const MAX_METRIC_ROWS = 720;

export function upsertAgent(db: Database, a: AgentRecord): void {
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, tmux_session, telegram_bot_username, workspace_path, persona_file, moderator_eligible, avatar_emoji, icon, hermes_profile, hermes_alias, gateway_service)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name=excluded.display_name,
       role=excluded.role,
       runtime=excluded.runtime,
       status_provider=excluded.status_provider,
       tmux_session=excluded.tmux_session,
       telegram_bot_username=excluded.telegram_bot_username,
       workspace_path=excluded.workspace_path,
       persona_file=excluded.persona_file,
       moderator_eligible=excluded.moderator_eligible,
       avatar_emoji=excluded.avatar_emoji,
       icon=excluded.icon,
       hermes_profile=excluded.hermes_profile,
       hermes_alias=excluded.hermes_alias,
       gateway_service=excluded.gateway_service`,
  ).run(
    a.id,
    a.display_name,
    a.role,
    a.runtime,
    a.status_provider,
    a.tmux_session,
    a.telegram_bot_username,
    a.workspace_path,
    a.persona_file,
    a.moderator_eligible ? 1 : 0,
    a.avatar_emoji,
    a.icon ?? null,
    a.hermes_profile ?? null,
    a.hermes_alias ?? null,
    a.gateway_service ?? null,
  );
}

export function deleteAgentsNotIn(db: Database, ids: string[]): void {
  if (ids.length === 0) {
    db.prepare("DELETE FROM agent").run();
    return;
  }
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM agent WHERE id NOT IN (${placeholders})`).run(...ids);
}

export function listAgents(db: Database): AgentRecord[] {
  const rows = db
    .prepare(
      `SELECT id, display_name, role, runtime, status_provider, tmux_session, telegram_bot_username, workspace_path, persona_file, moderator_eligible, avatar_emoji, icon, hermes_profile, hermes_alias, gateway_service FROM agent ORDER BY id`,
    )
    .all() as Array<Omit<AgentRecord, "moderator_eligible"> & { moderator_eligible: number }>;
  return rows.map((r) => ({ ...r, moderator_eligible: r.moderator_eligible === 1 }));
}

export function upsertStatus(
  db: Database,
  s: {
    agent_id: string;
    state: AgentState;
    last_activity_at: string | null;
    last_log_line: string | null;
    tmux_pid: number | null;
    ctx_percent?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO agent_status (agent_id, state, last_activity_at, last_log_line, tmux_pid, ctx_percent, probed_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(agent_id) DO UPDATE SET
       state=excluded.state,
       last_activity_at=excluded.last_activity_at,
       last_log_line=excluded.last_log_line,
       tmux_pid=excluded.tmux_pid,
       ctx_percent=excluded.ctx_percent,
       probed_at=excluded.probed_at`,
  ).run(s.agent_id, s.state, s.last_activity_at, s.last_log_line, s.tmux_pid, s.ctx_percent ?? null);
}

export function listStatuses(db: Database): AgentStatus[] {
  return db
    .prepare(`SELECT agent_id, state, last_activity_at, last_log_line, tmux_pid, ctx_percent, probed_at FROM agent_status`)
    .all() as AgentStatus[];
}

export function getStatus(db: Database, agentId: string): AgentStatus | undefined {
  return db
    .prepare(
      `SELECT agent_id, state, last_activity_at, last_log_line, tmux_pid, ctx_percent, probed_at FROM agent_status WHERE agent_id = ?`,
    )
    .get(agentId) as AgentStatus | undefined;
}

export function insertLogLine(db: Database, agentId: string, line: string): void {
  db.prepare(`INSERT INTO log_line (agent_id, line) VALUES (?, ?)`).run(agentId, line);
}

export function pruneLogLines(db: Database, agentId: string): void {
  db.prepare(
    `DELETE FROM log_line
     WHERE agent_id = ?
       AND id NOT IN (
         SELECT id FROM log_line WHERE agent_id = ? ORDER BY id DESC LIMIT ?
       )`,
  ).run(agentId, agentId, MAX_LOG_LINES_PER_AGENT);
}

export function recentLogLines(db: Database, agentId: string, limit = 100): LogLine[] {
  return db
    .prepare(
      `SELECT id, agent_id, line, captured_at FROM log_line WHERE agent_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(agentId, limit)
    .reverse() as LogLine[];
}

export function insertMetric(
  db: Database,
  m: { cpu_percent: number | null; mem_used_mb: number | null; load_1min: number | null; ollama_running: boolean },
): void {
  db.prepare(
    `INSERT INTO metric (cpu_percent, mem_used_mb, load_1min, ollama_running) VALUES (?, ?, ?, ?)`,
  ).run(m.cpu_percent, m.mem_used_mb, m.load_1min, m.ollama_running ? 1 : 0);
}

export function pruneMetrics(db: Database): void {
  db.prepare(
    `DELETE FROM metric WHERE id NOT IN (SELECT id FROM metric ORDER BY id DESC LIMIT ?)`,
  ).run(MAX_METRIC_ROWS);
}

export function latestMetric(db: Database): MetricRow | undefined {
  return db
    .prepare(`SELECT id, cpu_percent, mem_used_mb, load_1min, ollama_running, probed_at FROM metric ORDER BY id DESC LIMIT 1`)
    .get() as MetricRow | undefined;
}

export function recentMetrics(db: Database, limit = 120): MetricRow[] {
  return db
    .prepare(`SELECT id, cpu_percent, mem_used_mb, load_1min, ollama_running, probed_at FROM metric ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .reverse() as MetricRow[];
}

export function appendAudit(
  db: Database,
  actor: string,
  action: string,
  target: string | null,
  detail: unknown,
): void {
  db.prepare(`INSERT INTO audit_event (actor, action, target, detail_json) VALUES (?, ?, ?, ?)`).run(
    actor,
    action,
    target,
    detail == null ? null : JSON.stringify(detail),
  );
}

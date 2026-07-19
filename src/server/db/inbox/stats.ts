import type { Database } from "bun:sqlite";
import type { EnvelopeStored } from "../../../shared/envelopeSchema";
import { type MessageRow, type ThreadRow, rowToEnvelope, RESOLVE_GRACE_SECONDS } from "./_shared";
import { isAgentOff } from "../../lib/agentControl";

/**
 * Per-agent stats for the dashboard: counts over 24h / 7d, last activity, avg reply latency.
 */
export interface AgentStats {
  agent_id: string;
  out_24h: number;
  in_24h: number;
  out_7d: number;
  in_7d: number;
  last_out_at: string | null;
  last_in_at: string | null;
  avg_reply_ms_24h: number | null; // median-ish: avg over recent N user→agent→user→agent pairs
  reply_samples_24h: number;
}

export function agentStats(db: Database, agent_id: string): AgentStats {
  const num = (q: string) =>
    (db.prepare(q).get(agent_id) as { c: number }).c;
  const out_24h = num(
    `SELECT COUNT(*) AS c FROM message WHERE from_agent_id = ? AND created_at > datetime('now','-1 day')`,
  );
  const in_24h = num(
    `SELECT COUNT(*) AS c FROM message WHERE to_agent_id = ? AND created_at > datetime('now','-1 day')`,
  );
  const out_7d = num(
    `SELECT COUNT(*) AS c FROM message WHERE from_agent_id = ? AND created_at > datetime('now','-7 days')`,
  );
  const in_7d = num(
    `SELECT COUNT(*) AS c FROM message WHERE to_agent_id = ? AND created_at > datetime('now','-7 days')`,
  );
  const lastOutRow = db
    .prepare(
      `SELECT created_at AS t FROM message WHERE from_agent_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(agent_id) as { t: string } | undefined;
  const lastInRow = db
    .prepare(
      `SELECT created_at AS t FROM message WHERE to_agent_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(agent_id) as { t: string } | undefined;

  // Avg reply latency: for each user→agent message in 24h, find the next agent→user
  // message in the same thread (after the user message). Diff = reply ms.
  const pairs = db
    .prepare(
      `SELECT u.created_at AS u_at, MIN(r.created_at) AS r_at
       FROM message u
       JOIN message r
         ON r.thread_id = u.thread_id
        AND r.from_agent_id = u.to_agent_id
        AND r.created_at > u.created_at
       WHERE u.to_agent_id = ?
         AND u.source = 'user'
         AND u.created_at > datetime('now','-1 day')
       GROUP BY u.id`,
    )
    .all(agent_id) as Array<{ u_at: string; r_at: string }>;

  let totalMs = 0;
  let n = 0;
  for (const p of pairs) {
    if (!p.r_at) continue;
    const u = new Date(p.u_at.replace(" ", "T") + "Z").getTime();
    const r = new Date(p.r_at.replace(" ", "T") + "Z").getTime();
    if (Number.isFinite(u) && Number.isFinite(r) && r > u) {
      totalMs += r - u;
      n++;
    }
  }

  return {
    agent_id,
    out_24h,
    in_24h,
    out_7d,
    in_7d,
    last_out_at: lastOutRow?.t ?? null,
    last_in_at: lastInRow?.t ?? null,
    avg_reply_ms_24h: n > 0 ? Math.round(totalMs / n) : null,
    reply_samples_24h: n,
  };
}

/**
 * Recent operational alerts — used by the dashboard alert strip.
 * Failures + warnings from audit_event in the given window.
 */
export interface AlertEvent {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
  at: string;
}

const ALERT_ACTIONS = new Set([
  "slack_relay_failed",
  "slack_post_failed",
  "openclaw_inject_failed",
  "tmux_inject_failed",
  "hop_limit_exceeded",
  "slack_relay_skipped_no_creds",
  "messages_expired",
]);

export function recentAlerts(db: Database, hours = 6, limit = 20): AlertEvent[] {
  const placeholders = Array.from(ALERT_ACTIONS).map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, actor, action, target, detail_json, at FROM audit_event
       WHERE action IN (${placeholders})
         AND at > datetime('now','-${hours} hours')
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...Array.from(ALERT_ACTIONS), limit) as Array<{
      id: number;
      actor: string;
      action: string;
      target: string | null;
      detail_json: string | null;
      at: string;
    }>;
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: r.detail_json ? JSON.parse(r.detail_json) : null,
    at: r.at,
  }));
}

// ─── SLG cycle1 B (Audit screen) — read-only audit_event feed ────────────────
export interface AuditRecentRow {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
  at: string;
  /** true when a close looks heuristic (ack-only / reply-observed) — the Audit screen
   * highlights these so a human can spot a possibly-premature close at a glance. */
  suspicious_close: boolean;
}

// close_reason values that are inferred from a reply rather than an explicit completion.
const SUSPICIOUS_CLOSE_REASONS = new Set(["ack_only", "reply_observed", "backfill_transport"]);

// Guards (Bill server gate): limit hard-capped; action bound as a parameter (never string-built).
const AUDIT_LIMIT_DEFAULT = 100;
const AUDIT_LIMIT_MAX = 500;

/**
 * Recent audit events, newest first. Optional `action` filter (e.g. 'recipient_state_change').
 * read-only. `limit` is clamped to [1, AUDIT_LIMIT_MAX]. `action` is passed as a bound
 * parameter — no string concatenation into SQL.
 */
export function auditRecent(
  db: Database,
  opts: { action?: string; limit?: number } = {},
): AuditRecentRow[] {
  const limit = Math.min(Math.max(1, opts.limit ?? AUDIT_LIMIT_DEFAULT), AUDIT_LIMIT_MAX);
  const action = opts.action && opts.action.trim() !== "" ? opts.action.trim() : null;

  const rows = (
    action
      ? db
          .prepare(
            `SELECT id, actor, action, target, detail_json, at FROM audit_event
             WHERE action = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(action, limit)
      : db
          .prepare(
            `SELECT id, actor, action, target, detail_json, at FROM audit_event
             ORDER BY id DESC LIMIT ?`,
          )
          .all(limit)
  ) as Array<{
    id: number;
    actor: string;
    action: string;
    target: string | null;
    detail_json: string | null;
    at: string;
  }>;

  return rows.map((r) => {
    const detail = r.detail_json ? JSON.parse(r.detail_json) : null;
    const closeReason =
      detail && typeof detail === "object" ? (detail as { close_reason?: string }).close_reason : undefined;
    return {
      id: r.id,
      actor: r.actor,
      action: r.action,
      target: r.target,
      detail,
      at: r.at,
      suspicious_close:
        r.action === "recipient_state_change" && !!closeReason && SUSPICIOUS_CLOSE_REASONS.has(closeReason),
    };
  });
}

/**
 * Phase 2b activity feed — all messages involving this agent (from or to), time DESC.
 * Used by the dashboard "Activity" tab per agent.
 */
export function agentActivity(db: Database, agent_id: string, limit = 50): EnvelopeStored[] {
  const rows = db
    .prepare(
      `SELECT * FROM message
       WHERE from_agent_id = ? OR to_agent_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(agent_id, agent_id, limit) as MessageRow[];
  return rows.map(rowToEnvelope);
}

export function listThreads(db: Database, limit = 50): ThreadRow[] {
  return db
    .prepare(
      `SELECT * FROM thread ORDER BY COALESCE(last_message_at, opened_at) DESC LIMIT ?`,
    )
    .all(limit) as ThreadRow[];
}

// ─── Team Bus: operational status snapshot ───────────────────────────────────

export interface BusStatusCounts {
  pending: number;
  dispatching: number;
  wake_dispatched: number;
  deferred: number;  // pending rows with deferred_count > 0 (soft tracking — delivery_state is 'pending')
  blocked: number;
  dead_letter: number;
  completed: number;
  agent_ack: number;
  expired: number;   // 2026-05-27: allowlist_not_enabled + execute_timeout_expired — terminal, no retry
}

export interface BusStatusRecentItem {
  message_id: string;
  agent_id: string;
  delivery_state: string;
  last_error: string | null;
  deferred_count: number | null;
  updated_at: string | null;
}

export interface BusStatusSnapshot {
  counts: BusStatusCounts;
  recent_terminal_bad: BusStatusRecentItem[];  // last 10 dead_letter + blocked rows
}

/**
 * Operational status snapshot for GET /api/bus/status.
 * Returns delivery_state counts across all message_recipient rows
 * plus the 10 most recent dead_letter/blocked rows for triage.
 *
 * Note: SQLite has no native 'deferred' state — deferred is modeled as
 * 'pending' with deferred_count > 0. We count those separately here
 * for observability (not a separate DB state).
 */
export function busStatusSnapshot(db: Database): BusStatusSnapshot {
  // delivery_state counts
  const stateRows = db
    .prepare(
      `SELECT delivery_state, COUNT(*) AS cnt
       FROM message_recipient
       GROUP BY delivery_state`,
    )
    .all() as Array<{ delivery_state: string; cnt: number }>;

  const stateMap = new Map(stateRows.map((r) => [r.delivery_state, r.cnt]));

  // "deferred" = pending rows with deferred_count > 0
  const deferredCountRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM message_recipient
       WHERE delivery_state = 'pending' AND COALESCE(deferred_count, 0) > 0`,
    )
    .get() as { cnt: number };

  const counts: BusStatusCounts = {
    pending: stateMap.get("pending") ?? 0,
    dispatching: stateMap.get("dispatching") ?? 0,
    wake_dispatched: stateMap.get("wake_dispatched") ?? 0,
    deferred: deferredCountRow.cnt,
    blocked: stateMap.get("blocked") ?? 0,
    dead_letter: stateMap.get("dead_letter") ?? 0,
    completed: stateMap.get("completed") ?? 0,
    agent_ack: stateMap.get("agent_ack") ?? 0,
    expired: stateMap.get("expired") ?? 0,
  };

  // Recent dead_letter + blocked (10 most recent by claimed_at or created_at fallback).
  // Time-windowed to the last 48h so stale terminal rows age out instead of lingering
  // forever (the metric is "last N rows" with no natural expiry — without a window a
  // burst of guard-blocked rows keeps re-triggering weekly health alerts on old data).
  const recentRows = db
    .prepare(
      `SELECT mr.message_id, mr.agent_id, mr.delivery_state, mr.last_error,
              mr.deferred_count,
              COALESCE(mr.claimed_at, m.created_at) AS updated_at
       FROM message_recipient mr
       JOIN message m ON m.id = mr.message_id
       WHERE mr.delivery_state IN ('dead_letter', 'blocked')
         AND COALESCE(mr.claimed_at, m.created_at) > datetime('now', '-48 hours')
       ORDER BY updated_at DESC
       LIMIT 10`,
    )
    .all() as BusStatusRecentItem[];

  return {
    counts,
    recent_terminal_bad: recentRows,
  };
}

// ─── Team Bus flow (dashboard real-time view) ────────────────────────────────

export interface BusFlowRecipient {
  agent_id: string;
  delivery_state: string; // transport (did the bus deliver the wake)
  recipient_state: string; // semantic closure (SLG A) — what the Inbox screen renders
  close_reason: string | null; // why it closed (ack_only/reply_observed/explicit_done/...)
  last_error: string | null;
  updated_at: string | null;
}

export interface BusFlowMessage {
  id: string;
  thread_id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: string;
  source: string;
  priority: string;
  body: string;
  created_at: string;
  recipients: BusFlowRecipient[];
}

/**
 * Recent bus messages with per-recipient delivery_state, newest first.
 * Powers the dashboard "Bus Flow" view — who sent what to whom and where each
 * recipient sits in the delivery state machine. Body is truncated for transport.
 * updated_at is best-effort: claimed_at (when the dispatcher last touched the row)
 * falling back to the message created_at, since message_recipient has no updated_at.
 */
export function busFlowRecent(db: Database, limit = 40): BusFlowMessage[] {
  const msgs = db
    .prepare(
      `SELECT id, thread_id, from_agent_id, to_agent_id, type, source,
              COALESCE(priority, 'normal') AS priority,
              substr(body, 1, 240) AS body, created_at
       FROM message
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<Omit<BusFlowMessage, "recipients">>;

  const rcptStmt = db.prepare(
    `SELECT agent_id, delivery_state, recipient_state, close_reason, last_error,
            COALESCE(closed_at, claimed_at, last_deferred_at) AS updated_at
     FROM message_recipient
     WHERE message_id = ?
     ORDER BY agent_id`,
  );

  return msgs.map((m) => ({
    ...m,
    recipients: rcptStmt.all(m.id) as BusFlowRecipient[],
  }));
}

// ─── Team Bus member status (busviz-v1 topology view) ────────────────────────

export interface MemberBusStatus {
  agent_id: string;
  counts: BusStatusCounts;
  // pending/deferred rows old enough to be safely resolved (what resolve would touch)
  resolvable_pending: number;
  // in-flight = dispatching + wake_dispatched; oldest_age_sec lets the frontend flag
  // zombies/stuck rows with its own threshold (Gemini #3). null when none in flight.
  inflight: { count: number; oldest_age_sec: number | null };
  off?: boolean; // /onoff 로 의도적 정지 — 토폴로지/리스트에 '중지' 표시
}

export interface BusMembersSnapshot {
  generated_at: string;
  members: MemberBusStatus[];
}

function emptyBusCounts(): BusStatusCounts {
  return {
    pending: 0,
    dispatching: 0,
    wake_dispatched: 0,
    deferred: 0,
    blocked: 0,
    dead_letter: 0,
    completed: 0,
    agent_ack: 0,
    expired: 0,
  };
}

/**
 * Per-member delivery-state snapshot for the busviz-v1 topology view. Read-only.
 * One entry per registered agent (zero-filled) so the topology always renders the
 * full node set. 'deferred' mirrors busStatusSnapshot — pending rows with
 * deferred_count>0 (soft state), counted separately as an overlay on `pending`.
 */
export function busMemberStatus(db: Database): BusMembersSnapshot {
  const graceArg = `-${RESOLVE_GRACE_SECONDS} seconds`;

  const rows = db
    .prepare(
      `SELECT agent_id, delivery_state, COUNT(*) AS cnt
       FROM message_recipient
       GROUP BY agent_id, delivery_state`,
    )
    .all() as Array<{ agent_id: string; delivery_state: string; cnt: number }>;

  const deferredRows = db
    .prepare(
      `SELECT agent_id, COUNT(*) AS cnt
       FROM message_recipient
       WHERE delivery_state = 'pending' AND COALESCE(deferred_count, 0) > 0
       GROUP BY agent_id`,
    )
    .all() as Array<{ agent_id: string; cnt: number }>;

  const resolvableRows = db
    .prepare(
      `SELECT mr.agent_id, COUNT(*) AS cnt
       FROM message_recipient mr
       JOIN message m ON m.id = mr.message_id
       WHERE mr.delivery_state IN ('pending', 'deferred')
         AND mr.recipient_state = 'open'
         AND m.created_at < datetime('now', ?)
       GROUP BY mr.agent_id`,
    )
    .all(graceArg) as Array<{ agent_id: string; cnt: number }>;

  // SLG cycle1 A (ack-close): a wake_dispatched row whose recipient has ALREADY responded
  // (recipient_state != 'open') is NOT in-flight/stuck — the transport state just lingers
  // because ackClose intentionally leaves delivery_state untouched. Counting it as in-flight
  // is the false-red bug. So in-flight = transport-in-flight AND semantically still open.
  const inflightRows = db
    .prepare(
      `SELECT mr.agent_id, COUNT(*) AS cnt,
              CAST((julianday('now') - julianday(MIN(COALESCE(mr.claimed_at, m.created_at)))) * 86400 AS INTEGER) AS oldest_age_sec
       FROM message_recipient mr
       JOIN message m ON m.id = mr.message_id
       WHERE mr.delivery_state IN ('dispatching', 'wake_dispatched')
         AND mr.recipient_state = 'open'
       GROUP BY mr.agent_id`,
    )
    .all() as Array<{ agent_id: string; cnt: number; oldest_age_sec: number | null }>;

  // registered roster — zero-fill so every node always shows
  const roster = db.prepare(`SELECT id FROM agent`).all() as Array<{ id: string }>;
  const ids = new Set(roster.map((a) => a.id));
  for (const r of rows) ids.add(r.agent_id); // defensive: include any agent with rows but not in roster

  const byAgent = new Map<string, MemberBusStatus>();
  for (const id of ids) {
    byAgent.set(id, {
      agent_id: id,
      counts: emptyBusCounts(),
      resolvable_pending: 0,
      inflight: { count: 0, oldest_age_sec: null },
      off: isAgentOff(id), // /onoff 로 의도적 정지된 팀원 — 토폴로지/리스트에 '중지' 표시용
    });
  }

  for (const r of rows) {
    const m = byAgent.get(r.agent_id);
    if (m && r.delivery_state in m.counts) {
      (m.counts as unknown as Record<string, number>)[r.delivery_state] = r.cnt;
    }
  }
  for (const r of deferredRows) {
    const m = byAgent.get(r.agent_id);
    if (m) m.counts.deferred = r.cnt;
  }
  for (const r of resolvableRows) {
    const m = byAgent.get(r.agent_id);
    if (m) m.resolvable_pending = r.cnt;
  }
  for (const r of inflightRows) {
    const m = byAgent.get(r.agent_id);
    if (m) m.inflight = { count: r.cnt, oldest_age_sec: r.oldest_age_sec };
  }

  const members = Array.from(byAgent.values()).sort((a, b) =>
    a.agent_id.localeCompare(b.agent_id),
  );
  const generated_at = (db.prepare(`SELECT datetime('now') AS now`).get() as { now: string }).now;
  return { generated_at, members };
}

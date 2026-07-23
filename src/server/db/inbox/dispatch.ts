import type { Database } from "bun:sqlite";
import type { PendingDispatchRow } from "../../bus/types";

// ─── Team Bus v1.2: delivery status aggregation (issue 6) ────────────────────

/**
 * Aggregate delivery status for a message from its message_recipient rows.
 *
 * Aggregation rules (message_recipient is the authority for delivery state):
 *   any 'dead_letter' + all others terminal   → 'failed'
 *   any 'dead_letter' + some non-terminal     → 'partial_failed'
 *   any 'blocked'                             → 'failed' (policy terminal)
 *   any 'pending'|'dispatching'|'deferred'    → 'pending'
 *   all 'completed'|'agent_ack'|'wake_dispatched' → 'delivered'
 *   no recipients                             → null (use message.delivery_status as-is)
 *
 * This is used by dashboard/inbox/agentStats queries to read the canonical
 * per-message delivery status from message_recipient rather than the denormalized
 * message.delivery_status field (which is not updated per-recipient for broadcasts).
 */
export type AggregatedDeliveryStatus = "pending" | "delivered" | "failed" | "partial_failed" | null;

export function aggregateDeliveryStatus(db: Database, messageId: string): AggregatedDeliveryStatus {
  const rows = db
    .prepare(
      `SELECT delivery_state FROM message_recipient WHERE message_id = ?`,
    )
    .all(messageId) as Array<{ delivery_state: string }>;

  if (rows.length === 0) return null;

  const states = rows.map((r) => r.delivery_state);
  const terminalBad = new Set(["dead_letter", "blocked", "expired"]);
  const terminalOk = new Set(["completed", "agent_ack", "wake_dispatched"]);
  const inProgress = new Set(["pending", "dispatching", "deferred"]);

  const hasInProgress = states.some((s) => inProgress.has(s));
  const hasBad = states.some((s) => terminalBad.has(s));
  const hasOk = states.some((s) => terminalOk.has(s));
  const allOk = states.every((s) => terminalOk.has(s));
  const allBad = states.every((s) => terminalBad.has(s));

  // Priority: in-progress → pending (delivery not yet complete)
  if (hasInProgress) return "pending";
  // All recipients terminal-ok → delivered
  if (allOk) return "delivered";
  // All recipients terminal-bad → failed
  if (allBad) return "failed";
  // Mix of bad + ok (or bad + in-progress already handled above) → partial
  if (hasBad && hasOk) return "partial_failed";
  // Remaining: all ok (covered), all bad (covered), mix already covered.
  // Fallback for unexpected states (e.g. all 'dispatching' already in hasInProgress).
  return "pending";
}

/**
 * Return messages with their aggregated delivery status from message_recipient.
 * Replaces reading message.delivery_status for dashboard/inbox consumers.
 * For messages with no recipients, message.delivery_status is used as fallback.
 */
export function messagesWithAggregatedStatus(
  db: Database,
  messageIds: string[],
): Map<string, AggregatedDeliveryStatus> {
  const result = new Map<string, AggregatedDeliveryStatus>();
  for (const id of messageIds) {
    result.set(id, aggregateDeliveryStatus(db, id));
  }
  return result;
}

// ─── Team Bus v1: dispatch outbox queries ────────────────────────────────────

/**
 * Return message_recipient rows that need dispatching (delivery_state='pending').
 * Joins message to get routing/body info.
 *
 * scope filter: dispatch rows where source IN ('agent','user').
 *  - 'agent' = inter-agent bus messages.
 *  - 'user'  = dashboard 1:1 (source='user' + dispatch:true → recipient inserted 'pending').
 * Telegram/Slack user messages are completed-on-insert (the channel poller delivers them),
 * so they are NOT 'pending' and never appear here — no double-wake. Only dashboard's
 * pending user rows get bus-woken.
 *
 * ★'system' — 2026-07-13 (GD 승인) 부터 깨운다. 단 ★시각 컷오프★ 를 건다.★
 *   예전엔 system 을 ★수집 번들일 때만★ 통과시켰다. 그 수집 기능은 삭제됐다 → ★system 이 전부 막혔다.★
 *   실측: 카드 알림 29건 중 ★배달 0건★ (expired 21 · pending 8, 가장 오래된 건 7/04).
 *   "[카드 배정] 카드 'X' 담당이 되셨습니다" 가 ★단 한 번도 안 갔다★ → 팀원이 자기 카드를 못 챙겼다.
 *   ★에러가 안 난다.★ DB 에 잘 들어가고 '대기 중' 으로 조용히 남는다.
 *
 *   ★컷오프가 필수다★: 그냥 열면 7/04 부터 쌓인 알림이 ★한꺼번에 터진다.★
 *   오래된 알림은 이미 의미가 없다(카드가 바뀌었거나 닫혔다). SYSTEM_WAKE_CUTOFF_MIN(기본 30분).
 *   컷오프는 ★system 에만★ 건다 — 팀장/팀원 메시지를 나이로 버리면 안 된다.
 */
/** system 알림을 깨울 시간 창(분). 이보다 오래된 system 메시지는 깨우지 않는다 — 이미 의미가 없다. */
const SYSTEM_WAKE_CUTOFF_MIN = Number(process.env.SYSTEM_WAKE_CUTOFF_MIN ?? 30);

export function pendingDispatch(db: Database, limit = 20): PendingDispatchRow[] {
  return db
    .prepare(
      `SELECT
         mr.message_id,
         mr.agent_id,
         mr.delivery_state,
         mr.retry_count,
         mr.last_error,
         m.from_agent_id,
         m.to_agent_id,
         m.body,
         m.source,
         COALESCE(m.created_by, m.from_agent_id) AS created_by,
         COALESCE(m.max_hop, 16)    AS max_hop,  -- 5→16 (MAX_HOPS_DEFAULT 정렬; hop cap이 pingpong cap보다 낮던 버그 fix)
         m.hop_count,
         m.in_reply_to,
         m.parent_message_id,
         COALESCE(m.sync, 'none')  AS sync,
         m.thread_id,
         m.type,
         m.created_at,
         COALESCE(m.priority, 'normal') AS priority,
         m.attachments_json,
         m.meta_json
       FROM message_recipient mr
       JOIN message m ON m.id = mr.message_id
       WHERE mr.delivery_state = 'pending'
         AND (mr.lease_until IS NULL OR mr.lease_until <= datetime('now'))
         -- ★system 알림(카드 배정·삭제·PM 자동조치)이 팀원에게 ★한 번도 안 갔다.★★ (2026-07-13 실측)
         --   예전엔 system 을 ★수집 번들일 때만★ 예외로 통과시켰다. 그 수집 기능은 오늘 삭제됐다.
         --   → 실측: 카드 알림 29건 중 ★배달 0건★ (expired 21 · pending 8, 가장 오래된 건 7/04).
         --   ★에러가 안 난다.★ 메시지는 DB 에 잘 들어가고 '대기 중' 으로 조용히 남는다.
         --   보낸 쪽은 보냈다고 믿고, 받는 쪽은 온 적이 없다. ★오늘 하루 종일 본 그 패턴이다.★
         --
         --   ★시각 컷오프가 필수다★ (GD 승인, 안 하면 7/04부터 쌓인 알림이 한꺼번에 터진다):
         --   방금 만들어진 알림만 깨운다. 오래된 건 이미 의미가 없다(카드가 바뀌었거나 닫혔다).
         AND (m.source IN ('agent', 'user')
              OR (m.source = 'system'
                  AND m.created_at > datetime('now', '-' || CAST(? AS TEXT) || ' minutes')))
       ORDER BY
         CASE COALESCE(m.priority, 'normal')
           WHEN 'high'   THEN 0
           WHEN 'normal' THEN 1
           WHEN 'low'    THEN 2
           ELSE 1
         END ASC,
         m.created_at ASC
       LIMIT ?`,
    )
    .all(SYSTEM_WAKE_CUTOFF_MIN, limit) as PendingDispatchRow[];
}

/**
 * Atomically claim a message_recipient row for dispatching.
 * Uses UPDATE WHERE delivery_state='pending' — only the worker that gets changes=1 proceeds.
 * Sets lease_until = now + leaseSec so a crashed worker's claim expires.
 * Returns true if this worker successfully claimed the row.
 */
export function markDispatching(
  db: Database,
  messageId: string,
  agentId: string,
  leaseSec = 60,
): boolean {
  const result = db
    .prepare(
      `UPDATE message_recipient
       SET delivery_state = 'dispatching',
           claimed_at     = datetime('now'),
           lease_until    = datetime('now', '+${leaseSec} seconds')
       WHERE message_id = ? AND agent_id = ? AND delivery_state = 'pending'`,
    )
    .run(messageId, agentId);
  return result.changes === 1;
}

/**
 * Mark a row as wake_dispatched (adapter was called, waiting for ack).
 */
export function markWakeDispatched(
  db: Database,
  messageId: string,
  agentId: string,
): void {
  db.prepare(
    `UPDATE message_recipient
     SET delivery_state = 'wake_dispatched'
     WHERE message_id = ? AND agent_id = ?`,
  ).run(messageId, agentId);
}

/**
 * Mark as agent_ack → completed (agent processed the message).
 * Also records ack_at on the message row.
 */
export function markAck(db: Database, messageId: string, agentId: string): void {
  db.prepare(
    `UPDATE message_recipient
     SET delivery_state = 'agent_ack'
     WHERE message_id = ? AND agent_id = ?`,
  ).run(messageId, agentId);
  // Mark message ack_at and delivery_status for observability
  db.prepare(
    `UPDATE message
     SET ack_at = datetime('now'),
         delivery_status = 'delivered'
     WHERE id = ? AND ack_at IS NULL`,
  ).run(messageId);
}

/**
 * Increment retry_count and record last_error; return to 'pending' with backoff lease.
 * If retry_count reaches maxRetries, move to 'dead_letter'.
 *
 * Backoff (retry_count-based): 1s → 2s → 4s. The pending row gets lease_until set to
 * now + backoff so the poller naturally waits before re-claiming it (DB is the single
 * authority for retry timing — no in-process sleep loop).
 *
 * message.delivery_status is NOT updated here for per-recipient failures to avoid
 * broadcast partial-failure contamination (issue 6). The message-level status is
 * derived from message_recipient aggregation. Only dead_letter of ALL recipients
 * should set message.delivery_status='failed' — callers handle that aggregation.
 */
export function markFailed(
  db: Database,
  messageId: string,
  agentId: string,
  error: string,
  maxRetries = 3,
): "pending" | "dead_letter" {
  // Read current retry_count first
  const row = db
    .prepare(
      `SELECT retry_count FROM message_recipient WHERE message_id = ? AND agent_id = ?`,
    )
    .get(messageId, agentId) as { retry_count: number } | undefined;
  const currentRetries = row?.retry_count ?? 0;
  const nextRetries = currentRetries + 1;
  const nextState = nextRetries >= maxRetries ? "dead_letter" : "pending";

  // Backoff seconds: attempt 1→1s, 2→2s, 3+→4s
  const backoffSec = Math.min(Math.pow(2, currentRetries), 4);

  if (nextState === "pending") {
    // Set lease_until = now + backoff so poller doesn't immediately re-pick this row
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'pending',
           retry_count    = ?,
           last_error     = ?,
           lease_until    = datetime('now', '+${backoffSec} seconds'),
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(nextRetries, error.slice(0, 500), messageId, agentId);
  } else {
    // dead_letter — clear lease
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'dead_letter',
           retry_count    = ?,
           last_error     = ?,
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(nextRetries, error.slice(0, 500), messageId, agentId);
  }

  return nextState;
}

// v1.2 item 5: warn when deferred_count exceeds this threshold (starvation risk)
const DEFERRED_COUNT_WARN_THRESHOLD = 10;

// pre-widen item 1: hard cap on deferred_count — above this the row transitions to 'blocked'
// (terminal, no retry) instead of re-deferring. Prevents infinite 30s loops for dead sessions.
// Configurable via BUS_MAX_DEFER env (default 20).
const BUS_MAX_DEFER = Number(process.env.BUS_MAX_DEFER ?? 20);

/**
 * Mark a 'pending' row as deferred (lock-busy): reset to 'pending' with a short backoff
 * lease so the poller retries after ~2-3s without incrementing retry_count.
 * Also increments deferred_count and sets last_deferred_at for starvation monitoring.
 * v1.2: warns via console when deferred_count exceeds DEFERRED_COUNT_WARN_THRESHOLD (starvation risk).
 *
 * pre-widen: if deferred_count (after increment) >= BUS_MAX_DEFER, transitions to 'blocked'
 * (terminal) instead of 'pending'. Prevents dead-session infinite deferred loop.
 * Returns the final state: 'pending' (still retrying) or 'blocked' (terminal, capped).
 */
export function markDeferred(
  db: Database,
  messageId: string,
  agentId: string,
  backoffSec = 2,
): "pending" | "blocked" {
  // Read current deferred_count before incrementing
  const before = db
    .prepare(
      `SELECT deferred_count FROM message_recipient WHERE message_id = ? AND agent_id = ?`,
    )
    .get(messageId, agentId) as { deferred_count: number | null } | undefined;
  const currentCount = before?.deferred_count ?? 0;
  const nextCount = currentCount + 1;

  // Hard cap: if next count >= BUS_MAX_DEFER, transition to 'blocked' (terminal)
  if (nextCount >= BUS_MAX_DEFER) {
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state   = 'blocked',
           claimed_at       = NULL,
           lease_until      = NULL,
           deferred_count   = ?,
           last_deferred_at = datetime('now'),
           last_error       = 'deferred_cap_exceeded:count=' || ?
       WHERE message_id = ? AND agent_id = ?`,
    ).run(nextCount, nextCount, messageId, agentId);
    console.warn(
      `[bus] deferred hard cap: message ${messageId} → agent ${agentId} deferred ${nextCount} times (cap=${BUS_MAX_DEFER}) — transitioning to 'blocked' (terminal)`,
    );
    return "blocked";
  }

  db.prepare(
    `UPDATE message_recipient
     SET delivery_state   = 'pending',
         claimed_at       = NULL,
         lease_until      = datetime('now', '+${backoffSec} seconds'),
         deferred_count   = ?,
         last_deferred_at = datetime('now')
     WHERE message_id = ? AND agent_id = ?`,
  ).run(nextCount, messageId, agentId);

  // Starvation warning: warn if over soft threshold (below hard cap).
  if (nextCount >= DEFERRED_COUNT_WARN_THRESHOLD) {
    console.warn(
      `[bus] starvation warning: message ${messageId} → agent ${agentId} deferred ${nextCount} times (threshold=${DEFERRED_COUNT_WARN_THRESHOLD})`,
    );
  }
  return "pending";
}

/**
 * Crash recovery: reset dispatching rows whose lease has expired back to 'pending'.
 * Call on startup and periodically.
 */
export function recoverStaleClaims(db: Database): number {
  const result = db
    .prepare(
      `UPDATE message_recipient
       SET delivery_state = 'pending',
           claimed_at     = NULL,
           lease_until    = NULL
       WHERE delivery_state = 'dispatching'
         AND lease_until < datetime('now')`,
    )
    .run();
  return result.changes;
}

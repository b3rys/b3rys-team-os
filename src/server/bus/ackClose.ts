/**
 * SLG cycle1 A (ack-close) — server wiring: match a reply to the original recipient row
 * and apply the semantic recipient_state transition + audit.
 *
 * This REPLACES the naive 2026-06-10 block in inbox/messages.ts that did
 *   `UPDATE message_recipient SET delivery_state='completed' WHERE message_id=in_reply_to ...`
 * on ANY agent reply — which is the false-green source: an ack-only "네 볼게요" or a
 * clarifying question was marked transport-'completed' (read as done). Here the reply is
 * classified (ack_only / substantive / explicit_done) and only an explicit completion
 * (or a linked-task done) reaches 'completed'.
 */
import type { Database } from "bun:sqlite";
import { appendAudit } from "../db/queries";
import {
  classifyReplySignal,
  decideRecipientTransition,
  type RecipientState,
} from "../../shared/recipientState";

export interface ReplyLike {
  id: string;
  from_agent_id: string;
  body: string;
  thread_id: string;
  in_reply_to: string | null;
  source: string;
  type: string;
}

export interface ReplyTarget {
  messageId: string; // original message being closed
  agentId: string; // recipient (= reply sender)
  ambiguous: boolean; // multiple equal candidates → needs_match_review (req#4)
  tier: "in_reply_to" | "task_link" | "thread_recent";
}

/**
 * Resolve which original message_recipient row a reply closes.
 * Priority (req#4): in_reply_to id > task_link_id > thread 내 최근 open recipient.
 * Ambiguity (multiple equal candidates) → ambiguous=true, never auto-close.
 */
export function resolveReplyTarget(db: Database, reply: ReplyLike): ReplyTarget | null {
  const agentId = reply.from_agent_id;

  // ── tier 1: explicit in_reply_to (the skill convention; the common path) ──
  if (reply.in_reply_to) {
    const row = db
      .prepare(`SELECT 1 FROM message_recipient WHERE message_id = ? AND agent_id = ?`)
      .get(reply.in_reply_to, agentId);
    if (row) {
      return { messageId: reply.in_reply_to, agentId, ambiguous: false, tier: "in_reply_to" };
    }
    // in_reply_to set but no recipient row for this agent → fall through to weaker tiers
  }

  // Guard: tiers 2-3 are FUZZY (no explicit in_reply_to link). Only a message that is
  // actually a reply may use them — a brand-new request (type 'dm') must NEVER fuzzy-match
  // and close an unrelated open row the sender happens to hold in this thread (e.g. the
  // sender's own inbox rows from earlier replies). Without this, a new request silently
  // false-closes prior items. (Caught by the live demo, 2026-06-13.)
  if (reply.type !== "reply") return null;

  // ── tier 2: task_link_id on the reply message (task-scoped close) ──
  const replyTaskLink = db
    .prepare(`SELECT task_link_id FROM message WHERE id = ?`)
    .get(reply.id) as { task_link_id: string | null } | undefined;
  if (replyTaskLink?.task_link_id) {
    const rows = db
      .prepare(
        `SELECT mr.message_id
         FROM message_recipient mr JOIN message m ON m.id = mr.message_id
         WHERE m.task_link_id = ? AND mr.agent_id = ?
           AND mr.recipient_state NOT IN ('completed', 'expired')
         ORDER BY m.created_at DESC`,
      )
      .all(replyTaskLink.task_link_id, agentId) as Array<{ message_id: string }>;
    if (rows.length >= 1) {
      // single → confident; multiple open task messages → can't pick safely (ambiguous)
      return { messageId: rows[0]!.message_id, agentId, ambiguous: rows.length > 1, tier: "task_link" };
    }
  }

  // ── tier 3: most-recent OPEN recipient row in the same thread ──
  // No in_reply_to and no task link: weakest signal. A single open candidate is safe;
  // multiple opens are genuinely ambiguous → flag for review rather than guess (req#4).
  const open = db
    .prepare(
      `SELECT mr.message_id
       FROM message_recipient mr JOIN message m ON m.id = mr.message_id
       WHERE m.thread_id = ? AND mr.agent_id = ? AND mr.recipient_state = 'open'
         AND m.id != ?
       ORDER BY m.created_at DESC`,
    )
    .all(reply.thread_id, agentId, reply.id) as Array<{ message_id: string }>;
  if (open.length === 0) return null;
  // single open → confident; multiple opens → genuinely ambiguous, flag for review (req#4)
  return { messageId: open[0]!.message_id, agentId, ambiguous: open.length > 1, tier: "thread_recent" };
}

export interface AckCloseResult {
  applied: boolean;
  from?: RecipientState;
  to?: RecipientState;
  closeReason?: string | null;
  tier?: ReplyTarget["tier"];
}

/**
 * Transport↔work coupling (the wake_dispatched-orphan / red-"대기" root fix, 2026-06-22).
 *
 * `delivery_state` is the TRANSPORT layer ("did the bus deliver the wake?"); `recipient_state`
 * is the WORK layer ("did the recipient deal with it?"). They were never linked, so once a
 * recipient demonstrably ENGAGED (acked / replied / finished) the original wake's transport row
 * stayed orphaned at 'wake_dispatched' forever. openclaw/hermes don't pile up because their
 * bridge expires ambiguous wakes (expire_no_retry); claude_channel answers OUT OF BAND via its
 * own messaging tool, so the bus never sees a delivery-completion signal — the row sits red until
 * a TTL sweep expires it. (claude_channel agents accumulate dozens of orphans; bridge runtimes a handful.)
 *
 * Once the recipient has engaged, the wake WAS delivered, so advance the orphan
 * 'wake_dispatched' → 'completed' (provenance kept in last_error — a normally-NULL field on a
 * successful wake, so this overwrite loses nothing). Transport-only: recipient_state
 * is untouched, so 'acknowledged'/'in_progress' still correctly read as "engaged, not done" (no
 * false-green). SURGICAL: only 'wake_dispatched' — 'pending'/'dispatching' are left for the
 * dispatcher (completing them could drop an undelivered wake). Returns true if it closed an orphan.
 */
function closeOrphanedDelivery(db: Database, messageId: string, agentId: string): boolean {
  const res = db
    .prepare(
      `UPDATE message_recipient
       SET delivery_state = 'completed',
           last_error     = 'handled:recipient_engaged',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ? AND delivery_state = 'wake_dispatched'`,
    )
    .run(messageId, agentId);
  if (res.changes > 0) {
    appendAudit(db, agentId, "delivery_orphan_closed", messageId, {
      agent_id: agentId,
      from_state: "wake_dispatched",
      to_state: "completed",
      reason: "recipient_engaged",
    });
    return true;
  }
  return false;
}

/**
 * Classify the reply, resolve its target, decide the transition, and persist it
 * (idempotent UPDATE + audit). Pure decision lives in shared/recipientState; this is the
 * thin DB-bound shell. Returns what happened (for callers/tests/logging).
 */
export function applyAckClose(db: Database, reply: ReplyLike): AckCloseResult {
  if (reply.source !== "agent") return { applied: false };

  const target = resolveReplyTarget(db, reply);
  if (!target) return { applied: false };

  const cur = db
    .prepare(`SELECT recipient_state FROM message_recipient WHERE message_id = ? AND agent_id = ?`)
    .get(target.messageId, target.agentId) as { recipient_state: RecipientState } | undefined;
  if (!cur) return { applied: false };

  const signal = classifyReplySignal(reply.body);
  const decision = decideRecipientTransition({
    current: cur.recipient_state,
    signal,
    ambiguousMatch: target.ambiguous,
    source: "reply",
    closingMessageId: reply.id,
  });

  if (decision.noop) {
    return { applied: false, from: cur.recipient_state, to: cur.recipient_state, tier: target.tier };
  }

  // Idempotent UPDATE: guard on the exact current state we read, so a concurrent change
  // (or re-delivery of the same reply) updates 0 rows instead of double-applying.
  const res = db
    .prepare(
      `UPDATE message_recipient
       SET recipient_state = ?,
           close_reason = ?,
           state_source = ?,
           closing_message_id = ?,
           closed_at = ${decision.closedAt ? "datetime('now')" : "closed_at"}
       WHERE message_id = ? AND agent_id = ? AND recipient_state = ?`,
    )
    .run(
      decision.next,
      decision.closeReason,
      decision.state_source,
      decision.closing_message_id,
      target.messageId,
      target.agentId,
      cur.recipient_state,
    );

  if (res.changes === 0) {
    return { applied: false, from: cur.recipient_state, tier: target.tier };
  }

  // Audit (req#5) — queryable safety net for reply/ack-only closes & false-close hunting.
  appendAudit(db, target.agentId, "recipient_state_change", target.messageId, {
    agent_id: target.agentId,
    from_state: cur.recipient_state,
    to_state: decision.next,
    close_reason: decision.closeReason,
    state_source: decision.state_source,
    closing_message_id: decision.closing_message_id,
    match_tier: target.tier,
    signal,
  });

  // Transport coupling (root fix 2026-06-22): the recipient just engaged this exact message,
  // so its orphaned wake (if any) is delivered — close it. Skip needs_match_review: that
  // transition means we matched ambiguously, so we can't claim THIS wake was the right one.
  if (decision.next !== "needs_match_review") {
    closeOrphanedDelivery(db, target.messageId, target.agentId);
  }

  return {
    applied: true,
    from: cur.recipient_state,
    to: decision.next,
    closeReason: decision.closeReason,
    tier: target.tier,
  };
}

// ─── Inbox-refined: activity-based auto-ack ──────────────────────────────────
// Grace so a coincidental burst doesn't bury a just-arrived task: only rows older than
// this are eligible. Fresh messages (received < grace ago) stay 'open' (action-required)
// until genuinely handled. Tunes the cleanup to the historical backlog, not new work.
const ACTIVITY_ACK_GRACE_SECONDS = 30;

/**
 * When agent `senderId` emits ANY message, they are demonstrably alive — so their own
 * still-'open' received rows are not stuck red. Mark them acknowledged with
 * close_reason='activity_assumed' (inferred, kept distinct from a real reply ack). This
 * closes the silent-ack and answered-out-of-band (Telegram group) cases that an explicit
 * in_reply_to match never catches. Only lifts 'open' rows older than the grace window;
 * never touches in_progress/blocked/needs_match_review/terminal. Idempotent.
 *
 * @param excludeMessageId a message just handled by applyAckClose in the same insert — skip it.
 */
export function applyActivityAutoAck(
  db: Database,
  senderId: string,
  triggerMessageId: string,
  opts: { excludeMessageId?: string } = {},
): { acked: number } {
  const rows = db
    .prepare(
      `SELECT mr.message_id
       FROM message_recipient mr JOIN message m ON m.id = mr.message_id
       WHERE mr.agent_id = ?
         AND mr.recipient_state = 'open'
         AND mr.message_id != ?
         AND m.created_at < datetime('now', ?)`,
    )
    .all(senderId, triggerMessageId, `-${ACTIVITY_ACK_GRACE_SECONDS} seconds`) as Array<{ message_id: string }>;

  let acked = 0;
  for (const r of rows) {
    if (opts.excludeMessageId && r.message_id === opts.excludeMessageId) continue;
    const decision = decideRecipientTransition({
      current: "open",
      activityAck: true,
      source: "activity",
      closingMessageId: triggerMessageId,
    });
    if (decision.noop) continue;
    const res = db
      .prepare(
        `UPDATE message_recipient
         SET recipient_state = ?, close_reason = ?, state_source = ?, closing_message_id = ?
         WHERE message_id = ? AND agent_id = ? AND recipient_state = 'open'`,
      )
      .run(decision.next, decision.closeReason, decision.state_source, decision.closing_message_id, r.message_id, senderId);
    if (res.changes === 0) continue;
    acked++;
    appendAudit(db, senderId, "recipient_state_change", r.message_id, {
      agent_id: senderId,
      from_state: "open",
      to_state: decision.next,
      close_reason: decision.closeReason,
      state_source: decision.state_source,
      closing_message_id: decision.closing_message_id,
      via: "activity_auto_ack",
    });
    // Transport coupling (root fix 2026-06-22): the sender is alive and this row is now
    // acknowledged → its orphaned wake (the common claude_channel red-"대기" case) is delivered.
    closeOrphanedDelivery(db, r.message_id, senderId);
  }
  return { acked };
}

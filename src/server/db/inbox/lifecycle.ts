import type { Database } from "bun:sqlite";
import { RESOLVE_GRACE_SECONDS } from "./_shared";

/**
 * Phase 2a dedupe — if same dedupe_key was inserted in the last `windowSeconds`, return that id.
 */
export function findRecentDuplicate(
  db: Database,
  dedupe_key: string | null,
  windowSeconds = 60,
): string | null {
  if (!dedupe_key) return null;
  const row = db
    .prepare(
      `SELECT id FROM message
       WHERE dedupe_key = ? AND created_at > datetime('now', '-${windowSeconds} seconds')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(dedupe_key) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Phase 2a: mark unread messages whose expires_at has passed as 'expired'.
 */
export function expireOverdueMessages(db: Database): number {
  const result = db
    .prepare(
      `UPDATE message
       SET delivery_status = 'expired'
       WHERE expires_at IS NOT NULL
         AND expires_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         AND delivery_status IN ('pending','delivered')
         AND read_at IS NULL`,
    )
    .run();
  return result.changes;
}

/**
 * Phase 2a crash recovery: list open threads with non-idle state.
 */
export function listOpenInflightThreads(db: Database): Array<{ id: string; state: string; round_no: number }> {
  return db
    .prepare(
      `SELECT id, state, round_no FROM thread
       WHERE status = 'open' AND state != 'idle'`,
    )
    .all() as Array<{ id: string; state: string; round_no: number }>;
}

/**
 * Count automatic rounds (bot↔bot) in a chain via parent_message_id.
 * Returns the number of hops from the root of the conversation chain
 * that were sent by agents (source='agent'), up to maxDepth.
 */
export function countAutoRounds(
  db: Database,
  parentMessageId: string | null,
  maxDepth = 10,
): number {
  if (!parentMessageId) return 0;
  let count = 0;
  let currentId: string | null = parentMessageId;
  for (let i = 0; i < maxDepth && currentId; i++) {
    const row = db
      .prepare(
        `SELECT source, parent_message_id FROM message WHERE id = ?`,
      )
      .get(currentId) as { source: string; parent_message_id: string | null } | undefined;
    if (!row) break;
    if (row.source === "agent") count++;
    currentId = row.parent_message_id;
  }
  return count;
}

// ─── Team Bus member resolve (busviz-v1 topology view) ───────────────────────

export type ResolveAction = "expire" | "complete";

export interface ResolveResult {
  ok: boolean;
  agent_id: string;
  action: ResolveAction;
  applied_state: string; // expire → 'expired', complete → 'completed'
  affected_count: number;
  affected_message_ids: string[];
  skipped_recent: number; // pending/deferred within the grace window — protected, untouched
  remaining: number; // still-resolvable after this batch; >0 means call again
}

// Write-set cap per call (Gemini #1): bounds the resolve UPDATE so a large backlog
// can't hold a long write lock that stalls the dispatcher's polling.
const RESOLVE_BATCH_LIMIT = 500;

/**
 * Safely resolve a member's backlog of pending/deferred recipient rows.
 *
 * Guarded write — NEVER touches dispatching/wake_dispatched (in-flight), so it
 * cannot race the dispatcher's atomic `WHERE delivery_state='pending'` claim:
 *  - just-arrived protection: only rows whose message is older than the grace window
 *  - batch cap: at most RESOLVE_BATCH_LIMIT rows per call (bounded write lock)
 *  - single atomic UPDATE…RETURNING: the guard is re-checked in the WHERE, and the
 *    returned ids are exactly the rows changed (accurate audit even if a row
 *    transitioned out of pending between selection and write)
 *  - dry_run: reports affected/remaining without writing
 *  - audit: logs the changed message_ids (Gemini #4)
 */
export function resolvePendingForAgent(
  db: Database,
  agentId: string,
  action: ResolveAction,
  dryRun = false,
): ResolveResult {
  const applied_state = action === "expire" ? "expired" : "completed";
  const graceArg = `-${RESOLVE_GRACE_SECONDS} seconds`;

  const countResolvable = (): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM message_recipient mr
           JOIN message m ON m.id = mr.message_id
           WHERE mr.agent_id = ?
             AND mr.delivery_state IN ('pending', 'deferred')
             AND mr.recipient_state = 'open'
             AND m.created_at < datetime('now', ?)`,
        )
        .get(agentId, graceArg) as { cnt: number }
    ).cnt;

  const skipped_recent = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM message_recipient mr
         JOIN message m ON m.id = mr.message_id
         WHERE mr.agent_id = ?
           AND mr.delivery_state IN ('pending', 'deferred')
           AND mr.recipient_state = 'open'
           AND m.created_at >= datetime('now', ?)`,
      )
      .get(agentId, graceArg) as { cnt: number }
  ).cnt;

  if (dryRun) {
    const resolvable = countResolvable();
    return {
      ok: true,
      agent_id: agentId,
      action,
      applied_state,
      affected_count: Math.min(resolvable, RESOLVE_BATCH_LIMIT),
      affected_message_ids: [],
      skipped_recent,
      remaining: Math.max(0, resolvable - RESOLVE_BATCH_LIMIT),
    };
  }

  const updated = db
    .prepare(
      `UPDATE message_recipient
         SET delivery_state = ?, last_error = ?
       WHERE rowid IN (
         SELECT mr.rowid
         FROM message_recipient mr
         JOIN message m ON m.id = mr.message_id
         WHERE mr.agent_id = ?
           AND mr.delivery_state IN ('pending', 'deferred')
           AND mr.recipient_state = 'open'
           AND m.created_at < datetime('now', ?)
         ORDER BY m.created_at ASC
         LIMIT ?
       )
       RETURNING message_id`,
    )
    .all(
      applied_state,
      `busviz_resolve_${action}`,
      agentId,
      graceArg,
      RESOLVE_BATCH_LIMIT,
    ) as Array<{ message_id: string }>;

  const affected_message_ids = updated.map((r) => r.message_id);
  if (affected_message_ids.length > 0) {
    console.log(
      `[busviz_resolve] agent=${agentId} action=${action} → ${applied_state} ` +
        `affected=${affected_message_ids.length} ids=${JSON.stringify(affected_message_ids)}`,
    );
  }

  return {
    ok: true,
    agent_id: agentId,
    action,
    applied_state,
    affected_count: affected_message_ids.length,
    affected_message_ids,
    skipped_recent,
    remaining: countResolvable(),
  };
}

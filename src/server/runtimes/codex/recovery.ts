import type { Database } from "bun:sqlite";

// Codex runner default timeout is 240s. The stale threshold must be higher so
// periodic recovery cannot requeue a live turn before the CLI timeout resolves.
export const CODEX_INFLIGHT_STALE_SEC = 300;

export function recoverCodexInflight(db: Database, staleSec: number = CODEX_INFLIGHT_STALE_SEC): number {
  const stale = db
    .prepare(
      `SELECT message_id, agent_id, thread_id FROM codex_inflight
       WHERE started_at <= datetime('now', '-' || ? || ' seconds')`,
    )
    .all(staleSec) as { message_id: string; agent_id: string; thread_id: string }[];

  let redispatched = 0;
  for (const marker of stale) {
    const replied = db
      .prepare(`SELECT id FROM message WHERE in_reply_to = ? AND from_agent_id = ? LIMIT 1`)
      .get(marker.message_id, marker.agent_id) as { id: string } | undefined;

    if (!replied) {
      const res = db
        .prepare(
          `UPDATE message_recipient
           SET delivery_state = 'pending', claimed_at = NULL, lease_until = NULL
           WHERE message_id = ? AND agent_id = ? AND delivery_state NOT IN ('pending', 'dispatching')`,
        )
        .run(marker.message_id, marker.agent_id);
      if (res.changes > 0) redispatched++;
    }

    db.prepare(`DELETE FROM codex_inflight WHERE message_id = ? AND agent_id = ?`).run(
      marker.message_id,
      marker.agent_id,
    );
  }
  return redispatched;
}

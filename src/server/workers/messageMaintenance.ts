import type { Database } from "bun:sqlite";
import { expireOverdueMessages, listOpenInflightThreads } from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { appendAuditFile } from "../lib/auditFile";

const EXPIRE_TICK_MS = 30_000;

export function startMessageMaintenance(db: Database): () => void {
  // Crash recovery: scan open inflight threads on startup.
  const inflight = listOpenInflightThreads(db);
  for (const t of inflight) {
    appendAudit(db, "system", "thread_recovered_after_restart", t.id, {
      state: t.state,
      round_no: t.round_no,
    });
    appendAuditFile("system", "thread_recovered_after_restart", t.id, {
      state: t.state,
      round_no: t.round_no,
    });
  }
  if (inflight.length > 0) {
    console.log(`[recovery] restored ${inflight.length} open inflight thread(s)`);
  }

  // Periodic expiry sweep.
  const interval = setInterval(() => {
    try {
      const changed = expireOverdueMessages(db);
      if (changed > 0) {
        appendAudit(db, "system", "messages_expired", null, { count: changed });
        appendAuditFile("system", "messages_expired", null, { count: changed });
      }
    } catch (e) {
      console.error("[expire] sweep failed:", e);
    }
  }, EXPIRE_TICK_MS);

  return () => clearInterval(interval);
}

// Pending follow-up worker (2026-07-10) — deterministic ~60s tick that re-wakes a one-shot
// recipient once if it never delivered a report it was flagged to deliver. Core logic =
// bus/followupTracker.checkPendingFollowups (no LLM). Mirrors proposalSweeper's lightweight shape.
//   - 60s tick, 20s boot delay (avoid restart thundering herd).
//   - Per-tick volume bounded by checkPendingFollowups' internal LIMIT.
import type { Database } from "bun:sqlite";
import { checkPendingFollowups } from "../bus/followupTracker";
import { appendAudit } from "../db/queries";
import type { Broadcaster } from "./types";

const POLL_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 20_000;

export function startFollowupWorker(db: Database, broadcast?: Broadcaster): () => void {
  const tick = (): void => {
    try {
      const r = checkPendingFollowups(db, { broadcast });
      if (r.fulfilled.length || r.rewoken.length || r.gc.length) {
        appendAudit(db, "system", "followup_swept", null, {
          fulfilled: r.fulfilled.length,
          rewoken: r.rewoken.length,
          gc: r.gc.length,
        });
        console.log(`[followupWorker] fulfilled=${r.fulfilled.length} rewoken=${r.rewoken.length} gc=${r.gc.length}`);
      }
    } catch (e) {
      console.error("[followupWorker] tick failed:", e);
    }
  };
  const startTimer = setTimeout(tick, INITIAL_DELAY_MS);
  const interval = setInterval(tick, POLL_INTERVAL_MS);
  return () => {
    clearTimeout(startTimer);
    clearInterval(interval);
  };
}

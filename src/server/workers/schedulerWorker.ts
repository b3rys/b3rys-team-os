import type { Database } from "bun:sqlite";
import { appendAudit } from "../db/queries";
import { runDueSchedulerJobsOnce } from "../scheduler/core";

const DEFAULT_INTERVAL_MS = 60_000;

export function startSchedulerWorker(db: Database): () => void {
  const enabled = process.env.B3OS_SCHEDULER_ENABLED === "true";
  const dryRun = process.env.B3OS_SCHEDULER_DRY_RUN !== "0";
  const intervalMs = Math.max(5_000, Number(process.env.B3OS_SCHEDULER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS));
  if (!enabled) {
    console.log("[scheduler_worker] disabled (B3OS_SCHEDULER_ENABLED!=true)");
    return () => undefined;
  }

  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const results = await runDueSchedulerJobsOnce(db, { dryRun, lockOwner: "scheduler_worker" });
      if (results.length > 0) {
        appendAudit(db, "scheduler", "scheduler_tick", null, { dry_run: dryRun, results });
      }
    } catch (e) {
      appendAudit(db, "scheduler", "scheduler_tick_failed", null, {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  console.log(`[scheduler_worker] started — interval=${intervalMs}ms dry_run=${dryRun}`);

  return () => {
    clearInterval(timer);
    console.log("[scheduler_worker] stopped");
  };
}

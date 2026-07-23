import { Hono, type Context } from "hono";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { getScheduledJob, scheduleReminder } from "../scheduler/core";
import { appendAudit } from "../db/queries";
import { leadActorId, trustedActorFromRequest } from "../lib/opAuth";

interface SchedulerRouteDeps {
  db: Database;
  registeredAgentIds: () => Set<string>;
  schedulerAcceptingJobs?: () => boolean;
}

const reminderSchema = z
  .object({
    target_agent_id: z.string().min(1).max(64),
    body: z.string().min(1).max(2000),
    run_at: z.string().datetime().optional(),
    delay_seconds: z.number().int().positive().max(60 * 60 * 24 * 30).optional(),
    created_by: z.string().min(1).max(64).optional(),
    thread_id: z.string().min(4).max(32).optional(),
    title: z.string().min(1).max(200).optional(),
    direct_to_gd: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.run_at) !== Boolean(v.delay_seconds), {
    message: "provide exactly one of run_at or delay_seconds",
    path: ["run_at"],
  });

function authError(c: Context, auth: ReturnType<typeof trustedActorFromRequest>) {
  const status = (auth.status ?? 401) as 401 | 403 | 503;
  return c.json({ error: auth.error ?? "unauthorized" }, status);
}

function isLeadActor(db: Database, actor: string): boolean {
  return actor === leadActorId(db);
}

function directToGdPendingLimit(): number {
  return Math.max(1, Number(process.env.B3OS_SCHEDULER_DIRECT_TO_GD_PENDING_LIMIT ?? 5));
}

function directToGdHourlyLimit(): number {
  return Math.max(1, Number(process.env.B3OS_SCHEDULER_DIRECT_TO_GD_HOURLY_LIMIT ?? 10));
}

function countDirectToGdJobs(db: Database, actor: string, scope: "pending" | "hourly"): number {
  const where =
    scope === "pending"
      ? `created_by = ? AND status IN ('pending','running')`
      : `created_by = ? AND created_at >= datetime('now', '-1 hour')`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM scheduled_job
       WHERE ${where}
         AND payload_json LIKE '%"reply_mode":"direct_to_gd"%'`,
    )
    .get(actor) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function createSchedulerRoutes(deps: SchedulerRouteDeps): Hono {
  const r = new Hono();

  r.post("/schedules/reminder", async (c) => {
    const auth = trustedActorFromRequest(c.req.raw, { loopbackDashboardActor: leadActorId(deps.db) });
    if (!auth.ok || !auth.actor) return authError(c, auth);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = reminderSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "schema_validation", issues: parsed.error.issues }, 400);
    }
    const input = parsed.data;
    const acceptingJobs =
      deps.schedulerAcceptingJobs?.() ??
      (process.env.B3OS_SCHEDULER_ACCEPT_JOBS === "true" || process.env.B3OS_SCHEDULER_ENABLED === "true");
    if (!acceptingJobs) {
      return c.json(
        {
          error: "scheduler_disabled",
          hint: "b3os scheduler is not accepting new jobs; do not tell the user the reminder was scheduled.",
        },
        503,
      );
    }
    const actor = auth.actor.actor;
    const actorIsLead = isLeadActor(deps.db, actor);
    if (input.created_by && input.created_by !== actor) {
      return c.json({ error: "created_by_actor_mismatch" }, 403);
    }
    if (!deps.registeredAgentIds().has(input.target_agent_id)) {
      return c.json({ error: "unknown_target_agent", id: input.target_agent_id }, 400);
    }
    if (!actorIsLead && input.target_agent_id !== actor) {
      return c.json({ error: "target_agent_forbidden", actor, target_agent_id: input.target_agent_id }, 403);
    }
    if (input.direct_to_gd && !actorIsLead && input.target_agent_id !== actor) {
      return c.json({ error: "direct_to_gd_forbidden" }, 403);
    }
    if (input.direct_to_gd && !actorIsLead) {
      const pending = countDirectToGdJobs(deps.db, actor, "pending");
      if (pending >= directToGdPendingLimit()) {
        return c.json({ error: "direct_to_gd_pending_limit", limit: directToGdPendingLimit() }, 429);
      }
      const hourly = countDirectToGdJobs(deps.db, actor, "hourly");
      if (hourly >= directToGdHourlyLimit()) {
        return c.json({ error: "direct_to_gd_hourly_limit", limit: directToGdHourlyLimit() }, 429);
      }
    }
    const runAt = input.run_at ? new Date(input.run_at) : new Date(Date.now() + input.delay_seconds! * 1000);
    if (!Number.isFinite(runAt.getTime())) {
      return c.json({ error: "invalid_run_at" }, 400);
    }
    if (runAt.getTime() <= Date.now()) {
      return c.json({ error: "run_at_must_be_future" }, 400);
    }

    const job = scheduleReminder(deps.db, {
      targetAgentId: input.target_agent_id,
      body: input.body,
      runAt,
      createdBy: actor,
      threadId: input.thread_id,
      title: input.title,
      directToGd: input.direct_to_gd,
    });
    appendAudit(deps.db, actor, "scheduled_reminder_created", job.id, {
      target_agent_id: input.target_agent_id,
      next_run_at: job.next_run_at,
      direct_to_gd: input.direct_to_gd,
    });
    return c.json({ ok: true, job }, 201);
  });

  r.get("/schedules/:id", (c) => {
    const auth = trustedActorFromRequest(c.req.raw, { loopbackDashboardActor: leadActorId(deps.db) });
    if (!auth.ok || !auth.actor) return authError(c, auth);
    const id = c.req.param("id");
    const job = getScheduledJob(deps.db, id);
    if (!job) return c.json({ error: "not_found", id }, 404);
    const actor = auth.actor.actor;
    if (!isLeadActor(deps.db, actor) && job.created_by !== actor) {
      return c.json({ error: "schedule_forbidden", id }, 403);
    }
    return c.json({ job });
  });

  r.post("/schedules/:id/cancel", (c) => {
    const auth = trustedActorFromRequest(c.req.raw, { loopbackDashboardActor: leadActorId(deps.db) });
    if (!auth.ok || !auth.actor) return authError(c, auth);
    const id = c.req.param("id");
    const job = getScheduledJob(deps.db, id);
    if (!job) return c.json({ ok: false, error: "not_found_or_not_cancellable", id }, 404);
    const actor = auth.actor.actor;
    if (!isLeadActor(deps.db, actor) && job.created_by !== actor) {
      return c.json({ ok: false, error: "schedule_forbidden", id }, 403);
    }
    const result = deps.db
      .prepare(
        `UPDATE scheduled_job
         SET status = 'cancelled',
             enabled = 0,
             lock_until = NULL,
             lock_owner = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND status IN ('pending','running')`,
      )
      .run(id);
    if (result.changes === 0) return c.json({ ok: false, error: "not_found_or_not_cancellable", id }, 404);
    appendAudit(deps.db, actor, "scheduled_job_cancelled", id, null);
    return c.json({ ok: true, id });
  });

  return r;
}

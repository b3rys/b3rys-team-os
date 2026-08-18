import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../db/migrate";
import { seedKrHolidays } from "../db/migrate";
import {
  claimScheduledJob,
  computeCronNextRun,
  createCronJob,
  createScheduledJob,
  dueScheduledJobs,
  EXEC_ALLOWLIST,
  execScheduledJob,
  ensureDailyTaskReviewJobs,
  ensureWeeklySelfLearningJobs,
  fromSqliteDate,
  getScheduledJob,
  holidayCoverageThroughYear,
  isHolidayOn,
  pickCapabilityWorkloopTarget,
  runDueSchedulerJobsOnce,
  scheduleReminder,
  failScheduledJob,
  completeScheduledJob,
  skipScheduledJob,
  consecutiveFailures,
  lateWakeBanner,
  emitCapabilityWorkloop,
  ensureScheduledWorkflow,
  assignScheduledJobToWorkflow,
  skipWorkflowOccurrence,
  WEEKLY_SELF_LEARNING_WORKFLOW_ID,
} from "./core";
import { nextCronRun } from "./cron";

const learningPayload = {
  type: "capability_workloop" as const,
  capability: "learning_loop_pm",
  fallbackCapability: "coordinator",
  threadId: "weekly-self-learning",
  body: "weekly learning",
};

// A benign allowlist for exec unit tests — never spawns a real ops script.
const TEST_ALLOWLIST = {
  "echo-ok": { command: ["echo", "scheduler-exec-ok"], timeoutMs: 5_000, label: "test echo" },
  "exit-3": { command: ["bun", "-e", "process.exit(3)"], timeoutMs: 5_000, label: "test fail" },
  "sleep-long": { command: ["bun", "-e", "await Bun.sleep(3000)"], timeoutMs: 200, label: "test timeout" },
};

function execJob(d: ReturnType<typeof db>, execKey: string) {
  return createScheduledJob(d, {
    title: `exec ${execKey}`,
    kind: "oneshot",
    scheduleKind: "once",
    nextRunAt: new Date(),
    createdBy: "system",
    payload: { type: "exec", execKey },
  });
}

// A UTC instant for a given KST wall clock (KST = UTC+9, no DST).
function kst(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, 0));
}

function db() {
  const d = openDb(":memory:");
  migrate(d);
  d.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('dex','Dex','Codex runtime pilot','codex','codex_cli','/tmp/dex','/tmp/dex/AGENTS.md')`,
  ).run();
  return d;
}

describe("b3os scheduler core", () => {
  test("weekly learning seeds 04:00 curation and 05:00 proposal jobs idempotently", () => {
    const d = db();
    const first = ensureWeeklySelfLearningJobs(d);
    const second = ensureWeeklySelfLearningJobs(d);
    expect(second.map((job) => job.id)).toEqual(first.map((job) => job.id));
    expect(d.prepare(`SELECT count(*) AS n FROM scheduled_job WHERE id IN (?, ?)`).get(first[0]!.id, first[1]!.id)).toEqual({ n: 2 });
    expect(first.map((job) => [job.workflow_id, job.workflow_step_key, job.workflow_step_order])).toEqual([
      [WEEKLY_SELF_LEARNING_WORKFLOW_ID, "shared_curation", 10],
      [WEEKLY_SELF_LEARNING_WORKFLOW_ID, "self_learning", 20],
    ]);
    expect(d.prepare(`SELECT title FROM scheduled_workflow WHERE id = ?`).get(WEEKLY_SELF_LEARNING_WORKFLOW_ID)).toEqual({ title: "주간 러닝 세션" });
    expect(JSON.parse(first[0]!.schedule_expr!)).toMatchObject({ cron: "0 4 * * 5" });
    expect(JSON.parse(first[1]!.schedule_expr!)).toMatchObject({ cron: "0 5 * * 5" });
    expect(JSON.parse(first[0]!.payload_json)).toMatchObject({
      type: "capability_workloop",
      capability: "learning_loop_pm",
      fallbackCapability: "coordinator",
      threadId: "weekly-shared-curation",
    });
    const curationBody = JSON.parse(first[0]!.payload_json).body as string;
    expect(curationBody).toContain("proposal 등록 세션이 아닙니다");
    // rules/SHARED.md 는 gitignore 대상이라 커밋할 수 없다. 예전 문구("중앙 … 에 올립니다")를
    // 두 사람이 각각 "PR 로 올린다" 로 읽어 막혔다 → 방법을 문장에 박았는지 고정한다.
    expect(curationBody).toContain("커밋도 PR 도 하지 마세요");

    expect(JSON.parse(first[1]!.payload_json)).toMatchObject({
      type: "capability_workloop",
      capability: "coordinator",
      fallbackCapability: "learning_loop_pm",
      threadId: "weekly-self-learning",
    });
    const learningBody = JSON.parse(first[1]!.payload_json).body as string;
    // 라우터는 /team 아래에 붙는다. "POST /api/proposals" 로 시키면 404 가 난다.
    expect(learningBody).toContain("POST /team/api/proposals");
    expect(learningBody).not.toMatch(/등록 방법: POST \/api\/proposals/);

    // 두 루프 다 보고 경로가 런타임별로 갈린다는 것을 말해야 한다. 예전처럼
    // "send.sh --direct-to-gd" 만 적으면 발신자가 system 이라 서버가 거부한다.
    for (const body of [curationBody, learningBody]) {
      expect(body).toContain("보고 경로는 런타임마다 다릅니다");
      expect(body).not.toMatch(/정리 보고: send\.sh --direct-to-gd\./);
    }
  });

  test("weekly learning reconciles config drift on existing jobs", () => {
    const d = db();
    createCronJob(d, {
      id: "sched_weekly_self_learning_session",
      title: "old 11:30 job",
      cron: "30 11 * * 5",
      timezone: "Asia/Seoul",
      payload: learningPayload,
      from: kst(2026, 7, 20, 0, 0),
    });

    const jobs = ensureWeeklySelfLearningJobs(d);
    const session = jobs[1]!;
    expect(session.title).toBe("self-learning 세션 (금 05:00 KST)");
    expect(JSON.parse(session.schedule_expr!)).toMatchObject({ cron: "0 5 * * 5" });
    expect(JSON.parse(session.payload_json)).toMatchObject({ capability: "coordinator", fallbackCapability: "learning_loop_pm" });
    expect(session.status).toBe("pending");
    expect(session.enabled).toBe(1);
  });

  test("daily task review seeds portable 06:00/06:20 jobs idempotently", () => {
    const d = db();
    const first = ensureDailyTaskReviewJobs(d);
    const second = ensureDailyTaskReviewJobs(d);
    expect(first.map((j) => j.id)).toEqual(["sched_task_review_ping", "sched_task_review_summary"]);
    expect(second.map((j) => j.id)).toEqual(first.map((j) => j.id));
    expect(d.prepare(`SELECT count(*) AS n FROM scheduled_job WHERE id IN (?, ?)`).get(first[0]!.id, first[1]!.id)).toEqual({ n: 2 });
    expect(JSON.parse(first[0]!.schedule_expr!)).toMatchObject({ cron: "0 6 * * *" });
    expect(JSON.parse(first[1]!.schedule_expr!)).toMatchObject({ cron: "20 6 * * *" });
    expect(JSON.parse(first[0]!.payload_json)).toEqual({ type: "exec", execKey: "task-review-ping" });
    expect(JSON.parse(first[1]!.payload_json)).toEqual({ type: "exec", execKey: "task-review-summary" });
  });

  test("capability workloop targets PM, then coordinator, and never an arbitrary member", () => {
    const member = (id: string, capabilities: string[] = [], extra: Record<string, unknown> = {}) =>
      ({ id, capabilities, team_official_member: true, ...extra }) as any;
    expect(pickCapabilityWorkloopTarget([member("coord", ["coordinator"]), member("pm", ["learning_loop_pm"])], learningPayload)).toBe("pm");
    expect(pickCapabilityWorkloopTarget([member("coord", ["coordinator"]), member("plain")], learningPayload)).toBe("coord");
    expect(pickCapabilityWorkloopTarget([member("plain")], learningPayload)).toBeNull();
    expect(pickCapabilityWorkloopTarget([member("off", ["coordinator"], { enabled: false })], learningPayload)).toBeNull();
    expect(pickCapabilityWorkloopTarget([member("bot", ["coordinator", "non_interactive"])], learningPayload)).toBeNull();
    expect(pickCapabilityWorkloopTarget([], learningPayload)).toBeNull();
  });

  test("migration creates scheduler tables", () => {
    const d = db();
    const tables = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('scheduled_workflow','scheduled_job','scheduled_job_run','scheduled_workflow_exception')`).all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(["scheduled_job", "scheduled_job_run", "scheduled_workflow", "scheduled_workflow_exception"]);
  });

  test("workflow occurrence skip consumes every step atomically and is idempotent", () => {
    const d = db();
    ensureScheduledWorkflow(d, { id: "weekly-test", title: "Weekly test", timezone: "Asia/Seoul" });
    const a = createCronJob(d, {
      id: "weekly-test-a", title: "A", cron: "0 4 * * 5", timezone: "Asia/Seoul",
      from: kst(2026, 8, 17, 0, 0), payload: learningPayload,
    });
    const b = createCronJob(d, {
      id: "weekly-test-b", title: "B", cron: "0 10 * * 5", timezone: "Asia/Seoul",
      from: kst(2026, 8, 17, 0, 0), payload: learningPayload,
    });
    assignScheduledJobToWorkflow(d, a.id, "weekly-test", "prepare", 10);
    assignScheduledJobToWorkflow(d, b.id, "weekly-test", "report", 20);

    const result = skipWorkflowOccurrence(d, {
      workflowId: "weekly-test", occurrenceDate: "2026-08-21", actor: "gd", reason: "week off",
      now: kst(2026, 8, 18, 12, 0),
    });
    expect(result.skippedJobIds).toEqual([a.id, b.id]);
    expect(result.alreadySkipped).toBe(false);
    const rows = d.prepare(`SELECT id, next_run_at, run_count FROM scheduled_job WHERE workflow_id='weekly-test' ORDER BY workflow_step_order`).all() as Array<{ id: string; next_run_at: string; run_count: number }>;
    expect(rows.map((row) => fromSqliteDate(row.next_run_at))).toEqual([
      kst(2026, 8, 28, 4, 0),
      kst(2026, 8, 28, 10, 0),
    ]);
    expect(rows.map((row) => row.run_count)).toEqual([1, 1]);
    expect(d.prepare(`SELECT count(*) AS n FROM scheduled_job_run WHERE outcome='skipped' AND job_id IN (?, ?)`).get(a.id, b.id)).toEqual({ n: 2 });

    const repeated = skipWorkflowOccurrence(d, {
      workflowId: "weekly-test", occurrenceDate: "2026-08-21", actor: "gd", reason: "retry",
    });
    expect(repeated.alreadySkipped).toBe(true);
    expect(d.prepare(`SELECT sum(run_count) AS n FROM scheduled_job WHERE workflow_id='weekly-test'`).get()).toEqual({ n: 2 });
  });

  test("workflow occurrence skip rolls back when one step is on another occurrence", () => {
    const d = db();
    ensureScheduledWorkflow(d, { id: "weekly-mismatch", title: "Mismatch", timezone: "Asia/Seoul" });
    const a = createCronJob(d, { id: "mismatch-a", title: "A", cron: "0 4 * * 5", timezone: "Asia/Seoul", from: kst(2026, 8, 17, 0, 0), payload: learningPayload });
    const b = createCronJob(d, { id: "mismatch-b", title: "B", cron: "0 10 * * 5", timezone: "Asia/Seoul", from: kst(2026, 8, 24, 0, 0), payload: learningPayload });
    assignScheduledJobToWorkflow(d, a.id, "weekly-mismatch", "a", 10);
    assignScheduledJobToWorkflow(d, b.id, "weekly-mismatch", "b", 20);

    expect(() => skipWorkflowOccurrence(d, {
      workflowId: "weekly-mismatch", occurrenceDate: "2026-08-21", actor: "gd", reason: "week off",
    })).toThrow("scheduled_workflow_occurrence_mismatch:mismatch-b:2026-08-28");
    expect(d.prepare(`SELECT count(*) AS n FROM scheduled_workflow_exception WHERE workflow_id='weekly-mismatch'`).get()).toEqual({ n: 0 });
    expect(d.prepare(`SELECT sum(run_count) AS n FROM scheduled_job WHERE workflow_id='weekly-mismatch'`).get()).toEqual({ n: 0 });
  });

  test("scheduleReminder creates a one-shot scheduled inbox wake", () => {
    const d = db();
    const runAt = new Date(Date.now() + 60_000);
    const job = scheduleReminder(d, {
      targetAgentId: "dex",
      body: "[예약 알림] 테스트",
      runAt,
      createdBy: "dex",
      directToGd: true,
    });
    expect(job.kind).toBe("oneshot");
    expect(job.schedule_kind).toBe("once");
    expect(job.target_agent_id).toBe("dex");
    const meta = JSON.parse(job.payload_json).envelope.meta;
    expect(meta.reply_mode).toBe("direct_to_gd");
    expect(meta.requested_by).toBe("dex");
    expect(meta.requested_via).toBe("b3os_schedule_reminder");
  });

  test("due one-shot emits exactly one bus message and completes", async () => {
    const d = db();
    const now = new Date("2026-07-04T08:00:00Z");
    const job = scheduleReminder(d, {
      targetAgentId: "dex",
      body: "[예약 알림] due",
      runAt: new Date(now.getTime() - 1000),
      createdBy: "dex",
    });
    const results = await runDueSchedulerJobsOnce(d, { now });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("succeeded");
    const after = getScheduledJob(d, job.id)!;
    expect(after.status).toBe("succeeded");
    expect(after.enabled).toBe(0);
    const message = d.prepare(`SELECT * FROM message WHERE id = ?`).get(results[0]!.emittedMessageId!) as { to_agent_id: string; source: string } | undefined;
    expect(message?.to_agent_id).toBe("dex");
    expect(message?.source).toBe("agent");
    const rcpt = d.prepare(`SELECT delivery_state FROM message_recipient WHERE message_id = ? AND agent_id = 'dex'`).get(results[0]!.emittedMessageId!) as { delivery_state: string } | undefined;
    expect(rcpt?.delivery_state).toBe("pending");
  });

  test("dry-run consumes a one-shot so later ticks do not reprocess it", async () => {
    const d = db();
    const now = new Date("2026-07-04T08:00:00Z");
    const job = scheduleReminder(d, {
      targetAgentId: "dex",
      body: "[예약 알림] dry-run",
      runAt: new Date(now.getTime() - 1000),
      createdBy: "dex",
    });
    const results = await runDueSchedulerJobsOnce(d, { now, dryRun: true });
    expect(results[0]?.status).toBe("skipped");
    const after = getScheduledJob(d, job.id)!;
    expect(after.status).toBe("succeeded");
    expect(after.enabled).toBe(0);
    expect(await runDueSchedulerJobsOnce(d, { now: new Date(now.getTime() + 60_000), dryRun: true })).toEqual([]);
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 0 });
  });

  test("claim uses a lease so two workers cannot run the same job", () => {
    const d = db();
    const now = new Date("2026-07-04T08:00:00Z");
    const job = scheduleReminder(d, {
      targetAgentId: "dex",
      body: "[예약 알림] lease",
      runAt: new Date(now.getTime() - 1000),
      createdBy: "dex",
    });
    expect(claimScheduledJob(d, job.id, now, 120, "a")).toBe(true);
    expect(claimScheduledJob(d, job.id, now, 120, "b")).toBe(false);
  });

  test("interval recurring job computes the next run", async () => {
    const d = db();
    const now = new Date("2026-07-04T08:00:00Z");
    const job = createScheduledJob(d, {
      title: "interval",
      kind: "recurring",
      scheduleKind: "interval",
      nextRunAt: new Date(now.getTime() - 1000),
      targetAgentId: "dex",
      createdBy: "system",
      scheduleExpr: { minutes: 30 },
      payload: {
        type: "inbox",
        envelope: {
          from_agent_id: "system",
          to_agent_id: "dex",
          type: "dm",
          body: "interval wake",
          source: "agent",
          priority: "normal",
          hop_count: 0,
        },
      },
    });
    const result = (await runDueSchedulerJobsOnce(d, { now }))[0];
    expect(result?.status).toBe("succeeded");
    const after = getScheduledJob(d, job.id)!;
    expect(after.status).toBe("pending");
    expect(fromSqliteDate(after.next_run_at).getTime()).toBe(now.getTime() + 30 * 60_000);
  });

  test("migration seeds KR holidays", () => {
    const d = db();
    expect(isHolidayOn(d, "2026-08-15")).toBe(true); // 광복절
    expect(isHolidayOn(d, "2026-07-06")).toBe(false); // ordinary Monday
  });

  test("holidayCoverageThroughYear reports the seeded horizon", () => {
    const d = db();
    expect(holidayCoverageThroughYear(d)).toBe(2026);
  });

  test("KR holiday data is correct for 2026 (Steve cross-review must-fix)", () => {
    const d = db();
    expect(isHolidayOn(d, "2026-05-24")).toBe(true); // 부처님오신날 (일)
    expect(isHolidayOn(d, "2026-05-25")).toBe(true); // 대체공휴일 (월)
    expect(isHolidayOn(d, "2026-07-17")).toBe(true); // 제헌절 재지정
    // 5/5 is 어린이날 only — Buddha's birthday is NOT on 5/5 in 2026.
    const may5 = d.prepare("SELECT label FROM holiday WHERE country='KR' AND date='2026-05-05'").get() as { label: string };
    expect(may5.label).toBe("어린이날");
  });

  test("seedKrHolidays upserts a corrected label on re-seed", () => {
    const d = db();
    d.prepare("UPDATE holiday SET label = 'STALE' WHERE country='KR' AND date='2026-01-01'").run();
    seedKrHolidays(d); // re-run should overwrite STALE with the canonical label
    const row = d.prepare("SELECT label FROM holiday WHERE country='KR' AND date='2026-01-01'").get() as { label: string };
    expect(row.label).toBe("신정");
  });

  test("cron recurring job fires then reschedules to the next daily slot", async () => {
    const d = db();
    const from = kst(2026, 7, 6, 1, 0); // 01:00 KST — before 03:04
    const job = createCronJob(d, {
      title: "metrics-nightly",
      cron: "4 3 * * *",
      targetAgentId: "dex",
      createdBy: "system",
      timezone: "Asia/Seoul",
      from,
      payload: {
        type: "inbox",
        envelope: {
          from_agent_id: "system",
          to_agent_id: "dex",
          type: "dm",
          body: "nightly cron wake",
          source: "agent",
          priority: "normal",
          hop_count: 0,
        },
      },
    });
    // First slot = 03:04 KST same day.
    expect(fromSqliteDate(job.next_run_at).getTime()).toBe(kst(2026, 7, 6, 3, 4).getTime());
    expect(job.schedule_kind).toBe("cron");

    // Fire at 03:04 → succeeds, emits, and reschedules to the NEXT day's 03:04.
    const fireAt = kst(2026, 7, 6, 3, 4);
    const results = await runDueSchedulerJobsOnce(d, { now: fireAt });
    expect(results[0]?.status).toBe("succeeded");
    const after = getScheduledJob(d, job.id)!;
    expect(after.status).toBe("pending");
    expect(after.enabled).toBe(1);
    expect(after.run_count).toBe(1);
    expect(fromSqliteDate(after.next_run_at).getTime()).toBe(kst(2026, 7, 7, 3, 4).getTime());
  });

  test("cron job with holidayPolicy=skip jumps over a seeded holiday", () => {
    const d = db();
    // 2026-08-14 12:00 → next daily 09:00 candidate is the 15th (광복절, seeded).
    const job = createCronJob(d, {
      title: "skip-holiday",
      cron: "0 9 * * *",
      targetAgentId: "dex",
      createdBy: "system",
      holidayPolicy: "skip",
      from: kst(2026, 8, 14, 12, 0),
      payload: {
        type: "inbox",
        envelope: {
          from_agent_id: "system",
          to_agent_id: "dex",
          type: "dm",
          body: "skip wake",
          source: "agent",
          priority: "normal",
          hop_count: 0,
        },
      },
    });
    // 15th holiday + 17th holiday → first fire lands on the 16th.
    expect(fromSqliteDate(job.next_run_at).getTime()).toBe(kst(2026, 8, 16, 9, 0).getTime());
  });

  test("Asia/Seoul cron helper preserves legacy nextCronRun results", () => {
    const cases = [
      { cron: "0 9 * * *", from: kst(2026, 7, 6, 1, 0) },
      { cron: "0 9 * * 1", from: kst(2026, 7, 7, 12, 0) },
      { cron: "0 0 15 * 0", from: kst(2026, 7, 6, 12, 0) },
    ];
    for (const c of cases) {
      expect(computeCronNextRun(c.cron, c.from, { timezone: "Asia/Seoul" }).toISOString()).toBe(
        nextCronRun(c.cron, c.from, { timezone: "Asia/Seoul" }).toISOString(),
      );
    }
  });

  test("DST timezone cron creates first run and reschedules across spring-forward", async () => {
    const d = db();
    const job = createCronJob(d, {
      title: "ny-daily-6",
      cron: "0 6 * * *",
      timezone: "America/New_York",
      targetAgentId: "dex",
      createdBy: "system",
      from: new Date("2026-03-07T12:00:00.000Z"),
      payload: {
        type: "inbox",
        envelope: {
          from_agent_id: "system",
          to_agent_id: "dex",
          type: "dm",
          body: "ny cron wake",
          source: "agent",
          priority: "normal",
          hop_count: 0,
        },
      },
    });

    expect(job.next_run_at).toBe("2026-03-08 10:00:00"); // 06:00 EDT

    const results = await runDueSchedulerJobsOnce(d, { now: new Date("2026-03-08T10:00:00.000Z") });
    expect(results[0]?.status).toBe("succeeded");
    const after = getScheduledJob(d, job.id)!;
    expect(after.next_run_at).toBe("2026-03-09 10:00:00"); // still 06:00 EDT
  });

  test("DST timezone cron reconciles drift through ensureCronJob path", () => {
    const d = db();
    createCronJob(d, {
      id: "sched_task_review_ping",
      title: "old daily review",
      cron: "0 5 * * *",
      timezone: "Asia/Seoul",
      createdBy: "system",
      from: new Date("2026-03-07T12:00:00.000Z"),
      payload: { type: "exec", execKey: "task-review-ping" },
    });

    const original = process.env.B3OS_SCHEDULER_TIMEZONE;
    process.env.B3OS_SCHEDULER_TIMEZONE = "America/New_York";
    try {
      const [job] = ensureDailyTaskReviewJobs(d, { from: new Date("2026-03-07T12:00:00.000Z") });
      expect(job!.timezone).toBe("America/New_York");
      expect(job!.next_run_at).toBe("2026-03-08 10:00:00"); // 06:00 EDT
    } finally {
      if (original === undefined) delete process.env.B3OS_SCHEDULER_TIMEZONE;
      else process.env.B3OS_SCHEDULER_TIMEZONE = original;
    }
  });
});

describe("b3os scheduler exec jobs", () => {
  test("runs an allowlisted command and captures output", async () => {
    const d = db();
    const job = execJob(d, "echo-ok");
    const r = await execScheduledJob(job, { allowlist: TEST_ALLOWLIST });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdoutTail).toContain("scheduler-exec-ok");
  });

  test("rejects a non-allowlisted exec key (no spawn)", async () => {
    const d = db();
    const job = execJob(d, "rm-rf-everything");
    await expect(execScheduledJob(job, { allowlist: TEST_ALLOWLIST })).rejects.toThrow(/exec_key_not_allowlisted/);
  });

  test("throws on a non-zero exit", async () => {
    const d = db();
    const job = execJob(d, "exit-3");
    await expect(execScheduledJob(job, { allowlist: TEST_ALLOWLIST })).rejects.toThrow(/exec_failed.*exit3/);
  });

  test("kills and throws on timeout", async () => {
    const d = db();
    const job = execJob(d, "sleep-long");
    await expect(execScheduledJob(job, { allowlist: TEST_ALLOWLIST })).rejects.toThrow(/exec_timeout/);
  });

  test("the production allowlist only contains the vetted ops scripts (argv-only)", () => {
    // ★이 목록은 의도적으로 못박아 둔다★ — 여기 한 줄 추가 = ★서버 권한 코드실행 등록★ 이다.
    //   테스트가 깨지는 게 정상이고, 깨져야 사람이 한 번 더 본다. 목록을 늘렸으면 여기도 같이 고쳐라.
    // (2026-07-17: task-continuation-guard 를 launchd 에서 이관하며 추가 — GD 승인)
    expect(Object.keys(EXEC_ALLOWLIST).sort()).toEqual([
      "task-continuation-guard",
      "task-review-ping",
      "task-review-summary",
      "workloop-kanban",
    ]);
    for (const spec of Object.values(EXEC_ALLOWLIST)) {
      // argv array (no shell string) → no injection surface
      expect(Array.isArray(spec.command)).toBe(true);
      expect(spec.command[0]).toBe("bun");
      expect(spec.command.some((a) => a.includes("&&") || a.includes(";") || a.includes("|"))).toBe(false);
    }
  });

  test("run-loop routes an exec cron job: fires, records outcome, reschedules", async () => {
    const d = db();
    // Inject a benign key via opts.allowlist (no mutation of the frozen production allowlist).
    const allowlist = { ...(EXEC_ALLOWLIST as Record<string, (typeof TEST_ALLOWLIST)["echo-ok"]>), "__test-echo": TEST_ALLOWLIST["echo-ok"] };
    const from = kst(2026, 7, 6, 1, 0);
    const job = createCronJob(d, {
      id: "exec-cron-test",
      title: "exec cron",
      cron: "4 3 * * *",
      timezone: "Asia/Seoul",
      createdBy: "system",
      from,
      payload: { type: "exec", execKey: "__test-echo" },
    });
    const fireAt = kst(2026, 7, 6, 3, 4);
    const results = await runDueSchedulerJobsOnce(d, { now: fireAt, allowlist });
    expect(results[0]?.status).toBe("succeeded");
    const after = getScheduledJob(d, job.id)!;
    expect(after.status).toBe("pending");
    expect(after.enabled).toBe(1);
    expect(fromSqliteDate(after.next_run_at).getTime()).toBe(kst(2026, 7, 7, 3, 4).getTime());
    const run = d.prepare(`SELECT outcome, detail_json FROM scheduled_job_run WHERE job_id=? ORDER BY started_at DESC LIMIT 1`).get(job.id) as { outcome: string; detail_json: string };
    expect(run.outcome).toBe("succeeded");
    expect(JSON.parse(run.detail_json).execKey).toBe("__test-echo");
  });

  test("prototype-pollution keys are rejected, not resolved to Object.prototype", async () => {
    const d = db();
    for (const key of ["__proto__", "constructor", "hasOwnProperty"]) {
      const job = execJob(d, key);
      await expect(execScheduledJob(job, { allowlist: TEST_ALLOWLIST })).rejects.toThrow(/exec_key_not_allowlisted/);
    }
  });

  test("the production allowlist is frozen (cannot be mutated at runtime)", () => {
    expect(Object.isFrozen(EXEC_ALLOWLIST)).toBe(true);
    expect(() => {
      (EXEC_ALLOWLIST as Record<string, unknown>)["evil"] = { command: ["rm", "-rf"], timeoutMs: 1, label: "x" };
    }).toThrow();
  });

  test("a corrupt payload_json row is parked 'failed' and does NOT abort the batch (poison-pill guard)", async () => {
    const d = db();
    const now = new Date("2026-07-04T08:00:00Z");
    // A valid due one-shot that must still fire despite a sibling corrupt row.
    const good = scheduleReminder(d, {
      targetAgentId: "dex",
      body: "[예약 알림] good",
      runAt: new Date(now.getTime() - 2000),
      createdBy: "dex",
    });
    // Inject a corrupt payload_json row directly (createScheduledJob would stringify valid JSON).
    d.prepare(
      `INSERT INTO scheduled_job (id, kind, schedule_kind, status, enabled, title, created_by, timezone, next_run_at, payload_json)
       VALUES ('corrupt1','oneshot','once','pending',1,'corrupt','system','Asia/Seoul', ?, '{')`,
    ).run(toSqliteDateForTest(new Date(now.getTime() - 1000)));

    // Must NOT throw — the whole batch would otherwise die every poll.
    const results = await runDueSchedulerJobsOnce(d, { now });
    const byId = Object.fromEntries(results.map((r) => [r.jobId, r.status]));
    expect(byId["corrupt1"]).toBe("failed");
    expect(byId[good.id]).toBe("succeeded");
    // corrupt row parked failed (not re-selectable), good row rescheduled/consumed.
    expect(getScheduledJob(d, "corrupt1")!.status).toBe("failed");
  });
});

function toSqliteDateForTest(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// Misfire grace — the Mac is off for days, then every overdue job comes due in one tick.
// A stale slot must skip forward instead of firing late.
describe("b3os scheduler misfire grace", () => {
  const GRACE_ENV = "SCHEDULER_MISFIRE_GRACE_SEC";
  const GRACE_2H = "7200";   // 기본은 꺼져 있다 — 켜야 검사할 수 있다

  async function withGrace<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env[GRACE_ENV];
    if (value === undefined) delete process.env[GRACE_ENV];
    else process.env[GRACE_ENV] = value;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env[GRACE_ENV];
      else process.env[GRACE_ENV] = prev;
    }
  }

  /** A recurring daily job whose due slot sits `lateHours` hours in the past. */
  function overdueDailyJob(
    d: ReturnType<typeof db>,
    id: string,
    lateHours: number,
    now: Date,
    misfirePolicy?: "coalesce" | "catch_up_once",
  ) {
    const job = createCronJob(d, {
      id,
      title: "daily ping",
      cron: "0 6 * * *",
      payload: {
        type: "inbox",
        envelope: { from_agent_id: "dex", to_agent_id: "dex", body: "[예약] daily", thread_id: "misfire" },
      } as never,
      targetAgentId: "dex",
      createdBy: "dex",
      misfirePolicy,
    });
    d.prepare(`UPDATE scheduled_job SET next_run_at = ? WHERE id = ?`).run(
      toSqliteDateForTest(new Date(now.getTime() - lateHours * 3600_000)),
      job.id,
    );
    return getScheduledJob(d, job.id)!;
  }

  const NOW = new Date("2026-07-29T05:00:00Z");

  test("a slot missed by more than the grace window is skipped, not fired late", async () => {
    const d = db();
    const job = overdueDailyJob(d, "m_stale", 8, NOW);
    const results = await withGrace(GRACE_2H, () => runDueSchedulerJobsOnce(d, { now: NOW }));
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("skipped");
    // No bus message — the whole point is that a stale reminder is noise, not a reminder.
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 0 });
    // Still scheduled: skipping advances the slot, it does not disable the job.
    const after = getScheduledJob(d, job.id)!;
    expect(after.enabled).toBe(1);
    expect(fromSqliteDate(after.next_run_at).getTime()).toBeGreaterThan(NOW.getTime());
    // Visible in history rather than silently vanishing.
    const run = d
      .prepare(`SELECT outcome, detail_json FROM scheduled_job_run WHERE job_id = ?`)
      .get(job.id) as { outcome: string; detail_json: string };
    expect(run.outcome).toBe("skipped");
    expect(JSON.parse(run.detail_json).reason).toBe("misfire_stale");
  });

  test("a slot inside the grace window still fires", async () => {
    const d = db();
    overdueDailyJob(d, "m_fresh", 1, NOW);
    const results = await withGrace(GRACE_2H, () => runDueSchedulerJobsOnce(d, { now: NOW }));
    expect(results[0]?.status).toBe("succeeded");
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 1 });
  });

  test("misfire_policy catch_up_once still runs however late", async () => {
    const d = db();
    overdueDailyJob(d, "m_catchup", 72, NOW, "catch_up_once");
    const results = await withGrace(GRACE_2H, () => runDueSchedulerJobsOnce(d, { now: NOW }));
    expect(results[0]?.status).toBe("succeeded");
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 1 });
  });

  test("grace 0 disables skipping explicitly too", async () => {
    const d = db();
    overdueDailyJob(d, "m_off", 72, NOW);
    const results = await withGrace("0", () => runDueSchedulerJobsOnce(d, { now: NOW }));
    expect(results[0]?.status).toBe("succeeded");
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 1 });
  });

  test("a malformed grace value falls back to the default, it does not skip everything", async () => {
    const d = db();
    overdueDailyJob(d, "m_bad", 1, NOW);
    const results = await withGrace("nonsense", () => runDueSchedulerJobsOnce(d, { now: NOW }));
    expect(results[0]?.status).toBe("succeeded");
  });

  // One rule for every kind — off at the slot means it does not arrive.
  test("a stale one-shot reminder is skipped too — same rule for every kind", async () => {
    const d = db();
    const job = scheduleReminder(d, {
      targetAgentId: "dex",
      body: "[예약 알림] 지난 알림",
      runAt: new Date(NOW.getTime() - 48 * 3600_000),
      createdBy: "dex",
    });
    const results = await withGrace(GRACE_2H, () => runDueSchedulerJobsOnce(d, { now: NOW }));
    expect(results[0]?.status).toBe("skipped");
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 0 });
    // Consumed, not left pending — otherwise every tick re-claims it forever.
    const after = getScheduledJob(d, job.id)!;
    expect(after.enabled).toBe(0);
    expect(after.status).toBe("succeeded");
  });

  // Through the PUBLIC creation API, not a post-hoc SQL UPDATE. Patching the row directly
  // would pass even if scheduleReminder dropped the option on the floor — which it did,
  // and the SQL-UPDATE version of this test hid exactly that. (codex review)
  test("a one-shot that must arrive however late opts out via the creation API", async () => {
    const d = db();
    const job = scheduleReminder(d, {
      targetAgentId: "dex",
      body: "[예약 알림] 늦어도 와야 함",
      runAt: new Date(NOW.getTime() - 48 * 3600_000),
      createdBy: "dex",
      misfirePolicy: "catch_up_once",
    });
    expect(getScheduledJob(d, job.id)!.misfire_policy).toBe("catch_up_once");
    const results = await withGrace(GRACE_2H, () => runDueSchedulerJobsOnce(d, { now: NOW }));
    expect(results[0]?.status).toBe("succeeded");
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 1 });
  });

  test("a reminder created without the option keeps the default policy", async () => {
    const d = db();
    const job = scheduleReminder(d, {
      targetAgentId: "dex",
      body: "[예약 알림] 기본",
      runAt: new Date(NOW.getTime() + 3600_000),
      createdBy: "dex",
    });
    expect(getScheduledJob(d, job.id)!.misfire_policy).toBe("coalesce");
  });

  // A skip bumps run_count, so it must end the job at max_runs exactly like a real run.
  // Otherwise skipping the last allowed slot buys the job one extra run. (codex review)
  test("skipping the last allowed slot does not let a max_runs job overshoot", async () => {
    const d = db();
    const job = overdueDailyJob(d, "m_cap", 8, NOW);
    d.prepare(`UPDATE scheduled_job SET max_runs = 1, run_count = 0 WHERE id = ?`).run(job.id);
    const results = await withGrace(GRACE_2H, () => runDueSchedulerJobsOnce(d, { now: NOW }));
    expect(results[0]?.status).toBe("skipped");
    const after = getScheduledJob(d, job.id)!;
    expect(after.run_count).toBe(1);
    // Cap consumed → the job is done, not waiting for one more turn.
    expect(after.enabled).toBe(0);
    expect(after.status).toBe("succeeded");
    // And a later tick must not resurrect it.
    const later = await withGrace(undefined, () =>
      runDueSchedulerJobsOnce(d, { now: new Date(NOW.getTime() + 7 * 24 * 3600_000) }),
    );
    expect(later).toEqual([]);
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 0 });
  });

  test("a recurring job under its max_runs cap keeps going after a skip", async () => {
    const d = db();
    const job = overdueDailyJob(d, "m_cap_ok", 8, NOW);
    d.prepare(`UPDATE scheduled_job SET max_runs = 5, run_count = 0 WHERE id = ?`).run(job.id);
    await withGrace(GRACE_2H, () => runDueSchedulerJobsOnce(d, { now: NOW }));
    const after = getScheduledJob(d, job.id)!;
    expect(after.enabled).toBe(1);
    expect(after.status).toBe("pending");
  });

  // 기본은 꺼져 있다. 이게 뒤집히면 "며칠 껐다 켰더니 아무것도 안 왔다" 가 된다.
  test("misfire skipping is OFF by default — a stale slot still fires", async () => {
    const d = db();
    overdueDailyJob(d, "m_default_off", 72, NOW);
    const results = await withGrace(undefined, () => runDueSchedulerJobsOnce(d, { now: NOW }));
    expect(results[0]?.status).toBe("succeeded");
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 1 });
  });

  test("a stale one-shot also fires by default", async () => {
    const d = db();
    scheduleReminder(d, {
      targetAgentId: "dex",
      body: "[예약 알림] 기본은 켜져 온다",
      runAt: new Date(NOW.getTime() - 48 * 3600_000),
      createdBy: "dex",
    });
    const results = await withGrace(undefined, () => runDueSchedulerJobsOnce(d, { now: NOW }));
    expect(results[0]?.status).toBe("succeeded");
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 1 });
  });

  test("many overdue jobs in one tick are all skipped — the boot burst is why this exists", async () => {
    const d = db();
    for (let i = 0; i < 5; i++) overdueDailyJob(d, `m_burst${i}`, 24 + i, NOW, i % 2 === 0 ? undefined : "coalesce");
    const results = await withGrace(GRACE_2H, () => runDueSchedulerJobsOnce(d, { now: NOW, limit: 20 }));
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === "skipped")).toBe(true);
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 실패한 반복 잡의 재예약 (2026-07-30 사고)
//   사고: 부팅 경합으로 한 번 실패한 30분 주기 잡이 ★9시간 정지★. 원인은 일시적인데 결과가 영구적.
//   근본: failScheduledJob 이 next_run_at 을 안 옮기는데 dueScheduledJobs 는 status='pending' 만 고른다.
//   ★검증은 "행 값이 바뀌었나" 가 아니라 "스케줄러가 다시 뽑나" 로 한다★ — 값만 보면 선정 쿼리와
//   어긋나도 통과한다(그게 원래 사고의 모양이었다: 값은 멀쩡해 보이는데 아무도 안 뽑았다).
// ─────────────────────────────────────────────────────────────────────────────
describe("실패한 반복 잡은 다음 슬롯으로 되살아난다", () => {
  const T0 = new Date(Date.UTC(2026, 6, 30, 0, 0, 0)); // 2026-07-30 09:00 KST
  function every30(d: ReturnType<typeof db>, id = "guard") {
    const job = createCronJob(d, {
      id,
      title: "30분 가드",
      cron: "*/30 * * * *",
      timezone: "Asia/Seoul",
      createdBy: "system",
      payload: { type: "exec", execKey: "task-review-ping" },
      from: T0,
    });
    return getScheduledJob(d, job.id)!;
  }
  const due = (d: ReturnType<typeof db>, at: Date) => dueScheduledJobs(d, at).map((j) => j.id);

  test("★한 번 실패해도 스케줄러가 다시 뽑는다★ (사고 회귀)", () => {
    const d = db();
    const job = every30(d);
    failScheduledJob(d, job, "boot race: Unable to connect", { now: T0 });

    const after = getScheduledJob(d, job.id)!;
    expect(after.status).toBe("pending");
    // 다음 시각이 ★앞으로★ 갔는지 — 실패 시각보다 미래여야 한다.
    expect(fromSqliteDate(after.next_run_at!).getTime()).toBeGreaterThan(T0.getTime());
    // ★공개 경로 검증★: 그 시각이 되면 선정 쿼리가 실제로 이 잡을 집는다.
    expect(due(d, fromSqliteDate(after.next_run_at!))).toContain(job.id);
    // 실패 기록 자체는 남는다(원인 추적용).
    expect(after.last_error).toContain("Unable to connect");
  });

  test("고치기 전 동작(영구 정지)이 되살아나면 실패한다 — 한도 전에는 park 하지 않는다", () => {
    const d = db();
    const job = every30(d);
    failScheduledJob(d, job, "일시적", { now: T0 });
    expect(getScheduledJob(d, job.id)!.status).not.toBe("failed");
  });

  test("★연속 3회 실패하면 park★ — 진짜 고장이 30분마다 영원히 헛돌지 않게", () => {
    const d = db();
    let job = every30(d);
    for (let i = 0; i < 3; i++) {
      job = getScheduledJob(d, job.id)!;
      failScheduledJob(d, job, `계속 깨짐 #${i + 1}`, { now: new Date(T0.getTime() + i * 60_000) });
    }
    const parked = getScheduledJob(d, job.id)!;
    expect(parked.status).toBe("failed");
    // park 된 뒤에는 시각이 지나도 아무도 안 뽑는다 = 헛돌지 않는다.
    expect(due(d, new Date(T0.getTime() + 24 * 3600_000))).not.toContain(job.id);
    // park 은 흔적을 남긴다(조용히 죽지 않는다).
    const audit = d
      .prepare(`SELECT detail_json FROM audit_event WHERE action = 'scheduler_job_parked'`)
      .all() as Array<{ detail_json: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail_json)).toMatchObject({ job_id: job.id, reason: "retry_limit", limit: 3 });
  });

  test("중간에 성공하면 연속 카운트가 리셋된다 — 가끔 실패하는 잡이 park 되지 않게", () => {
    const d = db();
    let job = every30(d);
    failScheduledJob(d, job, "1", { now: T0 });
    job = getScheduledJob(d, job.id)!;
    failScheduledJob(d, job, "2", { now: new Date(T0.getTime() + 60_000) });
    job = getScheduledJob(d, job.id)!;
    completeScheduledJob(d, job, { now: new Date(T0.getTime() + 120_000) });   // ← 한 번 성공
    job = getScheduledJob(d, job.id)!;
    failScheduledJob(d, job, "3", { now: new Date(T0.getTime() + 180_000) });
    // 누적 3회지만 연속은 1회 → 아직 살아 있어야 한다.
    expect(getScheduledJob(d, job.id)!.status).toBe("pending");
  });

  test("oneshot 은 재예약하지 않는다 — 다음 차례라는 게 없다", () => {
    const d = db();
    const job = execJob(d, "echo-ok");
    failScheduledJob(d, job, "한 번짜리", { now: T0 });
    expect(getScheduledJob(d, job.id)!.status).toBe("failed");
  });

  test("cron 표현식이 깨졌으면 park 한다 — 되살려봐야 매번 같은 자리에서 죽는다", () => {
    const d = db();
    const job = every30(d, "broken");
    d.prepare(`UPDATE scheduled_job SET schedule_expr = '{"cron":""}' WHERE id = ?`).run(job.id);
    failScheduledJob(d, getScheduledJob(d, job.id)!, "표현식 깨짐", { now: T0 });
    expect(getScheduledJob(d, job.id)!.status).toBe("failed");
  });

  test("max_runs 를 다 쓴 잡은 재예약하지 않는다", () => {
    const d = db();
    const job = every30(d, "capped");
    d.prepare(`UPDATE scheduled_job SET max_runs = 2, run_count = 2 WHERE id = ?`).run(job.id);
    failScheduledJob(d, getScheduledJob(d, job.id)!, "상한 소진", { now: T0 });
    const row = getScheduledJob(d, job.id)!;
    expect(row.status).toBe("failed");
    const audit = d.prepare(`SELECT detail_json FROM audit_event WHERE action='scheduler_job_parked'`).get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({ reason: "max_runs_reached" });
  });
});

// steve 리뷰에서 나온 실질 위험: skip 이 연속 카운트를 리셋해 ★진짜 고장이 영원히 park 되지 않는다.★
// 오늘은 잠복(미스파이어 유예 기본 꺼짐)이지만 그 env 를 켜면 살아난다.
describe("연속 실패 카운트는 성공에서만 끊긴다", () => {
  const T0 = new Date(Date.UTC(2026, 6, 30, 0, 0, 0));
  function guard(d: ReturnType<typeof db>) {
    const j = createCronJob(d, {
      id: "skipmix", title: "30분 가드", cron: "*/30 * * * *", timezone: "Asia/Seoul",
      createdBy: "system", payload: { type: "exec", execKey: "task-review-ping" }, from: T0,
    });
    return getScheduledJob(d, j.id)!;
  }

  test("★skip 이 섞여도 연속 카운트가 리셋되지 않는다★ — 실패·skip·실패·skip·실패 = park", () => {
    const d = db();
    let job = guard(d);
    for (let i = 0; i < 3; i++) {
      job = getScheduledJob(d, job.id)!;
      failScheduledJob(d, job, `깨짐 ${i + 1}`, { now: new Date(T0.getTime() + i * 2 * 60_000) });
      if (i < 2) {
        job = getScheduledJob(d, job.id)!;
        skipScheduledJob(d, job, "misfire", { now: new Date(T0.getTime() + (i * 2 + 1) * 60_000) });
      }
    }
    // skip 이 리셋했다면 연속은 1 이라 계속 살아 있다 = 영원히 park 안 됨.
    expect(getScheduledJob(d, job.id)!.status).toBe("failed");
  });

  test("skip 자체는 실패로 세지 않는다 — '돌려보지도 않았다' 는 고장의 증거가 아니다", () => {
    const d = db();
    let job = guard(d);
    for (let i = 0; i < 3; i++) {
      job = getScheduledJob(d, job.id)!;
      skipScheduledJob(d, job, "misfire", { now: new Date(T0.getTime() + i * 60_000) });
    }
    expect(consecutiveFailures(d, job.id, 5)).toBe(0);
  });

  test("성공은 연속을 끊는다", () => {
    const d = db();
    let job = guard(d);
    failScheduledJob(d, job, "1", { now: T0 });
    job = getScheduledJob(d, job.id)!;
    completeScheduledJob(d, job, { now: new Date(T0.getTime() + 60_000) });
    job = getScheduledJob(d, job.id)!;
    failScheduledJob(d, job, "2", { now: new Date(T0.getTime() + 120_000) });
    expect(consecutiveFailures(d, job.id, 5)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 늦은 깨움 배너 + 봉투가 다른 job 의 결과를 단정하지 않는다 (prop_696c5d65b2d5)
//
// 실측 배경(2026-08-13): 맥이 자다 깨면 밀린 슬롯이 부팅 직후 한꺼번에 돈다.
// 그날 23:52:05 UTC 한 초에 8개 job 이 실행됐고, 04:00 SHARED 정리와 05:00 self-learning 의
// 1시간 간격이 0초가 됐다. 그 사실은 scheduled_job_run 에만 남고 ★깨어난 당사자에겐 안 갔다.★
// ─────────────────────────────────────────────────────────────────────────────
describe("늦은 깨움은 봉투에 사실로 실린다", () => {
  // 2026-08-14 금 05:00 KST 예정 슬롯 = 2026-08-13 20:00 UTC.
  const DUE = kst(2026, 8, 14, 5, 0);

  // ★테스트가 라이브 agents.json 을 읽지 않게 격리한다★ — ambientAgents 의 기본 경로는
  // <repo>/agents.json 이고, 그건 팀 전체의 런타임 상태다(b3os-infra-safety ④).
  // 파일 하나를 tmp 에 새로 쓰고 TEAM_AGENT_REGISTRY 로 명시한다(캐시가 경로+mtime 키라 매번 새 파일).
  let registryDir: string | undefined;
  let prevRegistry: string | undefined;
  beforeEach(() => {
    prevRegistry = process.env.TEAM_AGENT_REGISTRY;
    registryDir = mkdtempSync(join(tmpdir(), "b3os-sched-reg-"));
    const registryPath = join(registryDir, "agents.json");
    writeFileSync(registryPath, JSON.stringify([
      { id: "dex", display_name: "Dex", role: "Codex runtime pilot", runtime: "codex",
        capabilities: ["learning_loop_pm", "coordinator"], enabled: true },
    ]));
    process.env.TEAM_AGENT_REGISTRY = registryPath;
  });
  afterEach(() => {
    if (prevRegistry === undefined) delete process.env.TEAM_AGENT_REGISTRY;
    else process.env.TEAM_AGENT_REGISTRY = prevRegistry;
    // ★만든 것은 지운다★ — 없으면 수트를 한 번 돌 때마다 tmpdir 에 이 describe 의 테스트 수만큼
    // 디렉토리가 쌓인다(codex 리뷰 실측: 누적 80개). 검사가 남기는 쓰레기도 검사의 결함이다.
    if (registryDir) rmSync(registryDir, { recursive: true, force: true });
    registryDir = undefined;
  });

  function workloopJob(d: ReturnType<typeof db>, id = "sched_late_probe") {
    const j = createCronJob(d, {
      id, title: "self-learning", cron: "0 5 * * 5", timezone: "Asia/Seoul",
      createdBy: "system", payload: learningPayload, from: new Date(DUE.getTime() - 1000),
    });
    return getScheduledJob(d, j.id)!;
  }

  // ★정시일 때 봉투가 한 글자도 안 바뀌는지부터 고정한다.★ 이게 없으면 "항상 붙이는" 구현이
  // 아래 지연 검사를 전부 통과한다 — 가짜가 통과하는 길을 먼저 막는다.
  test("정시 깨움은 원문 그대로 — 배너 0자", () => {
    const d = db();
    const job = workloopJob(d);
    expect(lateWakeBanner(job, DUE)).toBe("");
    const out = emitCapabilityWorkloop(d, job, learningPayload, DUE);
    const body = d.prepare(`SELECT body FROM message WHERE id = ?`).get(out.emittedMessageId!) as { body: string };
    expect(body.body).toBe(learningPayload.body); // 부분일치가 아니라 완전일치
  });

  test("임계는 15분 — 14분은 조용하고 16분은 말한다", () => {
    const d = db();
    const job = workloopJob(d);
    expect(lateWakeBanner(job, new Date(DUE.getTime() + 14 * 60_000))).toBe("");
    expect(lateWakeBanner(job, new Date(DUE.getTime() + 16 * 60_000))).toContain("16분 늦게");
  });

  // 08-13 실측 재현: 예정 05:00 KST → 실제 08:52 KST = 232분 지연.
  test("실제로 있었던 232분 지연이 시각·간격까지 그대로 찍힌다", () => {
    const d = db();
    const job = workloopJob(d);
    const banner = lateWakeBanner(job, kst(2026, 8, 14, 8, 52));
    // ★시간+분을 둘 다 읽는다★ — 분을 버리면 3시간 52분이 "3시간" 으로 반올림돼도 통과한다.
    expect(banner).toContain("3시간 52분 늦게");
    // 이 두 줄은 job 시간대(Asia/Seoul) 기준이다. bun test 의 기본 TZ 는 UTC 라
    // 구현이 로컬 포맷을 쓰면 UTC(20:00 / 23:52)로 찍혀 실패한다 — ★단 그건 기본 TZ 일 때만이다.★
    // TZ=Asia/Seoul 로 돌리면 로컬 == job 시간대라 같은 문자열이 나온다(아래 별도 검사 참고).
    expect(banner).toContain("예정 2026-08-14 05:00");
    expect(banner).toContain("실제 2026-08-14 08:52");
    expect(banner).toContain("Asia/Seoul");
  });

  // ★위 검사만으로는 시간대 독립성을 못 잰다.★ job 시간대가 Asia/Seoul 이라, 프로세스도
  // Asia/Seoul 이면 로컬 포맷과 결과가 같아진다 — 실제로 `timeZone` 을 지운 뮤턴트가
  // TZ=Asia/Seoul 에서만 살아남았다(UTC·LA 에서는 죽음). 이미 보는 축으로 변이하면 안 잡힌다.
  // 그래서 ★job 시간대를 프로세스와 겹치지 않을 값으로 둔 검사★ 를 따로 세운다.
  // 예정 2026-08-13 20:00 UTC = 13:00 PDT, 232분 뒤 = 16:52 PDT.
  test("배너 시각은 job 시간대를 따른다 — 프로세스 시간대가 무엇이든", () => {
    const d = db();
    const j = createCronJob(d, {
      // LA 기준 목 13:00 = 서울 금 05:00 = DUE. 요일도 시간대를 따라 달라진다.
      id: "sched_late_probe_la", title: "LA 예약", cron: "0 13 * * 4",
      timezone: "America/Los_Angeles", createdBy: "system",
      payload: learningPayload, from: new Date(DUE.getTime() - 1000),
    });
    const banner = lateWakeBanner(getScheduledJob(d, j.id)!, kst(2026, 8, 14, 8, 52));
    expect(banner).toContain("예정 2026-08-13 13:00");
    expect(banner).toContain("실제 2026-08-13 16:52");
    expect(banner).toContain("America/Los_Angeles");
  });

  test("60분 미만은 '시간' 을 안 쓴다", () => {
    const d = db();
    const job = workloopJob(d);
    expect(lateWakeBanner(job, new Date(DUE.getTime() + 45 * 60_000))).toContain("45분 늦게");
    expect(lateWakeBanner(job, new Date(DUE.getTime() + 45 * 60_000))).not.toContain("시간");
  });

  // ★두 경로 다 잰다.★ 한쪽만 고치고 "완료" 로 읽히는 것이 이 팀이 가장 자주 밟는 함정이다.
  test("capability_workloop 봉투 — 배너가 맨 앞, 원문은 그대로", () => {
    const d = db();
    const job = workloopJob(d);
    const late = kst(2026, 8, 14, 8, 52);
    const out = emitCapabilityWorkloop(d, job, learningPayload, late);
    const { body } = d.prepare(`SELECT body FROM message WHERE id = ?`).get(out.emittedMessageId!) as { body: string };
    expect(body.startsWith("[늦은 깨움]")).toBe(true);
    expect(body).toContain(learningPayload.body);
  });

  test("inbox 봉투도 같은 배너를 받는다 — 예약 알림도 늦게 깨어난다", async () => {
    const d = db();
    const now = kst(2026, 8, 14, 8, 52);
    const job = scheduleReminder(d, {
      targetAgentId: "dex",
      body: "[예약 알림] 늦은 깨움 경로",
      runAt: DUE,
      createdBy: "dex",
    });
    const results = await runDueSchedulerJobsOnce(d, { now });
    expect(results[0]?.status).toBe("succeeded");
    const { body } = d.prepare(`SELECT body FROM message WHERE id = ?`).get(results[0]!.emittedMessageId!) as { body: string };
    expect(body.startsWith("[늦은 깨움]")).toBe(true);
    expect(body).toContain("3시간 52분 늦게");
    expect(body).toContain("[예약 알림] 늦은 깨움 경로");
    expect(getScheduledJob(d, job.id)!.status).toBe("succeeded");
  });

  // ★배너가 dedupe 를 바꾸면 같은 슬롯이 두 번 깨운다.★ 본문이 달라져도 키는 슬롯 기준이어야 한다.
  test("배너가 붙어도 같은 슬롯은 여전히 한 번만 나간다", () => {
    const d = db();
    const job = workloopJob(d);
    const late = kst(2026, 8, 14, 8, 52);
    const first = emitCapabilityWorkloop(d, job, learningPayload, late);
    const second = emitCapabilityWorkloop(d, job, learningPayload, new Date(late.getTime() + 30_000));
    expect(second.emittedMessageId).toBe(first.emittedMessageId);
    expect(d.prepare(`SELECT count(*) AS n FROM message`).get()).toEqual({ n: 1 });
  });

  // ★고친 본체.★ 봉투가 04:00 job 의 결과를 산문으로 단정하던 문장을 지웠는지 본다.
  // 부재만 재면 문장을 통째로 날려도 통과하므로, 대체 지시가 실제로 들어왔는지 함께 잰다.
  test("self-learning 봉투는 04:00 정리 결과를 단정하지 않고 직접 확인을 시킨다", () => {
    const d = db();
    const jobs = ensureWeeklySelfLearningJobs(d);
    const body = JSON.parse(jobs[1]!.payload_json).body as string;
    // 없어야 하는 것: 다른 job 이 이미 돌았다는 주장
    expect(body).not.toContain("04:00에 정리된 것 포함");
    // 있어야 하는 것: 읽는 시점에 직접 재라는 지시 + 아직일 때의 대안
    expect(body).toContain("읽기 직전에 mtime 과 최신 항목 날짜를 직접 확인하세요");
    expect(body).toContain("별개 job 이라 아직 안 돌았을 수 있습니다");
    expect(body).toContain("원자료");
    // 원래 목적은 그대로 남아 있어야 한다(문장을 지우다 과제까지 지우지 않았는지)
    expect(body).toContain("POST /team/api/proposals");
  });
});

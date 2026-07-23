import { describe, expect, test } from "bun:test";
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
    expect(JSON.parse(first[0]!.schedule_expr!)).toMatchObject({ cron: "0 4 * * 5" });
    expect(JSON.parse(first[1]!.schedule_expr!)).toMatchObject({ cron: "0 5 * * 5" });
    expect(JSON.parse(first[0]!.payload_json)).toMatchObject({
      type: "capability_workloop",
      capability: "learning_loop_pm",
      fallbackCapability: "coordinator",
      threadId: "weekly-shared-curation",
    });
    expect(JSON.parse(first[0]!.payload_json).body).toContain("proposal 등록 세션이 아닙니다");
    expect(JSON.parse(first[1]!.payload_json)).toMatchObject({
      type: "capability_workloop",
      capability: "coordinator",
      fallbackCapability: "learning_loop_pm",
      threadId: "weekly-self-learning",
    });
    expect(JSON.parse(first[1]!.payload_json).body).toContain("POST /api/proposals");
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
    const tables = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('scheduled_job','scheduled_job_run')`).all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(["scheduled_job", "scheduled_job_run"]);
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
    //   (2026-07-17: task-continuation-guard 를 launchd 에서 이관하며 추가 — GD 승인)
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

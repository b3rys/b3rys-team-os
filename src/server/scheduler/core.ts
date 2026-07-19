import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type { EnvelopeInbound } from "../../shared/envelopeSchema";
import { acceptInbound } from "../db/inbox/acceptInbound";
import { ambientAgents } from "../lib/registry";
import { hasCapability } from "../lib/capabilities";
import { isTeamOfficialMember } from "../lib/agentMembership";
import { type HolidayPolicy, nextCronRun } from "./cron";

export type ScheduledJobKind = "oneshot" | "recurring";
export type ScheduleKind = "once" | "interval" | "cron";
export type ScheduledJobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface ScheduledJobRow {
  id: string;
  kind: ScheduledJobKind;
  schedule_kind: ScheduleKind;
  status: ScheduledJobStatus;
  enabled: number;
  title: string;
  owner_agent_id: string | null;
  target_agent_id: string | null;
  created_by: string;
  timezone: string;
  next_run_at: string;
  last_run_at: string | null;
  schedule_expr: string | null;
  payload_json: string;
  dedupe_key: string | null;
  misfire_policy: string;
  max_runs: number | null;
  run_count: number;
  lock_until: string | null;
  lock_owner: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboxPayload {
  type: "inbox";
  envelope: EnvelopeInbound & { thread_id?: string };
}
/** Run an allowlisted ops script on schedule. `execKey` MUST be a key in EXEC_ALLOWLIST —
 * an arbitrary command cannot be injected via the DB. */
export interface ExecPayload {
  type: "exec";
  execKey: string;
}
export interface CapabilityWorkloopPayload {
  type: "capability_workloop";
  capability: string;
  fallbackCapability?: string;
  threadId: string;
  body: string;
}
export type SchedulePayload = InboxPayload | ExecPayload | CapabilityWorkloopPayload;

export const WEEKLY_SELF_LEARNING_JOB_ID = "sched_weekly_self_learning_session";
export const WEEKLY_SELF_LEARNING_CRON = "30 11 * * 5";
export const WEEKLY_SELF_LEARNING_BODY = [
  "[workloop: 주간 self-learning 세션 · 금 11:30 KST]",
  "b3os-task-loop의 scheduled workloop 계약으로 이번 세션을 오픈→취합→SHARED 정리→닫기까지 한 턴에 수행하세요.",
  "지난 1주 팀원들이 실제 작업에서 겪은 것 중 팀에 재사용할 수 있는 교훈만 취합하세요. 일 적거나 교훈 없는 팀원은 스킵하고 억지로 만들지 마세요.",
  "재사용할 교훈이 없으면 SHARED에 내용을 꾸며 넣지 말고 '이번 주 없음'으로 정상 종료하세요.",
  "정책·보안·라우팅·외부전송 규칙 변경은 자동 승격하지 말고 TEAM-OS 승인 게이트를 따르세요.",
].join("\n");

export const DAILY_TASK_REVIEW_PING_JOB_ID = "sched_task_review_ping";
export const DAILY_TASK_REVIEW_SUMMARY_JOB_ID = "sched_task_review_summary";
export const DAILY_TASK_REVIEW_TIMEZONE = process.env.B3OS_SCHEDULER_TIMEZONE ?? "Asia/Seoul";

/**
 * Allowlist of ops scripts the scheduler may run. Keyed by a stable id stored in the
 * job payload; the command is defined HERE in code (never taken from the DB), so a
 * job row can only trigger one of these vetted commands. Commands are spawned as an
 * argv array (no shell → no injection) with a hard timeout.
 */
export interface ExecSpec {
  command: string[];
  timeoutMs: number;
  label: string;
}
// ⚠️ Allowlisted scripts run at the SERVER's full privilege and inherit its full env
// (secrets included). Only vet-and-add in-repo, version-controlled scripts. Adding an
// entry = scheduled code-exec at server privilege — treat like committing server code.
// Frozen so no code path can mutate the allowlist at runtime; null-proto so a payload
// execKey of "__proto__"/"constructor" can't resolve to an Object.prototype member.
export const EXEC_ALLOWLIST: Readonly<Record<string, ExecSpec>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, ExecSpec>, {
    "task-review-ping": {
      command: ["bun", "run", "scripts/task-review-ping.ts"],
      timeoutMs: 120_000,
      label: "매일 06:00 과제 리뷰 핑 (active owner만)",
    },
    "task-review-summary": {
      command: ["bun", "run", "scripts/task-review-summary.ts"],
      timeoutMs: 180_000,
      label: "매일 06:20 과제 리뷰 다이제스트 (OWNER 텔레그램)",
    },
    "workloop-kanban": {
      command: ["bun", "run", "scripts/workloop-driver.ts", "kanban"],
      timeoutMs: 120_000,
      label: "매일 06:00 칸반 PM 워크루프 (담당자 동적해석 wake)",
    },
    // ★launchd → scheduled_job 이관★ (OWNER 2026-07-17). 옛 경로: launchd `com.example.team-continuation-guard`.
    //   왜 옮겼나:
    //   ① ★조용히 죽었다★ — plist 는 있는데 launchctl 에 언로드된 채 ★3일 18시간 정지★(7/14 00:12 마지막).
    //      아무도 몰랐다. 룰(TEAM-OS.task-mgmt)은 그동안 "가드가 owner 를 깨워줄 것" 이라고 약속하고 있었다.
    //      → 서버 스케줄러에 얹으면 ★서버가 살아있는 한 같이 산다★ (별도 언로드 지점이 없다).
    //   ② ★퍼블릭 포터블★ — launchd 는 macOS 전용이라 리눅스 사용자는 이 기능을 못 썼다(README 에 명시된 제약).
    //      scheduled_job 은 team.db 기반이라 OS 무관.
    "task-continuation-guard": {
      command: ["bun", "run", "scripts/task-continuation-guard.ts"],
      timeoutMs: 120_000,
      label: "30분마다 진행 지속 가드 (멈춘 doing 카드 → owner 핑, 이슈별 cooldown)",
    },
  }),
);

// Look up an allowlist entry with an own-property guard (defeats __proto__/constructor).
function resolveExecSpec(allowlist: Record<string, ExecSpec>, execKey: string): ExecSpec | undefined {
  return Object.prototype.hasOwnProperty.call(allowlist, execKey) ? allowlist[execKey] : undefined;
}

/**
 * ★설치본에 그 스크립트가 실제로 있는지.★
 *
 * 공개 릴리즈는 `/scripts/` 를 제외한다(make-public-release.sh). 그래서 위 allowlist 의 커맨드들은
 * 공개 클론에 **존재하지 않는다** — 그대로 spawn 하면 정체를 알 수 없는 실패로 끝나고(조용한 실패),
 * 사용자는 "스케줄러가 그냥 안 돈다"만 겪는다. 실행 전에 확인해서 **무엇이 없는지 말해준다.**
 *
 * 커맨드 argv 에서 repo 상대 스크립트 경로(.ts/.sh)를 찾아 존재 여부만 본다.
 */
export function execSpecScriptPath(spec: ExecSpec): string | undefined {
  return spec.command.find((a) => /\.(ts|sh|js|mjs)$/.test(a) && !a.startsWith("-"));
}

export function isExecSpecAvailable(spec: ExecSpec, repoRoot: string = REPO_ROOT): boolean {
  const rel = execSpecScriptPath(spec);
  if (!rel) return true; // 스크립트 파일에 의존하지 않는 커맨드
  return existsSync(isAbsolute(rel) ? rel : join(repoRoot, rel));
}

// Repo root = three levels up from this module (src/server/scheduler/core.ts).
// fileURLToPath (not URL.pathname) so a repo path with spaces/special chars decodes.
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
// Cap captured output so a runaway script can't OOM the server before truncation.
const EXEC_OUTPUT_CAP_BYTES = 64 * 1024;

export interface CreateScheduledJobInput {
  id?: string;
  title: string;
  kind: ScheduledJobKind;
  scheduleKind: ScheduleKind;
  nextRunAt: Date;
  payload: SchedulePayload;
  ownerAgentId?: string | null;
  targetAgentId?: string | null;
  createdBy?: string;
  timezone?: string;
  scheduleExpr?: Record<string, unknown> | null;
  dedupeKey?: string | null;
  misfirePolicy?: "coalesce" | "skip" | "catch_up_once";
  maxRuns?: number | null;
}

export interface ScheduleReminderInput {
  targetAgentId: string;
  body: string;
  runAt: Date;
  createdBy: string;
  threadId?: string;
  title?: string;
  directToGd?: boolean;
  timezone?: string;
}

export interface SchedulerRunResult {
  jobId: string;
  status: "succeeded" | "failed" | "skipped";
  emittedMessageId?: string;
  error?: string;
}

export function toSqliteDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function fromSqliteDate(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

export function createScheduledJob(db: Database, input: CreateScheduledJobInput): ScheduledJobRow {
  const id = input.id ?? `sched_${nanoid(10)}`;
  const now = toSqliteDate(new Date());
  const payloadJson = JSON.stringify(input.payload);
  db.prepare(
    `INSERT INTO scheduled_job
       (id, kind, schedule_kind, status, enabled, title, owner_agent_id, target_agent_id,
        created_by, timezone, next_run_at, schedule_expr, payload_json, dedupe_key,
        misfire_policy, max_runs, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.scheduleKind,
    input.title,
    input.ownerAgentId ?? null,
    input.targetAgentId ?? null,
    input.createdBy ?? "system",
    input.timezone ?? "Asia/Seoul",
    toSqliteDate(input.nextRunAt),
    input.scheduleExpr ? JSON.stringify(input.scheduleExpr) : null,
    payloadJson,
    input.dedupeKey ?? null,
    input.misfirePolicy ?? "coalesce",
    input.maxRuns ?? null,
    now,
    now,
  );
  return getScheduledJob(db, id)!;
}

export function scheduleReminder(db: Database, input: ScheduleReminderInput): ScheduledJobRow {
  const threadId = input.threadId ?? `sched-${nanoid(10)}`;
  const id = `sched_${nanoid(10)}`;
  const scheduledFor = toSqliteDate(input.runAt);
  const dedupeKey = scheduledDedupeKey(id, scheduledFor);
  const meta = {
    scheduled_job: true,
    scheduled_for: scheduledFor,
    requested_by: input.createdBy,
    requested_via: "b3os_schedule_reminder",
    target_agent_id: input.targetAgentId,
    ...(input.directToGd ? { reply_mode: "direct_to_gd" } : {}),
  };
  return createScheduledJob(db, {
    id,
    title: input.title ?? `One-shot reminder for ${input.targetAgentId}`,
    kind: "oneshot",
    scheduleKind: "once",
    nextRunAt: input.runAt,
    ownerAgentId: input.createdBy,
    targetAgentId: input.targetAgentId,
    createdBy: input.createdBy,
    timezone: input.timezone ?? "Asia/Seoul",
    maxRuns: 1,
    dedupeKey,
    payload: {
      type: "inbox",
      envelope: {
        thread_id: threadId,
        from_agent_id: "system",
        to_agent_id: input.targetAgentId,
        type: "dm",
        body: input.body,
        source: "agent",
        hop_count: 0,
        priority: "normal",
        dedupe_key: dedupeKey,
        meta,
      },
    },
  });
}

export interface CreateCronJobInput {
  id?: string;
  title: string;
  cron: string;
  payload: SchedulePayload;
  targetAgentId?: string | null;
  ownerAgentId?: string | null;
  createdBy?: string;
  timezone?: string;
  holidayPolicy?: HolidayPolicy;
  holidayCountry?: string;
  misfirePolicy?: "coalesce" | "skip" | "catch_up_once";
  /** Compute the first next_run_at relative to this instant (default: now). */
  from?: Date;
}

/**
 * Register a recurring cron job. The initial next_run_at is computed from the cron
 * expression (in `timezone`) so the first fire lands on a real schedule slot. Holiday
 * policy defaults to "run" (fire regardless of holidays).
 */
export function createCronJob(db: Database, input: CreateCronJobInput): ScheduledJobRow {
  const tz = input.timezone ?? "Asia/Seoul";
  const policy = input.holidayPolicy ?? "run";
  const country = input.holidayCountry ?? "KR";
  const from = input.from ?? new Date();
  const firstRun = nextCronRun(input.cron, from, {
    timezone: tz,
    holidayPolicy: policy,
    isHoliday: policy === "run" ? undefined : (dateStr) => isHolidayOn(db, dateStr, country),
  });
  // Holiday calendar has a hard coverage cliff: past the last seeded year, isHolidayOn
  // returns false, so a skip/shift job silently behaves as "run". Warn loudly at
  // creation so the calendar gets extended rather than degrading unnoticed.
  if (policy !== "run") {
    const coverage = holidayCoverageThroughYear(db, country);
    if (coverage == null || firstRun.getUTCFullYear() > coverage) {
      console.warn(
        `[scheduler] cron job '${input.title}' uses holidayPolicy=${policy} but ${country} holidays are only seeded through ${coverage ?? "(none)"}; occurrences past that will fire as if no holiday.`,
      );
    }
  }
  return createScheduledJob(db, {
    id: input.id,
    title: input.title,
    kind: "recurring",
    scheduleKind: "cron",
    nextRunAt: firstRun,
    payload: input.payload,
    ownerAgentId: input.ownerAgentId ?? null,
    targetAgentId: input.targetAgentId ?? null,
    createdBy: input.createdBy ?? "system",
    timezone: tz,
    misfirePolicy: input.misfirePolicy ?? "coalesce",
    scheduleExpr: { cron: input.cron, holidayPolicy: policy, holidayCountry: country },
  });
}

/** Seed the portable weekly learning trigger. Fixed id makes server startup idempotent. */
export function ensureWeeklySelfLearningJob(db: Database): ScheduledJobRow {
  const existing = getScheduledJob(db, WEEKLY_SELF_LEARNING_JOB_ID);
  if (existing) return existing;
  return createCronJob(db, {
    id: WEEKLY_SELF_LEARNING_JOB_ID,
    title: "주간 self-learning 세션 (금 11:30 KST)",
    cron: WEEKLY_SELF_LEARNING_CRON,
    timezone: "Asia/Seoul",
    holidayPolicy: "run",
    createdBy: "system",
    payload: {
      type: "capability_workloop",
      capability: "learning_loop_pm",
      fallbackCapability: "coordinator",
      threadId: "weekly-self-learning",
      body: WEEKLY_SELF_LEARNING_BODY,
    },
  });
}

/** Seed portable daily task-review jobs. Existing installations are reconciled separately by ops. */
export function ensureDailyTaskReviewJobs(db: Database): ScheduledJobRow[] {
  const specs = [
    { id: DAILY_TASK_REVIEW_PING_JOB_ID, title: "과제 리뷰 핑 (06:00)", cron: "0 6 * * *", execKey: "task-review-ping" },
    { id: DAILY_TASK_REVIEW_SUMMARY_JOB_ID, title: "과제 리뷰 다이제스트 (06:20)", cron: "20 6 * * *", execKey: "task-review-summary" },
  ] as const;
  return specs.map((spec) => getScheduledJob(db, spec.id) ?? createCronJob(db, {
    id: spec.id,
    title: spec.title,
    cron: spec.cron,
    timezone: DAILY_TASK_REVIEW_TIMEZONE,
    holidayPolicy: "run",
    createdBy: "system",
    payload: { type: "exec", execKey: spec.execKey },
  }));
}

export function getScheduledJob(db: Database, id: string): ScheduledJobRow | null {
  return db.prepare(`SELECT * FROM scheduled_job WHERE id = ?`).get(id) as ScheduledJobRow | null;
}

export function dueScheduledJobs(db: Database, now = new Date(), limit = 10): ScheduledJobRow[] {
  return db
    .prepare(
      `SELECT * FROM scheduled_job
       WHERE enabled = 1
         AND (
           status = 'pending'
           OR (status = 'running' AND lock_until IS NOT NULL AND lock_until <= ?)
         )
         AND next_run_at <= ?
         AND (lock_until IS NULL OR lock_until <= ?)
       ORDER BY next_run_at ASC
       LIMIT ?`,
    )
    .all(toSqliteDate(now), toSqliteDate(now), toSqliteDate(now), limit) as ScheduledJobRow[];
}

export function claimScheduledJob(db: Database, id: string, now = new Date(), leaseSec = 120, lockOwner = "scheduler"): boolean {
  const nowSql = toSqliteDate(now);
  const leaseUntil = toSqliteDate(new Date(now.getTime() + leaseSec * 1000));
  const result = db
    .prepare(
      `UPDATE scheduled_job
       SET status = 'running',
           lock_until = ?,
           lock_owner = ?,
           updated_at = ?
       WHERE id = ?
         AND enabled = 1
         AND (
           status = 'pending'
           OR (status = 'running' AND lock_until IS NOT NULL AND lock_until <= ?)
         )
         AND next_run_at <= ?
         AND (lock_until IS NULL OR lock_until <= ?)`,
    )
    .run(leaseUntil, lockOwner, nowSql, id, nowSql, nowSql, nowSql);
  return result.changes === 1;
}

export function scheduledDedupeKey(jobId: string, scheduledFor: string): string {
  return `scheduled_job:${jobId}:${scheduledFor}`;
}

function nextIntervalRun(job: ScheduledJobRow, now: Date): string | null {
  if (job.schedule_kind !== "interval" || !job.schedule_expr) return null;
  const parsed = JSON.parse(job.schedule_expr) as { minutes?: unknown };
  const minutes = typeof parsed.minutes === "number" && Number.isFinite(parsed.minutes) ? parsed.minutes : null;
  if (!minutes || minutes <= 0) return null;
  return toSqliteDate(new Date(now.getTime() + minutes * 60_000));
}

/** Is `dateStr` (YYYY-MM-DD, in the job timezone) a holiday for `country`? */
export function isHolidayOn(db: Database, dateStr: string, country = "KR"): boolean {
  const row = db.prepare("SELECT 1 AS hit FROM holiday WHERE country = ? AND date = ?").get(country, dateStr) as
    | { hit: number }
    | undefined;
  return !!row;
}

interface CronScheduleExpr {
  cron?: unknown;
  holidayPolicy?: unknown;
  holidayCountry?: unknown;
}

/** Latest year with any seeded holiday for `country` (null if none). */
export function holidayCoverageThroughYear(db: Database, country = "KR"): number | null {
  const row = db.prepare("SELECT MAX(date) AS d FROM holiday WHERE country = ?").get(country) as
    | { d: string | null }
    | undefined;
  return row?.d ? Number(row.d.slice(0, 4)) : null;
}

function nextCronRunForJob(db: Database, job: ScheduledJobRow, now: Date): string | null {
  if (job.schedule_kind !== "cron") return null;
  // A cron job with a missing/blank expression is misconfigured — throw so the fire
  // path parks it 'failed' (consistent with a malformed expression), rather than
  // silently returning null → succeeded+disabled.
  if (!job.schedule_expr) throw new Error(`cron job ${job.id} has no schedule_expr`);
  const parsed = JSON.parse(job.schedule_expr) as CronScheduleExpr;
  if (typeof parsed.cron !== "string" || parsed.cron.trim() === "") {
    throw new Error(`cron job ${job.id} has an empty cron expression`);
  }
  const policy: HolidayPolicy =
    parsed.holidayPolicy === "skip" || parsed.holidayPolicy === "shift" ? parsed.holidayPolicy : "run";
  const country = typeof parsed.holidayCountry === "string" ? parsed.holidayCountry : "KR";
  const next = nextCronRun(parsed.cron, now, {
    timezone: job.timezone,
    holidayPolicy: policy,
    isHoliday: policy === "run" ? undefined : (dateStr) => isHolidayOn(db, dateStr, country),
  });
  return toSqliteDate(next);
}

/**
 * Next fire time for a recurring job, dispatching on schedule_kind.
 * Returns null for non-recurring schedules (once) or a malformed expr.
 */
export function computeNextRun(db: Database, job: ScheduledJobRow, now: Date): string | null {
  if (job.schedule_kind === "interval") return nextIntervalRun(job, now);
  if (job.schedule_kind === "cron") return nextCronRunForJob(db, job, now);
  return null;
}

export function completeScheduledJob(
  db: Database,
  job: ScheduledJobRow,
  opts: { emittedMessageId?: string; detail?: Record<string, unknown>; now?: Date } = {},
): void {
  const now = opts.now ?? new Date();
  const nowSql = toSqliteDate(now);
  const runId = `sjr_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO scheduled_job_run
       (id, job_id, scheduled_for, started_at, finished_at, outcome, emitted_message_id, detail_json)
     VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?)`,
  ).run(runId, job.id, job.next_run_at, nowSql, nowSql, opts.emittedMessageId ?? null, opts.detail ? JSON.stringify(opts.detail) : null);

  // NOTE (Steve review F-C): misfire_policy is stored on the row but only "coalesce"
  // is implemented — next_run_at is always recomputed forward from `now`, so a missed
  // slot fires at most once on recovery (no catch_up_once backfill / no skip-specific
  // branch yet). Add those branches here if per-job misfire behavior is needed.
  // Fencing (defense-in-depth): only complete if THIS runner still holds the lease. If a
  // stale second runner re-claimed (shouldn't happen — lease is sized > exec timeout —
  // but don't rest safety on that single invariant), lock_owner won't match and this
  // no-ops. `OR ? IS NULL` keeps it a no-op guard for callers that don't track ownership.
  const nextRun = computeNextRun(db, job, now);
  if (job.kind === "recurring" && nextRun && (job.max_runs == null || job.run_count + 1 < job.max_runs)) {
    db.prepare(
      `UPDATE scheduled_job
       SET status = 'pending',
           run_count = run_count + 1,
           last_run_at = ?,
           next_run_at = ?,
           lock_until = NULL,
           lock_owner = NULL,
           updated_at = ?,
           last_error = NULL
       WHERE id = ? AND (lock_owner = ? OR ? IS NULL)`,
    ).run(nowSql, nextRun, nowSql, job.id, job.lock_owner, job.lock_owner);
    return;
  }

  db.prepare(
    `UPDATE scheduled_job
     SET status = 'succeeded',
         enabled = 0,
         run_count = run_count + 1,
         last_run_at = ?,
         lock_until = NULL,
         lock_owner = NULL,
         updated_at = ?,
         last_error = NULL
     WHERE id = ?`,
  ).run(nowSql, nowSql, job.id);
}

export function failScheduledJob(
  db: Database,
  job: ScheduledJobRow,
  error: string,
  opts: { now?: Date; detail?: Record<string, unknown> } = {},
): void {
  const now = opts.now ?? new Date();
  const nowSql = toSqliteDate(now);
  const runId = `sjr_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO scheduled_job_run
       (id, job_id, scheduled_for, started_at, finished_at, outcome, error, detail_json)
     VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)`,
  ).run(runId, job.id, job.next_run_at, nowSql, nowSql, error.slice(0, 500), opts.detail ? JSON.stringify(opts.detail) : null);
  db.prepare(
    `UPDATE scheduled_job
     SET status = 'failed',
         lock_until = NULL,
         lock_owner = NULL,
         updated_at = ?,
         last_error = ?
     WHERE id = ? AND (lock_owner = ? OR ? IS NULL)`,
  ).run(nowSql, error.slice(0, 500), job.id, job.lock_owner, job.lock_owner);
}

export function skipScheduledJob(
  db: Database,
  job: ScheduledJobRow,
  reason: string,
  opts: { now?: Date; detail?: Record<string, unknown> } = {},
): void {
  const now = opts.now ?? new Date();
  const nowSql = toSqliteDate(now);
  const runId = `sjr_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO scheduled_job_run
       (id, job_id, scheduled_for, started_at, finished_at, outcome, detail_json)
     VALUES (?, ?, ?, ?, ?, 'skipped', ?)`,
  ).run(runId, job.id, job.next_run_at, nowSql, nowSql, JSON.stringify({ reason, ...(opts.detail ?? {}) }));
  const nextRun = job.kind === "recurring" ? computeNextRun(db, job, now) : null;
  db.prepare(
    `UPDATE scheduled_job
       SET status = 'pending',
         next_run_at = COALESCE(?, next_run_at),
         run_count = run_count + 1,
         last_run_at = ?,
         lock_until = NULL,
         lock_owner = NULL,
         updated_at = ?
       WHERE id = ?`,
  ).run(nextRun, nowSql, nowSql, job.id);
}

export function emitScheduledJob(db: Database, job: ScheduledJobRow): string {
  const payload = JSON.parse(job.payload_json) as SchedulePayload;
  if (payload.type !== "inbox") throw new Error(`unsupported_payload:${payload.type}`);
  const env = {
    ...payload.envelope,
    dedupe_key: scheduledDedupeKey(job.id, job.next_run_at),
  };
  const accepted = acceptInbound(db, env, { dedupeWindowSec: 60 });
  if (!accepted.ok) return accepted.duplicate;
  return accepted.stored.id;
}

export function pickCapabilityWorkloopTarget(
  agents: ReturnType<typeof ambientAgents>,
  payload: CapabilityWorkloopPayload,
): string | null {
  const active = agents.filter(
    (agent) => agent.enabled !== false && isTeamOfficialMember(agent) && !hasCapability(agent, "non_interactive"),
  );
  if (active.length === 0) return null;
  return (
    active.find((agent) => hasCapability(agent, payload.capability))?.id ??
    (payload.fallbackCapability
      ? active.find((agent) => hasCapability(agent, payload.fallbackCapability!))?.id
      : undefined) ??
    null
  );
}

export function emitCapabilityWorkloop(
  db: Database,
  job: ScheduledJobRow,
  payload: CapabilityWorkloopPayload,
): { emittedMessageId?: string; skippedReason?: string; targetAgentId?: string } {
  const agents = ambientAgents();
  if (agents.filter((agent) => agent.enabled !== false && isTeamOfficialMember(agent) && !hasCapability(agent, "non_interactive")).length === 0) {
    return { skippedReason: "no_active_team_members" };
  }
  const targetAgentId = pickCapabilityWorkloopTarget(agents, payload);
  if (!targetAgentId) return { skippedReason: "no_capability_holder_or_coordinator" };
  const accepted = acceptInbound(
    db,
    {
      thread_id: payload.threadId,
      from_agent_id: "system",
      to_agent_id: targetAgentId,
      type: "dm",
      body: payload.body,
      source: "agent",
      hop_count: 0,
      priority: "normal",
      dedupe_key: scheduledDedupeKey(job.id, job.next_run_at),
      meta: { scheduled_workloop: job.id },
    },
    { dedupeWindowSec: 60 },
  );
  return {
    emittedMessageId: accepted.ok ? accepted.stored.id : accepted.duplicate,
    targetAgentId,
  };
}

export interface ExecResult {
  execKey: string;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  timedOut: boolean;
}

const EXEC_KILL_GRACE_MS = 5_000; // SIGTERM → grace → SIGKILL
const EXEC_HARD_MARGIN_MS = 5_000; // extra margin before abandoning a wedged child

/** Drain a stream to completion (no pipe-buffer deadlock) but retain only the last
 * `capBytes` in memory (rolling tail) so a runaway script can't OOM the server. */
async function readStreamTail(stream: ReadableStream<Uint8Array>, capBytes: number): Promise<string> {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged.length > capBytes ? merged.slice(merged.length - capBytes) : merged;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(buf);
}

/**
 * Run an exec job's allowlisted script. Spawns as an argv array (no shell), enforces a
 * per-script timeout with SIGTERM→SIGKILL escalation, drains output with a byte cap,
 * and races the whole run against a hard deadline so a wedged (un-killable) child can
 * NEVER hang the scheduler loop. Throws on non-allowlisted key / non-zero exit /
 * timeout / wedge so the fire path parks the job 'failed'.
 * NOTE: at-least-once — unlike the inbox path (atomic emit+reschedule in one tx), a
 * crash between the script running and the reschedule can re-run it on recovery, and
 * a concurrent scheduler caller could too if the lease expires mid-run (the run loop
 * sizes the lease to exceed timeoutMs to prevent that). Allowlist ONLY idempotent-safe
 * scripts (review ping/digest re-run harmlessly); non-idempotent effects need their own dedupe.
 */
export async function execScheduledJob(
  job: ScheduledJobRow,
  opts: { now?: Date; allowlist?: Record<string, ExecSpec> } = {},
): Promise<ExecResult> {
  const payload = JSON.parse(job.payload_json) as SchedulePayload;
  if (payload.type !== "exec") throw new Error(`unsupported_payload:${payload.type}`);
  const spec = resolveExecSpec(opts.allowlist ?? EXEC_ALLOWLIST, payload.execKey);
  if (!spec) throw new Error(`exec_key_not_allowlisted:${payload.execKey}`);
  // ★조용한 실패 금지★ — 공개 릴리즈는 /scripts/ 를 제외하므로 이 커맨드가 아예 없을 수 있다.
  // 없는 걸 spawn 하면 원인 모를 실패로 끝난다. 무엇이 없는지 명시하고 멈춘다.
  if (!isExecSpecAvailable(spec)) {
    throw new Error(`exec_script_missing:${payload.execKey}:${execSpecScriptPath(spec) ?? "?"}`);
  }

  const startedMs = opts.now ? opts.now.getTime() : Date.now();
  const proc = Bun.spawn(spec.command, { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill(); // SIGTERM
    } catch {
      /* already gone */
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill(9); // SIGKILL if it ignored SIGTERM
      } catch {
        /* already gone */
      }
    }, EXEC_KILL_GRACE_MS);
  }, spec.timeoutMs);

  const run = (async () => {
    const [stdout, stderr] = await Promise.all([
      readStreamTail(proc.stdout, EXEC_OUTPUT_CAP_BYTES),
      readStreamTail(proc.stderr, EXEC_OUTPUT_CAP_BYTES),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();

  const hardDeadlineMs = spec.timeoutMs + EXEC_KILL_GRACE_MS + EXEC_HARD_MARGIN_MS;
  let wedgeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        wedgeTimer = setTimeout(() => {
          try {
            proc.kill(9);
          } catch {
            /* already gone */
          }
          reject(new Error(`exec_wedged:${payload.execKey}:${hardDeadlineMs}ms (child ignored SIGTERM/SIGKILL)`));
        }, hardDeadlineMs);
      }),
    ]);
    const result: ExecResult = {
      execKey: payload.execKey,
      exitCode: outcome.exitCode,
      stdoutTail: outcome.stdout.slice(-2000),
      stderrTail: outcome.stderr.slice(-2000),
      durationMs: Date.now() - startedMs,
      timedOut,
    };
    if (timedOut) throw new Error(`exec_timeout:${payload.execKey}:${spec.timeoutMs}ms`);
    if (outcome.exitCode !== 0)
      throw new Error(`exec_failed:${payload.execKey}:exit${outcome.exitCode}:${result.stderrTail.slice(-200)}`);
    return result;
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (wedgeTimer) clearTimeout(wedgeTimer);
  }
}

const DEFAULT_LEASE_SEC = 120;
const EXEC_LEASE_MARGIN_SEC = 60;

export async function runDueSchedulerJobsOnce(
  db: Database,
  opts: {
    now?: Date;
    limit?: number;
    leaseSec?: number;
    lockOwner?: string;
    dryRun?: boolean;
    allowlist?: Record<string, ExecSpec>;
  } = {},
): Promise<SchedulerRunResult[]> {
  const allowlist = opts.allowlist ?? EXEC_ALLOWLIST;
  const scanNow = opts.now ?? new Date();
  const due = dueScheduledJobs(db, scanNow, opts.limit ?? 10);
  // Process inbox (sub-ms) jobs before exec (up to minutes) so a long script can't
  // delay a time-sensitive wake behind it within a batch.
  const jobs = [...due].sort((a, b) => execPriority(a) - execPriority(b));
  const results: SchedulerRunResult[] = [];
  for (const job of jobs) {
    // Re-read the clock per job: a preceding long exec makes a batch-start `now` stale,
    // which would mint born-expired leases and past-slot reschedules. Tests pin `now`.
    const now = opts.now ?? new Date();
    // Parse BEFORE claim (lease sizing needs the type) — but a corrupt payload_json must
    // NOT throw out of the loop (that would abort the whole batch and re-poison every poll,
    // since the bad row stays pending). Park it 'failed' instead.
    let payload: SchedulePayload;
    try {
      const parsed = JSON.parse(job.payload_json) as { type?: unknown };
      if (!parsed || (parsed.type !== "inbox" && parsed.type !== "exec" && parsed.type !== "capability_workloop")) {
        throw new Error(`bad_payload_type:${String(parsed?.type)}`);
      }
      payload = parsed as SchedulePayload;
    } catch (e) {
      if (claimScheduledJob(db, job.id, now, DEFAULT_LEASE_SEC, opts.lockOwner ?? "scheduler")) {
        const claimedBad = getScheduledJob(db, job.id)!;
        failScheduledJob(db, claimedBad, `bad_payload:${e instanceof Error ? e.message : String(e)}`, { now });
        results.push({ jobId: job.id, status: "failed", error: "bad_payload" });
      }
      continue;
    }
    // Size the lease to outlive an exec's own timeout (+margin) so it can't expire
    // mid-run and let a concurrent caller re-claim and double-run the script.
    let leaseSec = opts.leaseSec ?? DEFAULT_LEASE_SEC;
    if (payload.type === "exec") {
      const spec = resolveExecSpec(allowlist, payload.execKey);
      if (spec) leaseSec = Math.max(leaseSec, Math.ceil(spec.timeoutMs / 1000) + EXEC_LEASE_MARGIN_SEC);
    }
    if (!claimScheduledJob(db, job.id, now, leaseSec, opts.lockOwner ?? "scheduler")) continue;
    const claimed = getScheduledJob(db, job.id)!;
    if (opts.dryRun) {
      skipScheduledJob(db, claimed, "dry_run", { now });
      results.push({ jobId: job.id, status: "skipped" });
      continue;
    }
    try {
      if (payload.type === "exec") {
        // exec is async and side-effecting → run it, THEN record+reschedule (not one tx).
        const execResult = await execScheduledJob(claimed, { allowlist });
        // Re-read the clock AFTER the (possibly minutes-long) exec so the reschedule
        // uses real-now, not the pre-exec time (tests pin `now` for determinism).
        completeScheduledJob(db, claimed, { detail: { ...execResult }, now: opts.now ?? new Date() });
        results.push({ jobId: job.id, status: "succeeded" });
      } else if (payload.type === "inbox") {
        // inbox: emit + reschedule atomically so a crash can't double-emit.
        const emittedMessageId = db.transaction((j: ScheduledJobRow) => {
          const id = emitScheduledJob(db, j);
          completeScheduledJob(db, j, { emittedMessageId: id, now });
          return id;
        })(claimed);
        results.push({ jobId: job.id, status: "succeeded", emittedMessageId });
      } else {
        const outcome = db.transaction((j: ScheduledJobRow) => {
          const emitted = emitCapabilityWorkloop(db, j, payload);
          if (emitted.skippedReason) {
            skipScheduledJob(db, j, emitted.skippedReason, { now });
            return emitted;
          }
          completeScheduledJob(db, j, {
            emittedMessageId: emitted.emittedMessageId,
            detail: { targetAgentId: emitted.targetAgentId },
            now,
          });
          return emitted;
        })(claimed);
        results.push(
          outcome.skippedReason
            ? { jobId: job.id, status: "skipped" }
            : { jobId: job.id, status: "succeeded", emittedMessageId: outcome.emittedMessageId },
        );
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failScheduledJob(db, claimed, error, { now: opts.now ?? new Date() });
      results.push({ jobId: job.id, status: "failed", error });
    }
  }
  return results;
}

// inbox → 0, exec → 1, so a stable sort runs inbox jobs first within a batch.
function execPriority(job: ScheduledJobRow): number {
  try {
    return (JSON.parse(job.payload_json) as SchedulePayload).type === "exec" ? 1 : 0;
  } catch {
    return 0;
  }
}

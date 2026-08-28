import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type { EnvelopeInbound } from "../../shared/envelopeSchema";
import { acceptInbound } from "../db/inbox/acceptInbound";
import { appendAudit } from "../db/queries";
import { ambientAgents } from "../lib/registry";
import { hasCapability } from "../lib/capabilities";
import { isTeamOfficialMember } from "../lib/agentMembership";
import { type HolidayPolicy, nextCronRun } from "./cron";
import { TimezoneCronScheduler } from "./timezoneCronScheduler";

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
  workflow_id: string | null;
  workflow_step_key: string | null;
  workflow_step_order: number | null;
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

export const WEEKLY_SHARED_CURATION_JOB_ID = "sched_weekly_shared_curation";
export const WEEKLY_SELF_LEARNING_JOB_ID = "sched_weekly_self_learning_session";
export const WEEKLY_SELF_LEARNING_WORKFLOW_ID = "weekly_self_learning";
export const WEEKLY_SHARED_CURATION_CRON = "0 4 * * 5";
export const WEEKLY_SELF_LEARNING_CRON = "0 5 * * 5";
// 보고 경로 — 두 루프가 같은 문구를 쓴다.
//
// 예전에는 "send.sh --direct-to-gd" 한 줄이었는데 ★그대로 하면 실패한다★(2026-07-31 실측).
// --direct-to-gd 는 --to <요청자> 를 함께 요구하는데, 이 알림의 발신자는 `system` 이고
// 서버는 system 을 수신자로 받지 않는다(`not_a_recipient`). 즉 시킨 대로 하면 400 이 난다.
// 게다가 claude 계열 런타임은 팀장 1:1 이 텔레그램이라 send.sh 자체가 그 자리에 맞지 않는다.
const WORKLOOP_REPORT_LINE = [
  "★완료 후 GD 에게 직접 보고하세요.★ 보고 경로는 런타임마다 다릅니다 —",
  "  claude 계열은 자기 텔레그램 1:1 reply 도구, 그 외는 send.sh --to <요청자> --direct-to-gd.",
  "  (이 알림은 발신자가 system 이라 send.sh --to system 은 서버가 거부합니다.",
  "   1:1 로 보고했으면 마감 알림은 무시하세요 — 서버는 1:1 DM 을 보지 못합니다.)",
].join("\n");

export const WEEKLY_SHARED_CURATION_BODY = [
  "[workloop: SHARED.md 미팅 · 금 04:00 KST]",
  "b3os-task-loop의 scheduled workloop 계약으로 이번 세션을 오픈→수집·정리→보고→닫기까지 한 턴에 수행하세요.",
  "목적: 지난 1주 팀원들이 실제 작업에서 겪은 것 중 '팀 지식'으로 남길 만한 것을 rules/SHARED.md 에 기록합니다(수집·정리). 팀원 주중 메모/교훈 취합해 수록 + 완료·확정 항목 정돈·중복 정리.",
  // "중앙 … 에 올립니다" 였는데 수집 담당과 팀원이 각각 그걸 "PR 로 올린다" 로 읽었다(2026-07-31).
  // rules/SHARED.md 는 .gitignore 대상이라 애초에 커밋되지 않는다 → 방법을 문장에 박는다.
  "★기록 방법: rules/SHARED.md 를 직접 편집합니다. 커밋도 PR 도 하지 마세요★ — 이 파일은 .gitignore 대상(팀 전용 로컬 파일)이라 공개 저장소에 올라가지 않습니다. 공개 템플릿은 rules/SHARED.template.md 입니다.",
  "이 세션은 proposal 등록 세션이 아닙니다. 억지로 만들지 마세요 — 없거나 팀 레벨 교훈이 아니면 스킵, SHARED 에 꾸며 넣지 마세요.",
  "정책·보안·라우팅·외부전송 규칙은 자동 변경 금지.",
  WORKLOOP_REPORT_LINE,
  "내용 = SHARED.md 에 올린 항목 건수·주요 내용. 없으면 '이번 주 없음' 한 줄.",
].join("\n");
export const WEEKLY_SELF_LEARNING_BODY = [
  "[workloop: self-learning 세션 · 금 05:00 KST]",
  "b3os-task-loop의 scheduled workloop 계약으로 이번 세션을 오픈→검토→proposal 등록→보고→닫기까지 한 턴에 수행하세요.",
  // 예전에는 "SHARED.md(04:00에 정리된 것 포함)" 였다. ★이 봉투가 다른 job 의 결과를 산문으로 단정하고 있었다.★
  // 04:00 정리(codex)와 05:00 이 세션은 별개 job 이고, 맥이 자다 깨면 둘이 같은 초에 깨어난다
  // (2026-08-13: 8개 job 이 23:52:05 UTC 한 초에 실행 — 1시간 간격이 0초). 그러면 이 문장은 거짓이 된다.
  // ★대신 값을 박지도 않는다★ — 봉투는 wake 시점에 만들어지므로 "최종 수정: 08:52 기준" 같은 값은
  // 몇 분 뒤 무효가 되고, 산문 거짓말이 기계가 서명한 거짓말로 바뀔 뿐이다(dbak 반대리뷰).
  // 그래서 ★주장하지 말고 읽는 시점에 직접 확인하라고 지시한다.★ 지연 여부와 무관하게 성립한다.
  "목적: rules/SHARED.md 와 지난 1주 팀 활동을 검토해, 팀에 필요한 (a)팀 룰 변경 (b)새로운 과제 (c)고쳐야 할 이슈를 뽑아 ★proposal 시스템에 등록★하세요.",
  "★SHARED.md 를 읽기 직전에 mtime 과 최신 항목 날짜를 직접 확인하세요★ — 04:00 정리 세션은 별개 job 이라 아직 안 돌았을 수 있습니다. 아직이면 정리본을 기다리지 말고 원자료(team.db·git log·audit)로 보세요.",
  // 라우터가 /api 아래 마운트되고 그 전체가 /team 아래 붙는다 → 실제 경로는 /team/api/proposals.
  // "POST /api/proposals" 로 적혀 있어서 시킨 대로 하면 404 가 난다(2026-07-31 실측).
  "★등록 방법: POST /team/api/proposals★ (/api/proposals 는 404 입니다). 각 proposal 에 근거(왜)+예상효과 필수. 등록하면 리뷰 게이트로 올라갑니다(자동 적용 아님).",
  "★올리기 전에 이 세 가지를 스스로 통과시키세요. 하나라도 아니면 등록하지 마세요:★",
  "  1. 정말 팀에 필요한 것인가   2. 팀 전체의 이슈인가   3. 팀원 개인 레벨의 러닝이 아닌가",
  "  규칙으로 써봤을 때 \"잘 확인해라\" 류가 되면 등록하지 마세요 — 그런 규칙은 지켜지지 않습니다. 도구·절차를 고치는 쪽이 실효가 있습니다.",
  "억지로 만들지 마세요 — 진짜 팀에 필요한 것만. 없으면 등록하지 말고 '이번 주 없음'. 정책·보안·라우팅·외부전송 규칙 변경도 proposal 로만(자동 적용 금지).",
  WORKLOOP_REPORT_LINE,
  "내용 = 등록한 proposal 목록(각 제목·유형[룰/과제/이슈]·근거 한 줄·proposal ID). 없으면 '이번 주 없음' 한 줄.",
].join("\n");

export const DAILY_TASK_REVIEW_PING_JOB_ID = "sched_task_review_ping";
export const DAILY_TASK_REVIEW_SUMMARY_JOB_ID = "sched_task_review_summary";
const LEGACY_FIXED_OFFSET_TIMEZONES = new Set(["Asia/Seoul", "Asia/Kolkata", "UTC", "Etc/UTC"]);

function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

// Env 기본값만 안전 폴백한다. Job/API 에서 명시한 invalid timezone 은 생성/실행 경로에서 throw 되어야
// 손상 row 를 조용히 Asia/Seoul 로 바꾸지 않는다.
function validateSchedulerTimezone(tz: string | undefined): string {
  if (!tz) return "Asia/Seoul";
  if (isValidIanaTimezone(tz)) return tz;
  console.warn(`[scheduler] B3OS_SCHEDULER_TIMEZONE="${tz}" invalid IANA timezone → Asia/Seoul 폴백`);
  return "Asia/Seoul";
}
export const DAILY_TASK_REVIEW_TIMEZONE = validateSchedulerTimezone(process.env.B3OS_SCHEDULER_TIMEZONE);

function currentDailyTaskReviewTimezone(): string {
  return validateSchedulerTimezone(process.env.B3OS_SCHEDULER_TIMEZONE);
}

export function computeCronNextRun(
  cron: string,
  from: Date,
  opts: { timezone: string; holidayPolicy?: HolidayPolicy; isHoliday?: (dateStr: string) => boolean },
): Date {
  const policy = opts.holidayPolicy ?? "run";
  if (LEGACY_FIXED_OFFSET_TIMEZONES.has(opts.timezone)) {
    return nextCronRun(cron, from, { timezone: opts.timezone, holidayPolicy: policy, isHoliday: opts.isHoliday });
  }
  return new TimezoneCronScheduler({ timezone: opts.timezone, holidayPolicy: policy, isHoliday: opts.isHoliday }).nextRun(cron, from);
}

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
      label: "매일 06:20 과제 리뷰 다이제스트 (GD 텔레그램)",
    },
    "workloop-kanban": {
      command: ["bun", "run", "scripts/workloop-driver.ts", "kanban"],
      timeoutMs: 120_000,
      label: "매일 06:00 칸반 PM 워크루프 (담당자 동적해석 wake)",
    },
    // ★launchd → scheduled_job 이관★. 옛 경로: launchd `com.you.team-continuation-guard`.
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
  /**
   * 'catch_up_once' delivers this reminder however late it is, bypassing the misfire grace.
   * Only matters when the grace is enabled (SCHEDULER_MISFIRE_GRACE_SEC, off by default):
   * with it on, a stale one-shot is dropped and never comes back, so set this on the
   * reminder that must arrive even if the machine was off.
   */
  misfirePolicy?: "coalesce" | "skip" | "catch_up_once";
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
    misfirePolicy: input.misfirePolicy,
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
  const firstRun = computeCronNextRun(input.cron, from, {
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

function ensureCronJob(db: Database, input: CreateCronJobInput & { id: string }): ScheduledJobRow {
  const existing = getScheduledJob(db, input.id);
  if (!existing) return createCronJob(db, input);

  const timezone = input.timezone ?? "Asia/Seoul";
  const holidayPolicy = input.holidayPolicy ?? "run";
  const holidayCountry = input.holidayCountry ?? "KR";
  const scheduleExpr = JSON.stringify({ cron: input.cron, holidayPolicy, holidayCountry });
  const payloadJson = JSON.stringify(input.payload);
  const desiredMatches = existing.kind === "recurring"
    && existing.schedule_kind === "cron"
    && existing.title === input.title
    && existing.timezone === timezone
    && existing.schedule_expr === scheduleExpr
    && existing.payload_json === payloadJson
    && existing.owner_agent_id === (input.ownerAgentId ?? null)
    && existing.target_agent_id === (input.targetAgentId ?? null)
    && existing.created_by === (input.createdBy ?? "system")
    && existing.misfire_policy === (input.misfirePolicy ?? "coalesce")
    && existing.enabled === 1;
  if (desiredMatches) return existing;

  const nextRun = computeCronNextRun(input.cron, input.from ?? new Date(), {
    timezone,
    holidayPolicy,
    isHoliday: holidayPolicy === "run" ? undefined : (dateStr) => isHolidayOn(db, dateStr, holidayCountry),
  });
  const now = toSqliteDate(new Date());
  db.prepare(
    `UPDATE scheduled_job
       SET kind = 'recurring', schedule_kind = 'cron', status = 'pending', enabled = 1,
           title = ?, owner_agent_id = ?, target_agent_id = ?, created_by = ?, timezone = ?,
           next_run_at = ?, schedule_expr = ?, payload_json = ?, misfire_policy = ?, max_runs = NULL,
           lock_until = NULL, lock_owner = NULL, last_error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.title, input.ownerAgentId ?? null, input.targetAgentId ?? null, input.createdBy ?? "system", timezone,
    toSqliteDate(nextRun), scheduleExpr, payloadJson, input.misfirePolicy ?? "coalesce", now, input.id,
  );
  return getScheduledJob(db, input.id)!;
}

export interface ScheduledWorkflowInput {
  id: string;
  title: string;
  timezone?: string;
  ownerAgentId?: string | null;
  description?: string;
}

export interface WorkflowOccurrenceSkipResult {
  workflowId: string;
  occurrenceDate: string;
  skippedJobIds: string[];
  alreadyPassedJobIds: string[];
  ungroupedActiveJobIds: string[];
  alreadySkipped: boolean;
}

export function ensureScheduledWorkflow(db: Database, input: ScheduledWorkflowInput): void {
  db.prepare(
    `INSERT INTO scheduled_workflow
       (id, title, timezone, owner_agent_id, description, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       timezone = excluded.timezone,
       owner_agent_id = excluded.owner_agent_id,
       description = excluded.description,
       enabled = 1,
       updated_at = datetime('now')`,
  ).run(
    input.id,
    input.title,
    input.timezone ?? "Asia/Seoul",
    input.ownerAgentId ?? null,
    input.description ?? "",
  );
}

export function assignScheduledJobToWorkflow(
  db: Database,
  jobId: string,
  workflowId: string,
  stepKey: string,
  stepOrder: number,
): void {
  const result = db.prepare(
    `UPDATE scheduled_job
       SET workflow_id = ?, workflow_step_key = ?, workflow_step_order = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(workflowId, stepKey, stepOrder, jobId);
  if (result.changes !== 1) throw new Error(`scheduled_job_not_found:${jobId}`);
}

function localDateInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function backfillWorkflowSkipExceptions(db: Database, workflowId: string, timezone: string): void {
  const jobIds = (db.prepare(
    `SELECT id FROM scheduled_job WHERE workflow_id = ? ORDER BY id`,
  ).all(workflowId) as Array<{ id: string }>).map((row) => row.id);
  if (jobIds.length === 0) return;
  const placeholders = jobIds.map(() => "?").join(",");
  const historicalRuns = db.prepare(
    `SELECT job_id, scheduled_for, finished_at, detail_json
       FROM scheduled_job_run
      WHERE job_id IN (${placeholders})
        AND outcome = 'skipped'
        AND json_valid(detail_json)
        AND json_extract(detail_json, '$.reason') = 'lead_requested_week_skip'`,
  ).all(...jobIds) as Array<{ job_id: string; scheduled_for: string; finished_at: string | null; detail_json: string }>;
  const byOccurrence = new Map<string, { jobIds: Set<string>; createdAt: string; requestReason: string }>();
  for (const run of historicalRuns) {
    const occurrenceDate = localDateInZone(fromSqliteDate(run.scheduled_for), timezone);
    const detail = JSON.parse(run.detail_json) as { request_reason?: unknown };
    const current = byOccurrence.get(occurrenceDate) ?? {
      jobIds: new Set<string>(),
      createdAt: run.finished_at ?? run.scheduled_for,
      requestReason: typeof detail.request_reason === "string" ? detail.request_reason : "lead_requested_week_skip",
    };
    current.jobIds.add(run.job_id);
    if ((run.finished_at ?? run.scheduled_for) < current.createdAt) current.createdAt = run.finished_at ?? run.scheduled_for;
    byOccurrence.set(occurrenceDate, current);
  }
  for (const [occurrenceDate, occurrence] of byOccurrence) {
    if (occurrence.jobIds.size !== jobIds.length) continue;
    db.prepare(
      `INSERT OR IGNORE INTO scheduled_workflow_exception
         (id, workflow_id, occurrence_date, action, reason, actor, created_at)
       VALUES (?, ?, ?, 'skip', ?, 'historical_backfill', ?)`,
    ).run(`swx_backfill_${workflowId}_${occurrenceDate}`, workflowId, occurrenceDate, occurrence.requestReason, occurrence.createdAt);
  }
}

/**
 * Consume every job in one workflow occurrence as a single transaction.
 * The occurrence may be skipped before it is due; advancing from each scheduled
 * slot (not from the request time) guarantees that the skipped slot cannot wake.
 */
export function skipWorkflowOccurrence(
  db: Database,
  input: { workflowId: string; occurrenceDate: string; actor: string; reason: string; now?: Date },
): WorkflowOccurrenceSkipResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurrenceDate)) throw new Error("invalid_occurrence_date");
  if (!input.actor.trim()) throw new Error("actor_required");
  if (!input.reason.trim()) throw new Error("reason_required");

  const requestedAt = input.now ?? new Date();
  const run = db.transaction((): WorkflowOccurrenceSkipResult => {
    const workflow = db.prepare(
      `SELECT id, timezone, enabled FROM scheduled_workflow WHERE id = ?`,
    ).get(input.workflowId) as { id: string; timezone: string; enabled: number } | null;
    if (!workflow || workflow.enabled !== 1) throw new Error(`scheduled_workflow_not_active:${input.workflowId}`);

    const ungroupedJobs = db.prepare(
      `SELECT * FROM scheduled_job
       WHERE workflow_id IS NULL AND enabled = 1 AND status = 'pending'
       ORDER BY next_run_at, id`,
    ).all() as ScheduledJobRow[];
    const ungroupedActiveJobIds = ungroupedJobs
      .filter((job) => localDateInZone(fromSqliteDate(job.next_run_at), job.timezone || workflow.timezone) === input.occurrenceDate)
      .map((job) => job.id);

    const existing = db.prepare(
      `SELECT action FROM scheduled_workflow_exception WHERE workflow_id = ? AND occurrence_date = ?`,
    ).get(input.workflowId, input.occurrenceDate) as { action: string } | null;
    if (existing) {
      return {
        workflowId: input.workflowId,
        occurrenceDate: input.occurrenceDate,
        skippedJobIds: [],
        alreadyPassedJobIds: [],
        ungroupedActiveJobIds,
        alreadySkipped: true,
      };
    }

    const jobs = db.prepare(
      `SELECT * FROM scheduled_job
       WHERE workflow_id = ? AND enabled = 1
       ORDER BY workflow_step_order, id`,
    ).all(input.workflowId) as ScheduledJobRow[];
    if (jobs.length === 0) throw new Error(`scheduled_workflow_has_no_jobs:${input.workflowId}`);
    const remainingJobs: ScheduledJobRow[] = [];
    const alreadyPassedJobIds: string[] = [];
    for (const job of jobs) {
      if (job.status !== "pending") throw new Error(`scheduled_workflow_job_not_pending:${job.id}:${job.status}`);
      const timezone = job.timezone || workflow.timezone;
      const jobDate = localDateInZone(fromSqliteDate(job.next_run_at), timezone);
      if (jobDate === input.occurrenceDate) {
        remainingJobs.push(job);
        continue;
      }
      const requestDate = localDateInZone(requestedAt, timezone);
      if (jobDate > input.occurrenceDate && requestDate === input.occurrenceDate) {
        alreadyPassedJobIds.push(job.id);
        continue;
      }
      throw new Error(`scheduled_workflow_occurrence_mismatch:${job.id}:${jobDate}`);
    }

    const nowSql = toSqliteDate(requestedAt);
    db.prepare(
      `INSERT INTO scheduled_workflow_exception
         (id, workflow_id, occurrence_date, action, reason, actor, created_at)
       VALUES (?, ?, ?, 'skip', ?, ?, ?)`,
    ).run(`swx_${nanoid(10)}`, input.workflowId, input.occurrenceDate, input.reason, input.actor, nowSql);

    for (const job of remainingJobs) {
      const scheduledFor = fromSqliteDate(job.next_run_at);
      skipScheduledJob(db, job, "workflow_occurrence_skip", {
        now: requestedAt,
        nextRunFrom: new Date(scheduledFor.getTime() + 1),
        detail: {
          workflow_id: input.workflowId,
          occurrence_date: input.occurrenceDate,
          requested_by: input.actor,
          request_reason: input.reason,
        },
      });
    }
    appendAudit(db, input.actor, "scheduled_workflow_occurrence_skipped", input.workflowId, {
      occurrence_date: input.occurrenceDate,
      job_ids: remainingJobs.map((job) => job.id),
      already_passed_job_ids: alreadyPassedJobIds,
      ungrouped_active_job_ids: ungroupedActiveJobIds,
      reason: input.reason,
    });
    return {
      workflowId: input.workflowId,
      occurrenceDate: input.occurrenceDate,
      skippedJobIds: remainingJobs.map((job) => job.id),
      alreadyPassedJobIds,
      ungroupedActiveJobIds,
      alreadySkipped: false,
    };
  });
  return run.immediate();
}

/** Seed and reconcile the portable weekly learning triggers. */
export function ensureWeeklySelfLearningJobs(db: Database): ScheduledJobRow[] {
  ensureScheduledWorkflow(db, {
    id: WEEKLY_SELF_LEARNING_WORKFLOW_ID,
    title: "주간 러닝 세션",
    timezone: "Asia/Seoul",
    description: "SHARED.md 정리와 주간 self-learning proposal 검토를 한 회차로 묶는다.",
  });
  const sharedCuration = ensureCronJob(db, {
    id: WEEKLY_SHARED_CURATION_JOB_ID,
    title: "SHARED.md 미팅 (금 04:00 KST)",
    cron: WEEKLY_SHARED_CURATION_CRON,
    timezone: "Asia/Seoul",
    holidayPolicy: "run",
    createdBy: "system",
    payload: {
      type: "capability_workloop",
      capability: "learning_loop_pm",
      fallbackCapability: "coordinator",
      threadId: "weekly-shared-curation",
      body: WEEKLY_SHARED_CURATION_BODY,
    },
  });
  assignScheduledJobToWorkflow(db, sharedCuration.id, WEEKLY_SELF_LEARNING_WORKFLOW_ID, "shared_curation", 10);
  const selfLearning = ensureCronJob(db, {
    id: WEEKLY_SELF_LEARNING_JOB_ID,
    title: "self-learning 세션 (금 05:00 KST)",
    cron: WEEKLY_SELF_LEARNING_CRON,
    timezone: "Asia/Seoul",
    holidayPolicy: "run",
    createdBy: "system",
    payload: {
      type: "capability_workloop",
      capability: "coordinator",
      fallbackCapability: "learning_loop_pm",
      threadId: "weekly-self-learning",
      body: WEEKLY_SELF_LEARNING_BODY,
    },
  });
  assignScheduledJobToWorkflow(db, selfLearning.id, WEEKLY_SELF_LEARNING_WORKFLOW_ID, "self_learning", 20);
  backfillWorkflowSkipExceptions(db, WEEKLY_SELF_LEARNING_WORKFLOW_ID, "Asia/Seoul");
  return [getScheduledJob(db, sharedCuration.id)!, getScheduledJob(db, selfLearning.id)!];
}

/** @deprecated Use ensureWeeklySelfLearningJobs so both weekly jobs are seeded. */
export function ensureWeeklySelfLearningJob(db: Database): ScheduledJobRow {
  return ensureWeeklySelfLearningJobs(db)[1]!;
}

/** Seed and reconcile portable daily task-review jobs. */
export function ensureDailyTaskReviewJobs(db: Database, opts: { from?: Date } = {}): ScheduledJobRow[] {
  const specs = [
    { id: DAILY_TASK_REVIEW_PING_JOB_ID, title: "과제 리뷰 핑 (06:00)", cron: "0 6 * * *", execKey: "task-review-ping" },
    { id: DAILY_TASK_REVIEW_SUMMARY_JOB_ID, title: "과제 리뷰 다이제스트 (06:20)", cron: "20 6 * * *", execKey: "task-review-summary" },
  ] as const;
  return specs.map((spec) => ensureCronJob(db, {
    id: spec.id,
    title: spec.title,
    cron: spec.cron,
    timezone: currentDailyTaskReviewTimezone(),
    holidayPolicy: "run",
    createdBy: "system",
    from: opts.from,
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
  const next = computeCronNextRun(parsed.cron, now, {
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

/**
 * 연속 실패를 몇 번까지 봐주고 재예약할지. 이 횟수에 ★도달하면★ park(=status 'failed' 로 정지)한다.
 *
 * 하한은 1 이다. ★1 은 "첫 실패에 바로 park" = 고치기 전 동작을 의도적으로 되사는 값★ 이므로
 * 막지 않는다(그렇게 쓰고 싶은 운영자가 있을 수 있다). 다만 ★기본값이 아니라 명시적으로 골라야★ 한다.
 * 막는 것은 0·음수·NaN 뿐 — 그건 설정 실수이지 선택이 아니고, 그대로 두면 루프가 아예 안 돈다.
 * (처음 주석은 "1 로 올린다 = 옛 동작 방지" 라고 적었는데 ★1 이 바로 그 옛 동작★ 이라 앞뒤가 안 맞았다. steve 지적.)
 */
export const DEFAULT_FAILURE_RETRY_LIMIT = 3;
export function failureRetryLimit(): number {
  const raw = Number(process.env.SCHEDULER_FAILURE_RETRY_LIMIT ?? DEFAULT_FAILURE_RETRY_LIMIT);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_FAILURE_RETRY_LIMIT;
}

/**
 * 이 잡의 가장 최근 실행부터 거슬러 올라가며 연속 'failed' 개수를 센다(이번 실패 포함).
 *
 * ★'failed 가 아니면 멈춘다' 가 아니라 'succeeded 에서만 리셋한다'★ (steve 리뷰).
 * 처음엔 outcome 이 failed 가 아니면 즉시 break 했는데, 그러면 ★skip 이 카운트를 리셋한다.★
 * `skipScheduledJob` 은 outcome='skipped' 행을 넣으므로 fail·skip·fail·skip 이 섞이면
 * 연속 카운트가 매번 1 로 돌아가 ★진짜 고장이 영원히 park 되지 않는다.★
 * 오늘은 잠복이다(미스파이어 유예가 기본 꺼짐이라 skip 행이 안 생긴다) — 그 env 를 켜는 순간 살아난다.
 * 같은 구멍이 하나 더 있다: 스키마 CHECK 가 outcome 에 'started' 를 이미 허용한다(지금 writer 는 없다).
 * → 조회를 'succeeded'·'failed' 로 좁히면 두 구멍이 같이 닫힌다.
 *   skip 은 "돌려보지도 않았다" 라서 ★잡이 나아졌다는 증거가 아니다★ — 세지도 리셋하지도 않는 중립이 맞다.
 */
export function consecutiveFailures(db: Database, jobId: string, limit: number): number {
  const rows = db
    .prepare(
      // rowid = 삽입 순서. started_at 은 같은 초에 여러 건이 들어갈 수 있어 정렬 기준으로 불안정하다.
      `SELECT outcome FROM scheduled_job_run
        WHERE job_id = ? AND outcome IN ('succeeded','failed')
        ORDER BY rowid DESC LIMIT ?`,
    )
    .all(jobId, limit) as Array<{ outcome: string }>;
  let n = 0;
  for (const r of rows) {
    if (r.outcome === "succeeded") break; // 성공에서만 연속이 끊긴다
    n += 1;
  }
  return n;
}

/**
 * ★실패해도 다음 시각은 잡아준다★ (2026-07-30 사고 수정)
 *
 * 고치기 전: status='failed' 로 두고 next_run_at 을 ★안 옮겼다★. 그런데 `dueScheduledJobs` 는
 * status='pending' 만 고른다 → ★반복 잡이 한 번 실패하면 영구 정지★ 했다. 재시도도 재스케줄도 없고
 * 복구 API 도 없어서(취소만 있다) 사람이 DB 를 직접 고쳐야 살아났다.
 * 실제 사고: 부팅 직후 서버가 아직 안 떠서 실패한 `sched_task_continuation_guard`(30분 주기) 가 9시간 정지.
 * ★원인은 일시적이었는데 결과가 영구적이었다.★
 *
 * 고친 뒤: 성공 경로(completeScheduledJob)와 같은 계산으로 다음 슬롯을 잡고 'pending' 으로 되돌린다.
 * 단 ★무한 재시도는 안 된다★ — 진짜 고장(스크립트 깨짐 등)이면 30분마다 영원히 실패만 반복하고
 * 아무도 모른다. 그래서 연속 실패가 한도에 닿으면 park 하고, park 사실을 audit 으로 남긴다.
 * (park 를 사람에게 ★알리는★ 경로는 여기서 새로 만들지 않는다 — 알림 경로는 opNotice 쪽 작업과
 *  겹치므로 그 위에 얹는 게 맞다. 지금은 대시보드 표시 + acceptance-check 가 잡는다.)
 */
export function failScheduledJob(
  db: Database,
  job: ScheduledJobRow,
  error: string,
  opts: { now?: Date; detail?: Record<string, unknown> } = {},
): void {
  const now = opts.now ?? new Date();
  const nowSql = toSqliteDate(now);
  const runId = `sjr_${nanoid(10)}`;
  const err = error.slice(0, 500);
  db.prepare(
    `INSERT INTO scheduled_job_run
       (id, job_id, scheduled_for, started_at, finished_at, outcome, error, detail_json)
     VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)`,
  ).run(runId, job.id, job.next_run_at, nowSql, nowSql, err, opts.detail ? JSON.stringify(opts.detail) : null);

  const limit = failureRetryLimit();
  const failures = consecutiveFailures(db, job.id, limit);
  // 재예약 자격: 반복 잡이고 · 아직 한도 전이고 · 실행 횟수 상한이 남아 있고 · 다음 시각이 계산되어야 한다.
  // run_count 는 성공/skip 만 올린다(실패는 소비로 치지 않는다). 그래서 상한 판정은 run_count 그대로 본다.
  const capLeft = job.max_runs == null || job.run_count < job.max_runs;
  let nextRun: string | null = null;
  if (job.kind === "recurring" && failures < limit && capLeft) {
    // cron 표현식이 깨져 있으면 computeNextRun 이 throw 한다 → 재예약 대상이 아니다(park).
    try {
      nextRun = computeNextRun(db, job, now);
    } catch {
      nextRun = null;
    }
  }

  if (nextRun) {
    db.prepare(
      `UPDATE scheduled_job
       SET status = 'pending',
           next_run_at = ?,
           lock_until = NULL,
           lock_owner = NULL,
           updated_at = ?,
           last_error = ?
       WHERE id = ? AND (lock_owner = ? OR ? IS NULL)`,
    ).run(nextRun, nowSql, err, job.id, job.lock_owner, job.lock_owner);
    return;
  }

  db.prepare(
    `UPDATE scheduled_job
     SET status = 'failed',
         lock_until = NULL,
         lock_owner = NULL,
         updated_at = ?,
         last_error = ?
     WHERE id = ? AND (lock_owner = ? OR ? IS NULL)`,
  ).run(nowSql, err, job.id, job.lock_owner, job.lock_owner);
  // park 은 "이제 아무도 안 돌린다" 는 뜻이라 흔적을 남긴다. 재시도로 넘어간 실패는 남기지 않는다(소음).
  appendAudit(db, "scheduler", "scheduler_job_parked", null, {
    job_id: job.id,
    consecutive_failures: failures,
    limit,
    reason: job.kind !== "recurring" ? "not_recurring" : !capLeft ? "max_runs_reached" : failures >= limit ? "retry_limit" : "no_next_run",
    error: err,
  });
}

export function skipScheduledJob(
  db: Database,
  job: ScheduledJobRow,
  reason: string,
  opts: { now?: Date; nextRunFrom?: Date; detail?: Record<string, unknown> } = {},
): void {
  const now = opts.now ?? new Date();
  const nowSql = toSqliteDate(now);
  const runId = `sjr_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO scheduled_job_run
       (id, job_id, scheduled_for, started_at, finished_at, outcome, detail_json)
     VALUES (?, ?, ?, ?, ?, 'skipped', ?)`,
  ).run(runId, job.id, job.next_run_at, nowSql, nowSql, JSON.stringify({ reason, ...(opts.detail ?? {}) }));
  const nextRun = job.kind === "recurring" ? computeNextRun(db, job, opts.nextRunFrom ?? now) : null;
  // A skip is still a consumed occurrence — it bumps run_count. So it must honor max_runs
  // exactly like completeScheduledJob does, or the last allowed slot being skipped lets
  // the job run one more time and overshoot its cap.
  const exhausted = job.max_runs != null && job.run_count + 1 >= job.max_runs;
  // Leaving a one-shot pending with its past next_run_at makes every worker tick claim
  // and record it forever.
  const done = job.kind === "oneshot" || exhausted || nextRun == null;
  const nextStatus = done ? "succeeded" : "pending";
  const enabled = done ? 0 : job.enabled;
  db.prepare(
    `UPDATE scheduled_job
       SET status = ?,
         enabled = ?,
         next_run_at = COALESCE(?, next_run_at),
         run_count = run_count + 1,
         last_run_at = ?,
         lock_until = NULL,
         lock_owner = NULL,
         updated_at = ?
       WHERE id = ?`,
  ).run(nextStatus, enabled, nextRun, nowSql, nowSql, job.id);
}

export function emitScheduledJob(db: Database, job: ScheduledJobRow, now: Date = new Date()): string {
  const payload = JSON.parse(job.payload_json) as SchedulePayload;
  if (payload.type !== "inbox") throw new Error(`unsupported_payload:${payload.type}`);
  const env = {
    ...payload.envelope,
    // ★두 emit 경로 모두에 붙인다★ — inbox 도 capability_workloop 도 늦게 깨어난다.
    // 한쪽만 고치면 "고쳤다" 로 읽히고 다른 쪽은 조용히 옛 동작을 유지한다.
    body: withLateWakeBanner(payload.envelope.body, job, now),
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
  now: Date = new Date(),
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
      body: withLateWakeBanner(payload.body, job, now),
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

/**
 * Misfire grace: a slot missed by more than this many seconds is skipped, not run late.
 *
 * OFF BY DEFAULT. Set SCHEDULER_MISFIRE_GRACE_SEC to a positive number of seconds
 * (7200 = the 2 hours we discussed) to turn it on.
 *
 * The problem it addresses: after the Mac is off for days every job's next_run_at is in
 * the past, so they all come due in one tick and a "06:00 ping" lands at 14:00.
 *
 * Why it ships off: the burst is smaller than it looks — next_run_at is
 * recomputed forward from `now` and missed slots are never backfilled, so a 30-minute job
 * idle for three days fires ONCE, not 144 times. So the cost of leaving it off is a dozen
 * late messages at boot. The cost of turning it on is that things silently do not happen:
 * a one-shot has no next occurrence, and our four Friday learning-loop jobs would skip a
 * whole week. Noisy beats silently missing, so this stays opt-in.
 *
 * Per-job opt-out when it IS on: misfire_policy = 'catch_up_once' runs however late.
 */
const DEFAULT_MISFIRE_GRACE_SEC = 0;

function misfireGraceSec(): number {
  const raw = process.env.SCHEDULER_MISFIRE_GRACE_SEC;
  if (raw == null || raw === "") return DEFAULT_MISFIRE_GRACE_SEC;
  const n = Number(raw);
  // A malformed value must fall back to the default (off), never to "skip everything".
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MISFIRE_GRACE_SEC;
}

/** How late this job's due slot is, in seconds. Negative/zero means on time. */
function lateBySec(job: ScheduledJobRow, now: Date): number {
  return (now.getTime() - fromSqliteDate(job.next_run_at).getTime()) / 1000;
}

/**
 * A wake this late gets a banner. 15분: 정시 tick 지터(초 단위)와 "맥이 자다 깼다"(수십 분~수 시간)
 * 사이에 겹치는 구간이 없다. 30일 실측에서 이 선을 넘은 실행은 전부 부팅 직후 catch-up 이었다.
 */
export const LATE_WAKE_BANNER_THRESHOLD_SEC = 15 * 60;

/**
 * 시각을 job 의 시간대로 찍는다.
 *
 * ★프로세스 시간대에 의존하지 않는다★ — `bun test` 는 TZ=UTC 로 돌고 실서버는 Asia/Seoul 이라,
 * 로컬 포맷을 쓰면 검사 환경에서만 통과하는 결함이 생긴다(SHARED.md 2026-07-30). timeZone 을
 * 명시하면 어디서 돌든 같은 문자열이 나온다. sv-SE 로케일은 "YYYY-MM-DD HH:mm" 을 준다.
 */
function formatInZone(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date);
  } catch {
    // 알 수 없는 시간대면 UTC 로 떨어뜨린다 — 배너가 없는 것보다 UTC 라도 있는 게 낫다.
    return `${toSqliteDate(date).slice(0, 16)} UTC`;
  }
}

function formatLateness(sec: number): string {
  const totalMin = Math.round(sec / 60);
  if (totalMin < 60) return `${totalMin}분`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/**
 * 늦게 깨어난 wake 봉투 맨 앞에 붙는 배너. 정시면 빈 문자열(= 봉투 무변화).
 *
 * 왜 필요한가: 미스파이어 유예가 기본 OFF 라서(위 주석) 맥이 자는 동안 밀린 슬롯은 부팅 직후
 * 한꺼번에 실행된다. 그때 04:00 job 과 05:00 job 이 같은 초에 깨어나 ★간격 계약이 0초가 된다.★
 * 그 사실은 scheduled_job_run 에만 남고 ★깨어난 당사자에게는 안 간다★ — 그래서 후행 owner 가
 * 선행 job 의 산출물이 아직 없는 상태에서 그것을 읽는다(2026-08-13 실측).
 *
 * ★배너는 동시 실행 자체를 막지 못한다.★ 막는 건 봉투 본문의 "읽기 직전에 직접 확인하라" 쪽이고,
 * 배너는 owner 가 "이 세션의 입력이 신선한가" 를 판단할 사실을 주는 역할이다. 둘은 대체재가 아니다.
 *
 * ★선행 job 의 '완료' 는 싣지 않는다★ — scheduled_job_run.outcome='succeeded' 는 "깨움 메시지를
 * 발송했다" 는 뜻이지 "그 일이 끝났다" 가 아니다(started_at == finished_at 같은 초). 그 값을
 * "선행 완료" 로 실으면 지금 고치는 것과 똑같은 거짓을 한 세대 더 만든다(dbak 반대리뷰).
 */
export function lateWakeBanner(job: ScheduledJobRow, now: Date): string {
  const lateSec = lateBySec(job, now);
  if (lateSec < LATE_WAKE_BANNER_THRESHOLD_SEC) return "";
  const tz = job.timezone || "Asia/Seoul";
  return [
    `[늦은 깨움] 이 세션은 예정보다 ★${formatLateness(lateSec)} 늦게★ 시작됐습니다.`,
    `  예정 ${formatInZone(fromSqliteDate(job.next_run_at), tz)} · 실제 ${formatInZone(now, tz)} (${tz})`,
    "  같은 시각에 다른 정기 작업도 함께 깨어났을 수 있습니다 — 앞선 작업의 산출물이 아직 없을 수 있으니, 파일·기록을 읽기 전에 실제 상태를 직접 확인하세요.",
  ].join("\n");
}

/** 배너를 봉투 본문 앞에 붙인다. 정시면 원문 그대로(문자열 동일성 보장). */
function withLateWakeBanner(body: string, job: ScheduledJobRow, now: Date): string {
  const banner = lateWakeBanner(job, now);
  return banner ? `${banner}\n\n${body}` : body;
}

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
    // Stale slot → skip forward instead of firing late. skipScheduledJob records a
    // 'skipped' run (so this is visible in history, not a silent disappearance) and
    // advances next_run_at, exactly like any other consumed occurrence.
    //
    // One rule for every job kind: if the machine was off when the slot came round,
    // the job does not fire. GD chose this over a recurring-only carve-out, having been
    // told that a one-shot has no next occurrence and is therefore dropped for good
    // (2026-07-29): a notification that arrives at the wrong time is noise either way,
    // and one predictable rule beats two.
    //
    // Escape hatch for the rare job that MUST run however late: misfire_policy = 'catch_up_once'.
    const graceSec = misfireGraceSec();
    const lateSec = lateBySec(claimed, now);
    if (graceSec > 0 && lateSec > graceSec && claimed.misfire_policy !== "catch_up_once") {
      skipScheduledJob(db, claimed, "misfire_stale", {
        now,
        // Both timestamps, not just "late by N": a long preceding exec delays this
        // decision, and without the decision time you cannot tell a genuinely stale slot
        // from one that went stale waiting behind a slow job. (steve review)
        detail: {
          lateSec: Math.round(lateSec),
          graceSec,
          dueAt: claimed.next_run_at,
          decidedAt: toSqliteDate(now),
        },
      });
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
          // 배너의 "실제" 시각은 completeScheduledJob 이 기록하는 시각과 같아야 한다 —
          // 여기서 새로 new Date() 를 부르면 봉투와 run 기록이 서로 다른 시각을 말한다.
          const id = emitScheduledJob(db, j, now);
          completeScheduledJob(db, j, { emittedMessageId: id, now });
          return id;
        })(claimed);
        results.push({ jobId: job.id, status: "succeeded", emittedMessageId });
      } else {
        const outcome = db.transaction((j: ScheduledJobRow) => {
          const emitted = emitCapabilityWorkloop(db, j, payload, now);
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

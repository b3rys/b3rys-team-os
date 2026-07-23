/**
 * Pending follow-up tracker (approach "a" — requester-flagged, deterministic, NO LLM).
 *
 * WHY THIS EXISTS
 * A one-shot runtime agent (openclaw / hermes) handles a directed request in a SINGLE turn
 * and then goes idle — it has no continuous session to notice "I said I'd report but never did".
 * So when such an agent is asked to report TO THE TEAM LEAD and then goes quiet, the report can
 * be silently lost. (claude_channel agents have a continuous session + their own guards, so they
 * do NOT need this — and never get a row.)
 *
 * SCOPE (team-lead-destined only, generic/public-portable)
 * Only reports destined for the TEAM LEAD are tracked — a plain member↔member directed request is
 * out of scope (the PM tracks those). The "destined for the team lead" signal REUSES the codebase's
 * existing owner concept: `meta.reply_mode === "direct_to_gd"` (the `--direct-to-gd` flag), which is
 * how any runtime already routes a message to the team lead's DM (owner_chat_id / owner_name settings,
 * configured per user). We store the target as the generic role constant TEAM_LEAD_TARGET and the
 * re-wake text says "팀장" (the team lead) — NEVER a hardcoded user name or chat id. Any user's team
 * lead works.
 *
 * THE MECHANISM (bounded, self-cleaning, no loops)
 *   1. The requester flags the send with `--direct-to-gd --expect-report-by <duration>` → the
 *      envelope carries meta.reply_mode='direct_to_gd' + meta.expect_report_by. If (and only if) the
 *      recipient's runtime is one-shot, the inbox route inserts ONE row with an absolute deadline.
 *   2. A ~60s worker checks due rows. For each: did the recipient produce a SUBSTANTIVE (non-ack)
 *      report toward the team lead AFTER the row was created — i.e. a message from the recipient,
 *      on the tracked thread OR itself carrying reply_mode=direct_to_gd?
 *        · yes → the report arrived → DELETE the row (fulfilled).
 *        · no  → send exactly ONE re-wake nudge to the recipient, then mark fired=1.
 *   3. A fired row NEVER fires again. One re-wake, then done.
 *
 * Everything here is deterministic: runtime is looked up from the agent registry, the ack/report
 * distinction reuses classifyReplySignal (exact-lexeme classifier in shared/recipientState.ts).
 * No natural-language parsing, no LLM, anywhere.
 */
import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { classifyReplySignal } from "../../shared/recipientState";
import { acceptInbound } from "../db/inbox/acceptInbound";
import type { Broadcaster } from "../workers/types";

/** The one-shot runtimes that need follow-up tracking. claude_channel (continuous session) and
 * codex are intentionally excluded — only these two "answer once then idle" runtimes get a row. */
const ONE_SHOT_RUNTIMES = new Set(["openclaw", "hermes_agent"]);

/** Generic role marker stored as the follow-up target. NOT a user name / chat id — the actual
 * team-lead identity is resolved elsewhere from owner_chat_id/owner_name (public-portable). */
export const TEAM_LEAD_TARGET = "team_lead";

/** The existing "destined for the team lead" signal (the `--direct-to-gd` flag / owner routing). */
export const DIRECT_TO_GD = "direct_to_gd";

/** After a row has fired (one re-wake sent), keep it this long to catch a late report and GC it;
 * past this the row is dropped without re-poking. 24h — a report that never comes in a day won't. */
const FIRED_GRACE_MS = 24 * 60 * 60 * 1000;

export function isOneShotRuntime(runtime: string | null | undefined): boolean {
  return !!runtime && ONE_SHOT_RUNTIMES.has(runtime);
}

/** Is this envelope a report destined for the team lead? Reuses the codebase's owner concept. */
export function isTeamLeadDestined(replyMode: string | null | undefined): boolean {
  return replyMode === DIRECT_TO_GD;
}

/** Resolve an agent's runtime from the synced agent registry (DB). null = unknown agent. */
export function getAgentRuntime(db: Database, agentId: string): string | null {
  const row = db.prepare(`SELECT runtime FROM agent WHERE id = ?`).get(agentId) as
    | { runtime: string }
    | undefined;
  return row?.runtime ?? null;
}

/**
 * Parse a duration like "10m", "30m", "2h", "45s", or a bare number (minutes) into seconds.
 * Returns null for anything unparseable (fail-safe: caller then creates no row).
 */
export function parseDurationSec(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? "m"; // bare number → minutes
  const mult = unit.startsWith("s") ? 1 : unit.startsWith("h") ? 3600 : 60;
  return Math.round(n * mult);
}

/** Format a Date as sqlite datetime ('YYYY-MM-DD HH:MM:SS') so it compares lexicographically
 * against datetime('now') stored on message.created_at / pending_followup rows. */
function toSqliteDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Resolve a duration to an absolute sqlite-format deadline relative to `now`. null if unparseable. */
export function resolveDeadline(duration: string | null | undefined, now = new Date()): string | null {
  const sec = parseDurationSec(duration);
  if (sec == null) return null;
  return toSqliteDate(new Date(now.getTime() + sec * 1000));
}

export interface CreatePendingFollowupInput {
  recipientAgentId: string; // the one-shot agent expected to report
  targetAgentId: string; // who they should report to (the requester)
  threadId: string | null;
  sourceMessageId: string; // the request message that carried expect_report_by
  deadlineAt: string; // absolute sqlite-format deadline
}

/** Insert one pending_followup row. Returns the row id. */
export function createPendingFollowup(db: Database, input: CreatePendingFollowupInput): string {
  const id = `pf_${nanoid(12)}`;
  db.prepare(
    `INSERT INTO pending_followup
       (id, recipient_agent_id, target_agent_id, thread_id, source_message_id, deadline_at, fired)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id,
    input.recipientAgentId,
    input.targetAgentId,
    input.threadId,
    input.sourceMessageId,
    input.deadlineAt,
  );
  return id;
}

export interface MaybeCreateFollowupInput {
  toAgentId: string; // recipient of the request (the one-shot agent expected to report)
  threadId: string | null;
  sourceMessageId: string;
  /** meta.expect_report_by from the envelope (duration string). */
  expectReportBy: string | null | undefined;
  /** meta.reply_mode from the envelope — must be 'direct_to_gd' for a team-lead-destined report. */
  replyMode: string | null | undefined;
  now?: Date;
}

/**
 * Gate + create. Creates a pending_followup row IFF ALL hold:
 *   · the request is destined for the TEAM LEAD (reply_mode === 'direct_to_gd'), AND
 *   · expect_report_by is set and parseable, AND
 *   · the recipient's runtime is one-shot (openclaw / hermes_agent).
 * Member↔member requests (no direct_to_gd), claude/codex/unknown recipients → no row (returns null).
 * The stored target is the generic TEAM_LEAD_TARGET role — never a user name/id. Deterministic — no LLM.
 */
export function maybeCreatePendingFollowup(db: Database, input: MaybeCreateFollowupInput): string | null {
  if (!isTeamLeadDestined(input.replyMode)) return null; // ★ scope: team-lead-destined reports only
  if (!input.expectReportBy) return null;
  const runtime = getAgentRuntime(db, input.toAgentId);
  if (!isOneShotRuntime(runtime)) return null; // ★ scope guard: only one-shot recipients get a row
  const deadlineAt = resolveDeadline(input.expectReportBy, input.now ?? new Date());
  if (!deadlineAt) return null; // unparseable duration → fail-safe, no row
  return createPendingFollowup(db, {
    recipientAgentId: input.toAgentId,
    targetAgentId: TEAM_LEAD_TARGET, // generic role marker (public-portable)
    threadId: input.threadId,
    sourceMessageId: input.sourceMessageId,
    deadlineAt,
  });
}

/**
 * ★자가등록 (GD 2026-07-18 응답가드)★ — 팀원이 "작업이 길어져 팀장 보고를 잊으면 안 된다" 싶을 때 스스로 건다.
 * 기존 pending_followup 파이프라인(60s 워커·1회성 재-wake·보고감지·GC)을 그대로 재사용한다 — 별도 크론/워커 금지
 * (hermes 2026-07-18: 딴 경로를 만들면 1회성·GC·중복방지 불변식이 깨진다).
 * · 게이트 = 등록자 runtime 이 one-shot(턴기반) — GD: "턴기반 팀원만". 탈락은 ★명시적 reason 으로 거절★한다 (침묵 금지).
 * · threadId 는 ★실제 작업 thread 필수★ — 보고 감지(hasSubstantiveReport)와 hermes/openclaw audit 결합이 thread 로 묶인다.
 * · sourceMessageId 는 합성 id — 원 요청 메시지가 없다. NULL 로 두면 audit 결합 SQL 이 전부 불일치한다(하네스 반증 2026-07-18).
 */
export const SELF_FOLLOWUP_DEFAULT_DURATION = "10m"; // GD: 10분 = 팀 작업 기준시간

export interface CreateSelfFollowupInput {
  agentId: string;
  threadId: string;
  duration?: string | null;
  now?: Date;
}

export type SelfFollowupResult =
  | { ok: true; id: string; deadlineAt: string }
  | { ok: false; reason: "missing_thread" | "not_one_shot_runtime" | "bad_duration" };

export function createSelfFollowup(db: Database, input: CreateSelfFollowupInput): SelfFollowupResult {
  const threadId = input.threadId?.trim();
  if (!threadId) return { ok: false, reason: "missing_thread" };
  const runtime = getAgentRuntime(db, input.agentId);
  if (!isOneShotRuntime(runtime)) return { ok: false, reason: "not_one_shot_runtime" };
  const duration = input.duration?.trim() || SELF_FOLLOWUP_DEFAULT_DURATION;
  const deadlineAt = resolveDeadline(duration, input.now ?? new Date());
  if (!deadlineAt) return { ok: false, reason: "bad_duration" };
  const id = createPendingFollowup(db, {
    recipientAgentId: input.agentId,
    targetAgentId: TEAM_LEAD_TARGET,
    threadId,
    sourceMessageId: `selfreg_${nanoid(12)}`,
    deadlineAt,
  });
  return { ok: true, id, deadlineAt };
}

interface PendingFollowupRow {
  id: string;
  recipient_agent_id: string;
  target_agent_id: string;
  thread_id: string | null;
  source_message_id: string;
  deadline_at: string;
  created_at: string;
  fired: number;
}

/**
 * Did `recipient_agent_id` deliver a SUBSTANTIVE report toward the team lead after the row was
 * created? A report = a message FROM the recipient, created after the row, that is either on the
 * tracked thread OR itself carries reply_mode='direct_to_gd' (a report routed to the team lead),
 * and whose body classifies as substantive/explicit_done (NOT ack-only) per classifyReplySignal.
 * ack-only replies ("알았습니다"/"네"/👀) do NOT count as a report.
 */
function hasSubstantiveReport(db: Database, row: PendingFollowupRow): boolean {
  const candidates = db
    .prepare(
      `SELECT body FROM message
       WHERE from_agent_id = ?
         AND created_at > ?
         AND (
           (thread_id IS NOT NULL AND thread_id = ?)
           -- ★thread 가 있는 follow-up 은 direct_to_gd meta 단독으로 fulfil 되지 않는다★ (hermes 리뷰 2026-07-18:
           --   thB 의 direct_to_gd 보고가 thA 의 row 를 잘못 fulfil → 미배달 보고가 조용히 '완료' 처리 = 보고 유실.
           --   자가등록으로 멤버당 다중 thread row 가 흔해져 실결함. thread-NULL row 만 meta 단독 fulfil 허용.)
           OR (? IS NULL AND meta_json IS NOT NULL AND meta_json LIKE '%"reply_mode":"direct_to_gd"%')
         )
       ORDER BY created_at ASC`,
    )
    .all(row.recipient_agent_id, row.created_at, row.thread_id, row.thread_id) as Array<{ body: string }>;
  for (const c of candidates) {
    const signal = classifyReplySignal(c.body ?? "");
    if (signal === "substantive" || signal === "explicit_done") return true;
  }
  // The tracker's two runtimes (openclaw/hermes) deliver a direct_to_gd report to the owner DM WITHOUT a
  // message row (openclaw = direct Telegram post; hermes = insertMessage intentionally skipped to avoid the
  // old double-send). So the message scan above misses a genuinely-delivered on-time report → the follow-up
  // re-wakes → the one-shot agent re-reports = DUPLICATE GD DM report (harness B, HIGH: fires on ~every success).
  // Accept a DB delivery audit as fulfillment: openclaw = 'gd_report_delivered' (wakeDispatcher), hermes =
  // 'message_sent' with direct_to_gd. This only WIDENS detection (fewer re-wakes, never a new send) → regression-0.
  // BIND the delivery audit to THIS follow-up (codex fix-review: actor+time alone falsely fulfills a
  // concurrent follow-up if the same agent delivers on a DIFFERENT thread). openclaw's gd_report_delivered
  // carries target = the dispatched message id = this row's source_message_id; hermes' message_sent carries
  // detail.thread_id = this row's thread. So a delivery for another thread/task cannot fulfill this row.
  const delivered = db
    .prepare(
      `SELECT 1 FROM audit_event
       WHERE actor = ? AND at > ?
         AND (
           (action = 'gd_report_delivered'
               AND (target = ?
                    OR (json_extract(detail_json, '$.thread_id') IS NOT NULL
                        AND json_extract(detail_json, '$.thread_id') = ?)))
           OR (action = 'message_sent'
               AND json_extract(detail_json, '$.to') = 'direct_to_gd'
               AND json_extract(detail_json, '$.via') = 'hermes_agent'
               AND json_extract(detail_json, '$.thread_id') = ?)
         )
       LIMIT 1`,
    )
    .get(row.recipient_agent_id, row.created_at, row.source_message_id, row.thread_id, row.thread_id) as { 1: number } | undefined;
  return !!delivered;
}

export interface CheckPendingFollowupsResult {
  fulfilled: string[]; // row ids deleted because the report arrived
  rewoken: string[]; // row ids that got a re-wake nudge + fired
  gc: string[]; // fired rows cleaned up: report landed late, OR grace window elapsed (stop tracking)
}

export interface CheckPendingFollowupsOpts {
  now?: Date;
  broadcast?: Broadcaster;
  limit?: number;
}

/**
 * One deterministic tick over due follow-ups. For each row with fired=0 AND deadline_at <= now:
 *   · report arrived → DELETE (fulfilled).
 *   · no report → insert ONE directed re-wake to the recipient, then mark fired=1.
 * A fired row is never re-woken again → bounded to exactly one re-wake per row.
 * Then a GC pass over fired=1 rows: DELETE if the report landed late, or if the grace window elapsed
 * (stop tracking — never a second poke). Keeps the table self-cleaning without ever double-sending.
 */
export function checkPendingFollowups(db: Database, opts: CheckPendingFollowupsOpts = {}): CheckPendingFollowupsResult {
  const now = opts.now ?? new Date();
  const nowSql = toSqliteDate(now);
  const limit = opts.limit ?? 50;
  const due = db
    .prepare(
      `SELECT id, recipient_agent_id, target_agent_id, thread_id, source_message_id, deadline_at, created_at, fired
       FROM pending_followup
       WHERE fired = 0 AND deadline_at <= ?
       ORDER BY deadline_at ASC
       LIMIT ?`,
    )
    .all(nowSql, limit) as PendingFollowupRow[];

  const result: CheckPendingFollowupsResult = { fulfilled: [], rewoken: [], gc: [] };
  for (const row of due) {
    if (hasSubstantiveReport(db, row)) {
      db.prepare(`DELETE FROM pending_followup WHERE id = ?`).run(row.id);
      result.fulfilled.push(row.id);
      continue;
    }
    // No report by the deadline → one re-wake nudge to the recipient, addressed as a directed
    // message so the wake dispatcher delivers it. from='system' so it's a system nudge, not a peer.
    // The team lead is referenced generically ("팀장") — never a hardcoded name/id (public-portable).
    const body =
      `[follow-up] 팀장님께 보고하기로 한 게 아직 안 왔음 — 지금 팀장님께 보고해줘 (--direct-to-gd).` +
      (row.thread_id ? ` (thread ${row.thread_id})` : "");
    acceptInbound(
      db,
      {
        from_agent_id: "system",
        to_agent_id: row.recipient_agent_id,
        type: "dm",
        body,
        source: "agent",
        hop_count: 0,
        priority: "high",
        ...(row.thread_id ? { thread_id: row.thread_id } : {}),
      },
      { dedupeWindowSec: 60, broadcast: opts.broadcast },
    );
    // Mark fired so it can never fire twice (bounded to one re-wake).
    db.prepare(`UPDATE pending_followup SET fired = 1 WHERE id = ?`).run(row.id);
    result.rewoken.push(row.id);
  }

  // GC pass (2026-07-10, GD): the report can land AFTER the single re-wake fired — clean those rows
  // so no phantom "pending" lingers. Also hard-expire fired rows past a grace window: one nudge was
  // already sent, and re-poking would send a duplicate ("중복보다 안 오는 게 낫다") — so we stop, not
  // re-fire. Bounded (LIMIT), fired-only; nothing here ever sends a message.
  const graceSql = toSqliteDate(new Date(now.getTime() - FIRED_GRACE_MS));
  const firedThisTick = new Set(result.rewoken); // just fired above → give a full grace window, don't GC yet
  const firedDue = db
    .prepare(
      `SELECT id, recipient_agent_id, target_agent_id, thread_id, source_message_id, deadline_at, created_at, fired
       FROM pending_followup
       WHERE fired = 1 AND deadline_at <= ?
       ORDER BY deadline_at ASC
       LIMIT ?`,
    )
    .all(nowSql, limit) as PendingFollowupRow[];
  for (const row of firedDue) {
    if (firedThisTick.has(row.id)) continue;
    if (hasSubstantiveReport(db, row) || row.deadline_at <= graceSql) {
      db.prepare(`DELETE FROM pending_followup WHERE id = ?`).run(row.id);
      result.gc.push(row.id);
    }
  }

  return result;
}

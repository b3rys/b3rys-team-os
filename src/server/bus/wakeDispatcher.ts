/**
 * Team Bus v1 — Wake Dispatcher worker.
 *
 * Polls message_recipient for pending dispatch rows, atomically claims each one,
 * resolves the target agent's runtime, calls the appropriate wake adapter, and
 * records the outcome (wake_dispatched / dead_letter + audit).
 *
 * Key design decisions:
 * - Adapter calls are isolated in async tasks; hang in one adapter cannot block
 *   the poller loop or the HTTP server (blast-radius containment).
 * - BUS_DISPATCH_ENABLED default ON (GD 2026-07-19); set =false → shadow mode: logs decisions, sends no wakes.
 * - claude_channel wakes are serialized via runtime_lock to avoid OAuth 429.
 * - Crash recovery runs on startup: stale 'dispatching' rows are reset to 'pending'.
 */

import { statSync, readFileSync } from "node:fs";
import { turnReplyTarget } from "./replyTarget";
import { sweepCollectionDeadlines } from "./collectionDeadline";
import { timeAgo } from "../lib/timeAgo";   // ★시각은 정본 함수로만★ (손으로 파싱하면 KST 에서 9시간 틀린다)
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import type { PendingDispatchRow, WakeAdapter, WakeResult } from "./types";
import {
  pendingDispatch,
  markDispatching,
  markWakeDispatched,
  markFailed,
  markDeferred,
  recoverStaleClaims,
  recentThreadMessages,
} from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { insertMessage } from "../db/inboxQueries";
import { recoverB3osNativeInflight } from "../runtimes/b3osNative/recovery";
import { recoverCodexInflight } from "../runtimes/codex/recovery";
import { appendAuditFile } from "../lib/auditFile";
import { checkPingpong } from "./antiPingpong";
import { recordReportDelivery } from "./deliveryRecord";
import { applySync, mirrorDeadLetter } from "./syncPolicy";
import { injectPrompt, tmuxSessionExists, EXECUTE_HARD_LIMIT_MS } from "../lib/tmuxInject";
import { getLocale } from "../lib/captureConfig";

// direct_to_gd DM 릴레이용 — GD 1:1 DM chat_id(setting owner_chat_id). 미설정이면 undefined(릴레이 불가).
function ownerDmChatId(db: Database): string | undefined {
  const row = db.prepare("SELECT value FROM setting WHERE key='owner_chat_id'").get() as { value?: string } | undefined;
  return row?.value || undefined;
}
import { injectOpenclawTelegramTurn, injectOpenclawDirectedTurn } from "../lib/openclawBridge";
import { reactTelegramAsHermes, runHermesTeamTurn, HERMES_TURN_TIMEOUT_MS } from "../lib/hermesBridge";
import { getChannel, resolveThreadKind } from "../channels/registry";
import { coordinatorId } from "../lib/capabilities";
import { ambientAgents } from "../lib/registry";
import { buildDedupeKey } from "../../shared/envelopeSchema";
import { classifyReplySignal } from "../../shared/recipientState";
import { makeB3osNativeAdapter } from "../runtimes/b3osNative/adapter";
import { makeCodexAdapter } from "../runtimes/codex/adapter";

type BusAttachment = {
  kind: "path" | "url";
  value: string;
  note?: string;
};

function attachmentsFromRow(row: PendingDispatchRow): BusAttachment[] | undefined {
  if (!row.attachments_json) return undefined;
  try {
    const parsed = JSON.parse(row.attachments_json) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((item): item is BusAttachment => {
      if (!item || typeof item !== "object") return false;
      const rec = item as Record<string, unknown>;
      return (rec.kind === "path" || rec.kind === "url") && typeof rec.value === "string";
    });
  } catch {
    return undefined;
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

// ★기본 ON★ (GD 2026-07-19): 협업/위임은 dispatcher 가 팀원을 깨워야 성립한다. 명시적으로 "false" 일 때만 shadow.
// (fresh/public 설치도 켜진 채로 뜬다 — 예전엔 기본 OFF 라 새 사용자는 버스 wake 가 안 됐다.)
export const BUS_DISPATCH_ENABLED = process.env.BUS_DISPATCH_ENABLED !== "false";

// Call-time read of the dispatch-enable gate. The const above is a load-time snapshot kept for
// status (routes/bus) + the startup log; per-row dispatch decisions use this so runtime env (and
// tests) take effect without a module reload. Same value, evaluated when dispatchRow runs.
function isDispatchEnabled(): boolean {
  return process.env.BUS_DISPATCH_ENABLED !== "false";
}
const POLL_INTERVAL_MS = Number(process.env.BUS_POLL_INTERVAL_MS ?? 1500);
// TTL hierarchy — there are TWO independent ladders, one per adapter family. The claim lease and
// inFlight self-heal are chosen PER RUNTIME (see leaseSecForRuntime / inFlightGraceForRuntime) so a
// slow openclaw wake can hold its claim long enough without loosening the fast paths.
//
//   tmux/claude path (fast, lock-serialized) — UNCHANGED:
//     adapter_timeout: 10s  — tmux prepare/session check (ADAPTER_TIMEOUT_MS)
//     execute_limit:   18s  — hard upper-bound for tmux execute (EXECUTE_HARD_LIMIT_MS from tmuxInject)
//     lock_ttl:        35s  — runtime_lock hold (acquireRuntimeLock)
//     lease_ttl:       60s  — claimed message_recipient lease (DEFAULT_LEASE_SEC)
//     inFlight_grace: 120s  — inFlight self-heal threshold (lease 60 + buffer 60)
//     Invariant: 10 < 18 < 35 < 60 < 120.  (codex/b3os_native use this default lane — they detach
//       immediately so their claim releases fast. ★hermes does NOT★ — it blocks the whole turn
//       (cap 300s+), so it has its OWN derived ladder below, mirroring openclaw. 2026-07-16 fix —
//       the old "hermes turn ≤90s" premise was stale, which left it on the fast lane → duplicate.)
//
//   openclaw path (slow: codex turns measured ~125–149s, gateway-bounded):
//     adapter_timeout: 240s — OpenClaw visible-reply bridge cap (OPENCLAW_ADAPTER_TIMEOUT_MS).
//                      Was 60s — an UNFINISHED fix: the inner gateway wait was raised to 300s
//                      (openclawBridge OPENCLAW_GATEWAY_TIMEOUT_MS) but this OUTER cap stayed 60s, so
//                      it cut off normal-but-slow codex turns at 60s → execute_timeout_maybe_partial
//                      → expired, GD report never marked delivered (2026-06-29 diagnosis). A timeout
//                      here is an "unknown side effect" (the turn may still post), not a retryable false.
//     lease_ttl:       300s — adapter_timeout + 60s (OPENCLAW_LEASE_SEC). MUST exceed adapter_timeout:
//                      otherwise the lease expires mid-wake, recoverStaleClaims resets the row to
//                      'pending', and the next poll re-dispatches the SAME message → codex woken twice.
//     inFlight_grace: 360s — lease 300 + buffer 60 (OPENCLAW_IN_FLIGHT_GRACE_MS). Secondary guard:
//                      keeps the in-process key past the lease so self-heal never evicts a live wake.
//     Invariant: 240 (adapter) < 300 (lease ≤ inner gateway 300) < 360 (grace).
//   The openclaw lease/grace AUTO-DERIVE from OPENCLAW_ADAPTER_TIMEOUT_MS so an env override of the
//   timeout cannot break the ladder.
export const ADAPTER_TIMEOUT_MS = 10_000; // tmux prepare/session check timeout (10s)
export const OPENCLAW_ADAPTER_TIMEOUT_MS = Number(process.env.OPENCLAW_ADAPTER_TIMEOUT_MS ?? 240_000);
const DEFAULT_LEASE_SEC = 60; // fast runtimes (tmux/claude/hermes/codex/b3os_native) claim lease
const IN_FLIGHT_GRACE_MS = 120_000; // default inFlight eviction: lease 60 + buffer 60
// openclaw-only long lease/grace, derived from the adapter timeout so adapter < lease < grace always holds.
const OPENCLAW_LEASE_MS = OPENCLAW_ADAPTER_TIMEOUT_MS + 60_000;
const OPENCLAW_LEASE_SEC = Math.ceil(OPENCLAW_LEASE_MS / 1000);
const OPENCLAW_IN_FLIGHT_GRACE_MS = OPENCLAW_LEASE_MS + 60_000;
// ★hermes: openclaw 와 같은 사다리 — 자기 turn cap(HERMES_TURN_TIMEOUT_MS)에서 파생★ (2026-07-16, 하네스 2대 검증).
//   hermes 어댑터는 ★턴 전체(최대 cap)를 블록★ 한다 → lease/grace 가 cap 보다 길어야 recoverStaleClaims 가
//   턴 도중 row 를 리셋하지 않는다(안 그러면 이중발사=중복보고). hermes 는 "턴 ≤90s" 라는 ★이제 거짓인 전제★
//   때문에 60/120 빠른 레인에 방치돼 있었다(실제 cap 300s+). openclaw 가 이미 이 방식으로 해결한 그대로 미러.
const HERMES_LEASE_MS = HERMES_TURN_TIMEOUT_MS + 60_000;
const HERMES_LEASE_SEC = Math.ceil(HERMES_LEASE_MS / 1000);
const HERMES_IN_FLIGHT_GRACE_MS = HERMES_LEASE_MS + 60_000;
const MAX_RETRIES = 3;

/**
 * Per-runtime claim lease (seconds). ★Blocking-wake runtimes (openclaw, hermes) hold their claim
 * for the WHOLE turn, so their lease must outlive the turn cap★ — else recoverStaleClaims resets
 * the row mid-turn → double-dispatch (duplicate). Each derives lease/grace from its own turn cap
 * (openclaw from OPENCLAW_ADAPTER_TIMEOUT_MS, hermes from HERMES_TURN_TIMEOUT_MS). Non-blocking
 * runtimes (tmux/claude ~28s fast-return, codex/b3os_native detach immediately) keep the 60s default.
 */
export function leaseSecForRuntime(runtime: string | undefined): number {
  if (runtime === "openclaw") return OPENCLAW_LEASE_SEC;
  if (runtime === "hermes_agent") return HERMES_LEASE_SEC;
  return DEFAULT_LEASE_SEC;
}
/** Per-runtime inFlight self-heal threshold — paired with the lease (lease + 60s buffer). */
export function inFlightGraceForRuntime(runtime: string | undefined): number {
  if (runtime === "openclaw") return OPENCLAW_IN_FLIGHT_GRACE_MS;
  if (runtime === "hermes_agent") return HERMES_IN_FLIGHT_GRACE_MS;
  return IN_FLIGHT_GRACE_MS;
}
const UNKNOWN_SIDE_EFFECT_DETAIL = "execute_timeout_maybe_partial";
// pre-widen: allowlist of agent IDs to wake-dispatch.
// BUS_DISPATCH_AGENTS="bill,codex,demis" → only those recipients get dispatched.
// Recipients not in the list are skipped (row stays 'pending' until they're added).
// Unset → all agents (existing behavior when BUS_DISPATCH_ENABLED=true).
const BUS_DISPATCH_AGENTS_RAW = process.env.BUS_DISPATCH_AGENTS;
const ENV_ALLOWLIST: ReadonlySet<string> | null = BUS_DISPATCH_AGENTS_RAW
  ? new Set(BUS_DISPATCH_AGENTS_RAW.split(",").map((s) => s.trim()).filter(Boolean))
  : null;

// 동적 보강 allowlist 파일(2026-06-10 GD): 영입 시 재시작 없이 에이전트를 wake 대상에 추가하기 위함.
// env(BUS_DISPATCH_AGENTS, plist·재시작 필요) ∪ 이 파일(쓰면 즉시 반영). mtime 캐시로 매 dispatch 읽기 저렴.
// 이게 "영입=클릭/자동, 터미널 0"의 인프라 — 활성화가 이 파일에 에이전트를 추가하면 바로 깨워짐.
// ★경로를 call-time+env override로 — 테스트가 실 운영파일(var/bus-wake-extra.txt) 읽어 fixture(bill/codex/steve)가
//   운영 allowlist(lui/devon/…)에 밀려 allowlist_not_enabled 되던 격리 갭(Codex 진단, 테스트 격리 게이트). GD 2026-07-01.
export function busWakeExtraFile(): string {
  return process.env.TEAMOS_BUS_WAKE_EXTRA_FILE ?? `${process.cwd()}/var/bus-wake-extra.txt`;
}
let _extraCache: { file: string; mtimeMs: number; ids: string[] } | null = null;
function extraAllowedIds(): string[] {
  const file = busWakeExtraFile();
  try {
    const st = statSync(file);
    if (!_extraCache || _extraCache.file !== file || _extraCache.mtimeMs !== st.mtimeMs) {
      const raw = readFileSync(file, "utf-8");
      _extraCache = { file, mtimeMs: st.mtimeMs, ids: raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) };
    }
    return _extraCache.ids;
  } catch {
    return []; // 파일 없음 = 보강 없음
  }
}
/**
 * 현재 wake allowlist: env ∪ 동적 파일. env·파일 둘 다 비면 null(= dispatch all, 기존 동작).
 * 파일에 에이전트를 추가하면 재시작 없이 다음 dispatch부터 반영된다.
 */
export function busDispatchAllowlist(): ReadonlySet<string> | null {
  const extra = extraAllowedIds();
  if (ENV_ALLOWLIST === null && extra.length === 0) return null;
  const s = new Set<string>(ENV_ALLOWLIST ?? []);
  for (const id of extra) s.add(id);
  return s;
}
/** @deprecated env-only 스냅샷(하위호환). 동적 판정은 busDispatchAllowlist() 사용. */
export const BUS_DISPATCH_ALLOWLIST = ENV_ALLOWLIST;

// OAuth 429 serialization lock key for claude_channel wakes
const CLAUDE_WAKE_LOCK_KEY = "bus_claude_wake";

// ─── Runtime lock helpers ─────────────────────────────────────────────────────

function acquireRuntimeLock(db: Database, key: string, holderId: string, ttlSec = 35): boolean {
  // Try to insert; if exists and expired, update.
  try {
    db.prepare(
      `INSERT INTO runtime_lock (key, holder_agent_id, acquired_at, expires_at)
       VALUES (?, ?, datetime('now'), datetime('now', '+${ttlSec} seconds'))`,
    ).run(key, holderId);
    return true;
  } catch {
    // Row exists — check if expired
    const row = db
      .prepare(`SELECT expires_at FROM runtime_lock WHERE key = ?`)
      .get(key) as { expires_at: string | null } | undefined;
    if (!row) return false;
    if (row.expires_at && row.expires_at < new Date().toISOString().replace("T", " ").slice(0, 19)) {
      // Expired — steal the lock
      const r = db
        .prepare(
          `UPDATE runtime_lock
           SET holder_agent_id = ?, acquired_at = datetime('now'), expires_at = datetime('now', '+${ttlSec} seconds')
           WHERE key = ?`,
        )
        .run(holderId, key);
      return r.changes > 0;
    }
    return false;
  }
}

function releaseRuntimeLock(db: Database, key: string): void {
  db.prepare(`DELETE FROM runtime_lock WHERE key = ?`).run(key);
}

export function isCollectOnlyFeedbackReply(
  db: Database,
  row: PendingDispatchRow,
  coordinator: string | undefined = coordinatorId(ambientAgents()),
): boolean {
  // collect-only feedback = coordinator(기본 owner)가 자기 자신에게 보내는 reply. 코디네이터가 팀원
  // 피드백을 1건씩 ack 하지 않고 inbox 에 모으게 하는 게이트. (이전 하드코딩 "codex" → coordinator capability.)
  if (!coordinator || row.agent_id !== coordinator || row.to_agent_id !== coordinator || row.type !== "reply") return false;
  const parentId = row.in_reply_to ?? row.parent_message_id;
  if (row.thread_id.includes("feedback") || row.thread_id.includes("dup-test")) return true;
  if (!parentId) return false;
  const parent = db
    .prepare(`SELECT thread_id, body, meta_json FROM message WHERE id = ?`)
    .get(parentId) as { thread_id: string; body: string; meta_json: string | null } | undefined;
  if (!parent) return false;
  if (parent.thread_id.includes("feedback") || parent.thread_id.includes("dup-test")) return true;
  if (parent.body.includes("한 번만 답") || parent.body.includes("추가 설명은 붙이지")) return true;
  if (parent.meta_json) {
    try {
      const meta = JSON.parse(parent.meta_json) as { kind?: string; reply_mode?: string };
      return meta.kind === "skill_feedback_request" || meta.reply_mode === "collect_only";
    } catch {
      return false;
    }
  }
  return false;
}

// ─── Wake adapters ────────────────────────────────────────────────────────────

/** Claude (tmux) adapter — reuses injectPrompt from tmuxInject.ts */

function makeCludeAdapter(db: Database): WakeAdapter {
  return {
    async wake(targetAgentId, row, teamContext): Promise<WakeResult> {
      // Serialize claude_channel wakes via runtime_lock (OAuth 429 guard)
      const lockKey = CLAUDE_WAKE_LOCK_KEY;
      const acquired = acquireRuntimeLock(db, lockKey, `bus:${targetAgentId}`);
      if (!acquired) {
        // Lock busy — defer without consuming retry_count (issue 2)
        return { ok: false, deferred: true, detail: "claude_wake_lock_busy" };
      }
      try {
        // Find agent record for tmux session
        const agentRow = db
          .prepare(`SELECT tmux_session FROM agent WHERE id = ?`)
          .get(targetAgentId) as { tmux_session: string | null } | undefined;
        const session = agentRow?.tmux_session;
        if (!session) {
          return { ok: false, detail: `no_tmux_session_for:${targetAgentId}` };
        }

        // ─── Issue 5: split injectPrompt into prepare + execute ──────────────
        // preparePrompt: pure computation (DB reads + string building), abortable via timeout.
        // executeTmuxInjection: atomic tmux write — MUST NOT be interrupted mid-send
        // (partial paste = workspace corruption). Timeout only applies to prepare phase.

        // prepare phase: resolve session exists (I/O, can be cut short by timeout)
        const sessionCheckOk = await withTimeout(
          tmuxSessionExists(session),
          ADAPTER_TIMEOUT_MS,
          false,
        );
        if (!sessionCheckOk) {
          // Session not found or prepare timed out — conservative: unknown_result + backoff
          return { ok: false, detail: "tmux_session_check_failed_or_timeout" };
        }

        // execute phase: has hard upper-bound (EXECUTE_HARD_LIMIT_MS) inside injectPrompt.
        // On execute timeout, injectPrompt returns { ok: false, maybePartial: true }.
        // We surface this as a special error so the caller applies a cooldown backoff
        // (not an immediate retry — partial paste risk).
        // case 6: Bill 위임 + direct_to_gd → demis 등 claude_channel 수신자가 버스 ack 대신
        // GD 1:1 DM 에 자기 reply 도구로 직접 보고하도록 directReport 를 넘긴다.
        const directToGd = resolveDirectToGd(row, ownerDmChatId(db));
        // ★팀원간 directed 는 "telegram" 으로 넘기지 않는다★ — 넘기면 tmuxInject 가 tg- thread 에서
        //   "단톡방에 답해라" 로 지시하고, 봇이 방에 올린 답은 캡처가 무시해 ★증발★한다.
        //   "bus" 로 넘기면 isTelegramGroup 이 거짓이 되어 ★답이 버스로 돌아온다.★ (isTeammateDirected 주석)
        const claudeSource = isTeammateDirected(row)
          ? "bus"
          : (row.source === "agent" || row.source === "user" || row.source === "system")
            ? (row.source === "user" ? "user" : "telegram")
            : "telegram";
        // ★봉투 kind★ (2026-07-15) — hermes hReplyRoute(662~707)·openclaw oDirectedKind(548~551) 와
        //   동일 판정. 단 claude 는 tmuxInject 내부에서 답 텍스트가 directReport→isTelegramGroup→default
        //   순으로 갈리므로(tmuxInject.ts:213~229), kind 도 ★그 분기와 정렬★ 한다 (kind 와 텍스트가
        //   어긋나면 팀원이 상충 신호를 받는다):
        //     · directReport(direct_to_gd) → "direct_to_gd"
        //     · isTelegramGroup(=source"telegram" && tg- thread. 예: 팀원 broadcast 가 tg- thread 로 옴)
        //         → "group" (방에 broadcast). '방이 어디냐'는 정본 resolveThreadKind 에 묻는다(복붙 금지).
        //     · 그 외 system 알림 → reply_to 있으면 "teammate"(그 사람에게), 없으면 "notice"(답할 곳 없음)
        //     · 나머지 → "teammate" (물어본 팀원에게)
        const claudeSys = resolveSystemReplyTo(row);
        const claudeKind: "teammate" | "group" | "direct_to_gd" | "notice" =
          directToGd
            ? "direct_to_gd"
            : (claudeSource === "telegram" && resolveThreadKind(row.thread_id) === "telegram_group")
              ? "group"
              : claudeSys.system
                ? (claudeSys.replyTo ? "teammate" : "notice")
                : "teammate";
        const injectResult = await injectPrompt({
          session,
          fromLabel: row.from_agent_id,
          locale: getLocale(db),
          threadId: row.thread_id,
          messageId: row.message_id,
          inReplyTo: row.in_reply_to ?? undefined,
          hopCount: row.hop_count,
          body: row.body,
          attachments: attachmentsFromRow(row),
          source: claudeSource,
          kind: claudeKind,
          agentId: targetAgentId,
          teamContext,
          directReport: directToGd ? { groupId: directToGd.groupId } : undefined,
        });
        if (injectResult.maybePartial) {
          // Partial inject — cannot assume abort. Signal to caller via special detail.
          return { ok: false, detail: "execute_timeout_maybe_partial" };
        }
        return { ok: injectResult.ok, detail: injectResult.ok ? "tmux_injected" : "tmux_inject_returned_false" };
      } finally {
        releaseRuntimeLock(db, lockKey);
      }
    },
  };
}

/**
 * case 6 (2026-06-05, DM 전환 2026-07-08): direct_to_gd — Bill 등이 팀원에게 위임하면서 "수신자가
 * GD 에게 직접 visible 응답하라"고 표시한 directed 메시지인지 판별. 핵심은 자연어 추측이 아니라 라우팅 계약:
 * 발신자(LLM)가 meta.reply_mode="direct_to_gd" 를 붙인다. 타겟은 ★GD 1:1 DM(owner_chat_id)★ — 팀방 유무 무관.
 * 수신자는 본문 해석 없이 이 플래그만 보고 GD DM 에 직접 응답한다. (source_thread_id 는 무시 — DM 이 기본.)
 * tg- thread 로 이미 온 메시지엔 적용 안 함(이미 텔레그램 경로). 반환: {groupId=owner DM chat_id, threadId} or null.
 */
// ★2026-07-08 GD: direct_to_gd 기본 타겟 = GD 1:1 DM(owner_chat_id). 그룹 아님.★
//   이유: 팀방 없는 퍼블릭 사용자도 릴레이 가능해야 하고, GD-facing 보고를 그룹에 노출하면 footgun.
//   반환 groupId 필드 = 이제 "GD DM chat_id" (봇이 자기 토큰으로 그 DM에 post). source_thread_id 는 무시(호환).
/** 수집 fan-out ask 인가 (meta.collect === true). ★그룹 thread 여도 답을 버스로 받아야★ 서버가
 *  collection_reply 로 집계할 수 있다. 없으면 tmuxInject 의 isTelegramGroup 분기가 이겨 수신자가
 *  telegram 그룹에 답하고, 그 답은 버스에 안 남아 collection 이 영원히 미완 → 종합에서 누락
 *  (2026-07-12 실측: 그룹 thread 수집에서 dbak 이 그룹에 "가을"이라 답했으나 서버는 미응답 처리).
 *  send.sh --collect 가 찍는 JSON boolean true 만 신뢰(문자열 "true" 아님). */
/**
 * ★팀원 사이의 directed 메시지인가 — 라우팅의 단일 판정 기준.★
 *
 * 참이면 ★thread 이름이 무엇이든 답은 버스로 돌아와야 한다.★
 *
 * WHY (2026-07-12 라이브 실측):
 *   지금까지 "답을 어디에 쓸지" 를 ★thread 이름(tg- 접두사)★ 으로 정했다. 그런데 텔레그램에서 시작된
 *   대화는 ★전부★ tg- 를 달고, 그 꼬리표는 ★답장·재위임을 이어가도 계속 따라다닌다.★
 *   → 팀장이 단톡방에서 시킨 일을 빌이 스티브에게 재위임하면, 스티브는 tg- 를 물려받아
 *     ★"단톡방에 답해라"★ 로 지시된다. 그런데 ★봇이 방에 올린 글은 telegramCapture 가 무시한다(is_bot —
 *     봇끼리 무한루프 방지. 그 자체는 옳다).★ → DB 에 한 줄도 안 남는다 → ★위임자는 답을 영영 못 받는다.★
 *   에러 0, 경고 0. 팀 단톡방 thread 의 팀원간 directed 메시지 ★155건★ 이 이 경로를 탔다.
 *
 *   `--collect` 를 붙이면 "버스로 답해라" 로 바뀌었다 — ★즉 --collect 가 이 버그의 반창고였다.★
 *   수집을 걷어내면 반창고가 사라지고 상처가 드러난다. 그 전에 봉합해야 한다.
 *
 * 판정은 ★thread 이름이 아니라 메시지의 종류★ 로:
 *   · 팀원이(source="agent") 특정 팀원에게(to !== "broadcast") → ★함수호출. 답은 버스로.★
 *   · 팀장이 보낸 telegram 메시지(source="user"/"system") → ★그룹·DM 경로 그대로★ (회귀 0)
 *   · broadcast → ★그룹 게시 그대로★ (모두가 봐야 하는 공지)
 */
export function isTeammateDirected(row: PendingDispatchRow): boolean {
  // ★system 알림도 directed 다.★ (2026-07-13 실측 — 마감 알림이 ★단톡방에 샜다★)
  //   [마감]·[전달 실패] 같은 알림은 ★그 팀원에게만★ 하는 말이다. 팀장 방에 뿌릴 내용이 아니다.
  //   그런데 source='system' 이라 이 판정에서 빠졌고 → 그룹 답변 경로를 타서 ★방에 게시됐다.★
  //   ★"수신자가 특정 팀원이면 그 사람에게만" — 발신자가 누구든 마찬가지다.★
  const directedToAgent = row.to_agent_id !== null && row.to_agent_id !== "broadcast" && row.to_agent_id !== "user";
  return (row.source === "agent" || row.source === "system") && directedToAgent;
}


/**
 * ★system 알림의 답 주소를 정한다.★ (하네스 D1 — 실측 40건이 --to system 으로 사라졌다)
 *
 * 예전엔 답 주소가 무조건 "보낸 사람에게" 였다 → 알림은 from='system' 이니 ★--to system★.
 * ★system 은 사람이 아니다★ → 수신자 행이 안 생긴다 → ★아무도 못 받는다.★ 서버는 201 ok 를 준다.
 * → ★본인은 "보고했다", 아무도 못 받았다.★ (단톡방 26% 유실과 ★같은 병, 두 번째 장소★)
 *
 * ★알림은 자기가 누구 일인지 안다★ — meta.reply_to 에 실어 보낸다(추측이 아니라 사실):
 *   카드 배정 → 배정한 사람 · 마감 알림 → 수집을 시킨 사람
 * 실을 게 없는 순수 통지(전달 실패)는 ★"답할 곳이 없다" 고 사실대로 말한다.★
 */
export function resolveSystemReplyTo(row: { from_agent_id: string; source?: string | null; meta_json?: string | null }):
  | { system: false }
  | { system: true; replyTo: string | null } {
  const isSystem = row.from_agent_id === "system" || row.source === "system";
  if (!isSystem) return { system: false };
  try {
    const m = row.meta_json ? (JSON.parse(row.meta_json) as { reply_to?: unknown }) : null;
    const to = typeof m?.reply_to === "string" && m.reply_to ? m.reply_to : null;
    return { system: true, replyTo: to };
  } catch {
    return { system: true, replyTo: null };
  }
}

export function resolveDirectToGd(row: PendingDispatchRow, ownerChatId?: string): { groupId: string; threadId: string } | null {
  // ★단톡방 스레드면 DM 직보를 하지 않는다 — 팀장님이 그 방에 계시니 방에 답하면 이미 닿는다.★
  //   DM 까지 보내면 ★중복 보고★ 다. (GD 2026-07-14 확인: "둘 다 상관없어" → 중복 없는 쪽을 택함.
  //   이건 2026-07-08 case-6 계약과 같은 동작이라 회귀도 없다.)
  //
  //   ★단, '이름 앞글자' 가 아니라 '방이 어디냐' 라는 ★사실★ 로 묻는다.★ (codex 리뷰)
  //   예전엔 여기서 `thread_id.startsWith("tg-")` 를 ★직접★ 봤다 — 같은 판단이 코드 4곳에 복붙돼 있었고,
  //   그중 하나(inbox.ts)가 오늘 36건을 삼켰다. ★판단이 여러 벌이면 언젠가 갈린다.★
  //   → 정본은 resolveThreadKind() 하나다. 방 이름 규칙이 바뀌어도 고칠 곳은 거기 한 군데다.
  if (resolveThreadKind(row.thread_id) === "telegram_group") return null;
  if (!row.meta_json) return null;
  try {
    const meta = JSON.parse(row.meta_json) as { reply_mode?: string; source_thread_id?: string };
    if (meta.reply_mode !== "direct_to_gd") return null;
    if (!ownerChatId) return null; // owner DM 없으면 릴레이 불가(설정 필요)
    return { threadId: `dm-${ownerChatId}`, groupId: ownerChatId };
  } catch {
    return null;
  }
}

export function resolveChannelSurfaceTarget(
  row: PendingDispatchRow,
  fallbackGroupId = process.env.CAPTURE_GROUP_ID ?? "",
  ownerChatId?: string,
): { groupId: string; threadId: string; directToGd: boolean } | null {
  const directToGd = resolveDirectToGd(row, ownerChatId);
  if (directToGd) {
    return { ...directToGd, directToGd: true };
  }
  if (resolveThreadKind(row.thread_id) === "telegram_group" && fallbackGroupId) {
    return { groupId: fallbackGroupId, threadId: row.thread_id, directToGd: false };
  }
  return null;
}

/** Openclaw adapter — reuses injectOpenclawTelegramTurn from openclawBridge.ts */
/**
 * ★openclaw 가 자기 손으로 텔레그램에 게시한 '턴의 최종 답변'을 배달 기록으로 남긴다.★ (2026-07-12)
 * openclaw 는 서버에 boolean 만 돌려주므로, ★콜백이 없으면 서버는 무엇이 나갔는지 영영 모른다.★
 * ★fail-soft★ — recordReportDelivery 는 throw 하지 않는다(발송 경로 불변).
 */
function openclawDeliveryRecorder(
  db: Database,
  agentId: string,
  threadId: string,     // ★원래 위임이 오간 thread★ (목적지 아님 — 그래야 위임과 연결된다)
  refId: string,
  directToGd: boolean,
) {
  return (info: { ok: boolean; text: string; groupId: string; deliveryMessageId?: string | number | null }) => {
    recordReportDelivery(db, {
      actor: agentId,
      channel: directToGd ? "telegram_dm" : "telegram_group",
      recipient: directToGd ? "gd" : info.groupId,
      threadId,
      refId,
      body: info.text,
      ok: info.ok,
      error: info.ok ? null : "telegram_send_failed",
    });
  };
}

function makeOpenclawAdapter(db: Database, agents: () => AgentRecord[]): WakeAdapter {
  return {
    async wake(targetAgentId, row, teamContext): Promise<WakeResult> {
      // Build a minimal AgentRecord-compatible object for the bridge call.
      // openclaw_agent_id(게이트웨이 프로필명)는 실제 레지스트리 레코드에서 해석한다 — codex="gd",
      // devon="devon" 등 agents.json 에 이미 박혀 있음(이전 하드코딩 targetAgentId==="codex"?"gd" 대체).
      const real = agents().find((a) => a.id === targetAgentId);
      const agent: AgentRecord = {
        id: targetAgentId,
        display_name: targetAgentId,
        role: "agent",
        runtime: "openclaw",
        status_provider: "openclaw_gateway",
        tmux_session: null,
        telegram_bot_username: null,
        workspace_path: "",
        persona_file: "",
        moderator_eligible: false,
        avatar_emoji: "🤖",
        openclaw_agent_id: real?.openclaw_agent_id ?? targetAgentId,
        // capabilities 를 실제 레지스트리 레코드에서 전달한다. openclawBridge.openclawTelegramBotToken 가
        // hasCapability(agent,"native_routing") 로 codex 의 공유 env 파일(gd 프로필 토큰) fallback 을 켜기
        // 때문 — 이게 빠지면 codex 봇 토큰을 못 찾아 postTelegramAsOpenclaw 가 {ok:false}(agent_reply_post_failed)
        // 로 실패해 direct_to_gd 보고가 GD 그룹에 안 올라간다(2026-06-24 continuation-driver 라이브 진단).
        capabilities: real?.capabilities,
      };
      // ★수집 fan-out 은 tg- thread(그룹)여도 directed(버스 복귀) 경로로 보낸다★ — 그룹 경로
      //   (injectOpenclawTelegramTurn)는 답을 텔레그램 그룹에만 올리고 ★버스 row 를 안 남겨서★
      //   collection_reply 집계가 불가 → openclaw 기여자(devon/brief/codex)가 ★영구 missing★
      //   (codex 리뷰 blocker 2, 2026-07-12). fan-out ask 는 그룹 게시가 아니라 directed 함수호출이다.
      //   tg- + collect 는 resolveDirectToGd 가 null(354행: tg- 는 早期 return)이라 자연히 directed 로 흐른다.
      // ★판정을 thread 접두사가 아니라 메시지 종류로.★ 팀원간 directed 는 tg- 여도 ★버스 복귀★.
      //   전에는 isCollectFanout(--collect 가 붙었나) 으로 예외를 뒀다 — ★그건 반창고였다.★
      //   --collect 없는 일반 위임은 그대로 "그룹에 답해라" 로 새어 ★답이 증발★했다.
      // ★'방이 어디냐' 는 정본 하나(resolveThreadKind)에 묻는다★ — 같은 판단을 복붙하지 않는다.
      if (resolveThreadKind(row.thread_id) !== "telegram_group" || isTeammateDirected(row)) {
        // case 6 (direct_to_gd): Bill 이 위임하며 "GD 그룹에 직접 응답" 플래그를 단 directed 메시지면,
        // 버스 ack 대신 GD 1:1 DM 에 visible reply 로 올린다. (injectOpenclawTelegramTurn 가 답을 DM 에 전송)
        const directToGd = resolveDirectToGd(row, ownerDmChatId(db));
        if (directToGd) {
          try {
            // normal tg 경로와 동일하게 withTimeout 으로 감싼다(게이트웨이 지연 시 dispatcher hang 방지).
            const timeoutSentinel = "__openclaw_timeout_unknown_side_effect__" as const;
            const wakePromise: Promise<boolean | typeof timeoutSentinel> = injectOpenclawTelegramTurn({
              agent,
              groupId: directToGd.groupId,
              threadId: directToGd.threadId,
              messageId: row.message_id,
              onDelivered: openclawDeliveryRecorder(db, targetAgentId, row.thread_id, row.message_id, true),
              body: row.body,
              attachments: attachmentsFromRow(row),
              fromLabel: row.from_agent_id,
              locale: getLocale(db),
              teamContext,
              inReplyTo: row.in_reply_to ?? undefined,
              hopCount: row.hop_count,
              directReport: true,
              kind: "direct_to_gd", // ★봉투 kind★ — 이 경로는 GD 직보(hermes hReplyRoute 의 direct_to_gd 와 동일)
            });
            const result = await withTimeout(wakePromise, OPENCLAW_ADAPTER_TIMEOUT_MS, timeoutSentinel);
            if (result === timeoutSentinel) {
              return { ok: false, detail: UNKNOWN_SIDE_EFFECT_DETAIL };
            }
            if (result) {
              // DB-queryable delivery marker: openclaw posts the direct_to_gd report straight to the owner DM
              // and writes NO message row, so followupTracker.hasSubstantiveReport (message-table scan) would
              // miss the delivered report → re-wake → the agent re-reports = DUPLICATE GD DM report. A DB audit
              // row lets the tracker see fulfillment. Additive audit only — the send path is untouched (regression-0).
              appendAudit(db, agent.id, "gd_report_delivered", row.message_id, { to: "direct_to_gd", via: "openclaw", thread_id: row.thread_id });
            }
            return { ok: result, detail: result ? "openclaw_direct_to_gd_injected" : "openclaw_direct_to_gd_returned_false" };
          } catch (e) {
            return { ok: false, detail: `openclaw_direct_to_gd_error:${e instanceof Error ? e.message : String(e)}` };
          }
        }
        // directed(지정) 버스 메시지: 그룹에 노출하지 않고 에이전트를 깨운다. 에이전트가 발신자에게
        // 버스로 ack/응답한다. (기존 inbox-only 는 directed handoff 가 openclaw 에이전트한테 안 닿는 버그였음 — GD 2489)
        // ★봉투 kind★ (2026-07-15) — hermes hReplyRoute(662~707) 와 ★동일 판정★. 여기는 directToGd 가
        //   null 인 else 분기라 direct_to_gd 는 이미 위에서 갈렸다. 남은 건 두 가지다:
        //   system 알림이면 reply_to 있으면 teammate(그 사람에게), 없으면 notice(답할 곳 없음); 아니면 teammate.
        const oSys = resolveSystemReplyTo(row);
        const oDirectedKind: "teammate" | "notice" = oSys.system
          ? (oSys.replyTo ? "teammate" : "notice")
          : "teammate";
        try {
          const ok = await injectOpenclawDirectedTurn({
            agent,
            threadId: row.thread_id,
            messageId: row.message_id,
            body: row.body,
            attachments: attachmentsFromRow(row),
            fromLabel: row.from_agent_id,
            locale: getLocale(db),
            teamContext,
            inReplyTo: row.in_reply_to ?? undefined,
            hopCount: row.hop_count,
            kind: oDirectedKind,
            });
          return { ok, detail: "openclaw_directed_injected" };
        } catch (e) {
          return { ok: false, detail: `openclaw_directed_error:${e instanceof Error ? e.message : String(e)}` };
        }
      }
      try {
        const timeoutSentinel = "__openclaw_timeout_unknown_side_effect__" as const;
        const wakePromise: Promise<boolean | typeof timeoutSentinel> = injectOpenclawTelegramTurn({
            agent,
            groupId: process.env.CAPTURE_GROUP_ID ?? "",
            threadId: row.thread_id,
            messageId: row.message_id,
            onDelivered: openclawDeliveryRecorder(db, targetAgentId, row.thread_id, row.message_id, false),
            body: row.body,
            attachments: attachmentsFromRow(row),
            fromLabel: row.from_agent_id,
            locale: getLocale(db),
            teamContext,
            // v1.2 issue 3: pass anti-pingpong metadata so openclaw adapter propagates
            // in_reply_to + hop_count in its prompt (same convention as tmux adapter).
            inReplyTo: row.in_reply_to ?? undefined,
            hopCount: row.hop_count,
            kind: "group", // ★봉투 kind★ — 단톡방 라우터 경로(팀원은 broadcast 로 답)
          });
        const result = await withTimeout(
          wakePromise,
          OPENCLAW_ADAPTER_TIMEOUT_MS,
          timeoutSentinel,
        );
        if (result === timeoutSentinel) {
          // injectOpenclawTelegramTurn cannot be cancelled. It may still produce and post a
          // Telegram reply after this timeout. Retrying here creates duplicate visible replies.
          return { ok: false, detail: UNKNOWN_SIDE_EFFECT_DETAIL };
        }
        const ok = result;
        return { ok, detail: ok ? "openclaw_injected" : "openclaw_inject_returned_false" };
      } catch (e) {
        return { ok: false, detail: `openclaw_error:${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}

/** Hermes Agent adapter — runs the configured Hermes profile as a one-shot team turn. */
function telegramOriginFromMeta(row: PendingDispatchRow): { chatId: string; messageId: string } | null {
  if (!row.meta_json) return null;
  try {
    const meta = JSON.parse(row.meta_json) as {
      telegram?: { chat_id?: unknown; message_id?: unknown };
    };
    const chatId = meta.telegram?.chat_id;
    const messageId = meta.telegram?.message_id;
    if (chatId === undefined || messageId === undefined) return null;
    return { chatId: String(chatId), messageId: String(messageId) };
  } catch {
    return null;
  }
}

// ★[B] 전환(2026-07-13) 으로 죽은 코드 제거★ (surfaceReplyOnChannel — 2026-07-15)
//   서버가 팀원 대신 채널에 게시하던 함수. 이제 팀원이 send.sh 로 직접 보내므로 ★아무도 호출하지 않는다.★
//   (visible surface 좌표 계산은 resolveChannelSurfaceTarget 에 남아있고 테스트도 유지 — export + 단위테스트)

function makeHermesAdapter(db: Database, agents: () => AgentRecord[]): WakeAdapter {
  return {
    async wake(targetAgentId, row, teamContext): Promise<WakeResult> {
      const agent = agents().find((a) => a.id === targetAgentId);
      if (!agent) return { ok: false, detail: "unknown_hermes_agent" };
      try {
        const origin = telegramOriginFromMeta(row);
        if (origin) {
          void reactTelegramAsHermes(agent, origin.chatId, origin.messageId).then((ok) => {
            appendAuditFile("hermes_bridge", ok ? "telegram_reacted" : "telegram_react_failed", row.message_id, {
              agent_id: targetAgentId,
              chat_id: origin.chatId,
              message_id: origin.messageId,
            });
          });
        }

        // ★[B] — 서버는 팀원 대신 말하지 않는다.★ (GD 2026-07-13: "팀원한테 맡겨. 다 빼.")
        //
        // ═══ 예전엔 여기서 무슨 일이 일어났나 ═══
        //   hermes 의 stdout(턴 본문)을 받아서 ★서버가 대신 게시★했다:
        //     · 턴 본문을 버스에 insert   → "hermes 가 말했다" 로 기록됐다
        //     · surfaceReplyOnChannel(reply)      → 단톡방/팀장 DM 에 게시
        //   그래서 hermes 는 ★뭘 쓰든 나갔다★ → ★"아무 말도 안 하기" 가 불가능★ → `[NO_REPLY]` 우회로 →
        //   가드 3곳 → 하나 놓침 → ★팀장 단톡방에 "[NO_REPLY]" 가 문자 그대로 찍혔다.★ (2026-07-13 라이브)
        //   거기에 ★"이 답을 누구에게 보낼까" 를 서버가 추측★해야 했다(turnReplyTarget) — 오배송의 근원.
        //
        // ═══ 지금 ═══
        //   ★턴 본문은 그 팀원의 메모다. 아무 데도 안 간다.★
        //   말하려면 팀원이 ★직접 보낸다★ — send.sh --to <상대> / --to broadcast(방) / --direct-to-gd.
        //   ★"보낸 것만 말한 것이다."★  → 침묵에 토큰이 필요없고, 수신자를 서버가 추측하지 않는다.
        //   (claude 가 원래 이렇게 돌고 있었고, 그래서 이 병이 없었다.)
        // ★답이 어디로 가야 하는지는 ★여기가 안다★. 주입문이 추측하게 두지 않는다.★ (GD 2026-07-14)
        //   claude 는 이미 :299 에서 resolveDirectToGd 로 판정하는데 ★hermes 만 그 줄이 없었다★ (codex 리뷰).
        //   그래서 direct_to_gd 위임을 받아도 hermes 는 그걸 모르고 위임자에게 답했다.
        //   여기는 ★버스 경로★ 다 — 답은 물어본 팀원에게 1:1 로 간다 (단톡방이 아니다).
        const hDirectToGd = resolveDirectToGd(row, ownerDmChatId(db));
        // ★system 알림이면 '보낸 사람(system)에게 답해라' 가 된다 = ★블랙홀★.★ (하네스 D1, 30일 40건)
        //   알림은 ★자기가 누구 일인지 안다★ — meta.reply_to. 그걸 쓴다(추측 아님).
        //   실을 게 없는 순수 통지는 ★답할 곳이 없다고 사실대로 말한다★ (kind:'notice').
        const hSys = resolveSystemReplyTo(row);
        const hReplyRoute = hDirectToGd
          ? ({ kind: "direct_to_gd" } as const)
          : hSys.system
            ? (hSys.replyTo ? ({ kind: "teammate", to: hSys.replyTo } as const) : ({ kind: "notice" } as const))
            : ({ kind: "teammate", to: row.from_agent_id } as const);
        await runHermesTeamTurn({
          agent,
          threadId: row.thread_id,
          messageId: row.message_id,
          body: row.body,
          fromLabel: row.from_agent_id,
          replyRoute: hReplyRoute,
          hopCount: row.hop_count,
          locale: getLocale(db),
          teamContext,
          // 턴 상한은 안 넘긴다 — runHermesTeamTurn 의 기본값(HERMES_TURN_TIMEOUT_MS)에 맡긴다.
          // ★상한은 한 곳(hermesBridge)에만 산다★ (GD 2026-07-15). 호출부마다 넘기면 또 슬랙처럼 빠뜨린다.
        });

        return { ok: true, detail: "hermes_oneshot_completed" };
      } catch (e) {
        return { ok: false, detail: "hermes_error:" + (e instanceof Error ? e.message : String(e)) };
      }
    },
  };
}

// ─── Timeout helper ───────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─── Team context capture ─────────────────────────────────────────────────────

/**
 * ★그룹 스레드에서 collector 가 봐야 하는 최소한 — ★자기 대화★.★ (2026-07-13, Steve)
 *
 * ═══ 왜 필요한가 ═══
 * 내 ctxfix 는 `tg-` 그룹을 ★일부러 제외★ 했다 ("팀방 전체는 광범위하다" — 3,072건·6주).
 * ★그 대가가 이거다★ (라이브 실측): 그룹에서 collector 가 ★눈을 감고 있다★ →
 *   ① ★재팬아웃★ (자기가 이미 물은 걸 모른다)
 *   ② ★"아직 안 모였다"★ (기여자가 답한 걸 모른다 — 둘 다 답했는데!)
 *   ③ ★종합 0건★ → ★팀장은 아무것도 못 받는다★
 * ★그리고 그룹이 팀장이 제일 많이 쓰는 경로다.★
 *
 * ═══ 전체가 아니라 ★필요한 것만★ ═══
 * ★"내가 보낸 것 + 나에게 온 것"★ = 내 팬아웃과 그 답. ★그룹 전체 대화가 아니다.★
 * 광범위 우려도 없고, 수집에 필요한 최소한이다. ★이건 권한 문제가 아니라 '내 대화' 를 보여주는 것이다.★
 */


/**
 * ★네가 이미 무엇을 보냈는지 ★보이게★ 만든다.★ (GD 2026-07-13: "룰과 세션데이터로 하자")
 *
 * ═══ 무엇이 잘못됐었나 (실측) ═══
 *   collector 가 종합을 두 번 냈다 (22:40:11 / 22:40:17 — 같은 내용).
 *   ★그 팀원의 컨텍스트에 자기 종합이 ★있었다★.★ 그런데 이렇게 보였다:
 *       [bill] steve랑 dbak한테 물어봐서 종합해줘
 *       [dex]  좋아하는 계절과 이유를 한 줄로…
 *       [dbak] 가을 — 습기 빠진…
 *       [dex]  종합: steve와 dbak 모두 가을을…      ← ★이게 자기 보고인데★
 *   ★자기가 보낸 것과 남이 보낸 것이 똑같이 생겼다.★ 수신자도 안 보인다.
 *   → 6줄 중에서 "저 중 하나가 내 보고다" 를 ★알아채야만★ 룰을 지킬 수 있었다.
 *   ★"읽고 판단해라" 고 시켜놓고, 읽기 어렵게 만들어 놨다.★ (오늘 이 패턴만 열 번째)
 *
 * ═══ 그래서 ═══
 *   · ★방향을 표시한다★: `[너 → bill]` / `[dbak → 너]` — 누가 누구에게인지 한눈에.
 *   · ★내가 이미 한 일을 요약해서 맨 아래 못박는다★ — 나열에 묻히지 않게.
 *   ★유사도 같은 걸로 서버가 막지 않는다★ (GD). ★팀원이 볼 수 있으면 팀원이 판단한다.★
 */

/** 문맥에 담는 메시지 수 · 시간창 · 한 건 상한 · 전체 예산. ★실측으로 정했다 (추측 아님)★:
 *   · 한 건 200자였는데 ★웹조사 답변(258자·219자)이 잘렸다★ → 800자
 *   · 전체 예산 8,000자 — 그룹방 최근 12건 실측이 761자였으니 평소엔 근처도 안 간다. ★폭주 방지용 상한.★ */
const CTX_MSGS = Number(process.env.CTX_MSGS ?? 12);
const CTX_HOURS = Number(process.env.CTX_HOURS ?? 24);   // ★24시간. 넘으면 문맥 없음★ (GD 결정)
const CTX_MSG_CHARS = Number(process.env.CTX_MSG_CHARS ?? 800);
const CTX_TOTAL_CHARS = Number(process.env.CTX_TOTAL_CHARS ?? 8000);
// ★단톡방(그룹 스레드) 전용 상한★ (GD 2026-07-16): 그룹방은 스레드 하나에 전 과제가 섞여, 12건·24h 를
//   그대로 주면 판교·증시·민재 인사가 통째 붙어 팀원이 ★옛 일을 지금 일로 착각★한다(Ames·codex 실측).
//   → 그룹방만 좁힌다: 자기것만 · 6시간 · 6건. (수집·작업 전용 스레드는 tg- 가 아니라 그대로 full)
const CTX_HOURS_GROUP = Number(process.env.CTX_HOURS_GROUP ?? 6);
// ★참고용 주입은 '자기것만' · 5건 (그룹·버스 통일, 분기 없음)★ (GD 2026-07-16 "전부 5개로 해. 분기 타지 말고").
//   from=나 OR to=나만 남기고 최근 5건. 남의 딴-대화(예: codex→demis 리뷰 팬아웃)를 걷어낸다.
const CTX_MSGS_OWN = Number(process.env.CTX_MSGS_OWN ?? 6);

export function buildTeamContext(db: Database, threadId: string, agentId?: string): string {
  try {
    // ★6시간 안에 아무것도 없으면 빈 문맥이었다★ (GD 질문: "만약 6시간 메시지가 없으면?")
    //   → 하루 뒤 재개된 위임에서 collector 가 ★자기가 이미 뭘 했는지도 모른 채★ 돈다.
    //   ★시간창은 '최근 대화' 를 주려는 것이지 '아무것도 안 주려는' 게 아니다.★ → 비면 나이 무시하고 준다.
    // ★24시간 넘으면 문맥 없음.★ (GD 2026-07-13 결정)
    //   ★옛 대화를 붙이면 "지금 일" 로 착각한다★ — 빈 문맥보다 나쁠 수 있다.
    //   필요하면 팀원이 `thread.sh <thread_id>` 로 ★직접 꺼내 본다★ (능력은 이미 있다).
    //   ★우리가 대신 "볼지 말지" 를 정하지 않는다.★
    // ★단톡방(그룹 스레드)만 좁힌다★ (GD 2026-07-16): resolveThreadKind 로 그룹방 판별(정본 함수).
    //   그룹방 = 스레드 하나에 전 과제 섞임 → ①6시간 ②자기것+나에게온것 ③6건.
    //   (수집·작업 스레드는 tg- 가 아니므로 full 유지 = 기여자 답이 그대로 보여 수집 안 깨짐)
    const isGroupRoom = resolveThreadKind(threadId) === "telegram_group";
    const fetchHours = isGroupRoom ? CTX_HOURS_GROUP : CTX_HOURS;
    const fetchLimit = 40; // 그룹·버스 모두 필터를 견디게 넉넉히 뽑고 아래서 5건으로 자른다
    let recent = recentThreadMessages(db, threadId, fetchLimit, fetchHours);
    if (agentId) {
      // ★자기것 + 나에게 온 것만 · 5건 (그룹·버스 통일, 분기 없음)★ (GD 2026-07-16 "전부 5개, 분기 타지 말고").
      //   from=나(내 팬아웃·발언) OR to=나(기여자 답·GD 지시)만. 남의 딴-대화(예: codex→demis 리뷰 팬아웃)를 제거.
      //   ★기여자 답(to=나)은 남으므로 수집 안 깨짐.★
      recent = recent
        .filter((m) => m.from_agent_id === agentId || m.to_agent_id === agentId)
        .slice(-CTX_MSGS_OWN);
    }
    if (!recent.length) return "";

    const who = (id: string | null | undefined): string => (id && id === agentId ? "너" : (id ?? "?"));
    // ★잘림이 진짜 답을 잘랐다★ (GD 질문: "메시지가 크면?"). 실측: 최근 121건 중 4건이 200자 초과인데
    //   ★하필 웹조사 답변들이었다★ (라이프치히 258자 · 한스아이슬러 219자) → collector 가 ★잘린 답으로 종합★.
    //   → 한 건 상한을 올리고(800자), ★전체 예산★ 으로 막는다(무한정 커지지 않게).
    //   ★상한에 걸려 잘리면 그 사실을 알려준다★ — 조용히 자르면 collector 는 그게 전부인 줄 안다.
    const lines: string[] = [];
    let budget = CTX_TOTAL_CHARS;
    for (let i = recent.length - 1; i >= 0; i--) {   // 최신부터 담고, 예산 다 쓰면 옛 것을 버린다
      const m = recent[i]!;
      const full = m.body.replace(/\n/g, " ");
      const cut = full.length > CTX_MSG_CHARS;
      const body = cut ? `${full.slice(0, CTX_MSG_CHARS)} …(잘림: 원문 ${full.length}자)` : full;
      const mine = m.from_agent_id === agentId;
      // ★언제 일인지 안 알려주고 있었다.★ (GD 2026-07-13: "오래된걸 주면 안좋은거 아냐?")
      //   ★맞다 — 오래됐다는 걸 ★모르게★ 주면 나쁘다.★ 3일 전 대화를 지금 일로 착각하면 엉뚱한 걸 실행한다.
      //   ★알려주면 팀원이 판단한다.★ ("이건 어제 얘기구나") — 빈 문맥보다 낫고, 무표시 옛 문맥보다 안전하다.
      const line = `${mine ? "★" : " "}(${timeAgo(m.created_at)})[${who(m.from_agent_id)} → ${who(m.to_agent_id)}] ${body}`;
      if (budget - line.length < 0 && lines.length > 0) break;
      budget -= line.length;
      lines.unshift(line);
    }

    if (!agentId) return lines.join("\n");

    // ★내가 이미 한 일 — 나열에 묻히지 않게 따로 못박는다.★
    // ★"물어본 사람" 과 "보고한 사람" 을 수신자만으로는 못 가른다★ — 그래서 ★있는 그대로★ 만 말한다.
    //   (요청자 bill 을 "이미 물어본 사람" 이라고 하면 그게 또 다른 거짓말이다)
    const mine = recent.filter((m) => m.from_agent_id === agentId);
    if (mine.length === 0) return lines.join("\n");
    const sentTo = [...new Set(mine.map((m) => m.to_agent_id ?? "?"))];
    const summary =
      `\n★[네가 이 스레드에서 이미 보낸 것] ${mine.length}건 → ${sentTo.join(", ")} ` +
      `(위에서 ★ 표시된 줄이 전부 네가 보낸 것이다)★\n` +
      `★같은 사람에게 같은 질문을 다시 하지 마라. 같은 요청에 두 번 보고하지 마라.★\n` +
      // ★24시간 넘은 이력은 안 붙인다 — 대신 ★꺼내 보는 법★ 을 한 줄로 알려준다 (GD 지시).★
      `(더 이전 이력이 필요하면: thread.sh ${threadId})`;
    return lines.join("\n") + "\n" + summary;
  } catch {
    return "";
  }
}

// ─── Core dispatch logic ──────────────────────────────────────────────────────

/**
 * Dispatch a single row. Called per-tick, single attempt.
 * Retry policy: DB retry_count is the single authority. On failure, markFailed sets
 * lease_until = now + backoff so the poller naturally waits. No in-process sleep loop.
 *
 * Policy-block (untrusted_source / unknown_sender / hop_limit_exceeded / pingpong):
 * These are terminal — no retry, immediate dead_letter/blocked (retry_count not used).
 *
 * Lock-busy (deferred): does NOT increment retry_count; resets pending with 2-3s backoff.
 */
// dispatchRow internals split into 3 stages (2026-06-06 strangler refactor, Bill claim-cut spec):
//   buildDispatchPlan → invokeWakeAdapter → recordDispatchOutcome.
// CLAIM stays in the worker/tick (pendingDispatch→markDispatching→inFlight→recoverStaleClaims) —
// its atomicity / inFlight self-heal is NEVER pulled into dispatchRow.
type DispatchPlan =
  | { kind: "skip" } // a preflight gate already applied the terminal state + audit
  | { kind: "invoke"; adapter: WakeAdapter; targetAgent: AgentRecord; teamContext: string };

/**
 * PLAN (preflight). Resolves the target and runs every skip-gate: unknown agent, owner-set,
 * collect-only feedback, anti-pingpong/trusted, shadow mode, allowlist, broadcast-no-marker,
 * unsupported runtime. Each gate writes its own terminal state + audit and returns {kind:"skip"}.
 * If all gates pass, picks the adapter + builds team context and returns {kind:"invoke", ...}.
 * (No claim here — the worker already claimed this row.)
 */
function buildDispatchPlan(
  db: Database,
  row: PendingDispatchRow,
  agents: AgentRecord[],
  claudeAdapter: WakeAdapter,
  openclawAdapter: WakeAdapter,
  hermesAdapter: WakeAdapter,
  b3osNativeAdapter: WakeAdapter,
  codexAdapter: WakeAdapter,
): DispatchPlan {
  const targetAgent = agents.find((a) => a.id === row.agent_id);
  if (!targetAgent) {
    // Unknown agent — terminal, no retry
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'dead_letter',
           last_error     = 'unknown_agent_in_roster',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(row.message_id, row.agent_id);
    appendAuditFile("bus_dispatcher", "dead_letter", row.message_id, {
      agent_id: row.agent_id,
      reason: "unknown_agent_in_roster",
    });
    return { kind: "skip" };
  }

  // v1.2 fix: owner-designated messages (handed to a specific owner) are not auto-wake
  // broadcast candidates. NOTE: the original expected_response=0 check was REMOVED — the
  // column DEFAULT is 0, so it excluded EVERY message (dispatcher woke nobody = critical
  // bug). A proper status/mirror exclusion needs sender-set fields + a sane default
  // (e.g. DEFAULT 1); deferred. Loop prevention = hop_count + round-count (checkPingpong) below.
  const msgMeta = db
    .prepare(`SELECT owner FROM message WHERE id = ?`)
    .get(row.message_id) as { owner: string | null } | undefined;
  if (msgMeta && msgMeta.owner !== null) {
    // owner-designated — not an auto-wake target.
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'completed',
           last_error     = 'no_auto_wake:owner_set',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(row.message_id, row.agent_id);
    return { kind: "skip" };
  }

  // Feedback collection is inbox-only. Otherwise each teammate reply wakes Codex, and Codex
  // tends to send per-person "received" acknowledgements instead of one concise synthesis.
  if (isCollectOnlyFeedbackReply(db, row, coordinatorId(agents))) {
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'completed',
           last_error     = 'collect_only_feedback_reply_no_wake',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(row.message_id, row.agent_id);
    appendAuditFile("bus_dispatcher", "collect_only_feedback_reply", row.message_id, {
      agent_id: row.agent_id,
      from: row.from_agent_id,
      thread_id: row.thread_id,
    });
    return { kind: "skip" };
  }

  // ack-only reply wake-gate (team-comm 왕복 축소, GD 2026-07-09):
  // "네 확인했습니다"/👍 같은 ack-only reply 는 상대를 full wake 하지 않는다(inbox-only). wake 는
  // actionable 신호(substantive/explicit_done)에만 — bare ack 로 상대 턴+토큰을 소모하는 ack 핑퐁 제거.
  // collect_only 게이트와 동형. 안전: recipient_state 는 ackClose 가 이미 반영하므로 상대는 다음
  // 자연 wake 때 inbox 에서 ack 를 본다(정보 유실 없음). reply 가 아닌 신규 task(type dm)는 항상 wake.
  if (
    row.type === "reply" &&
    (row.in_reply_to ?? row.parent_message_id) &&
    classifyReplySignal(row.body) === "ack_only"
  ) {
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'completed',
           last_error     = 'ack_only_reply_no_wake',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(row.message_id, row.agent_id);
    appendAuditFile("bus_dispatcher", "ack_only_reply_no_wake", row.message_id, {
      agent_id: row.agent_id,
      from: row.from_agent_id,
      thread_id: row.thread_id,
      body_preview: row.body.slice(0, 40),
    });
    return { kind: "skip" };
  }

  // ack-loop guard (team-comm ②, GD 2026-07-09; 하네스 적대검증 반영 2026-07-10):
  //   같은 (thread, from→to) 쌍이 '짧은 시간창 내' CAP 회 넘게 발신하면 반복(맞장구·재정리) → inbox-only.
  //   ★하네스 BLOCKING fix★: (1)그룹은 영구 thread(tg-GROUP) 라 lifetime 누적은 몇 주 뒤 정상 협업까지
  //   막음 → 반드시 '최근 시간창(WINDOW_MIN)' bound. (2)source=agent 만(user/system=GD 지시 절대 안 막음).
  //   (3)broadcast 제외(@all wake-all 보장 침해 방지). shadow-first(로그만) → GD 재검토+재검증 후에만 enforce.
  const ACK_LOOP_WINDOW_MIN = Number(process.env.ACK_LOOP_GUARD_WINDOW_MIN ?? 15);
  const ackLoopShadow = process.env.ACK_LOOP_GUARD_SHADOW === "true";
  const ackLoopEnforce = process.env.ACK_LOOP_GUARD === "true";
  if (
    (ackLoopShadow || ackLoopEnforce) &&
    row.source === "agent" &&                 // user/system(GD 지시)은 절대 억제 안 함
    row.type !== "broadcast" &&               // broadcast/@all wake-all 보장 유지
    row.to_agent_id !== "broadcast"
  ) {
    // 이 메시지보다 '먼저 생성된'(rowid) 같은 쌍 메시지를, '최근 WINDOW_MIN 분' 안에서만 카운트.
    //   rowid=삽입순서라 동시 도착해도 첫 것은 prior=0 통과; 시간창이라 몇 주 뒤 새 협업은 안 걸림.
    const prior = db
      .prepare(
        `SELECT COUNT(*) AS n FROM message
         WHERE thread_id = ? AND from_agent_id = ? AND to_agent_id = ?
           AND created_at > datetime('now', ?)
           AND rowid < (SELECT rowid FROM message WHERE id = ?)`,
      )
      .get(row.thread_id, row.from_agent_id, row.to_agent_id, `-${ACK_LOOP_WINDOW_MIN} minutes`, row.message_id) as { n: number };
    // CAP=1: 최근 시간창 내 같은 쌍의 2번째 발신부터 반복으로 간주 → inbox-only. 첫 것(위임·첫답·종합) 통과.
    if (prior.n >= 1) {
      if (ackLoopEnforce) {
        db.prepare(
          `UPDATE message_recipient
           SET delivery_state = 'completed', last_error = 'ack_loop_guard_no_wake',
               lease_until = NULL, claimed_at = NULL
           WHERE message_id = ? AND agent_id = ?`,
        ).run(row.message_id, row.agent_id);
        appendAuditFile("bus_dispatcher", "ack_loop_guard_blocked", row.message_id, {
          from: row.from_agent_id, to: row.to_agent_id, thread_id: row.thread_id,
          pair_prior: prior.n, body_preview: row.body.slice(0, 40),
        });
        return { kind: "skip" };
      }
      appendAuditFile("bus_dispatcher", "ack_loop_guard_shadow", row.message_id, {
        would_block: true, from: row.from_agent_id, to: row.to_agent_id,
        thread_id: row.thread_id, pair_prior: prior.n, body_preview: row.body.slice(0, 60),
      });
    }
  }

  // Anti-pingpong + trusted-source check
  const agentRoster = new Set(agents.map((a) => a.id));
  const verdict = checkPingpong(db, row, agentRoster);
  if (!verdict.allowed) {
    // Policy block — terminal, no retry. v1.2: use 'blocked' state (not 'dead_letter')
    // to distinguish policy blocks (untrusted/hop_limit/pingpong) from adapter failures.
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'blocked',
           last_error     = ?,
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(`blocked:${verdict.reason}`.slice(0, 500), row.message_id, row.agent_id);
    appendAudit(db, "bus_dispatcher", "dispatch_blocked", row.message_id, {
      agent_id: row.agent_id,
      reason: verdict.reason,
    });
    appendAuditFile("bus_dispatcher", "dispatch_blocked", row.message_id, {
      agent_id: row.agent_id,
      reason: verdict.reason,
      from: row.from_agent_id,
    });
    return { kind: "skip" };
  }

  // GD-report reminder (prompt-injection, GD 2026-07-11): while this collector has an active team-lead
  // collection flag for this thread, append a soft "wrap up & report to the team lead" reminder to the
  // wake body. It RIDES this existing wake (never creates one — no infinite loop). TTL-bounded + cleared
  // when the report is observed. Applied once here so every runtime adapter inherits it via row.body.
  // ★수집 오케스트레이션 제거(2026-07-13)★ — 서버가 번들을 안 준다. collector 가 직접 모아 직접 보고한다.

  //   이 리마인더는 그 보고를 잊지 않게 하는 ★가벼운 꼬리표★ 다 (기계가 아니다).


  // Shadow mode: log only, no actual wake (issue 5)
  // Only log once per row (first time we see it in shadow) using shadow_seen_at column.
  if (!isDispatchEnabled()) {
    const seenRow = db
      .prepare(
        `SELECT shadow_seen_at FROM message_recipient WHERE message_id=? AND agent_id=?`,
      )
      .get(row.message_id, row.agent_id) as { shadow_seen_at: string | null } | undefined;

    if (!seenRow?.shadow_seen_at) {
      // First time we see this row in shadow — log once
      appendAuditFile("bus_dispatcher", "shadow_would_dispatch", row.message_id, {
        agent_id: row.agent_id,
        from: row.from_agent_id,
        runtime: targetAgent.runtime,
        sync: row.sync,
        // pre-widen: also log allowlist status in shadow for pre-enable verification (동적 allowlist)
        allowlist_would_pass: (() => { const al = busDispatchAllowlist(); return al === null || al.has(row.agent_id); })(),
      });
      db.prepare(
        `UPDATE message_recipient
         SET delivery_state='pending',
             shadow_seen_at=datetime('now'),
             claimed_at=NULL,
             lease_until=datetime('now', '+30 seconds')
         WHERE message_id=? AND agent_id=?`,
      ).run(row.message_id, row.agent_id);
    } else {
      // Already logged — just release the claim without re-logging
      db.prepare(
        `UPDATE message_recipient
         SET delivery_state='pending',
             claimed_at=NULL,
             lease_until=datetime('now', '+30 seconds')
         WHERE message_id=? AND agent_id=?`,
      ).run(row.message_id, row.agent_id);
    }
    return { kind: "skip" };
  }

  // pre-widen: allowlist filter — only dispatch to agents in BUS_DISPATCH_AGENTS.
  // 2026-05-27 (GD): agents NOT in the allowlist are expired (dropped), not requeued.
  // "애매하면 만료" — ambiguous/indefinite waits are worse than a clean drop.
  // If the agent is later added to the allowlist, sender re-sends a new message.
  const _allow = busDispatchAllowlist();
  if (_allow !== null && !_allow.has(row.agent_id)) {
    appendAuditFile("bus_dispatcher", "allowlist_expired", row.message_id, {
      agent_id: row.agent_id,
      allowlist: Array.from(_allow),
    });
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired',
           last_error     = 'allowlist_not_enabled',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(row.message_id, row.agent_id);
    return { kind: "skip" };
  }

  // @all-gating (GD 2026-05-27): a broadcast message wakes every recipient ONLY when its body
  // carries an explicit wake-all marker (@all / @ALL / @b3rys / @group). Without the marker a
  // broadcast is inbox-only — it lands in each inbox (visible) but does NOT proactively wake.
  // Direct messages (to_agent_id != 'broadcast') always wake the addressed recipient.
  // (user-source broadcasts are already excluded upstream by the source='agent' scope.)
  const isBroadcast = row.to_agent_id === "broadcast" || row.type === "broadcast";
  if (isBroadcast && !/@(all|b3rys|group)\b/i.test(row.body)) {
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'completed',
           last_error     = 'broadcast_inbox_only_no_wake_marker',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(row.message_id, row.agent_id);
    appendAuditFile("bus_dispatcher", "broadcast_inbox_only", row.message_id, {
      agent_id: row.agent_id,
      from: row.from_agent_id,
    });
    return { kind: "skip" };
  }

  // Pick adapter — runtime→adapter registry (P1a: 삼항식을 Map 레지스트리로, 동작 동일).
  // 새 런타임 추가 = 이 Map에 한 줄. 미지원 runtime → undefined → null (기존 삼항식 final ': null'과 동일).
  // Map 사용(Steve·Codex 리뷰 채택): plain object[runtime]은 'constructor'/'__proto__'/'toString' 등
  //   상속 프로퍼티가 truthy라 `?? null`이 안 잡는 신규 위험 → Map.get은 구조적으로 차단.
  //   현재 runtime은 migrate.ts CHECK enum으로 제약돼 실질 안전하나, 그 불변식이 드리프트(수동 insert·
  //   agents.json 로드·향후 마이그레이션)해도 안전하게 + 설계문서 RuntimeAdapter REGISTRY의 씨앗.
  // 코어 선택 로직·dead_letter 경로 불변. (RuntimeAdapter 표준화의 첫 단계 — 코어 불가침)
  const runtimeAdapters = new Map<string, WakeAdapter>([
    ["claude_channel", claudeAdapter],
    ["openclaw", openclawAdapter],
    ["hermes_agent", hermesAdapter],
    ["b3os_native", b3osNativeAdapter],
    ["codex", codexAdapter],
  ]);
  const adapter: WakeAdapter | null = runtimeAdapters.get(targetAgent.runtime) ?? null;
  if (!adapter) {
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'dead_letter',
           last_error     = 'unsupported_runtime',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(row.message_id, row.agent_id);
    appendAuditFile("bus_dispatcher", "dead_letter", row.message_id, {
      agent_id: row.agent_id,
      runtime: targetAgent.runtime,
      reason: "unsupported_runtime",
    });
    return { kind: "skip" };
  }

  // Build team context for injection
  // ★깨워진 스레드의 최근 대화는 ★항상★ 준다 — 그건 "팀 전체 가시성" 이 아니라 ★자기 대화★ 다.★
  //
  // ═══ 무엇이 잘못됐었나 (2026-07-13 실측) ═══
  // ★예전엔 hermes 가 권한이 없어서 문맥을 ★빈 문자열★ 로 받았다 (그래서 종합을 못 했다).★
  // → 기여자 둘이 각각 답해도 hermes 는 ★자기를 깨운 한 건만★ 보였다 → "스티브 1건뿐" → ★종합 불가.★
  // ★codex 가 종합을 잘한 건 자가발신 때문만이 아니라 이 권한이 있어서였다.★
  //
  // ★그런데 이 게이트는 두 가지를 한 덩어리로 막고 있었다★:
  //   · `tg-` 그룹 스레드 문맥 = ★팀방 전체 대화★ → 광범위 가시성 → ★게이트가 맞다★
  //   · 위임/과제 스레드 문맥  = ★자기가 참여 중인 그 대화★ → ★막을 이유가 없다★
  // 우리 룰도 그렇게 말한다: "버스 문맥은 ★네가 깨워진 스레드에 대해서만★ 온다".
  // ★그 최소한마저 안 주고 있었다.★ → 그래서 갈랐다.
  // ★그룹방도 푼다.★ (GD 2026-07-13: "그룹방도 풀면 안돼?")
  //   ═══ 게이트를 걸 이유가 없었다 ═══
  //   · ★그룹방은 어차피 다 같이 있는 방이다.★ 거기 오간 말을 그 방 사람에게 숨길 이유가 없다.
  //   · 토큰 부담? ★실측: 최근 12건 = 총 761자.★ 부담이 아니다.
  //   · 그리고 게이트에 걸린 팀원들이 받던 대체 문맥은
  //     ★방향 표시도, '네가 보낸 것' 마커도 없는 옛 형식이었다★ — 오늘 고친 그 문제를 그대로 갖고 있었다.
  //   → ★깨워진 스레드의 문맥은 전 팀원에게, 같은 형식으로.★ (full_context 특권 불필요)
  //   (팀 전체·타 스레드 가시성은 별개다 — 여긴 ★네가 깨워진 그 대화★ 만 준다)
  const teamContext = buildTeamContext(db, row.thread_id, row.agent_id);
  return { kind: "invoke", adapter, targetAgent, teamContext };
}

/**
 * INVOKE — the ONLY side-effecting step: a single adapter.wake() attempt (retry is the DB poller's
 * job, issue 3). Exceptions are captured so recordDispatchOutcome handles them uniformly.
 */
async function invokeWakeAdapter(
  adapter: WakeAdapter,
  agentId: string,
  row: PendingDispatchRow,
  teamContext: string,
): Promise<{ result?: WakeResult; exception?: string }> {
  try {
    return { result: await adapter.wake(agentId, row, teamContext) };
  } catch (e) {
    return { exception: e instanceof Error ? e.message : String(e) };
  }
}

// 런타임별 웨이크-실패 정책 (P1a: runtime 문자열 분기를 선언적 정책 맵으로 — Steve·Codex 리뷰 방향).
// "expire_no_retry": inject가 취소불가/부분 side-effect 가능(openclaw) → exception·returned-false·timeout
//   3경로 모두 동일 terminal expire로 닫아 중복 가시응답 방지(GD 2026-06-03 dup root cause). preservesInbox.
// "retry": 깨끗한 실패 → markFailed 백오프(claude maybePartial은 아래 별도 cooldown 분기, hermes clean).
// 향후 P1b에서 RuntimeAdapter.ambiguousWakePolicy 필드로 이전(지금은 wakeDispatcher-local, types.ts 무관).
// 동작 동일: 기존 `runtime === "openclaw"` 두 분기를 정책 조회로 치환만 함(SQL·last_error 프리픽스 불변).
type WakeFailurePolicy = "expire_no_retry" | "retry";
const RUNTIME_WAKE_FAILURE_POLICY = new Map<string, WakeFailurePolicy>([
  ["openclaw", "expire_no_retry"],
  // ★hermes 도 재시도하면 안 된다.★ (2026-07-13 — 적대 리뷰가 내 1차 fix 를 반증했다)
  //   openclaw 와 같은 이유다: ★턴이 멱등이 아니다.★ hermes 는 턴 ★도중에★ send.sh 로 버스에 직접 쓴다
  //   (실측: 01:07:16 hermes→steve 위임 / 01:07:17 hermes→dbak 위임 / 01:07:54 그 턴이 실패).
  //   그 턴을 재시도하면 hermes 는 -z one-shot 이라 ★이전 시도의 기억이 없다★ → ★같은 사람에게 다시 위임★
  //   → 기여자들이 다시 답함 → 그 답들은 각자 ★새 retry 예산★ 을 가진 새 행이다. 상한이 3이 아니라 ★트리★ 다.
  //   게다가 "after 3 continuation attempts" 는 hermes 가 ★이미 자체 재시도를 소진했다★ 는 뜻이고,
  //   형제 실패가 ★HTTP 429 usage limit★ 이다 — 1s/2s/4s 백오프로 rate-limited 백엔드를 두들긴다.
  ["hermes_agent", "expire_no_retry"],
]);
function wakeFailurePolicy(runtime: string): WakeFailurePolicy {
  return RUNTIME_WAKE_FAILURE_POLICY.get(runtime) ?? "retry";
}

/**
 * RECORD — single place that maps the invoke outcome to the delivery state machine + audit + sync:
 * exception / deferred / ok / failure, with openclaw no-retry and unknown-side-effect expiry.
 */
/**
 * ★깨우기가 죽었으면 ★요청자에게 알린다.★★ (2026-07-13 — 팀장 라이브 테스트에서 드러남)
 *
 * ═══ 실측 ═══
 *   16:22:01  steve → hermes   [팀장 지시 수집] 질문
 *   16:23:32  hermes 턴 ★타임아웃★ → expired (재시도 없음 — 맞는 정책이다)
 *             ★steve 에게는 아무도 안 알려줬다.★
 *   → steve 는 ★오지 않을 답을 영원히 기다린다.★
 *
 * 룰은 "끝내 침묵하는 사람이 있으면 보고하고 누가 안 했는지 밝혀라" 고 한다.
 * ★steve 는 그걸 하고 싶어도 못 한다 — hermes 가 죽었다는 사실 자체가 안 보이니까.★
 * ★"룰이 시켰는데 안 한다" 가 아니라 "볼 수 없게 해놓고 시켰다".★ (오늘 이 패턴만 여섯 번째)
 *
 * ★재시도는 여전히 안 한다★ (hermes/openclaw 는 턴 도중 이미 팬아웃을 보낸다 → 재시도 = 중복 위임).
 * 대신 ★요청자에게 사실을 알려준다.★ 그러면 요청자가 룰대로 "미응답" 으로 마감할 수 있다.
 *
 * source='system' 으로 넣는다 — ★그 팀원이 한 말이 아니다.★
 * (system 알림이 실제로 배달되는 것은 2026-07-13 의 다른 fix 덕분이다 — 그전엔 이 통지도 조용히 묻혔다)
 */
function notifyRequesterOfExpiry(
  db: Database,
  row: PendingDispatchRow,
  agents: AgentRecord[],
  reason: string,
): void {
  try {
    // 팀원이 팀원에게 보낸 것만 — 팀장/시스템 발신은 통지 대상이 아니다(요청자가 사람/서버다)
    if (row.source !== "agent") return;
    const requester = row.from_agent_id;
    if (!requester || requester === row.agent_id) return;
    if (!agents.some((a) => a.id === requester)) return;

    const body =
      `[전달 실패] ${row.agent_id} 가 응답하지 못했습니다 (${reason}). ` +
      `이 요청은 재시도되지 않습니다 — ${row.agent_id} 없이 마감하셔도 됩니다. ` +
      `(수집이면 ${row.agent_id} 를 '미응답' 으로 명시하고 나머지로 종합하세요)`;

    const msg = insertMessage(db, {
      thread_id: row.thread_id,
      from_agent_id: "system",
      to_agent_id: requester,
      type: "dm",
      body,
      source: "system",           // ★그 팀원이 한 말이 아니다★
      hop_count: 0,               // 시스템 통지는 hop 체인 밖
      priority: "high",
      dedupe_key: `expiry-notice:${row.message_id}:${row.agent_id}`,   // 같은 실패로 두 번 안 알린다
    } as Parameters<typeof insertMessage>[1]);

    appendAudit(db, "bus_dispatcher", "expiry_notified_requester", row.message_id, {
      requester, failed_agent: row.agent_id, notice_id: msg.id, reason,
    });
  } catch (e) {
    appendAuditFile("bus_dispatcher", "expiry_notify_failed", row.message_id, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function recordDispatchOutcome(
  db: Database,
  row: PendingDispatchRow,
  targetAgent: AgentRecord,
  outcome: { result?: WakeResult; exception?: string },
  syncDeps: { groupId: string; botToken: string } | null,
  roster: AgentRecord[] = [],   // ★요청자가 실재 팀원인지 확인용★ (targetAgent 만으론 요청자를 못 찾는다)
): void {
  if (outcome.exception !== undefined) {
    const errMsg = outcome.exception;
    appendAuditFile("bus_dispatcher", "adapter_exception", row.message_id, {
      agent_id: row.agent_id,
      error: errMsg,
    });
    // OpenClaw exceptions are ambiguous just like returned-false/timeout: injectOpenclawTelegramTurn
    // may have already woken Codex and posted (or partially posted) a Telegram reply before throwing.
    // Generic retry here re-wakes + re-posts → duplicate visible replies (GD 2026-06-03 dup root cause —
    // the exception path was the last retry gap; the !result.ok path below already expires no-retry).
    // Same policy: expire (no retry), leave the bus message in the inbox for next-turn/manual collection.
    if (wakeFailurePolicy(targetAgent.runtime) === "expire_no_retry") {
      db.prepare(
        `UPDATE message_recipient
         SET delivery_state = 'expired',
             last_error     = ?,
             lease_until    = NULL,
             claimed_at     = NULL
         WHERE message_id = ? AND agent_id = ?`,
      ).run(`openclaw_no_retry_exception:${errMsg}`.slice(0, 500), row.message_id, row.agent_id);
      appendAuditFile("bus_dispatcher", "openclaw_wake_expired_no_retry", row.message_id, {
        agent_id: row.agent_id,
        detail: `exception:${errMsg}`.slice(0, 200),
      });
      appendAudit(db, "bus_dispatcher", "openclaw_wake_expired_no_retry", row.message_id, {
        agent_id: row.agent_id,
        last_error: `exception:${errMsg}`.slice(0, 200),
      });
      notifyRequesterOfExpiry(db, row, roster, errMsg);   // ★요청자가 영원히 기다리지 않게★
      return;
    }
    const nextState = markFailed(db, row.message_id, row.agent_id, errMsg, MAX_RETRIES);
    appendAudit(db, "bus_dispatcher", nextState === "dead_letter" ? "dead_letter" : "retrying", row.message_id, {
      agent_id: row.agent_id,
      last_error: errMsg,
    });
    if (nextState === "dead_letter" && syncDeps) {
      void mirrorDeadLetter(row, syncDeps);
    }
    return;
  }

  const result = outcome.result as WakeResult;

  // Handle deferred (lock-busy): reset without consuming retry_count (issue 2)
  // pre-widen: markDeferred now returns 'pending' | 'blocked' — handle hard cap.
  if (result.deferred) {
    const deferState = markDeferred(db, row.message_id, row.agent_id, 2);
    if (deferState === "blocked") {
      // Hard cap hit — log as terminal block (dead session guard)
      appendAuditFile("bus_dispatcher", "deferred_cap_blocked", row.message_id, {
        agent_id: row.agent_id,
        detail: result.detail,
      });
      appendAudit(db, "bus_dispatcher", "dispatch_blocked", row.message_id, {
        agent_id: row.agent_id,
        reason: "deferred_cap_exceeded",
      });
    } else {
      appendAuditFile("bus_dispatcher", "wake_deferred", row.message_id, {
        agent_id: row.agent_id,
        detail: result.detail,
      });
    }
    return;
  }

  if (result.ok) {
    markWakeDispatched(db, row.message_id, row.agent_id);
    appendAudit(db, "bus_dispatcher", "wake_dispatched", row.message_id, {
      agent_id: row.agent_id,
      runtime: targetAgent.runtime,
      detail: result.detail,
    });
    appendAuditFile("bus_dispatcher", "wake_dispatched", row.message_id, {
      agent_id: row.agent_id,
      runtime: targetAgent.runtime,
    });

    // Sync mirror (fire-and-forget, never blocks delivery)
    if (syncDeps) {
      void applySync(row, syncDeps);
    }
    return;
  }

  // Failure — increment retry_count, set backoff lease.
  // Special case: execute_timeout_maybe_partial — apply a longer cooldown to avoid
  // immediately re-injecting into a possibly-dirty session state (partial paste risk).
  const lastError = result.detail ?? "adapter_returned_false";
  appendAuditFile("bus_dispatcher", "wake_attempt_failed", row.message_id, {
    agent_id: row.agent_id,
    detail: lastError,
  });
  if (wakeFailurePolicy(targetAgent.runtime) === "expire_no_retry") {
    // OpenClaw gateway failures are ambiguous: the turn may already be queued or partially
    // visible to the native session. Retrying creates duplicate Codex turns, so expire and
    // leave the bus message in the inbox for manual/next-turn collection.
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired',
           last_error     = ?,
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(`openclaw_no_retry:${lastError}`.slice(0, 500), row.message_id, row.agent_id);
    appendAuditFile("bus_dispatcher", "openclaw_wake_expired_no_retry", row.message_id, {
      agent_id: row.agent_id,
      detail: lastError,
    });
    appendAudit(db, "bus_dispatcher", "openclaw_wake_expired_no_retry", row.message_id, {
      agent_id: row.agent_id,
      last_error: lastError,
    });
    notifyRequesterOfExpiry(db, row, roster, lastError);   // ★요청자가 영원히 기다리지 않게★
    return;
  }
  if (lastError === UNKNOWN_SIDE_EFFECT_DETAIL) {
    // 2026-05-27 (GD): "애매하면 만료" — partial inject is ambiguous (may have partially
    // applied). Retrying risks double-inject / workspace corruption. Drop immediately.
    // Sender re-sends if the message wasn't received. audit: execute_timeout_expired.
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired',
           last_error     = 'execute_timeout_expired',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(row.message_id, row.agent_id);
    appendAuditFile("bus_dispatcher", "execute_timeout_expired", row.message_id, {
      agent_id: row.agent_id,
    });
    appendAudit(db, "bus_dispatcher", "execute_timeout_expired", row.message_id, {
      agent_id: row.agent_id,
    });
    return;
  }
  const nextState = markFailed(db, row.message_id, row.agent_id, lastError, MAX_RETRIES);
  appendAudit(db, "bus_dispatcher", nextState === "dead_letter" ? "dead_letter" : "retrying", row.message_id, {
    agent_id: row.agent_id,
    last_error: lastError,
  });
  appendAuditFile("bus_dispatcher", nextState === "dead_letter" ? "dead_letter" : "retrying", row.message_id, {
    agent_id: row.agent_id,
    last_error: lastError,
  });

  if (nextState === "dead_letter" && syncDeps) {
    void mirrorDeadLetter(row, syncDeps);
  }
}

/**
 * Dispatch a single row. Called per-tick, single attempt.
 * Retry policy: DB retry_count is the single authority. On failure, markFailed sets
 * lease_until = now + backoff so the poller naturally waits. No in-process sleep loop.
 *
 * Thin orchestrator (2026-06-06 split): plan → invoke → record. Entry point/signature unchanged.
 */
export async function dispatchRow(
  db: Database,
  row: PendingDispatchRow,
  agents: AgentRecord[],
  claudeAdapter: WakeAdapter,
  openclawAdapter: WakeAdapter,
  hermesAdapter: WakeAdapter,
  b3osNativeAdapter: WakeAdapter,
  codexAdapter: WakeAdapter,
  syncDeps: { groupId: string; botToken: string } | null,
): Promise<void> {
  const plan = buildDispatchPlan(db, row, agents, claudeAdapter, openclawAdapter, hermesAdapter, b3osNativeAdapter, codexAdapter);
  if (plan.kind === "skip") return;
  const outcome = await invokeWakeAdapter(plan.adapter, row.agent_id, row, plan.teamContext);
  recordDispatchOutcome(db, row, plan.targetAgent, outcome, syncDeps, agents);
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export interface WakeDispatcherDeps {
  db: Database;
  agents: () => AgentRecord[];
}

export function startWakeDispatcher(deps: WakeDispatcherDeps): () => void {
  const { db } = deps;
  let stopped = false;

  // Crash recovery on startup
  const recovered = recoverStaleClaims(db);
  if (recovered > 0) {
    console.log(`[bus_dispatcher] crash recovery: reset ${recovered} stale dispatching rows → pending`);
    appendAuditFile("bus_dispatcher", "crash_recovery", null, { recovered });
  }

  // Startup cleanup: expire stale user-message pending recipients (2026-05-30, GD).
  // User (telegram) messages are delivered directly by the telegram channel, not the bus —
  // their recipient rows are never woken/completed by the dispatcher and have no expires_at,
  // so they accumulate as 'pending' forever (observed: 75 rows). The telegram path already
  // handled them, so on every startup we expire them. This is both the one-time cleanup and
  // the recurring re-dispatch-safety policy: a restart never re-fires already-handled user msgs.
  // Agent-to-agent pending is left untouched (the dispatcher delivers those; expiring would lose them).
  // M1.5 fix(Bill HIGH-1): runtime guard. The "user msgs are telegram-direct" premise is FALSE for
  // bus-dispatched runtimes (b3os_native/codex respond via the bus). Without this exclusion the
  // cleanup would expire b3os_native user-pending rows — including ones just re-queued by the
  // crash-recovery sweep below → the headline recovery case (user re-request) silently lost.
  const userCleanup = db
    .prepare(
      `UPDATE message_recipient SET delivery_state='expired',
         last_error='startup_cleanup: user msg handled via telegram direct'
       WHERE delivery_state='pending'
         AND message_id IN (SELECT id FROM message WHERE source='user')
         AND agent_id NOT IN (SELECT id FROM agent WHERE runtime IN ('b3os_native', 'codex'))`,
    )
    .run();
  if (userCleanup.changes > 0) {
    console.log(`[bus_dispatcher] startup cleanup: expired ${userCleanup.changes} stale user-message pending rows`);
    appendAuditFile("bus_dispatcher", "startup_user_pending_cleanup", null, { expired: userCleanup.changes });
  }

  // Startup cleanup: expire stale 'wake_dispatched' zombies (2026-05-31, GD).
  // wake_dispatched = "adapter called, waiting for the agent to ack". If no ack ever comes the row
  // sits forever (observed: ~38 rows, oldest ~4 days) and the topology shows them as lingering
  // in-flight. Anything older than 24h with no ack is dead — the wake either landed (agent moved on)
  // or was lost; it will never be acked now. Expire so the topology reflects reality. Only touches
  // wake_dispatched, never pending/dispatching (active dispatch) → hot path unaffected.
  const zombieCleanup = db
    .prepare(
      `UPDATE message_recipient SET delivery_state='expired',
         last_error='startup_cleanup: stale wake_dispatched (no ack >24h)'
       WHERE delivery_state='wake_dispatched'
         AND COALESCE(claimed_at, (SELECT created_at FROM message WHERE id=message_id))
             < datetime('now','-24 hours')`,
    )
    .run();
  if (zombieCleanup.changes > 0) {
    console.log(`[bus_dispatcher] startup cleanup: expired ${zombieCleanup.changes} stale wake_dispatched zombies`);
    appendAuditFile("bus_dispatcher", "startup_wake_dispatched_cleanup", null, { expired: zombieCleanup.changes });
  }

  // M1.5: b3os_native 크래시 턴 복구. 기존 recoverStaleClaims는 lease-safe-async라 이미 dispatching을 벗어난
  // b3os 행을 못 잡음 → 격리 마커 sweep으로 미완료 건을 'pending' 재wake. dedup이 이중게시 방어.
  // ★두 startup cleanup 뒤에 둔다(Bill HIGH-1): 그래야 재queue한 행을 user-cleanup이 못 만료.
  // ★부팅은 staleSec=0(Bill HIGH-2): 갓 부팅한 프로세스엔 라이브 턴이 없으니 모든 마커=크래시. 빠른 재시작(~1s)으로
  //   마커가 <150s여도 부팅에서 즉시 복구된다(150s 바닥은 런타임 주기 sweep에서 라이브 턴 보호 역할만).
  const b3osRecovered = recoverB3osNativeInflight(db, 0);
  if (b3osRecovered > 0) {
    console.log(`[bus_dispatcher] b3os_native crash recovery: re-dispatched ${b3osRecovered} lost turns`);
    appendAuditFile("bus_dispatcher", "b3os_native_crash_recovery", null, { recovered: b3osRecovered });
  }
  const codexRecovered = recoverCodexInflight(db, 0);
  if (codexRecovered > 0) {
    console.log(`[bus_dispatcher] codex crash recovery: re-dispatched ${codexRecovered} lost turns`);
    appendAuditFile("bus_dispatcher", "codex_crash_recovery", null, { recovered: codexRecovered });
  }

  const claudeAdapter = makeCludeAdapter(db);
  const openclawAdapter = makeOpenclawAdapter(db, deps.agents);
  const hermesAdapter = makeHermesAdapter(db, deps.agents);
  const b3osNativeAdapter = makeB3osNativeAdapter(db, deps.agents);
  const codexAdapter = makeCodexAdapter(db, deps.agents);

  // 미러 봇 토큰: 반드시 전용 TEAM_BUS_MIRROR_BOT_TOKEN 사용. CAPTURE_BOT_TOKEN(team op)은 쓰지 않는다 —
  // TEAM-OS §8: team op 봇은 agent 답변 중계/미러 금지(에이전트처럼 행동 X). 전용 미러 봇 없으면 미러 OFF.
  const mirrorBotToken = process.env.TEAM_BUS_MIRROR_BOT_TOKEN;
  const mirrorGroupId = process.env.CAPTURE_GROUP_ID ?? "";
  const syncDeps =
    mirrorBotToken
      ? {
          groupId: mirrorGroupId,
          botToken: mirrorBotToken,
        }
      : null;
  console.log(
    `[bus_dispatcher] started — enabled=${BUS_DISPATCH_ENABLED} poll=${POLL_INTERVAL_MS}ms`,
  );
  if (!BUS_DISPATCH_ENABLED) {
    console.log("[bus_dispatcher] SHADOW MODE: dispatch decisions logged only, no actual wakes");
  }

  // In-flight map: tracks (messageId:agentId) → { startedAt, graceMs }.
  // v1.2: changed from Set to Map so we can self-heal stale entries.
  // 2026-06-29: value carries a PER-RUNTIME graceMs (openclaw 360s vs default 120s) so a slow
  // openclaw wake isn't evicted mid-flight while fast runtimes keep the tight 120s self-heal.
  // DB lease is the authority; inFlight is a weak hint to avoid double-dispatch within a tick.
  // Self-healing: entries older than their graceMs are evicted at the start of each tick
  // so that a hang (e.g. execute timeout) never permanently blocks a key.
  /**
   * ★잠금은 '턴 완료' 까지 유지된다 — 이제 두 런타임 다 dispatchRow 가 턴 끝까지 블록한다.★
   * hermes 는 프로세스를 spawn 해 stdout 을 기다리고, openclaw 는 injectOpenclawDirectedTurn 이
   * agent.wait 으로 턴 종료(lifecycle-end)까지 블록한다(2026-07-16). → inFlight 잠금이 턴 내내 자연히
   * 유지되고, 그 사이 도착한 다음 답은 busy-defer(자가복구 경로)로 흘러 mid-turn 주입이 사라진다.
   * (옛 awaitingReplyFrom 슬롯홀드 + 게이트웨이 프로브는 openclaw 가 fire-and-forget 이던 시절의
   *  보정이었다 — agent.wait 블록킹으로 대체되어 제거함. 상한은 self-heal grace + claim-lease 가 받는다.)
   */
  const inFlight = new Map<string, { startedAt: number; graceMs: number }>();
  // ★"직렬화 때문에 얼마나 밀렸나" 를 재려면 ★첫 defer 시각★ 이 필요하다 (Steve).
  //   메시지 생성시각으로 재면 그건 ★"이 메시지가 몇 살인가"★ 다 — 9일 묵은 pending 행이 있으면 9일로 찍힌다.
  const firstDeferAt = new Map<string, number>();

  async function tick(): Promise<void> {
    try {
      // Self-heal: evict inFlight entries older than lease_ttl + grace.
      // DB lease is the truth; if the DB lease expired and recoverStaleClaims reset it,
      // we need inFlight to release too — otherwise the row is permanently skipped.
      const now = Date.now();
      // ★마감 독촉(collectionDeadline) — 개별보고 제외로 좁혀 되살림★ (GD 2026-07-15)
      //   [히스토리] 처음엔 통째 제거했다("독촉코드 빼는게 어때"). 그런데 이 backstop 이 실은 ★codex 의
      //   유일한 fallback 깨우기★ 였다 — codex 의 auto-wake 는 원래도 드롭했고(wake_dispatched 고아),
      //   [마감] 독촉이 codex 를 깨워 종합시키고 있었다(실측: 16:43 [마감]→16:44 종합). 제거하니 codex 가
      //   진짜 수집에서도 멈췄다. → ★뺄 게 아니라 개별/수집을 구별해 진짜 수집에만★ 깨우게 좁힌다.
      //   구별 = 기여자가 collector 에게 direct_to_gd 없이 답했나(수집) vs GD 께 direct_to_gd(개별).
      //   (collectionDeadline.ts inbound 쿼리에서 direct_to_gd 제외 — 개별보고는 answeredToCollector 에서 빠져 발사 안 됨)
      //   킬스위치 유지: COLLECTION_DEADLINE_ON=0 으로 끌 수 있다.
      if (process.env.COLLECTION_DEADLINE_ON !== "0") {
        try { sweepCollectionDeadlines(db, deps.agents()); } catch { /* 스윕 실패가 tick 을 죽이지 않는다 */ }
      }

      for (const [key, entry] of inFlight) {
        // 잠금 해제 = dispatchRow 완료(턴 종료) 시 finally 에서. 여기는 hang 백스톱(self-heal)만.
        if (now - entry.startedAt > entry.graceMs) {
          inFlight.delete(key);
          appendAuditFile("bus_dispatcher", "inflight_self_heal", null, { key, age_ms: now - entry.startedAt });
        }
      }

      // Team-Collect close tick (GD 2026-07-11, feature-flag OFF → no-op unless enabled): close any due
      // collection (all-received fast-path OR timeout guaranteed-closer) by emitting ONE synthetic
      // system→collector bundle message. That message dispatches on the next pass (normal wake path),
      // waking the collector once with the aggregated answers to synthesize + report. Idempotent per
      // collection (status leaves 'collecting'). Cheap query; guarded so it costs ~nothing when disabled.
      try {
      } catch (e) {
        appendAuditFile("bus_dispatcher", "team_collect_close_error", null, { error: e instanceof Error ? e.message : String(e) });
      }

      const agentsNow = deps.agents();
      const rows = pendingDispatch(db, 10);
      for (const row of rows) {
        const key = `${row.message_id}:${row.agent_id}`;
        if (inFlight.has(key)) continue;

        // Per-runtime claim lease: openclaw wakes run up to ~240s, so they need a lease that
        // outlives the wake (else recoverStaleClaims resets the row mid-wake → codex double-wake).
        // Other runtimes keep the 60s default. Runtime is a cheap roster lookup here.
        const runtime = agentsNow.find((a) => a.id === row.agent_id)?.runtime;

        // ★턴 직렬화 — 한 팀원의 턴이 도는 중이면 다음 wake 를 미룬다.★ (2026-07-13)
        //
        // ═══ 왜 ═══
        // in-flight 키가 ★메시지 단위★ 라, 같은 팀원의 ★다른 메시지★ 는 턴 중에도 그냥 나간다.
        // ★실측(rate-final-hermes-1)★: 기여자 두 명의 답이 각각 wake 를 일으켜 ★두 턴이 10초 간격으로 돌았고★,
        //   ★같은 종합이 팀장께 두 번 갔다.★
        //   두 번째 턴의 프롬프트 문맥은 ★첫 번째 종합이 나가기 전에★ 만들어져서,
        //   룰이 시킨 "이미 보냈으면 또 보내지 마라" 를 ★볼 수가 없었다.★ ★룰이 볼 게 없었다.★
        //
        // → ★앞 턴이 끝난 뒤에 깨우면★ 두 번째 턴의 문맥에 첫 종합이 들어온다 → ★스스로 침묵한다.★
        //
        // ★같은 변경이 다른 버그도 고친다★: 턴 중에 주입된 메시지를 openclaw TUI 는 ★버리고★,
        //   hermes REPL 은 ★돌던 턴을 죽인다(msg=interrupt)★ — 어제 실측한 ★조용한 유실★ 이 그것이다.
        //
        // ★claude 는 제외한다★ — Claude Code 는 ★입력을 큐잉★ 해서 안 잃는다. 직렬화하면 팀장 메시지만 느려진다.
        // ★영구 정체는 없다★: 아래 self-heal 이 grace 지난 항목을 비운다(죽은 턴도 결국 풀린다).
        if (runtime && runtime !== "claude_channel") {
          let busy = false;
          for (const k of inFlight.keys()) {
            if (k.endsWith(`:${row.agent_id}`)) { busy = true; break; }
          }
          if (busy) {
            // ★조용히 밀리면 아무도 모른다★ (Steve): 얼마나 기다렸는지 audit 으로 남긴다.
            //   → "팀장 메시지가 3분 밀렸다" 를 ★숫자로★ 안다. 안 남기면 다음에 또 추측한다.
            //   self-heal grace(120~420s)는 ★상한이지 목표가 아니다★ — 실제 분포를 봐야 한다.
            // ★UTC 를 로컬로 파싱하면 정확히 +9h 거짓말한다★ (Steve 실측: 실제 62초 → audit 9시간).
            //   DB 는 "2026-07-13 01:27:41" (UTC) 로 저장하는데 JS 는 그걸 ★로컬 시각★ 으로 읽는다.
            //   ★내 룰에 적혀 있는 함정에 내가 빠졌다.★ 여기서는 아예 ★DB 시각을 안 쓴다★ (아래 이유).
            // ★★매 tick 마다 찍으면 audit 폭풍이 된다★★ (라이브 실측: 1.5초마다 한 줄 → 2.5분에 200줄).
            //   긴 턴에 물린 메시지가 계속 재-defer 되기 때문이다. ★첫 defer 에만 남긴다.★
            //   ★"몇 번 밀렸나" 가 아니라 "밀리기 시작했다" 가 신호다.★ 실제 지연은 배달 시각과의 차이로 안다.
            const dk = `${row.message_id}:${row.agent_id}`;
            if (!firstDeferAt.has(dk)) {
              firstDeferAt.set(dk, Date.now());
              appendAudit(db, row.agent_id, "wake_deferred_turn_busy", row.message_id, { runtime });
            }
            continue; // row 는 pending 그대로 — 다음 tick 에 다시 온다 (retry_count 소모 없음)
          }
        }

        // Atomic claim — only one worker proceeds.
        // ★수집 오케스트레이션 제거(2026-07-13)★ — 수집 전용 리스/grace 상향이 필요 없어졌다.

        //   (수집 번들 턴이 300s 까지 돌아서 리스를 늘려뒀던 것. 이제 그 턴 자체가 없다.)

        const leaseSec = leaseSecForRuntime(runtime);

        const graceMs = inFlightGraceForRuntime(runtime);
        const claimed = markDispatching(db, row.message_id, row.agent_id, leaseSec);
        if (!claimed) continue; // Another process beat us to it

        inFlight.set(key, { startedAt: Date.now(), graceMs });
        // Fire-and-forget async task per row — adapter hang is isolated
        void (async () => {
          try {
            await dispatchRow(
              db,
              row,
              deps.agents(),
              claudeAdapter,
              openclawAdapter,
              hermesAdapter,
              b3osNativeAdapter,
              codexAdapter,
              syncDeps,
            );
          } catch (e) {
            appendAuditFile("bus_dispatcher", "dispatch_unhandled_error", row.message_id, {
              agent_id: row.agent_id,
              error: e instanceof Error ? e.message : String(e),
            });
            // Best effort: reset to pending for retry
            try {
              db.prepare(
                `UPDATE message_recipient
                 SET delivery_state='pending', claimed_at=NULL, lease_until=NULL
                 WHERE message_id=? AND agent_id=? AND delivery_state='dispatching'`,
              ).run(row.message_id, row.agent_id);
            } catch {
              // ignore secondary failure
            }
          } finally {
            // dispatchRow 가 턴 끝까지 블록한다(openclaw=agent.wait / hermes=stdout / claude=inject).
            //   → 여기 도달 = 턴 종료. 모든 런타임 동일하게 잠금 해제. (mid-turn 주입 방지는 busy-defer 가 담당)
            inFlight.delete(key);
          }
        })();
      }
    } catch (e) {
      console.error("[bus_dispatcher] poll error:", e instanceof Error ? e.message : String(e));
    }
  }

  // Also run crash recovery periodically (every 60s) for zombie leases
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;

  async function loop(): Promise<void> {
    while (!stopped) {
      await tick();
      if (!stopped) await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  recoveryTimer = setInterval(() => {
    const n = recoverStaleClaims(db);
    if (n > 0) {
      console.log(`[bus_dispatcher] periodic recovery: reset ${n} stale claims`);
    }
    // M1.5(Bill HIGH-2): b3os 마커도 주기적으로 sweep. 기본 150s 임계라 여기선 "진짜 라이브 턴(120s cap)"만
    // 보호하고, 부팅 때 <150s라 못 잡았거나 런타임 중 hung된 턴이 나이들면 재처리된다(데드존 제거).
    const b = recoverB3osNativeInflight(db);
    if (b > 0) {
      console.log(`[bus_dispatcher] periodic b3os recovery: re-dispatched ${b} stale turns`);
    }
    const c = recoverCodexInflight(db);
    if (c > 0) {
      console.log(`[bus_dispatcher] periodic codex recovery: re-dispatched ${c} stale turns`);
    }
  }, 60_000);

  void loop();

  return () => {
    stopped = true;
    if (recoveryTimer !== undefined) clearInterval(recoveryTimer);
    console.log("[bus_dispatcher] stopped");
  };
}

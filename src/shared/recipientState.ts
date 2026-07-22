/**
 * SLG cycle1 A (ack-close) — semantic recipient state: shared single source of truth.
 *
 * WHY THIS EXISTS
 * `delivery_state` answers a TRANSPORT question ("did the bus deliver the wake?").
 * It does NOT answer the WORK question ("did the recipient actually deal with it?").
 * The dashboard was reading transport state as if it were work state, so:
 *   - a delivered-but-unanswered message looked stuck/red  (false-red), and
 *   - a transport-'completed' row looked done/green        (false-green).
 * `recipient_state` is that missing work/closure layer. Both the topology view (A) and
 * the Inbox/Audit dashboard (B) MUST render from this contract so "받았다/하는중" can
 * never paint as "끝났다(green)". The state→color contract below is the enforcement point.
 */

// ─── Semantic states ─────────────────────────────────────────────────────────
export type RecipientState =
  | "open" // awaiting any recipient action (the only state that may paint red)
  | "acknowledged" // ack-only seen (네/👀/확인중) — engaged, NOT done
  | "in_progress" // substantive reply seen, no completion intent — engaged, NOT done
  | "completed" // explicit completion intent OR linked-task done — terminal, green
  | "blocked" // acked but blocked — non-terminal, keep tracking
  | "needs_match_review" // reply matched ambiguously — human/PM disambiguation, amber
  | "expired"; // dropped/timed out — terminal, neutral

export const RECIPIENT_STATES: RecipientState[] = [
  "open",
  "acknowledged",
  "in_progress",
  "completed",
  "blocked",
  "needs_match_review",
  "expired",
];

export type CloseReason =
  | "ack_only"
  | "reply_observed"
  | "explicit_done"
  | "task_status_mirror"
  | "needs_match_review"
  | "expired"
  | "manual"
  | "backfill_transport"
  | "activity_assumed" // Inbox-refined: closed because the recipient showed send-activity
//                         elsewhere (bus/Telegram/session) — inferred, NOT a real reply ack.
  | "broadcast_fyi"; // broadcast(@all/announce)는 FYI라 수신 시 acknowledged — 개별 응답 불요(action-required 아님).

export type StateSource = "reply" | "ack" | "task" | "manual" | "system" | "activity";

// ─── close_reason 표시 범주 (Inbox/Audit UI, Codex PM 확정 4범주) ──────────────
// 운영 close(활동근거)와 실제 답장 ack를 절대 안 섞는다 — 이게 모델의 정직성.
export type CloseCategory = "explicit_reply" | "activity_assumed" | "transport_backfill" | "expired" | "other";

export function closeReasonCategory(reason: CloseReason | null | undefined): CloseCategory {
  switch (reason) {
    case "ack_only":
    case "reply_observed":
    case "explicit_done":
    case "task_status_mirror":
      return "explicit_reply"; // 수신자/태스크의 실제 신호
    case "activity_assumed":
      return "activity_assumed"; // 활동근거 운영 close (추정)
    case "backfill_transport":
      return "transport_backfill"; // 과거 transport seed (미검증)
    case "expired":
      return "expired";
    default:
      return "other";
  }
}

/** Terminal states never re-open from a later reply (flip-flop guard). */
export function isTerminal(s: RecipientState): boolean {
  return s === "completed" || s === "expired";
}

/** Engaged = recipient has shown a sign of life. Clears false-red, but NOT green. */
export function isEngaged(s: RecipientState): boolean {
  return s !== "open";
}

// ─── state → color/label contract (Bill gate guard, 2026-06-13) ──────────────
// THE RULE: only 'completed' is green. acknowledged/in_progress are NEUTRAL — engaged
// but unfinished. If you ever map a non-completed state to green you have re-introduced
// the false-green bug A exists to kill.
export type SemanticColorKind = "red" | "neutral" | "green" | "amber" | "blocked" | "muted";

export interface SemanticStyle {
  /** node/badge color bucket — UI picks the actual hex from its theme */
  kind: SemanticColorKind;
  label: string;
  /** true only for 'completed' — a guard the UI can assert against */
  isDone: boolean;
}

export const RECIPIENT_STATE_STYLE: Record<RecipientState, SemanticStyle> = {
  open: { kind: "red", label: "대기", isDone: false }, // red only when past SLA (caller decides threshold)
  acknowledged: { kind: "neutral", label: "받음", isDone: false },
  in_progress: { kind: "neutral", label: "작업중", isDone: false },
  completed: { kind: "green", label: "완료", isDone: true },
  blocked: { kind: "blocked", label: "막힘", isDone: false },
  needs_match_review: { kind: "amber", label: "확인 필요", isDone: false },
  expired: { kind: "muted", label: "만료", isDone: false },
};

/** Hard invariant usable in tests: nothing but 'completed' is allowed to be green/done. */
export function assertNoFalseGreen(): void {
  for (const s of RECIPIENT_STATES) {
    const style = RECIPIENT_STATE_STYLE[s];
    const greenish = style.kind === "green" || style.isDone;
    if (greenish && s !== "completed") {
      throw new Error(`false-green: state '${s}' renders as done/green but is not 'completed'`);
    }
  }
}

// ─── reply-signal classifier (pure) ──────────────────────────────────────────
// Conservative by design: a reply only becomes 'explicit_done' on a clear completion
// word. Anything ambiguous stays 'substantive' (→ in_progress), never auto-completing.
// This is the false-green guard at the data layer.
export type ReplySignal = "ack_only" | "substantive" | "explicit_done";

// Base acknowledgement lexemes — a reply is a bare ack ONLY when every whitespace word equals a
// lexeme + an optional inflection suffix (below), or the body is pure emoji/reaction. Matching is
// lexeme+suffix (NOT a loose prefix), so a substantive word that merely starts with an ack syllable
// (확인불가, 네트워크, 예외, 콜백) can never be mis-gated. Growing this list is fail-safe: an
// uncovered phrase simply wakes the requester, never silently gated. (OWNER 2026-07-09: replaces the
// prefix-match + open-ended blocker list — no whack-a-mole, no possible mis-gate of a blocked reply.)
const ACK_LEXEMES = [
  "네", "넵", "넹", "예", "옙", "ok", "okay", "오케이", "콜",
  "확인", "볼게", "보겠", "알겠", "알았", "접수", "ack",
  "ㅇㅇ", "ㅇㅋ", "응", "웅", "굿", "good",
];
// Closed set of trailing inflections/particles that keep a lexeme a bare ack (확인+했습니다=ack,
// 확인+불가=substantive). Grammatical endings only — not open vocabulary, so it stays stable.
const ACK_SUFFIXES = [
  "", "요", "여", "어", "어요", "다", "습니다", "했어", "했어요", "했습니다",
  "할게", "할게요", "중", "중이야", "음", "겠습니다", "네요", "죠", "용", "쓰",
];

// Clear completion intent. Presence of any → explicit_done (overrides ack-only).
const DONE_MARKERS = [
  "완료", "처리했", "처리 완료", "끝냈", "끝났", "마무리했", "마무리 완료",
  "반영했", "반영 완료", "닫았", "닫음", "done", "완료했", "해결했", "해결 완료",
  "배포했", "머지했", "merged", "올렸", "제출했",
];

const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}️]/gu;

export function classifyReplySignal(rawBody: string): ReplySignal {
  const body = (rawBody ?? "").trim();
  const lower = body.toLowerCase();

  // 1) explicit completion intent wins (even if phrased briefly)
  if (DONE_MARKERS.some((m) => lower.includes(m.toLowerCase()))) {
    return "explicit_done";
  }

  const stripped = body.replace(EMOJI_RE, "").trim();
  // 2) pure emoji/reaction → ack
  if (stripped.length === 0) return "ack_only";

  // 3) ack-only: short AND every whitespace word is an ack lexeme + a closed-set inflection suffix
  //    (or the bare lexeme). Trailing punctuation is stripped per word. Because a word must FULLY
  //    equal lexeme+suffix (no partial/prefix match), a substantive word that starts with an ack
  //    syllable (확인불가, 네트워크 끊김, 콜백 실패, 네 안돼요) never matches → the requester is
  //    always woken for it. This is the fail-safe wake-gate input (OWNER 2026-07-09).
  const isAckWord = (w: string): boolean => {
    const wl = w.toLowerCase().replace(/[.!?~,·…]+$/u, "");
    if (!wl) return false;
    return ACK_LEXEMES.some((t) => ACK_SUFFIXES.some((s) => wl === (t + s).toLowerCase()));
  };
  const isShort = stripped.length <= 16;
  const words = stripped.split(/\s+/).filter(Boolean);
  if (isShort && words.length > 0 && words.every(isAckWord)) {
    return "ack_only";
  }

  // 4) anything with real content but no done-marker → substantive (in_progress)
  return "substantive";
}

// ─── transition decision (pure) ──────────────────────────────────────────────
// Maps a resolved signal + context to the next recipient_state. DB-side matching
// (in_reply_to → message, task lookup) happens in the server; this function is the
// pure core so it is fully unit-testable and shared.
export interface TransitionInput {
  current: RecipientState;
  /** reply classification, when the trigger is a reply/ack message */
  signal?: ReplySignal;
  /** set when the trigger is a linked-task status change */
  taskStatus?: "done" | "blocked" | "doing" | "plan";
  /** true when in_reply_to / task matching produced multiple equal candidates (req#4) */
  ambiguousMatch?: boolean;
  /** Inbox-refined: recipient showed send-activity elsewhere (no targeted reply). Closes
   * an 'open' row to acknowledged with close_reason='activity_assumed' (inferred, not a
   * real ack). Only lifts 'open' — never touches in_progress/blocked/needs_match_review. */
  activityAck?: boolean;
  source: StateSource;
  /** id of the reply/message (or task) that triggered this — provenance/reversibility */
  closingMessageId?: string;
}

export interface TransitionDecision {
  next: RecipientState;
  closeReason: CloseReason | null;
  closedAt: boolean; // caller stamps datetime('now') when true
  state_source: StateSource;
  closing_message_id: string | null;
  /** true when no transition should be written (idempotent no-op / terminal lock) */
  noop: boolean;
}

const noChange = (current: RecipientState, source: StateSource): TransitionDecision => ({
  next: current,
  closeReason: null,
  closedAt: false,
  state_source: source,
  closing_message_id: null,
  noop: true,
});

export function decideRecipientTransition(input: TransitionInput): TransitionDecision {
  const { current, signal, taskStatus, ambiguousMatch, activityAck, source, closingMessageId } = input;

  // Terminal lock: completed/expired never re-open from a later reply (flip-flop guard).
  if (isTerminal(current)) return noChange(current, source);

  // Activity-based auto-ack (Inbox-refined): the recipient is demonstrably alive (sent
  // something), so a still-'open' row isn't a stuck red — mark acknowledged but tag it
  // 'activity_assumed' so it never masquerades as a real reply ack. ONLY lifts 'open':
  // in_progress/blocked/acknowledged/needs_match_review are left as-is (already engaged
  // or need human attention). Lower precedence than an explicit reply/task signal below.
  if (activityAck && !signal && !taskStatus && !ambiguousMatch) {
    return current === "open"
      ? mk("acknowledged", "activity_assumed", false, "activity", closingMessageId)
      : noChange(current, source);
  }

  // Ambiguous match → flag for review, never auto-close (req#4).
  if (ambiguousMatch) {
    if (current === "needs_match_review") return noChange(current, source);
    return {
      next: "needs_match_review",
      closeReason: "needs_match_review",
      closedAt: false,
      state_source: source,
      closing_message_id: closingMessageId ?? null,
      noop: false,
    };
  }

  // Linked task is the source of truth (req#2). message close = mirror.
  if (taskStatus) {
    if (taskStatus === "done") {
      return mk("completed", "task_status_mirror", true, "task", closingMessageId);
    }
    if (taskStatus === "blocked") {
      return mk("blocked", "task_status_mirror", false, "task", closingMessageId);
    }
    // doing/plan → in_progress (engaged, not done)
    return current === "in_progress"
      ? noChange(current, "task")
      : mk("in_progress", "reply_observed", false, "task", closingMessageId);
  }

  // Reply/ack signal — the 2-stage close (req#1).
  switch (signal) {
    case "explicit_done":
      return mk("completed", "explicit_done", true, source, closingMessageId);
    case "substantive":
      // reply observed clears false-red but only reaches in_progress, never completed.
      return current === "in_progress"
        ? noChange(current, source)
        : mk("in_progress", "reply_observed", false, source, closingMessageId);
    case "ack_only":
      // ack-only never downgrades a richer state; only lifts 'open' → 'acknowledged'.
      return current === "open"
        ? mk("acknowledged", "ack_only", false, source, closingMessageId)
        : noChange(current, source);
    default:
      return noChange(current, source);
  }
}

function mk(
  next: RecipientState,
  closeReason: CloseReason,
  closedAt: boolean,
  state_source: StateSource,
  closingMessageId?: string,
): TransitionDecision {
  return {
    next,
    closeReason,
    closedAt,
    state_source,
    closing_message_id: closingMessageId ?? null,
    noop: false,
  };
}

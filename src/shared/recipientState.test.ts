import { describe, expect, test } from "bun:test";
import {
  RECIPIENT_STATES,
  RECIPIENT_STATE_STYLE,
  assertNoFalseGreen,
  classifyReplySignal,
  decideRecipientTransition,
  closeReasonCategory,
  isTerminal,
  type RecipientState,
} from "./recipientState";

describe("state→color contract (Bill gate guard)", () => {
  test("only 'completed' is green/done — no false-green", () => {
    expect(() => assertNoFalseGreen()).not.toThrow();
  });

  test("acknowledged & in_progress render neutral, never green", () => {
    expect(RECIPIENT_STATE_STYLE.acknowledged.kind).toBe("neutral");
    expect(RECIPIENT_STATE_STYLE.in_progress.kind).toBe("neutral");
    expect(RECIPIENT_STATE_STYLE.acknowledged.isDone).toBe(false);
    expect(RECIPIENT_STATE_STYLE.in_progress.isDone).toBe(false);
  });

  test("every state has a style", () => {
    for (const s of RECIPIENT_STATES) expect(RECIPIENT_STATE_STYLE[s]).toBeDefined();
  });
});

describe("classifyReplySignal", () => {
  test("ack-only: short acknowledgements", () => {
    for (const b of ["네", "넵", "ok", "확인", "확인중", "볼게요", "알겠습니다", "👀", "👍"]) {
      expect(classifyReplySignal(b)).toBe("ack_only");
    }
  });
  test("explicit_done: completion intent", () => {
    for (const b of ["완료했어", "처리했습니다", "끝냈어", "반영 완료", "merged 했어요", "해결했습니다"]) {
      expect(classifyReplySignal(b)).toBe("explicit_done");
    }
  });
  test("substantive: real content without done-marker → NOT done", () => {
    const b = "그 부분은 recipient_state 분리로 가면 될 것 같고, 매칭 우선순위만 더 보자";
    expect(classifyReplySignal(b)).toBe("substantive");
  });
  test("ambiguous '했어' without completion context is not force-completed", () => {
    // "볼게요" style ack must never be read as done
    expect(classifyReplySignal("일단 볼게요")).not.toBe("explicit_done");
  });

  // 적대리뷰 2026-07-09 #2 (BLOCKING) 회귀: 짧은 blocked/부정 답이 ack 토큰으로 시작한다는
  // 이유로 ack_only 오분류되어 요청자 wake 가 skip 되던 버그. 전부 substantive 여야 wake 된다.
  test("blocked/negative reply starting with an ack syllable → substantive (NOT ack_only)", () => {
    for (const b of [
      "네 안돼요", "네 근데 막혔어요", "확인했는데 안됨", "ok 근데 문제있어",
      "예외 발생", "콜백 실패", "네이버 다운됨", "예약 안됨", "네트워크 끊김",
      // Codex 머지리뷰: 2자+ ack 토큰(확인) prefix 뒤 부정 — 붙여쓴 형태까지.
      "확인불가", "확인불가능", "확인 불가", "네 불가", "처리 곤란", "일단 보류",
    ]) {
      expect(classifyReplySignal(b)).toBe("substantive");
    }
  });
  test("genuine bare acks still classify as ack_only (no regression)", () => {
    for (const b of ["네", "넵", "예", "ok", "확인", "확인중", "확인했습니다", "볼게요", "알겠습니다", "접수", "👀", "👍"]) {
      expect(classifyReplySignal(b)).toBe("ack_only");
    }
  });
  // 구조적 속성(GD 2026-07-09, exact lexeme+suffix): ack 음절로 '시작만' 하는 substantive 단어는
  // blocker 리스트 없이도 절대 ack 로 오분류되지 않는다 = 유지보수 없이 fail-safe.
  test("word that merely STARTS with an ack syllable is never mis-gated (no blocker list needed)", () => {
    for (const b of ["확인불가", "확인불가능", "네트워크", "예외", "콜백", "네이버", "예약", "응답 지연"]) {
      expect(classifyReplySignal(b)).toBe("substantive");
    }
  });
});

describe("decideRecipientTransition — 2-stage close (no false-green)", () => {
  const base = { source: "reply" as const, closingMessageId: "m1" };

  test("substantive reply → in_progress, NOT completed", () => {
    const d = decideRecipientTransition({ current: "open", signal: "substantive", ...base });
    expect(d.next).toBe("in_progress");
    expect(d.closeReason).toBe("reply_observed");
    expect(d.closedAt).toBe(false); // not terminal
  });

  test("ack-only → acknowledged, NOT completed", () => {
    const d = decideRecipientTransition({ current: "open", signal: "ack_only", ...base });
    expect(d.next).toBe("acknowledged");
    expect(isTerminal(d.next)).toBe(false);
  });

  test("explicit_done → completed (terminal)", () => {
    const d = decideRecipientTransition({ current: "in_progress", signal: "explicit_done", ...base });
    expect(d.next).toBe("completed");
    expect(d.closedAt).toBe(true);
  });

  test("terminal lock: completed never re-opens on a later reply", () => {
    const d = decideRecipientTransition({ current: "completed", signal: "substantive", ...base });
    expect(d.noop).toBe(true);
    expect(d.next).toBe("completed");
  });

  test("ack-only never downgrades in_progress", () => {
    const d = decideRecipientTransition({ current: "in_progress", signal: "ack_only", ...base });
    expect(d.noop).toBe(true);
    expect(d.next).toBe("in_progress");
  });

  test("ambiguous match → needs_match_review, never auto-close (req#4)", () => {
    const d = decideRecipientTransition({
      current: "open",
      signal: "explicit_done", // even a done-looking reply must NOT auto-close when ambiguous
      ambiguousMatch: true,
      ...base,
    });
    expect(d.next).toBe("needs_match_review");
    expect(d.closedAt).toBe(false);
  });

  test("linked task is source of truth (req#2): done → completed, blocked → blocked", () => {
    const done = decideRecipientTransition({ current: "in_progress", taskStatus: "done", source: "task" });
    expect(done.next).toBe("completed");
    expect(done.closeReason).toBe("task_status_mirror");

    const blocked = decideRecipientTransition({ current: "in_progress", taskStatus: "blocked", source: "task" });
    expect(blocked.next).toBe("blocked");
    expect(isTerminal(blocked.next)).toBe(false); // keep tracking
  });

  test("idempotent: re-applying substantive on in_progress is a no-op", () => {
    const d = decideRecipientTransition({ current: "in_progress", signal: "substantive", ...base });
    expect(d.noop).toBe(true);
  });
});

describe("false-red clears but stays honest", () => {
  test("any engaged state lifts 'open' so it won't paint red", () => {
    const engaged: RecipientState[] = ["acknowledged", "in_progress", "completed", "blocked"];
    for (const s of engaged) expect(s).not.toBe("open");
  });
});

describe("activity-based auto-ack (Inbox-refined)", () => {
  test("open + activity → acknowledged, close_reason=activity_assumed, source=activity (NOT a real ack)", () => {
    const d = decideRecipientTransition({ current: "open", activityAck: true, source: "activity", closingMessageId: "a1" });
    expect(d.next).toBe("acknowledged");
    expect(d.closeReason).toBe("activity_assumed");
    expect(d.state_source).toBe("activity");
    expect(d.closedAt).toBe(false); // non-terminal
  });

  test("activity does NOT touch in_progress / needs_match_review / blocked", () => {
    for (const cur of ["in_progress", "needs_match_review", "blocked"] as RecipientState[]) {
      const d = decideRecipientTransition({ current: cur, activityAck: true, source: "activity" });
      expect(d.noop).toBe(true);
      expect(d.next).toBe(cur);
    }
  });

  test("activity never re-opens terminal completed", () => {
    const d = decideRecipientTransition({ current: "completed", activityAck: true, source: "activity" });
    expect(d.noop).toBe(true);
  });

  test("explicit reply signal takes precedence over activity (no double-handling)", () => {
    const d = decideRecipientTransition({ current: "open", activityAck: true, signal: "explicit_done", source: "reply" });
    expect(d.next).toBe("completed"); // explicit wins, not activity_assumed
    expect(d.closeReason).toBe("explicit_done");
  });
});

describe("closeReasonCategory — explicit_reply vs activity_assumed never mixed", () => {
  test("real recipient signals → explicit_reply", () => {
    for (const r of ["ack_only", "reply_observed", "explicit_done", "task_status_mirror"] as const) {
      expect(closeReasonCategory(r)).toBe("explicit_reply");
    }
  });
  test("inferred/operational closes map to their own categories", () => {
    expect(closeReasonCategory("activity_assumed")).toBe("activity_assumed");
    expect(closeReasonCategory("backfill_transport")).toBe("transport_backfill");
    expect(closeReasonCategory("expired")).toBe("expired");
  });
  test("activity_assumed is NEVER categorized as explicit_reply (정직성 불변식)", () => {
    expect(closeReasonCategory("activity_assumed")).not.toBe("explicit_reply");
  });
});

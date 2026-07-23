/**
 * owner-gate 판정 로직 테스트 (team-comm 3a authority, GD 2026-07-09).
 * shouldSuppress = "확실 owner가 있는데 내가 그 owner가 아님" → 응답·👀 억제.
 * 이 로직이 owner-gate enforcement(그룹서 아무나 답 방지)의 심장 — 먼저 테스트로 고정.
 * 설계문서 team-comm-ingress-owner-gate-design §3a. Codex 적대리뷰 대상.
 */
import { describe, test, expect } from "bun:test";
import { isConfidentOwner, shouldSuppress } from "./gate";

describe("isConfidentOwner — 확실 owner reason 판정", () => {
  test.each(["explicit_mention", "reply_author", "active_assignee_followup"])(
    "'%s' → confident(true)",
    (reason) => expect(isConfidentOwner(reason)).toBe(true),
  );
  test.each(["default_intake", "default_step", "ask_gd", "broadcast_marker", "topic_shift_default", "unknown"])(
    "'%s' → 추측/전체 = not confident(false, fail-open)",
    (reason) => expect(isConfidentOwner(reason)).toBe(false),
  );
});

describe("shouldSuppress — 비-owner 응답 억제 판정", () => {
  test("확실 owner reason + self ∉ targets → 억제(true)", () => {
    // @codex 멘션인데 나(steve)는 owner 아님 → steve 침묵
    expect(shouldSuppress("explicit_mention", ["codex"], "steve")).toBe(true);
    expect(shouldSuppress("reply_author", ["bill"], "codex")).toBe(true);
  });
  test("확실 owner reason + self ∈ targets → 응답(false, 내가 owner)", () => {
    expect(shouldSuppress("explicit_mention", ["codex", "steve"], "steve")).toBe(false);
    expect(shouldSuppress("reply_author", ["bill"], "bill")).toBe(false);
  });
  test("추측성 reason(default_intake/ask_gd) → 억제 안 함(false, fail-open)", () => {
    // 확실 owner가 없으니 억제하면 아무도 답 안 하는 위험 → fail-open
    expect(shouldSuppress("default_intake", ["bill"], "steve")).toBe(false);
    expect(shouldSuppress("ask_gd", ["codex"], "steve")).toBe(false);
    expect(shouldSuppress("broadcast_marker", ["bill"], "steve")).toBe(false);
  });
  test("selfId 빈값 → false(판정 불가 시 억제 안 함)", () => {
    expect(shouldSuppress("explicit_mention", ["codex"], "")).toBe(false);
  });
});

/**
 * Inbox-refined — DOM proof: default action-required filter + activity_assumed category.
 * (Separate file from inboxAudit.dom.test.ts to avoid stepping on concurrent Phase2 edits.)
 */
import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { Window } from "happy-dom";

// Good citizen: clear any roots we mounted so a later test file (shared global document)
// doesn't query a polluted tree (happy-dom querySelector chokes on detached/foreign nodes).
afterEach(() => {
  const b = (globalThis as { document?: Document }).document?.body;
  if (b) b.innerHTML = "";
});

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  if (!g.document) {
    const win = new Window();
    g.window = win;
    g.document = win.document;
    g.MutationObserver = win.MutationObserver;
    g.Response = win.Response ?? globalThis.Response;
  }
});

function mkMsg(id: string, recipients: Array<{ agent_id: string; recipient_state: string; close_reason: string | null }>) {
  return {
    id, thread_id: "t1", from_agent_id: "gd", to_agent_id: recipients[0]!.agent_id,
    type: "dm", source: "user" as const, priority: "normal" as const, body: `body-${id}`,
    created_at: "2026-06-13T01:00:00",
    recipients: recipients.map((r) => ({
      agent_id: r.agent_id, delivery_state: "wake_dispatched",
      recipient_state: r.recipient_state, close_reason: r.close_reason, last_error: null, updated_at: null,
    })),
  };
}

describe("Inbox default filter = action-required (open + needs_match_review)", () => {
  test("collapses fully-resolved messages by default; toggle reveals 전체", async () => {
    const { store } = await import("../store");
    const { renderInboxView } = await import("./InboxView");

    store.getState().setBusFlow([
      mkMsg("action", [{ agent_id: "bill", recipient_state: "open", close_reason: null }]),
      mkMsg("resolved", [{ agent_id: "steve", recipient_state: "acknowledged", close_reason: "activity_assumed" }]),
      mkMsg("done", [{ agent_id: "demis", recipient_state: "completed", close_reason: "explicit_done" }]),
    ]);

    const root = document.createElement("div");
    document.body.appendChild(root);
    renderInboxView(root);

    // default: only the action-required message body shows
    expect(root.innerHTML).toContain("body-action");
    expect(root.innerHTML).not.toContain("body-resolved");
    expect(root.innerHTML).not.toContain("body-done");
    expect(root.innerHTML).toContain("행동필요만");

    // toggle → 전체
    (document.getElementById("inbox-filter-toggle") as HTMLButtonElement).click();
    expect(root.innerHTML).toContain("body-action");
    expect(root.innerHTML).toContain("body-resolved");
    expect(root.innerHTML).toContain("body-done");
    expect(root.innerHTML).toContain("전체");

    // reset for other tests
    (document.getElementById("inbox-filter-toggle") as HTMLButtonElement).click();
  });
});

describe("activity_assumed never masquerades as a real ack (category chip)", () => {
  test("activity_assumed → '활동추정' chip, distinct from explicit reply reasons", async () => {
    const { store } = await import("../store");
    const { renderInboxView } = await import("./InboxView");

    // include an open recipient so the message is action-required and renders,
    // plus an activity_assumed recipient whose chip we assert.
    store.getState().setBusFlow([
      mkMsg("m", [
        { agent_id: "bill", recipient_state: "open", close_reason: null },
        { agent_id: "steve", recipient_state: "acknowledged", close_reason: "activity_assumed" },
        { agent_id: "demis", recipient_state: "acknowledged", close_reason: "ack_only" },
      ]),
    ]);

    const root = document.createElement("div");
    document.body.appendChild(root);
    renderInboxView(root);
    const html = root.innerHTML;

    expect(html).toContain("활동추정"); // activity_assumed label
    // explicit ack shows its raw reason, NOT '활동추정' — never mixed
    expect(html).toContain("ack_only");
    // the two are visually different chips (blue vs slate). 색은 deep 토큰 text-txt-blue
    // (GD 3원칙 sweep 2026-06-21 — 흐린 text-sky-300/90→deep, 파랑·구별 semantic은 유지).
    expect(html).toContain("text-txt-blue");
  });
});

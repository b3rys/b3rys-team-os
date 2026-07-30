/**
 * Inbox-refined — DOM proof: default action-required filter + activity_assumed category.
 * (Separate file from inboxAudit.dom.test.ts to avoid stepping on concurrent Phase2 edits.)
 */
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { Window } from "happy-dom";

// Good citizen: clear any roots we mounted so a later test file (shared global document)
// doesn't query a polluted tree (happy-dom querySelector chokes on detached/foreign nodes).
afterEach(() => {
  const b = (globalThis as { document?: Document }).document?.body;
  if (b) b.innerHTML = "";
});

// ★여기서 심은 전역은 여기서 걷는다.★ (2026-07-30)
//   앞서는 `g.Response = win.Response` 를 심어놓고 되돌리지 않았다. bun test 는 파일들을 한 프로세스에서
//   돌리므로, 그 뒤에 도는 ★다른 파일의 서버 테스트가 happy-dom 의 Response 를 쓰게 된다.★
//   그러면 Hono 가 붙인 헤더가 사라진다 — 실측: content-type 이 text/html 대신 text/plain 이 됐다.
//   ★단독 실행은 통과하고 전체 실행만 깨진다★ 는 형태라, 원인을 코드에서 찾으면 못 찾는다
//   (hostGate 테스트가 그렇게 깨져서 여기까지 왔다).
const installedGlobals: string[] = [];
const savedGlobals: Record<string, unknown> = {};

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  if (!g.document) {
    const win = new Window();
    for (const [k, v] of [
      ["window", win],
      ["document", win.document],
      ["MutationObserver", win.MutationObserver],
      ["Response", win.Response ?? globalThis.Response],
    ] as const) {
      savedGlobals[k] = g[k];
      installedGlobals.push(k);
      g[k] = v;
    }
  }
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of installedGlobals) {
    if (savedGlobals[k] === undefined) delete g[k];
    else g[k] = savedGlobals[k];
  }
  installedGlobals.length = 0;
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

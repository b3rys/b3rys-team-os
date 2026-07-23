/**
 * SLG cycle1 B — server query tests: auditRecent (Audit screen feed) + busFlowRecent
 * now carrying recipient_state/close_reason (Inbox screen). Verifies Bill's 3 gate guards:
 * limit cap, bound action param, same read shape.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { insertMessage } from "./inbox/messages";
import { auditRecent, busFlowRecent } from "./inboxQueries";
import { appendAudit } from "./queries";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["bill", "steve"]) {
    db.prepare(
      `INSERT INTO agent (id,display_name,role,runtime,status_provider,workspace_path,persona_file)
       VALUES (?, ?, 'r', 'claude_channel', 'claude_tmux', '/tmp', 'p.md')`,
    ).run(a, a);
  }
  db.prepare(
    `INSERT INTO thread (id,title,kind,participants_json,opened_by) VALUES ('t1','t','dm','["bill","steve"]','bill')`,
  ).run();
  return db;
}

describe("auditRecent — Audit screen feed", () => {
  test("limit clamped to max 500 even if caller asks for more", () => {
    const db = setup();
    for (let i = 0; i < 5; i++) appendAudit(db, "steve", "recipient_state_change", `m${i}`, { close_reason: "ack_only" });
    const rows = auditRecent(db, { limit: 99999 });
    expect(rows.length).toBeLessThanOrEqual(500);
    expect(rows.length).toBe(5);
  });

  test("limit floor of 1 (0 or negative coerced up)", () => {
    const db = setup();
    appendAudit(db, "steve", "recipient_state_change", "m0", { close_reason: "ack_only" });
    expect(auditRecent(db, { limit: 0 }).length).toBe(1);
  });

  test("action filter returns only that action (bound param)", () => {
    const db = setup();
    appendAudit(db, "steve", "recipient_state_change", "m1", { close_reason: "reply_observed" });
    appendAudit(db, "bill", "message_sent", "m2", {});
    const rows = auditRecent(db, { action: "recipient_state_change" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("recipient_state_change");
  });

  test("action with a SQL-ish string is treated as a literal value (injection-safe)", () => {
    const db = setup();
    appendAudit(db, "steve", "recipient_state_change", "m1", { close_reason: "ack_only" });
    // a malicious 'action' must match nothing, not break out of the query
    const rows = auditRecent(db, { action: "recipient_state_change' OR '1'='1" });
    expect(rows.length).toBe(0);
  });

  test("suspicious_close flagged for ack_only / reply_observed / backfill_transport only", () => {
    const db = setup();
    appendAudit(db, "steve", "recipient_state_change", "a", { close_reason: "ack_only" });
    appendAudit(db, "steve", "recipient_state_change", "b", { close_reason: "reply_observed" });
    appendAudit(db, "steve", "recipient_state_change", "c", { close_reason: "explicit_done" });
    appendAudit(db, "steve", "recipient_state_change", "d", { close_reason: "backfill_transport" });
    const byTarget = Object.fromEntries(auditRecent(db, {}).map((r) => [r.target, r.suspicious_close]));
    expect(byTarget["a"]).toBe(true);
    expect(byTarget["b"]).toBe(true);
    expect(byTarget["c"]).toBe(false); // explicit completion is NOT suspicious
    expect(byTarget["d"]).toBe(true);
  });

  test("newest first", () => {
    const db = setup();
    appendAudit(db, "steve", "recipient_state_change", "old", { close_reason: "ack_only" });
    appendAudit(db, "steve", "recipient_state_change", "new", { close_reason: "ack_only" });
    const rows = auditRecent(db, {});
    expect(rows[0]!.target).toBe("new");
  });
});

describe("busFlowRecent — Inbox screen now carries semantic state", () => {
  test("recipient row includes recipient_state + close_reason", () => {
    const db = setup();
    const req = insertMessage(db, {
      thread_id: "t1", from_agent_id: "bill", to_agent_id: "steve", body: "처리해줘", source: "agent", type: "dm",
    } as never);
    // steve acks
    insertMessage(db, {
      thread_id: "t1", from_agent_id: "steve", to_agent_id: "bill", body: "네 볼게요",
      source: "agent", type: "reply", in_reply_to: req.id,
    } as never);
    const flow = busFlowRecent(db, 40);
    const reqMsg = flow.find((m) => m.id === req.id)!;
    const steveRcpt = reqMsg.recipients.find((r) => r.agent_id === "steve")!;
    expect(steveRcpt.recipient_state).toBe("acknowledged");
    expect(steveRcpt.close_reason).toBe("ack_only");
    expect(steveRcpt.delivery_state).toBeDefined(); // transport still present (additive)
  });
});

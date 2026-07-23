/**
 * Inbox-refined — activity-based auto-ack (server). When an agent emits any message, their
 * own stale 'open' received rows close as 'activity_assumed' (distinct from a real reply),
 * with a grace so a just-arrived task isn't buried.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { runBusMigration } from "../db/migrate";
import { applyActivityAutoAck } from "./ackClose";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url).pathname, "utf8"));
  runBusMigration(db);
  for (const id of ["bill", "steve"]) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'x', 'claude_channel', 'claude_tmux', '/tmp', '/tmp/x')`,
    ).run(id, id);
  }
  db.prepare(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','[]','gd')`).run();
  return db;
}

// a message RECEIVED by `recipient`, `ageSec` seconds ago, with given recipient_state.
function received(db: Database, msgId: string, recipient: string, ageSec: number, state = "open") {
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
     VALUES (?, 't1', 'gd', ?, 'dm', 'task', 'user', datetime('now', ?))`,
  ).run(msgId, recipient, `-${ageSec} seconds`);
  db.prepare(
    `INSERT INTO message_recipient (message_id, agent_id, delivery_state, recipient_state)
     VALUES (?, ?, 'wake_dispatched', ?)`,
  ).run(msgId, recipient, state);
}

function stateOf(db: Database, msgId: string, agent: string): { recipient_state: string; close_reason: string | null } {
  return db
    .prepare(`SELECT recipient_state, close_reason FROM message_recipient WHERE message_id=? AND agent_id=?`)
    .get(msgId, agent) as { recipient_state: string; close_reason: string | null };
}

describe("applyActivityAutoAck", () => {
  let db: Database;
  beforeEach(() => (db = freshDb()));

  test("old open rows → acknowledged/activity_assumed when sender shows activity", () => {
    received(db, "old1", "bill", 600); // 10min ago
    received(db, "old2", "bill", 300); // 5min ago
    const res = applyActivityAutoAck(db, "bill", "trigger-msg");
    expect(res.acked).toBe(2);
    expect(stateOf(db, "old1", "bill")).toEqual({ recipient_state: "acknowledged", close_reason: "activity_assumed" });
    expect(stateOf(db, "old2", "bill").recipient_state).toBe("acknowledged");
  });

  test("grace: a just-arrived open row (<30s) is NOT auto-acked (new task not buried)", () => {
    received(db, "fresh", "bill", 5); // 5s ago
    const res = applyActivityAutoAck(db, "bill", "trigger-msg");
    expect(res.acked).toBe(0);
    expect(stateOf(db, "fresh", "bill").recipient_state).toBe("open"); // still action-required
  });

  test("does NOT touch in_progress / needs_match_review (already engaged / needs human)", () => {
    received(db, "ip", "bill", 600, "in_progress");
    received(db, "nmr", "bill", 600, "needs_match_review");
    applyActivityAutoAck(db, "bill", "trigger-msg");
    expect(stateOf(db, "ip", "bill").recipient_state).toBe("in_progress");
    expect(stateOf(db, "nmr", "bill").recipient_state).toBe("needs_match_review");
  });

  test("only acks the SENDER's own rows, not other agents'", () => {
    received(db, "bills", "bill", 600);
    received(db, "steves", "steve", 600);
    applyActivityAutoAck(db, "bill", "trigger-msg");
    expect(stateOf(db, "bills", "bill").recipient_state).toBe("acknowledged");
    expect(stateOf(db, "steves", "steve").recipient_state).toBe("open"); // untouched
  });

  test("audit row tagged via=activity_auto_ack + close_reason=activity_assumed", () => {
    received(db, "old1", "bill", 600);
    applyActivityAutoAck(db, "bill", "trigger-msg");
    const ev = db
      .prepare(`SELECT detail_json FROM audit_event WHERE action='recipient_state_change' AND target='old1'`)
      .get() as { detail_json: string };
    const d = JSON.parse(ev.detail_json);
    expect(d.via).toBe("activity_auto_ack");
    expect(d.close_reason).toBe("activity_assumed");
    expect(d.to_state).toBe("acknowledged");
  });

  test("idempotent: a second activity pass does nothing (rows no longer open)", () => {
    received(db, "old1", "bill", 600);
    expect(applyActivityAutoAck(db, "bill", "t1").acked).toBe(1);
    expect(applyActivityAutoAck(db, "bill", "t2").acked).toBe(0);
  });
});

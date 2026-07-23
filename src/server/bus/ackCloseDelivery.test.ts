/**
 * Transport↔work coupling — the wake_dispatched-orphan / red-"대기" root fix (2026-06-22).
 *
 * Pins the fix: once a recipient ENGAGES (activity-ack, substantive reply, explicit done) an
 * orphaned 'wake_dispatched' delivery row advances to 'completed' — so a handled message turns
 * green regardless of runtime. recipient_state (the WORK layer) is left intact (no false-green),
 * and the close is SURGICAL: only 'wake_dispatched' moves; 'pending' (not yet delivered) and an
 * ambiguous match (needs_match_review) are never closed.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { runBusMigration } from "../db/migrate";
import { applyAckClose, applyActivityAutoAck, type ReplyLike } from "./ackClose";

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
  db.prepare(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','[]','bill')`).run();
  return db;
}

// A message RECEIVED by `recipient` `ageSec` ago, with given delivery+recipient state.
function received(
  db: Database,
  msgId: string,
  recipient: string,
  ageSec: number,
  delivery = "wake_dispatched",
  recipientState = "open",
) {
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
     VALUES (?, 't1', 'bill', ?, 'dm', 'please do X', 'agent', datetime('now', ?))`,
  ).run(msgId, recipient, `-${ageSec} seconds`);
  db.prepare(
    `INSERT INTO message_recipient (message_id, agent_id, delivery_state, recipient_state)
     VALUES (?, ?, ?, ?)`,
  ).run(msgId, recipient, delivery, recipientState);
}

function deliveryOf(db: Database, msg: string, agent: string): string {
  return (
    db.prepare(`SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?`).get(msg, agent) as {
      delivery_state: string;
    }
  ).delivery_state;
}
function recipientOf(db: Database, msg: string, agent: string): string {
  return (
    db.prepare(`SELECT recipient_state FROM message_recipient WHERE message_id=? AND agent_id=?`).get(msg, agent) as {
      recipient_state: string;
    }
  ).recipient_state;
}

function reply(over: Partial<ReplyLike>): ReplyLike {
  return {
    id: "r1",
    from_agent_id: "steve",
    body: "ok",
    thread_id: "t1",
    in_reply_to: "orig1",
    source: "agent",
    type: "reply",
    ...over,
  };
}

describe("transport coupling — activity-ack closes the orphaned wake", () => {
  let db: Database;
  beforeEach(() => (db = freshDb()));

  test("activity-ack on a wake_dispatched row → recipient acknowledged AND delivery completed", () => {
    received(db, "old1", "bill", 600); // wake_dispatched / open, 10min old
    applyActivityAutoAck(db, "bill", "trigger");
    expect(recipientOf(db, "old1", "bill")).toBe("acknowledged"); // work layer: engaged, not done
    expect(deliveryOf(db, "old1", "bill")).toBe("completed"); // transport orphan closed → no longer red
  });

  test("SURGICAL: a 'pending' (not-yet-delivered) row is acked but delivery stays pending (no drop)", () => {
    received(db, "p1", "bill", 600, "pending"); // queued, dispatcher hasn't woken it yet
    applyActivityAutoAck(db, "bill", "trigger");
    expect(recipientOf(db, "p1", "bill")).toBe("acknowledged");
    expect(deliveryOf(db, "p1", "bill")).toBe("pending"); // left for the dispatcher — never silently completed
  });

  test("SURGICAL: a 'dispatching' (claim in flight) row is acked but delivery stays dispatching", () => {
    received(db, "d1", "bill", 600, "dispatching"); // dispatcher actively delivering it right now
    applyActivityAutoAck(db, "bill", "trigger");
    expect(recipientOf(db, "d1", "bill")).toBe("acknowledged");
    expect(deliveryOf(db, "d1", "bill")).toBe("dispatching"); // never preempt an in-flight claim
  });

  test("audit: a delivery_orphan_closed event is emitted with from/to states", () => {
    received(db, "old1", "bill", 600);
    applyActivityAutoAck(db, "bill", "trigger");
    const ev = db
      .prepare(`SELECT detail_json FROM audit_event WHERE action='delivery_orphan_closed' AND target='old1'`)
      .get() as { detail_json: string } | undefined;
    expect(ev).toBeDefined();
    const d = JSON.parse(ev!.detail_json);
    expect(d.from_state).toBe("wake_dispatched");
    expect(d.to_state).toBe("completed");
  });

  test("idempotent: a second activity pass closes no further orphan (already completed)", () => {
    received(db, "old1", "bill", 600);
    applyActivityAutoAck(db, "bill", "t1");
    applyActivityAutoAck(db, "bill", "t2");
    const n = db
      .prepare(`SELECT COUNT(*) c FROM audit_event WHERE action='delivery_orphan_closed' AND target='old1'`)
      .get() as { c: number };
    expect(n.c).toBe(1);
  });
});

describe("transport coupling — reply ack-close closes the orphaned wake", () => {
  let db: Database;
  beforeEach(() => (db = freshDb()));

  test("substantive reply → in_progress AND delivery completed", () => {
    received(db, "orig1", "steve", 5); // fresh: activity-ack grace skips it, so only the reply path acts
    applyAckClose(db, reply({ body: "그 부분은 recipient_state 분리로 가면 될 듯, 매칭만 더 보자" }));
    expect(recipientOf(db, "orig1", "steve")).toBe("in_progress");
    expect(deliveryOf(db, "orig1", "steve")).toBe("completed");
  });

  test("explicit done → completed AND delivery completed", () => {
    received(db, "orig1", "steve", 5);
    applyAckClose(db, reply({ body: "처리 완료했습니다" }));
    expect(recipientOf(db, "orig1", "steve")).toBe("completed");
    expect(deliveryOf(db, "orig1", "steve")).toBe("completed");
  });

  test("SURGICAL: ambiguous match (needs_match_review) does NOT close the wake", () => {
    received(db, "orig1", "steve", 5);
    received(db, "orig2", "steve", 5); // two opens, no in_reply_to → ambiguous
    const res = applyAckClose(db, reply({ in_reply_to: null, body: "처리 완료했습니다" }));
    expect(res.to).toBe("needs_match_review");
    // ambiguous: we can't claim either wake was the right one → BOTH transports left untouched
    expect(deliveryOf(db, "orig1", "steve")).toBe("wake_dispatched");
    expect(deliveryOf(db, "orig2", "steve")).toBe("wake_dispatched");
  });
});

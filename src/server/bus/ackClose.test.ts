import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { runBusMigration } from "../db/migrate";
import { applyAckClose, resolveReplyTarget, type ReplyLike } from "./ackClose";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url).pathname, "utf8"));
  runBusMigration(db);
  // minimal agents
  for (const id of ["bill", "steve", "demis"]) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'x', 'claude_channel', 'claude_tmux', '/tmp', '/tmp/x')`,
    ).run(id, id);
  }
  return db;
}

function mkThread(db: Database, id = "t1") {
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by)
     VALUES (?, 't', 'dm', '[]', 'bill')`,
  ).run(id);
}

// original directed message bill→steve, steve has an OPEN recipient row
function mkOriginal(db: Database, id: string, thread = "t1", recipient = "steve") {
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source)
     VALUES (?, ?, 'bill', ?, 'dm', 'please do X', 'agent')`,
  ).run(id, thread, recipient);
  db.prepare(
    `INSERT INTO message_recipient (message_id, agent_id, delivery_state, recipient_state)
     VALUES (?, ?, 'wake_dispatched', 'open')`,
  ).run(id, recipient);
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

function stateOf(db: Database, msg: string, agent: string): string {
  return (
    db
      .prepare(`SELECT recipient_state FROM message_recipient WHERE message_id=? AND agent_id=?`)
      .get(msg, agent) as { recipient_state: string }
  ).recipient_state;
}

describe("resolveReplyTarget — matching priority (req#4)", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    mkThread(db);
  });

  test("tier 1: in_reply_to exact match", () => {
    mkOriginal(db, "orig1");
    const t = resolveReplyTarget(db, reply({}));
    expect(t).toMatchObject({ messageId: "orig1", agentId: "steve", ambiguous: false, tier: "in_reply_to" });
  });

  test("tier 3: no in_reply_to, single open in thread → matched", () => {
    mkOriginal(db, "orig1");
    const t = resolveReplyTarget(db, reply({ in_reply_to: null }));
    expect(t).toMatchObject({ messageId: "orig1", ambiguous: false, tier: "thread_recent" });
  });

  test("tier 3: multiple open in thread → ambiguous (no auto-close)", () => {
    mkOriginal(db, "orig1");
    mkOriginal(db, "orig2");
    const t = resolveReplyTarget(db, reply({ in_reply_to: null }));
    expect(t?.ambiguous).toBe(true);
  });

  test("no candidate → null", () => {
    const t = resolveReplyTarget(db, reply({ in_reply_to: null }));
    expect(t).toBeNull();
  });

  test("a NEW request (type 'dm', no in_reply_to) never fuzzy-matches — no false-close", () => {
    // sender holds an open row in the thread; a brand-new 'dm' from them must NOT close it.
    mkOriginal(db, "orig1");
    const t = resolveReplyTarget(db, reply({ in_reply_to: null, type: "dm" }));
    expect(t).toBeNull();
  });
});

describe("applyAckClose — 2-stage close, no false-green", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    mkThread(db);
    mkOriginal(db, "orig1");
  });

  test("ack-only reply ('네 볼게요') → acknowledged, NOT completed", () => {
    const res = applyAckClose(db, reply({ body: "네 볼게요" }));
    expect(res.applied).toBe(true);
    expect(res.to).toBe("acknowledged");
    expect(stateOf(db, "orig1", "steve")).toBe("acknowledged");
  });

  test("substantive reply → in_progress, NOT completed (kills the old false-green)", () => {
    const res = applyAckClose(
      db,
      reply({ body: "그 부분은 recipient_state 분리로 가면 될 것 같아, 매칭만 더 보자" }),
    );
    expect(res.to).toBe("in_progress");
    expect(res.closeReason).toBe("reply_observed");
    expect(stateOf(db, "orig1", "steve")).toBe("in_progress");
  });

  test("explicit completion → completed (terminal) + closed_at set", () => {
    const res = applyAckClose(db, reply({ body: "처리 완료했습니다" }));
    expect(res.to).toBe("completed");
    const row = db
      .prepare(`SELECT recipient_state, closed_at FROM message_recipient WHERE message_id='orig1' AND agent_id='steve'`)
      .get() as { recipient_state: string; closed_at: string | null };
    expect(row.recipient_state).toBe("completed");
    expect(row.closed_at).not.toBeNull();
  });

  test("ambiguous (2 opens, no in_reply_to) → needs_match_review, never completed", () => {
    mkOriginal(db, "orig2");
    const res = applyAckClose(db, reply({ in_reply_to: null, body: "처리 완료했습니다" }));
    expect(res.to).toBe("needs_match_review");
  });

  test("terminal lock: completed never re-opens on a later reply", () => {
    applyAckClose(db, reply({ id: "r1", body: "완료했어" }));
    const res = applyAckClose(db, reply({ id: "r2", body: "추가로 한 가지 더 있어" }));
    expect(res.applied).toBe(false);
    expect(stateOf(db, "orig1", "steve")).toBe("completed");
  });

  test("audit_event recorded with close_reason (req#5 safety net)", () => {
    applyAckClose(db, reply({ body: "네" }));
    const ev = db
      .prepare(
        `SELECT actor, action, target, detail_json FROM audit_event
         WHERE action='recipient_state_change' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { actor: string; action: string; target: string; detail_json: string };
    expect(ev.target).toBe("orig1");
    const d = JSON.parse(ev.detail_json);
    expect(d.close_reason).toBe("ack_only");
    expect(d.to_state).toBe("acknowledged");
    // queryable: reply/ack-only closes
    const n = db
      .prepare(
        `SELECT COUNT(*) c FROM audit_event
         WHERE action='recipient_state_change'
           AND json_extract(detail_json,'$.close_reason') IN ('reply_observed','ack_only')`,
      )
      .get() as { c: number };
    expect(n.c).toBeGreaterThan(0);
  });

  test("idempotent: same reply applied twice does not double-transition", () => {
    const first = applyAckClose(db, reply({ body: "네" }));
    expect(first.applied).toBe(true);
    const second = applyAckClose(db, reply({ body: "네" }));
    // ack-only on 'acknowledged' is a no-op
    expect(second.applied).toBe(false);
    expect(stateOf(db, "orig1", "steve")).toBe("acknowledged");
  });
});

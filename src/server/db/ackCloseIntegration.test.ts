/**
 * SLG cycle1 A (ack-close) — END-TO-END through the real bus path.
 *
 * Proves the fix on the actual insertMessage → recipient_state path that the live bus
 * uses, plus the topology data feed (busMemberStatus). This is the "characterization
 * rewritten as fix-evidence" test Bill asked for: it locks in the NEW contract
 *   reply → recipient_state transition; delivery_state(transport) stays wake_dispatched
 * and asserts the four live-demo claims:
 *   ① 가짜빨강 해제  ② 비완료 green 안 됨  ③ 회귀無(transport 보존)  ④ pending/stuck 정상
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { insertMessage } from "./inbox/messages";
import { busMemberStatus } from "./inbox/stats";
import { resolvePendingForAgent } from "./inbox/lifecycle";

function addAgent(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'persona.md')`,
  ).run(id, id);
}

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["bill", "steve"]) addAgent(db, a);
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','test','dm','["bill","steve"]','bill')`,
  ).run();
  return db;
}

// bill → steve directed request, simulated as already dispatched (woken, awaiting reply).
function dispatchedRequest(db: Database): string {
  const req = insertMessage(db, {
    thread_id: "t1",
    from_agent_id: "bill",
    to_agent_id: "steve",
    body: "이거 처리해줘",
    source: "agent",
    type: "dm",
  } as never);
  db.prepare(
    `UPDATE message_recipient SET delivery_state='wake_dispatched' WHERE message_id=? AND agent_id='steve'`,
  ).run(req.id);
  return req.id;
}

function steveReply(db: Database, reqId: string, body: string) {
  return insertMessage(db, {
    thread_id: "t1",
    from_agent_id: "steve",
    to_agent_id: "bill",
    body,
    source: "agent",
    type: "reply",
    in_reply_to: reqId,
  } as never);
}

function rcpt(db: Database, msgId: string) {
  return db
    .prepare(`SELECT delivery_state, recipient_state, close_reason, closed_at FROM message_recipient WHERE message_id=? AND agent_id='steve'`)
    .get(msgId) as { delivery_state: string; recipient_state: string; close_reason: string | null; closed_at: string | null };
}

function steveInflight(db: Database): number {
  const snap = busMemberStatus(db);
  return snap.members.find((m) => m.agent_id === "steve")?.inflight.count ?? 0;
}

describe("ack-close e2e — real insertMessage path", () => {
  test("BEFORE reply: dispatched request counts as in-flight (legit)", () => {
    const db = setup();
    dispatchedRequest(db);
    expect(steveInflight(db)).toBe(1); // genuinely awaiting — open
  });

  test("ack-only reply → acknowledged; orphaned transport closes (root fix 2026-06-22); false-red cleared (①③④)", () => {
    const db = setup();
    const reqId = dispatchedRequest(db);
    steveReply(db, reqId, "네 볼게요");
    const r = rcpt(db, reqId);
    expect(r.recipient_state).toBe("acknowledged"); // ② work layer: engaged, NOT completed (no false-green)
    // ③ transport coupling: the recipient engaged, so the orphaned wake closes → no longer red "대기".
    // (was 'wake_dispatched' pre-fix — the claude_channel out-of-band-reply orphan that never closed.)
    expect(r.delivery_state).toBe("completed");
    expect(steveInflight(db)).toBe(0); // ① + ④ no longer stuck/pending — replied
  });

  test("substantive reply → in_progress, NOT green/completed (②)", () => {
    const db = setup();
    const reqId = dispatchedRequest(db);
    steveReply(db, reqId, "지금 recipient_state 분리로 작업 중이고 매칭만 더 보면 돼");
    const r = rcpt(db, reqId);
    expect(r.recipient_state).toBe("in_progress");
    expect(r.close_reason).toBe("reply_observed");
    expect(r.closed_at).toBeNull(); // non-terminal
    expect(steveInflight(db)).toBe(0); // false-red cleared
  });

  test("explicit completion → completed (terminal, the ONLY green path)", () => {
    const db = setup();
    const reqId = dispatchedRequest(db);
    steveReply(db, reqId, "처리 완료했습니다");
    const r = rcpt(db, reqId);
    expect(r.recipient_state).toBe("completed");
    expect(r.closed_at).not.toBeNull();
    expect(steveInflight(db)).toBe(0);
  });

  test("audit trail written for the close (req#5)", () => {
    const db = setup();
    const reqId = dispatchedRequest(db);
    steveReply(db, reqId, "네");
    const ev = db
      .prepare(
        `SELECT detail_json FROM audit_event WHERE action='recipient_state_change' AND target=? ORDER BY id DESC LIMIT 1`,
      )
      .get(reqId) as { detail_json: string } | undefined;
    expect(ev).toBeDefined();
    expect(JSON.parse(ev!.detail_json).close_reason).toBe("ack_only");
  });

  test("regression: a fresh request to bill still pending, not falsely engaged", () => {
    const db = setup();
    const reqId = dispatchedRequest(db);
    steveReply(db, reqId, "완료했어");
    // steve's row closed, but a NEW unrelated request stays open/in-flight
    const req2 = insertMessage(db, {
      thread_id: "t1", from_agent_id: "bill", to_agent_id: "steve", body: "다음 것도", source: "agent", type: "dm",
    } as never);
    db.prepare(`UPDATE message_recipient SET delivery_state='wake_dispatched' WHERE message_id=? AND agent_id='steve'`).run(req2.id);
    expect(steveInflight(db)).toBe(1); // only the new one
    expect(rcpt(db, req2.id).recipient_state).toBe("open");
  });

  test("acknowledged legacy pending rows are not topology backlog or resolvable", () => {
    const db = setup();
    const req = insertMessage(db, {
      thread_id: "t1",
      from_agent_id: "bill",
      to_agent_id: "steve",
      body: "legacy acknowledged pending",
      source: "agent",
      type: "dm",
    } as never);
    db.prepare(`UPDATE message SET created_at = datetime('now', '-1 hour') WHERE id = ?`).run(req.id);
    db.prepare(
      `UPDATE message_recipient
          SET delivery_state = 'pending', recipient_state = 'acknowledged', close_reason = 'ack_only'
        WHERE message_id = ? AND agent_id = 'steve'`,
    ).run(req.id);

    const member = busMemberStatus(db).members.find((m) => m.agent_id === "steve");
    expect(member?.counts.pending).toBe(1); // raw transport history remains visible in breakdowns
    expect(member?.resolvable_pending).toBe(0); // but it is not real backlog
    expect(resolvePendingForAgent(db, "steve", "expire", true).affected_count).toBe(0);
  });
});

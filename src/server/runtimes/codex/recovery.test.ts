import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { insertMessage } from "../../db/inboxQueries";
import { CodexInflightStore } from "./state";
import { CODEX_INFLIGHT_STALE_SEC, recoverCodexInflight } from "./recovery";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('cody', 'Cody', 'Codex tester', 'codex', 'codex_cli', '/tmp', 'AGENTS.md')`,
  ).run();
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','test','dm','["cody","user"]','user')`,
  ).run();
  return db;
}

function userMessage(db: Database): string {
  const msg = insertMessage(db, {
    thread_id: "t1",
    from_agent_id: "user",
    to_agent_id: "cody",
    type: "dm",
    body: "도와줘",
    source: "agent",
    hop_count: 0,
    priority: "normal",
  });
  db.prepare(`UPDATE message_recipient SET delivery_state = 'wake_dispatched' WHERE message_id = ? AND agent_id = 'cody'`).run(msg.id);
  return msg.id;
}

describe("codex inflight recovery", () => {
  test("default stale threshold stays above the 240s runner timeout", () => {
    expect(CODEX_INFLIGHT_STALE_SEC).toBeGreaterThanOrEqual(300);
  });

  test("stale marker with no reply resets recipient to pending", () => {
    const db = setup();
    const messageId = userMessage(db);
    new CodexInflightStore(db).mark(messageId, "cody", "t1");
    const changed = recoverCodexInflight(db, 0);
    const row = db.prepare(`SELECT delivery_state FROM message_recipient WHERE message_id = ? AND agent_id = 'cody'`).get(messageId) as { delivery_state: string };
    expect(changed).toBe(1);
    expect(row.delivery_state).toBe("pending");
  });

  test("stale marker with existing reply clears marker without redispatch", () => {
    const db = setup();
    const messageId = userMessage(db);
    new CodexInflightStore(db).mark(messageId, "cody", "t1");
    insertMessage(db, {
      thread_id: "t1",
      from_agent_id: "cody",
      to_agent_id: "broadcast",
      type: "broadcast",
      body: "이미 답함",
      source: "agent",
      hop_count: 1,
      in_reply_to: messageId,
      priority: "normal",
    });
    const changed = recoverCodexInflight(db, 0);
    const row = db.prepare(`SELECT delivery_state FROM message_recipient WHERE message_id = ? AND agent_id = 'cody'`).get(messageId) as { delivery_state: string };
    const count = db.prepare(`SELECT COUNT(*) AS n FROM codex_inflight`).get() as { n: number };
    expect(changed).toBe(0);
    expect(row.delivery_state).not.toBe("pending");
    expect(count.n).toBe(0);
  });

  test("default recovery does not requeue a fresh live marker", () => {
    const db = setup();
    const messageId = userMessage(db);
    new CodexInflightStore(db).mark(messageId, "cody", "t1");
    const changed = recoverCodexInflight(db);
    const row = db.prepare(`SELECT delivery_state FROM message_recipient WHERE message_id = ? AND agent_id = 'cody'`).get(messageId) as { delivery_state: string };
    expect(changed).toBe(0);
    expect(row.delivery_state).toBe("wake_dispatched");
  });

  test("default recovery requeues a marker older than the Codex stale threshold", () => {
    const db = setup();
    const messageId = userMessage(db);
    new CodexInflightStore(db).mark(messageId, "cody", "t1");
    db.prepare(`UPDATE codex_inflight SET started_at = datetime('now', '-301 seconds') WHERE message_id = ?`).run(messageId);
    const changed = recoverCodexInflight(db);
    const row = db.prepare(`SELECT delivery_state FROM message_recipient WHERE message_id = ? AND agent_id = 'cody'`).get(messageId) as { delivery_state: string };
    expect(changed).toBe(1);
    expect(row.delivery_state).toBe("pending");
  });
});

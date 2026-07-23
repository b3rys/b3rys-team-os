/**
 * Telegram out-of-band agent activity backfill.
 * Closes stale action-required rows left by team-agent bot replies that were visible in Telegram
 * but not ingested as agent bus messages.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { outOfBandRecipientBackfill, runBusMigration } from "./migrate";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url).pathname, "utf8"));
  runBusMigration(db);
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, telegram_bot_username, workspace_path, persona_file)
     VALUES ('bill','bill','x','claude_channel','claude_tmux','example_dev_bot','/tmp','/tmp/x')`,
  ).run();
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('steve','steve','x','claude_channel','claude_tmux','/tmp','/tmp/x')`,
  ).run();
  db.prepare(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','[]','gd')`).run();
  return db;
}

function row(db: Database, id: string, agent: string, state: string, ageSec = 600, type = "dm") {
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
     VALUES (?, 't1', 'user', ?, ?, 'task', 'user', datetime('now', ?))`,
  ).run(id, type === "broadcast" ? "broadcast" : agent, type, `-${ageSec} seconds`);
  db.prepare(
    `INSERT INTO message_recipient (message_id, agent_id, delivery_state, recipient_state)
     VALUES (?, ?, 'wake_dispatched', ?)`,
  ).run(id, agent, state);
}

function stateOf(db: Database, id: string): { delivery_state: string; recipient_state: string; close_reason: string | null } {
  return db
    .prepare(`SELECT delivery_state, recipient_state, close_reason FROM message_recipient WHERE message_id = ?`)
    .get(id) as { delivery_state: string; recipient_state: string; close_reason: string | null };
}

function unguard(db: Database) {
  db.prepare(`DELETE FROM runtime_lock WHERE key = 'outofband_recipient_backfill_v1'`).run();
}

describe("outOfBandRecipientBackfill", () => {
  let db: Database;
  beforeEach(() => (db = freshDb()));

  test("closes stale open and needs_match_review rows for agents with Telegram bot identities", () => {
    row(db, "open", "bill", "open");
    row(db, "nmr", "bill", "needs_match_review");
    unguard(db);
    outOfBandRecipientBackfill(db);
    expect(stateOf(db, "open")).toEqual({
      delivery_state: "completed",
      recipient_state: "acknowledged",
      close_reason: "outofband_activity_backfill",
    });
    expect(stateOf(db, "nmr")).toEqual({
      delivery_state: "completed",
      recipient_state: "acknowledged",
      close_reason: "outofband_activity_backfill",
    });
  });

  test("leaves fresh rows, non-bot agents, and broadcast rows untouched", () => {
    row(db, "fresh", "bill", "open", 5);
    row(db, "nobot", "steve", "open", 600);
    row(db, "bcast", "bill", "open", 600, "broadcast");
    unguard(db);
    outOfBandRecipientBackfill(db);
    expect(stateOf(db, "fresh").recipient_state).toBe("open");
    expect(stateOf(db, "nobot").recipient_state).toBe("open");
    expect(stateOf(db, "bcast").recipient_state).toBe("open");
  });

  test("idempotent: flag-guarded after first run", () => {
    row(db, "first", "bill", "open");
    unguard(db);
    outOfBandRecipientBackfill(db);
    row(db, "second", "bill", "open");
    outOfBandRecipientBackfill(db);
    expect(stateOf(db, "first").recipient_state).toBe("acknowledged");
    expect(stateOf(db, "second").recipient_state).toBe("open");
  });
});

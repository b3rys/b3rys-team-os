/**
 * Transport-orphan backfill — retroactive half of the red-"대기" root fix (2026-06-22).
 * Closes existing engaged-but-wake_dispatched rows once; leaves ambiguous/expired/open alone.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { runBusMigration, orphanedDeliveryBackfill } from "./migrate";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url).pathname, "utf8"));
  runBusMigration(db); // runs the backfill on an empty DB (no-op) and sets the guard flag
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('bill','bill','x','claude_channel','claude_tmux','/tmp','/tmp/x')`,
  ).run();
  db.prepare(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','[]','gd')`).run();
  return db;
}

function row(db: Database, id: string, delivery: string, recipient: string) {
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source)
     VALUES (?, 't1', 'gd', 'bill', 'dm', 'x', 'user')`,
  ).run(id);
  db.prepare(
    `INSERT INTO message_recipient (message_id, agent_id, delivery_state, recipient_state)
     VALUES (?, 'bill', ?, ?)`,
  ).run(id, delivery, recipient);
}

function deliveryOf(db: Database, id: string): string {
  return (db.prepare(`SELECT delivery_state FROM message_recipient WHERE message_id=?`).get(id) as { delivery_state: string }).delivery_state;
}

// Clear the guard so we can exercise the function on the seeded rows.
function unguard(db: Database) {
  db.prepare(`DELETE FROM runtime_lock WHERE key='delivery_orphan_close_v1'`).run();
}

describe("orphanedDeliveryBackfill", () => {
  let db: Database;
  beforeEach(() => (db = freshDb()));

  test("closes engaged orphans (acknowledged/in_progress/completed/blocked) → completed", () => {
    row(db, "ack", "wake_dispatched", "acknowledged");
    row(db, "ip", "wake_dispatched", "in_progress");
    row(db, "cmp", "wake_dispatched", "completed");
    row(db, "blk", "wake_dispatched", "blocked");
    unguard(db);
    orphanedDeliveryBackfill(db);
    for (const id of ["ack", "ip", "cmp", "blk"]) expect(deliveryOf(db, id)).toBe("completed");
  });

  test("leaves ambiguous / expired / still-open rows untouched", () => {
    row(db, "nmr", "wake_dispatched", "needs_match_review"); // ambiguous — don't claim
    row(db, "exp", "wake_dispatched", "expired"); // terminal — let it sweep
    row(db, "open", "wake_dispatched", "open"); // genuinely awaiting — real in-flight
    unguard(db);
    orphanedDeliveryBackfill(db);
    expect(deliveryOf(db, "nmr")).toBe("wake_dispatched");
    expect(deliveryOf(db, "exp")).toBe("wake_dispatched");
    expect(deliveryOf(db, "open")).toBe("wake_dispatched");
  });

  test("does NOT touch non-wake_dispatched transports (e.g. pending engaged)", () => {
    row(db, "pend", "pending", "acknowledged");
    unguard(db);
    orphanedDeliveryBackfill(db);
    expect(deliveryOf(db, "pend")).toBe("pending");
  });

  test("idempotent: flag-guarded, a second call after a real run is a no-op", () => {
    row(db, "ack", "wake_dispatched", "acknowledged");
    unguard(db);
    orphanedDeliveryBackfill(db); // closes + sets flag
    // a new engaged orphan appears later, but the one-time backfill must not fire again
    row(db, "ack2", "wake_dispatched", "acknowledged");
    orphanedDeliveryBackfill(db);
    expect(deliveryOf(db, "ack2")).toBe("wake_dispatched"); // forward fix (live path) handles new ones, not this
  });
});

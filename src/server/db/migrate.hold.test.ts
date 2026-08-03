import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";

describe("task hold additive migration", () => {
  test("기존 task 행을 보존하며 두 번 실행해도 멱등이다", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE task (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      lane TEXT NOT NULL DEFAULT 'plan' CHECK(lane IN ('plan','doing','done')),
      owner TEXT, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    ); INSERT INTO task (id,title,lane) VALUES ('legacy','기존 계획','plan');`);
    migrate(db);
    migrate(db);
    const cols = db.query(`SELECT name FROM pragma_table_info('task') WHERE name IN ('held_at','hold_reason','review_at') ORDER BY name`).all() as { name: string }[];
    expect(cols.map((x) => x.name)).toEqual(["held_at", "hold_reason", "review_at"]);
    expect(db.query(`SELECT id,title,lane,held_at FROM task WHERE id='legacy'`).get()).toEqual({ id: "legacy", title: "기존 계획", lane: "plan", held_at: null });
  });
});

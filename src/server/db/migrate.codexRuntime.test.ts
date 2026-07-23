import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";

describe("migrateCodexRuntimeState", () => {
  test("codex_run_artifact is append-only evidence and survives agent delete", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    db.exec(`
      INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
      VALUES ('cody','Cody','tester','codex','codex_cli','/tmp','AGENTS.md');
      INSERT INTO codex_run_artifact (id, agent_id, message_id, thread_id, status, artifact_json)
      VALUES ('art-1','cody','msg-1','thread-1','succeeded','{}');
      DELETE FROM agent WHERE id = 'cody';
    `);
    const row = db.prepare(`SELECT agent_id FROM codex_run_artifact WHERE id = 'art-1'`).get() as
      | { agent_id: string }
      | undefined;
    const fks = db.prepare(`PRAGMA foreign_key_list('codex_run_artifact')`).all() as Array<{ table: string }>;
    expect(row?.agent_id).toBe("cody");
    expect(fks.some((fk) => fk.table === "agent")).toBe(false);
    db.close();
  });

  test("migrate rewrites an existing cascade artifact table without losing rows", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE agent (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        runtime TEXT NOT NULL CHECK(runtime IN ('codex')),
        status_provider TEXT NOT NULL CHECK(status_provider IN ('codex_cli')),
        workspace_path TEXT NOT NULL,
        persona_file TEXT NOT NULL
      );
      CREATE TABLE codex_run_artifact (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        task_id TEXT,
        codex_session_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','timed_out','deduped')),
        elapsed_ms INTEGER,
        reply_message_id TEXT,
        detail TEXT,
        artifact_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
      VALUES ('cody','Cody','tester','codex','codex_cli','/tmp','AGENTS.md');
      INSERT INTO codex_run_artifact (id, agent_id, message_id, thread_id, status, artifact_json)
      VALUES ('art-1','cody','msg-1','thread-1','succeeded','{}');
    `);
    migrate(db);
    db.exec(`DELETE FROM agent WHERE id = 'cody'`);
    const row = db.prepare(`SELECT agent_id FROM codex_run_artifact WHERE id = 'art-1'`).get() as
      | { agent_id: string }
      | undefined;
    const fks = db.prepare(`PRAGMA foreign_key_list('codex_run_artifact')`).all() as Array<{ table: string }>;
    expect(row?.agent_id).toBe("cody");
    expect(fks.some((fk) => fk.table === "agent")).toBe(false);
    db.close();
  });
});

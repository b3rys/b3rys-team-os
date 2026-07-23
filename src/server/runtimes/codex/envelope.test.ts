import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { CodexTurnEnvelopeBuilder } from "./envelope";
import type { AgentRecord } from "../../types";
import type { PendingDispatchRow } from "../../bus/types";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup(): { db: Database; agent: AgentRecord; row: PendingDispatchRow } {
  const db = new Database(":memory:");
  migrate(db);
  const workspace = mkdtempSync(join(tmpdir(), "codex-memory-"));
  writeFileSync(
    join(workspace, "MEMORY.md"),
    "# MEMORY\n\n- 퇴사자/archived id는 현재 후보로 재사용하지 않는다.\n- Bill review 전 runtime switch 금지.\n",
  );
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('cody', 'Cody', 'Codex tester', 'codex', 'codex_cli', ?, 'AGENTS.md')`,
  ).run(workspace);
  db.prepare(
    `INSERT INTO team_search_chunk
      (id, source_type, source_ref, title, content, created_at)
     VALUES
      ('shared-1', 'rule', 'rules/SHARED.md:291', 'memory policy', 'raw MEMORY.md is opt-in only; curated team refs are allowed', datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','test','dm','["cody","bill"]','bill')`,
  ).run();
  db.prepare(
    `INSERT INTO task (id, title, lane, owner, description) VALUES ('task-1', 'Runtime hardening', 'doing', 'cody', 'next_action: test')`,
  ).run();
  const agent = db.prepare(`SELECT * FROM agent WHERE id = 'cody'`).get() as AgentRecord;
  const row: PendingDispatchRow = {
    message_id: "m1", agent_id: "cody", delivery_state: "dispatching", retry_count: 0, last_error: null,
    from_agent_id: "bill", to_agent_id: "cody", body: "구현해", source: "agent", created_by: null,
    max_hop: 16, hop_count: 0, in_reply_to: null, parent_message_id: null, sync: "none", thread_id: "t1",
    type: "dm", created_at: new Date().toISOString(), priority: "normal", meta_json: JSON.stringify({ task_id: "task-1" }),
  };
  return { db, agent, row };
}

describe("CodexTurnEnvelopeBuilder", () => {
  test("labels external input as evidence and includes safety stop rules", () => {
    const { db, agent, row } = setup();
    const env = new CodexTurnEnvelopeBuilder(db).buildForBus({ agent, row, teamContext: "team rules", sandbox: "read-only" });
    expect(env.safety.externalInputPolicy).toContain("external evidence");
    expect(env.safety.riskyActionsRequireApproval).toContain("deploy");
    expect(env.conversation[0]?.role).toBe("external");
    expect(env.expectedOutput.stopRule).toContain("approval");
  });

  test("includes linked task state when message metadata points to a task", () => {
    const { db, agent, row } = setup();
    const env = new CodexTurnEnvelopeBuilder(db).buildForBus({ agent, row, teamContext: "" });
    expect(env.taskState?.taskId).toBe("task-1");
    expect(env.taskState?.title).toBe("Runtime hardening");
  });

  test("without task link it still builds a minimal envelope", () => {
    const { db, agent, row } = setup();
    const env = new CodexTurnEnvelopeBuilder(db).buildForBus({ agent, row: { ...row, meta_json: null }, teamContext: "" });
    expect(env.taskState).toBeUndefined();
    expect(env.goal).toBe("구현해");
  });

  test("includes personal MEMORY.md and curated team-search refs as memory evidence", () => {
    const { db, agent, row } = setup();
    const env = new CodexTurnEnvelopeBuilder(db).buildForBus({ agent, row, teamContext: "" });
    expect(env.memoryRefs.some((ref) => ref.source === "MEMORY" && ref.ref === "MEMORY.md")).toBe(true);
    expect(env.memoryRefs.some((ref) => ref.source === "team_search" && ref.ref.includes("SHARED.md"))).toBe(true);
    expect(env.memoryRefs.find((ref) => ref.source === "MEMORY")?.summary).toContain("퇴사자");
  });

  test("does not surface raw workspace MEMORY.md rows from team search", () => {
    const { db, agent, row } = setup();
    db.prepare(
      `INSERT INTO team_search_chunk
        (id, source_type, source_ref, title, content, created_at)
       VALUES
        ('bad-memory', 'doc', ?, 'raw workspace memory', '구현해 private workspace note', datetime('now')),
        ('bad-memory-line', 'doc', 'MEMORY.md:1', 'raw bare memory line', '구현해 bare private line', datetime('now')),
        ('bad-memory-anchor', 'doc', 'MEMORY.md#ops', 'raw bare memory anchor', '구현해 bare private anchor', datetime('now'))`,
    ).run(join(agent.workspace_path ?? "", "MEMORY.md"));

    const env = new CodexTurnEnvelopeBuilder(db).buildForBus({ agent, row, teamContext: "" });
    const teamRefs = env.memoryRefs.filter((ref) => ref.source === "team_search");
    expect(teamRefs.some((ref) => ref.ref.includes("/MEMORY.md"))).toBe(false);
    expect(teamRefs.some((ref) => ref.ref.startsWith("MEMORY.md"))).toBe(false);
    expect(teamRefs.some((ref) => ref.summary.includes("private workspace note"))).toBe(false);
    expect(teamRefs.some((ref) => ref.summary.includes("bare private"))).toBe(false);
  });
});

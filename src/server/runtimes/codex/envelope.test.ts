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


});

// ── ★답은 자동으로 전달되지 않는다★ (실측 2026-08-12) ──
//
// 턴은 성공했는데 dex 가 send.sh 를 안 불러서 ★팀에는 아무것도 도착하지 않았다.★
// 일은 다 하고(파일 읽고 정리하고) 마지막 한 걸음을 안 했다.
// 서버는 어떤 런타임에서도 답을 대신 게시하지 않는다(turn_completed_no_autopost).

test("★봉투가 '보내야 말한 것' 을 명시하고 실제 명령을 준다★", () => {
  const { db, agent, row } = setup();
  const b = new CodexTurnEnvelopeBuilder(db);
  const env = b.buildForBus({ agent, row, teamContext: "" });
  const cmd = env.howToReply;
  expect(cmd).toContain("send.sh");
  expect(cmd).toContain("--thread t1"); // 스레드가 박혀 있어야 조립 실수가 없다
  expect(cmd).toContain("--to bill");   // 요청한 사람에게 간다
  expect(cmd).toContain("--in-reply-to");

  const prompt = b.toPrompt(env);
  expect(prompt).toContain("delivered only by running"); // 안 보내면 전달 안 된다는 걸 말해야 한다
  // ★중간 메모로 끝내면 안 된다★ — 착수 확인만 보내고 결과를 안 보낸 실측 사례가 있다
  expect(prompt).toContain("Interim notes do not count");
  // ★같은 명령이 두 번 나오면 안 된다★ — JSON 에도 넣으면 중복이다(리뷰 지적)
  expect(prompt.split("send.sh").length - 1).toBe(1);
});

test("★팀 컨텍스트는 다른 런타임과 똑같이 들어간다★ — codex 만 못 받으면 안 된다", () => {
  // 런타임 무관 공통값이다(wakeDispatcher.buildTeamContext → claude·b3osNative 도 받는다).
  const { db, agent, row } = setup();
  const b = new CodexTurnEnvelopeBuilder(db);
  const env = b.buildForBus({ agent, row, teamContext: "팀 규칙 요약 줄" });
  expect(env.teamContext).toBe("팀 규칙 요약 줄");
  expect(b.toPrompt(env)).toContain("팀 규칙 요약 줄");
});

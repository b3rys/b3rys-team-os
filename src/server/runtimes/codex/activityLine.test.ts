// ★지금 무엇을 하는 중인가★ (팀 리드 2026-08-12: "한줄 말고 진짜 몰하는지 나와야지. 다른팀원들 처럼")
//
// tmux 팀원은 statusProbe 가 화면을 긁어 activity_line 을 채운다. 창이 없는 codex 팀원은
// ★영영 비어 있었다★ — 실측: dex 의 activity_line 은 항상 null.
// codex 의 등가물은 app-server item 이벤트다. 같은 칸에 쓴다.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { setActivityLine } from "../../db/queries";
import { activityLineOf } from "./appServerClient";

const dbWithDex = () => {
  const db = new Database(":memory:"); migrate(db);
  db.prepare(`INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
              VALUES ('dex','Dex','eng','codex','codex_cli','/w','AGENTS.md')`).run();
  return db;
};

test("★무엇을 하는지가 나온다★ — 종류만 말하면 '진짜 뭘 하는지' 가 아니다", () => {
  expect(activityLineOf({ type: "commandExecution", command: "npm test" })).toBe("실행: npm test");
  expect(activityLineOf({ type: "commandExecution", command: ["git", "status"] })).toBe("실행: git status");
  expect(activityLineOf({ type: "fileChange", fileChanges: { "src/a.ts": {} } })).toBe("파일 수정: src/a.ts");
  expect(activityLineOf({ type: "fileChange", fileChanges: { a: {}, b: {}, c: {} } })).toBe("파일 3개 수정");
  expect(activityLineOf({ type: "webSearch", query: "codex config" })).toBe("웹 검색: codex config");
  expect(activityLineOf({ type: "mcpToolCall", name: "team_status" })).toBe("도구 호출: team_status");
});

test("긴 명령은 잘린다 — 한 줄 표시라 넘치면 화면을 밀어낸다", () => {
  const line = activityLineOf({ type: "commandExecution", command: "x".repeat(300) })!;
  expect(line.length).toBeLessThanOrEqual(85);
  expect(line.endsWith("…")).toBe(true);
});

test("알 수 없는 항목은 null — 빈 줄로 덮어써서 있던 정보를 지우지 않는다", () => {
  expect(activityLineOf({})).toBeNull();
  expect(activityLineOf(null)).toBeNull();
});

test("★다른 칸을 건드리지 않는다★ — state·tmux_pid 는 statusProbe 의 것이다", () => {
  const db = dbWithDex();
  db.prepare(`INSERT INTO agent_status (agent_id, state, last_activity_at, last_log_line, tmux_pid, probed_at)
              VALUES ('dex','idle',datetime('now'),'기존 로그',4242,datetime('now'))`).run();
  setActivityLine(db, "dex", "실행: npm test");
  const r = db.query("select state, tmux_pid, last_log_line, activity_line from agent_status where agent_id='dex'").get() as Record<string, unknown>;
  expect(r.activity_line).toBe("실행: npm test");
  expect(r.tmux_pid).toBe(4242);        // 두 주인이 서로 덮어쓰면 안 된다
  expect(r.last_log_line).toBe("기존 로그");
  db.close();
});

test("행이 없어도 만들어진다(첫 턴에 표시가 나와야 한다)", () => {
  const db = dbWithDex();
  setActivityLine(db, "dex", "웹 검색: x");
  expect((db.query("select activity_line from agent_status where agent_id='dex'").get() as { activity_line: string }).activity_line).toBe("웹 검색: x");
  db.close();
});

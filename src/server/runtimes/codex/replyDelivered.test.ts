// 턴 성공과 답 전달을 따로 확인한다. 미전송은 기록·재촉하되 서버가 답을 대신 게시하지 않는다.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { agentRepliedSince } from "./adapter";

describe("codex 답 배달 확인 — 안 보낸 것을 잡는다", () => {

function db2() {
  const db = new Database(":memory:"); migrate(db);
  for (const id of ["dex", "demis"]) {
    db.prepare(`INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
                VALUES (?,?,'eng','codex','codex_cli','/w','AGENTS.md')`).run(id, id);
  }
  db.prepare(`INSERT INTO thread (id,title,kind,participants_json,opened_by) VALUES ('t1','x','dm','["dex"]','demis')`).run();
  return db;
}
const put = (db: Database, from: string, at: string) =>
  db.prepare(`INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
              VALUES (?,'t1',?,'demis','dm','b','agent',?)`).run(`m${Math.random()}`, from, at);

test("★안 보냈으면 안 보낸 것으로 잡힌다★", () => {
  const db = db2();
  expect(agentRepliedSince(db, "dex", "t1", "2026-08-12 05:00:00")).toBe(false);
  db.close();
});

test("보냈으면 잡히지 않는다(거짓 경고 금지)", () => {
  const db = db2();
  put(db, "dex", "2026-08-12 05:30:00");
  expect(agentRepliedSince(db, "dex", "t1", "2026-08-12 05:00:00")).toBe(true);
  db.close();
});

test("★턴 시작 전에 보낸 것은 이번 답이 아니다★ — 옛 메시지로 통과되면 안 된다", () => {
  const db = db2();
  put(db, "dex", "2026-08-12 04:00:00"); // 턴 시작 전
  expect(agentRepliedSince(db, "dex", "t1", "2026-08-12 05:00:00")).toBe(false);
  db.close();
});

test("다른 사람이 보낸 것은 그 팀원의 답이 아니다", () => {
  const db = db2();
  put(db, "demis", "2026-08-12 05:30:00");
  expect(agentRepliedSince(db, "dex", "t1", "2026-08-12 05:00:00")).toBe(false);
  db.close();
});

test("조회가 깨지면 거짓 경고를 내지 않는다(안전한 쪽으로)", () => {
  const db = new Database(":memory:"); // migrate 안 함 = message 테이블 없음
  expect(agentRepliedSince(db, "dex", "t1", "2026-08-12 05:00:00")).toBe(true);
  db.close();
});
});

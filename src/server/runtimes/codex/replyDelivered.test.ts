// ★답이 팀에 도착했는지 확인한다 — 대신 말하지는 않는다★ (2026-08-12)
//
// 서버가 팀원 대신 말하지 않는다는 규칙(GD 2026-07-13)은 그대로다.
// 다만 ★안 보낸 것을 아무도 모르는 것★ 은 다른 문제다. 오늘 하루에 세 번 났다:
//   답 없음 / 착수확인만 보내고 118초 일한 뒤 결과 없음 / 전송 0건
// 셋 다 턴은 succeeded 였고 로그도 조용했다. 사람이 물어보기 전엔 아무도 몰랐다.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { agentRepliedSince } from "./adapter";

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

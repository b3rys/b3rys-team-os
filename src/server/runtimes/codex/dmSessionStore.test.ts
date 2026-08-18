import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../db/migrate";
import { makeDmSessionStore, NOOP_DM_SESSION_STORE, DM_SURFACE } from "./dmSessionStore";
import { CodexSessionStore } from "./state";

function freshDbPath(): string {
  const p = join(mkdtempSync(join(tmpdir(), "dmsess-")), "team.db");
  const db = new Database(p);
  migrate(db);
  db.prepare(
    `INSERT OR IGNORE INTO agent(id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES('dex','Dex','runtime','codex','codex_cli','/tmp/dex','AGENTS.md')`,
  ).run();
  db.close();
  return p;
}

describe("1:1 세션 기억 — 재시작 연속성", () => {
  test("★재시작을 넘어 기억한다★ — 이게 없으면 재시작마다 앞 대화를 잊는다", () => {
    const dbPath = freshDbPath();

    // 재시작 전: 턴이 끝나 세션을 적는다
    const before = makeDmSessionStore("dex", dbPath);
    before.save(7066867819, "sess-abc");

    // ★재시작★ — 새 프로세스가 뜬 상황(인메모리 지도는 비어 있다)
    const after = makeDmSessionStore("dex", dbPath);
    expect(after.get(7066867819)).toBe("sess-abc");
  });

  test("★대조군 — 기억하지 않는 구현에서는 끊긴다★ (고치기 전 동작)", () => {
    NOOP_DM_SESSION_STORE.save(7066867819, "sess-abc");
    expect(NOOP_DM_SESSION_STORE.get(7066867819)).toBeUndefined();
  });

  test("대화별로 따로 기억한다 — 다른 방의 맥락이 섞이면 안 된다", () => {
    const dbPath = freshDbPath();
    const s = makeDmSessionStore("dex", dbPath);
    s.save(111, "sess-a");
    s.save(222, "sess-b");
    expect(s.get(111)).toBe("sess-a");
    expect(s.get(222)).toBe("sess-b");
  });

  test("같은 대화를 다시 적으면 최신으로 덮는다 — 옛 세션으로 resume 하면 안 된다", () => {
    const dbPath = freshDbPath();
    const s = makeDmSessionStore("dex", dbPath);
    s.save(111, "sess-old");
    s.save(111, "sess-new");
    expect(s.get(111)).toBe("sess-new");
  });

  test("★죽은 세션은 지운다★ — 안 지우면 재시작 후에도 계속 그것으로 resume 해 매번 실패한다", () => {
    const dbPath = freshDbPath();
    const s = makeDmSessionStore("dex", dbPath);
    s.save(111, "sess-dead");
    s.clear(111);
    expect(s.get(111)).toBeUndefined();
    expect(makeDmSessionStore("dex", dbPath).get(111)).toBeUndefined(); // 재시작 후에도
  });

  test("★버스 기록과 섞이지 않는다★ — 같은 표를 쓰되 surface 로 가른다", () => {
    const dbPath = freshDbPath();
    const db = new Database(dbPath);
    new CodexSessionStore(db).save({
      agentId: "dex", surface: "team_bus", conversationKey: "111", codexSessionId: "bus-sess",
    });
    db.close();

    const s = makeDmSessionStore("dex", dbPath);
    expect(s.get(111)).toBeUndefined();  // 버스 행을 1:1 세션으로 읽지 않는다
    s.save(111, "dm-sess");

    const check = new Database(dbPath);
    const rows = check.prepare("SELECT surface, codex_session_id FROM codex_session_map WHERE conversation_key='111' ORDER BY surface").all() as { surface: string; codex_session_id: string }[];
    check.close();
    expect(rows).toEqual([
      { surface: "team_bus", codex_session_id: "bus-sess" },
      { surface: DM_SURFACE, codex_session_id: "dm-sess" },
    ]);
  });

  test("★DB 를 못 열어도 대화는 계속된다★ — 기억 실패는 불편이지 고장이 아니다", () => {
    const s = makeDmSessionStore("dex", "/nonexistent-dir/nope/team.db");
    expect(() => s.save(111, "x")).not.toThrow();
    expect(s.get(111)).toBeUndefined();
    expect(() => s.clear(111)).not.toThrow();
  });
});

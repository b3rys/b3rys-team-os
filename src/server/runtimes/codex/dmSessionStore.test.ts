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

// ── ★그룹과 1:1 은 다른 surface 로 적힌다★ (2026-08-24) ──
//
// 섞어도 chatId 가 달라 충돌은 안 나지만 ★이름이 거짓말★ 이 된다. 6.8 을 재는 판별자
// (`created_at` 보존)도 두 대화가 한 이름에 섞이면 못 쓰게 된다.
import { makeChatSessionStore, GROUP_SURFACE } from "./dmSessionStore";

describe("makeChatSessionStore — chatId 부호로 surface 를 고른다", () => {
  function fresh(): { db: Database; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "css-"));
    const path = join(dir, "team.db");
    const db = new Database(path);
    migrate(db);
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES ('dex','Dex','Dev','codex','codex_cli','','')`,
    ).run();
    db.close();
    return { db: new Database(path), path };
  }
  const surfaceOf = (db: Database, key: string): string | undefined =>
    (db.prepare(`SELECT surface AS s FROM codex_session_map WHERE conversation_key = ?`).get(key) as { s: string } | undefined)?.s;

  test("★그룹(음수 chatId)은 telegram_group 으로 적힌다★", () => {
    const { db, path } = fresh();
    makeChatSessionStore("dex", path).save(-1003947108339, "sess-g");
    expect(surfaceOf(db, "-1003947108339")).toBe(GROUP_SURFACE);
  });

  test("1:1(양수 chatId)은 telegram_dm 그대로", () => {
    const { db, path } = fresh();
    makeChatSessionStore("dex", path).save(7066867819, "sess-d");
    expect(surfaceOf(db, "7066867819")).toBe(DM_SURFACE);
  });

  test("★두 대화가 서로를 안 덮는다★ — 각자 자기 세션을 돌려준다", () => {
    const { path } = fresh();
    const s = makeChatSessionStore("dex", path);
    s.save(-100, "sess-group");
    s.save(200, "sess-dm");
    expect(s.get(-100)).toBe("sess-group");
    expect(s.get(200)).toBe("sess-dm");
  });

  test("★지울 때도 자기 surface 만★ — 그룹을 지워도 1:1 은 남는다", () => {
    const { path } = fresh();
    const s = makeChatSessionStore("dex", path);
    s.save(-100, "sess-group");
    s.save(200, "sess-dm");
    s.clear(-100);
    expect(s.get(-100)).toBeUndefined();
    expect(s.get(200)).toBe("sess-dm");
  });
});

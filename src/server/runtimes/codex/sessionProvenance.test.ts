import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../db/migrate";
import { CodexSessionStore } from "./state";

/**
 * ★기록만으로 "이어받았나" 를 가릴 수 있어야 한다.★
 *
 * updated_at 만 있으면 이어받아도 새로 시작해도 값이 "방금" 으로 같다. 그래서 지금까지는
 * ★바깥에서 기준점을 재놔야만★ 판정할 수 있었다(누가 언제 0행을 봤는지 같은 것).
 * 그 관측은 재현이 안 된다 — 그때 본 사람만 안다.
 *
 * created_at 을 함께 두면 두 값의 관계가 답을 말한다:
 *   created_at == updated_at → 이번에 처음 만든 세션
 *   created_at <  updated_at → ★그 사이에 같은 세션으로 이어받았다★
 */
function freshDb(): Database {
  const p = join(mkdtempSync(join(tmpdir(), "sessprov-")), "team.db");
  const db = new Database(p);
  migrate(db);
  db.prepare(
    `INSERT OR IGNORE INTO agent(id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES('dex','Dex','runtime','codex','codex_cli','/tmp/dex','AGENTS.md')`,
  ).run();
  return db;
}

const row = (db: Database) =>
  db
    .prepare(
      `SELECT codex_session_id AS id, created_at AS created, updated_at AS updated
         FROM codex_session_map WHERE surface = 'telegram_dm'`,
    )
    .get() as { id: string; created: string; updated: string };

const save = (db: Database, id: string) =>
  new CodexSessionStore(db).save({
    agentId: "dex",
    surface: "telegram_dm",
    conversationKey: "7066867819",
    codexSessionId: id,
  });

describe("세션 기록 — 이어받았는지 기록만으로 가린다", () => {
  test("★처음 저장하면 두 값이 같다★ — 이번에 만든 세션이라는 뜻", () => {
    const db = freshDb();
    save(db, "sess-a");
    const r = row(db);
    expect(r.created).toBe(r.updated);
    db.close();
  });

  test("★같은 세션으로 다시 저장하면 created_at 은 그대로다★ — 이어받았다는 증거", () => {
    const db = freshDb();
    save(db, "sess-a");
    db.prepare(`UPDATE codex_session_map SET created_at = datetime('now','-2 hours'), updated_at = datetime('now','-2 hours')`).run();
    save(db, "sess-a"); // 재시작 뒤 이어받은 턴
    const after = row(db);
    expect(after.id).toBe("sess-a");
    expect(after.created < after.updated, "이어받았으면 created_at 이 더 이르다").toBe(true);
    db.close();
  });

  test("★대조군 — 세션이 바뀌면 created_at 도 다시 찍는다★ (안 그러면 새 대화를 이어받은 것으로 읽는다)", () => {
    const db = freshDb();
    save(db, "sess-a");
    db.prepare(`UPDATE codex_session_map SET created_at = datetime('now','-2 hours'), updated_at = datetime('now','-2 hours')`).run();
    save(db, "sess-b"); // 이어받기 실패 → 새 대화
    const r = row(db);
    expect(r.id).toBe("sess-b");
    expect(r.created).toBe(r.updated);
    db.close();
  });

  test("★옛 행(created_at 이 비어 있는 것)은 이어받아도 채우지 않는다★ — 채우면 이어받기가 '새 세션' 으로 읽힌다", () => {
    // 마이그레이션 이전 행이 이 상태다. 여기서 지금 시각을 채우면 created_at == updated_at 이 되어
    // ★실제로는 이어받았는데 '이번에 처음 만든 세션' 이라는 ★틀린 답★ 이 나온다.
    // 모르는 것은 NULL 로 남겨 모른다고 말한다 — 지어낸 값은 판정 불가보다 나쁘다.
    const db = freshDb();
    save(db, "sess-a");
    db.prepare(`UPDATE codex_session_map SET created_at = NULL, updated_at = datetime('now','-1 hours')`).run();
    save(db, "sess-a"); // 이어받은 턴
    const r = row(db);
    expect(r.created, "모르는 것은 모른다고 둔다").toBeNull();
    db.close();
  });

  test("★옛 행이라도 세션이 바뀌면 그때 채운다★ — 그 시점은 실제로 '새로 만든' 시점이다", () => {
    const db = freshDb();
    save(db, "sess-a");
    db.prepare(`UPDATE codex_session_map SET created_at = NULL, updated_at = datetime('now','-1 hours')`).run();
    save(db, "sess-b"); // 새 대화
    const r = row(db);
    expect(r.id).toBe("sess-b");
    expect(r.created).not.toBeNull();
    expect(r.created).toBe(r.updated);
    db.close();
  });

  test("버스 기록과 섞이지 않는다 — surface 로 갈린 채 각자 자기 값을 갖는다", () => {
    const db = freshDb();
    new CodexSessionStore(db).save({
      agentId: "dex", surface: "team_bus", conversationKey: "7066867819", codexSessionId: "bus-1",
    });
    save(db, "dm-1");
    const dm = row(db);
    expect(dm.id).toBe("dm-1");
    const bus = db
      .prepare(`SELECT codex_session_id AS id FROM codex_session_map WHERE surface='team_bus'`)
      .get() as { id: string };
    expect(bus.id).toBe("bus-1");
    db.close();
  });
});

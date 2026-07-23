// b3os_native CHECK 위든 마이그레이션 — 데이터 보존 + accept/reject 핀.
// 하네스 리뷰가 잡은 데이터손실 버그(재빌드가 icon·hermes_* 컬럼 누락 복사)를 회귀 방지로 고정.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { widenAgentRuntimeChecks } from "./migrate";

// b3os_native 추가 '전' 상태(hermes까지만 위든된 라이브 DB) 재현 — icon·hermes_* 데이터 있음.
function oldHermesWidenedDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE agent (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    runtime TEXT NOT NULL CHECK(runtime IN ('claude_channel','openclaw','hermes_agent')),
    status_provider TEXT NOT NULL CHECK(status_provider IN ('claude_tmux','openclaw_gateway','hermes_gateway')),
    tmux_session TEXT,
    telegram_bot_username TEXT,
    workspace_path TEXT NOT NULL,
    persona_file TEXT NOT NULL,
    moderator_eligible INTEGER NOT NULL DEFAULT 0,
    avatar_emoji TEXT NOT NULL DEFAULT '🤖',
    hermes_profile TEXT,
    hermes_alias TEXT,
    gateway_service TEXT,
    icon TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file,
       hermes_profile, hermes_alias, gateway_service, icon)
     VALUES ('herm','Herm','cso','hermes_agent','hermes_gateway','/tmp','p.md',
       'b3hermes','헤르메스','com.x.hermes','hexagon')`,
  ).run();
  return db;
}

describe("b3os_native CHECK 위든 마이그레이션", () => {
  test("★데이터 보존: 재빌드 후 hermes_profile·alias·gateway·icon 데이터 살아있음", () => {
    const db = oldHermesWidenedDb();
    widenAgentRuntimeChecks(db); // b3os_native 위해 1회 재빌드 발생
    const herm = db.prepare(`SELECT * FROM agent WHERE id='herm'`).get() as Record<string, unknown>;
    expect(herm.hermes_profile).toBe("b3hermes");
    expect(herm.hermes_alias).toBe("헤르메스");
    expect(herm.gateway_service).toBe("com.x.hermes");
    expect(herm.icon).toBe("hexagon"); // ← 하네스가 잡은 손실 컬럼들
  });

  test("재빌드 후 b3os_native / b3os_native_runner INSERT 가능", () => {
    const db = oldHermesWidenedDb();
    widenAgentRuntimeChecks(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
           VALUES ('nova','Nova','builder','b3os_native','b3os_native_runner','/tmp','p.md')`,
        )
        .run(),
    ).not.toThrow();
  });

  test("CHECK 유지: 엉뚱한 runtime 값은 거부", () => {
    const db = oldHermesWidenedDb();
    widenAgentRuntimeChecks(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
           VALUES ('x','X','r','garbage_runtime','b3os_native_runner','/tmp','p.md')`,
        )
        .run(),
    ).toThrow();
  });

  test("idempotent: 위든 두 번째 호출은 재빌드 안 함(데이터 안정)", () => {
    const db = oldHermesWidenedDb();
    widenAgentRuntimeChecks(db);
    widenAgentRuntimeChecks(db); // 두 번째 = no-op이어야
    const herm = db.prepare(`SELECT * FROM agent WHERE id='herm'`).get() as Record<string, unknown>;
    expect(herm.hermes_profile).toBe("b3hermes");
    expect(herm.icon).toBe("hexagon");
  });
});

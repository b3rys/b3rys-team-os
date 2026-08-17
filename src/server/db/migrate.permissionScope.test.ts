import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { decidePermissionRequest, requestPermission, getPermissionRequest } from "../lib/permissionGate";

// decision_scope 가 붙기 전의 표. 기존 설치본을 이 모양으로 재현한다.
const OLD_TABLE = `CREATE TABLE permission_request (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  runtime TEXT NOT NULL,
  agent_id TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','allowed_once','allowed_always','denied','expired')),
  requested_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  approver TEXT,
  provenance_json TEXT
)`;

const cols = (db: Database): string[] =>
  (db.prepare("PRAGMA table_info('permission_request')").all() as { name: string }[]).map((c) => c.name);

const tableSql = (db: Database): string =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='permission_request'").get() as { sql: string }).sql;

describe("permission_request.decision_scope — 표를 재작성하지 않고 범위를 적는다", () => {
  test("기존 설치본에 칸만 붙는다 — 행도 CHECK 도 그대로", () => {
    const db = new Database(":memory:");
    db.exec(OLD_TABLE);
    for (let i = 0; i < 26; i++) {
      db.prepare(
        `INSERT INTO permission_request (id, scope_key, runtime, action, target, status)
         VALUES (?, ?, 'codex', 'exec', '/tmp/x', ?)`,
      ).run(`p${i}`, `s${i}`, i < 12 ? "allowed_once" : i < 18 ? "denied" : "expired");
    }
    const checkBefore = tableSql(db).match(/CHECK\(status IN \([^)]*\)\)/)?.[0];

    migrate(db);

    expect(cols(db)).toContain("decision_scope");
    expect((db.prepare("SELECT count(*) AS n FROM permission_request").get() as { n: number }).n).toBe(26);
    // ★CHECK 는 손대지 않는다★ — 남의 DB 를 재작성하지 않는다는 것이 이 설계의 이유다.
    expect(tableSql(db).match(/CHECK\(status IN \([^)]*\)\)/)?.[0]).toBe(checkBefore);
    // 옛 행은 범위를 모른다. null 이어야 하고, '한번' 으로 채워지면 안 된다.
    expect((db.prepare("SELECT count(*) AS n FROM permission_request WHERE decision_scope IS NULL").get() as { n: number }).n).toBe(26);
  });

  test("두 번 돌려도 칸이 한 번만 붙는다", () => {
    const db = new Database(":memory:");
    db.exec(OLD_TABLE);
    migrate(db);
    migrate(db);
    expect(cols(db).filter((c) => c === "decision_scope")).toHaveLength(1);
  });
});

describe("세션 결정이 기록에 남는다", () => {
  function db(): Database {
    const d = new Database(":memory:");
    migrate(d);
    return d;
  }
  const op = (target: string) => ({ runtime: "codex", agent_id: "dex", action: "exec", target });

  test("★세션과 한번이 기록에서 갈린다★ — status 만 보면 같다", () => {
    const d = db();
    const once = requestPermission(d, op("/tmp/a")).request!;
    const session = requestPermission(d, op("/tmp/b")).request!;

    decidePermissionRequest(d, once.id, "allow_once", { approver: "gd" });
    decidePermissionRequest(d, session.id, "allow_session", { approver: "gd" });

    const a = getPermissionRequest(d, once.id)!;
    const b = getPermissionRequest(d, session.id)!;

    expect(a.status).toBe("allowed_once");
    expect(b.status).toBe("allowed_once"); // 지속 허가를 안 남긴다는 점에서 같다
    expect(a.decision_scope).toBe("once");
    expect(b.decision_scope).toBe("session"); // ★고른 것은 여기 남는다★
  });

  test("세션은 grant 를 만들지 않는다 — 세션 범위는 런타임이 지킨다", () => {
    const d = db();
    const r = requestPermission(d, op("/tmp/c")).request!;
    decidePermissionRequest(d, r.id, "allow_session", { approver: "gd" });
    expect((d.prepare("SELECT count(*) AS n FROM permission_grant").get() as { n: number }).n).toBe(0);
  });

  test("항상 허용은 grant 를 만들고 범위도 always 로 남는다", () => {
    const d = db();
    const r = requestPermission(d, op("/tmp/d")).request!;
    decidePermissionRequest(d, r.id, "allow_always", { approver: "gd" });
    const row = getPermissionRequest(d, r.id)!;
    expect(row.status).toBe("allowed_always");
    expect(row.decision_scope).toBe("always");
    expect((d.prepare("SELECT count(*) AS n FROM permission_grant").get() as { n: number }).n).toBe(1);
  });

  test("거절은 범위가 없다", () => {
    const d = db();
    const r = requestPermission(d, op("/tmp/e")).request!;
    decidePermissionRequest(d, r.id, "deny", { approver: "gd" });
    const row = getPermissionRequest(d, r.id)!;
    expect(row.status).toBe("denied");
    expect(row.decision_scope).toBeNull();
  });
});

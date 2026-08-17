/**
 * pollDecision 은 status 와 decision_scope 를 ★같이★ 읽는다.
 *
 * '이 세션' 은 지속되는 허가를 남기지 않으므로 status 가 allowed_once 와 같다(permissionGate.ts).
 * 둘을 가르는 것은 decision_scope 뿐이라, status 만 읽으면 사람이 세션을 골라도 런타임에는
 * '한번' 이 간다. 아래 시험은 그 경계를 양쪽에서 잰다 — 세션이 세션으로 가는가, 그리고
 * ★세션이 아닌 것이 세션으로 새지 않는가.★
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { decidePermissionRequest } from "../../lib/permissionGate";
import { pollDecision } from "./appServerPopup";

describe("codex 승인 범위 — status 와 decision_scope 를 같이 읽는다", () => {

/** 결정 대기 중인 요청 하나를 만든다. */
function pendingRequest(db: Database, id = "req_scope"): string {
  db.prepare(
    `INSERT INTO permission_request (id, scope_key, runtime, agent_id, action, target, status)
     VALUES (?, ?, 'codex', 'dex', 'shell', '/tmp/x', 'pending')`,
  ).run(id, `scope:${id}`);
  return id;
}

function migrated(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("★'이 세션' 을 고르면 세션으로 간다★ — status 는 allowed_once 지만 범위가 session 이다", async () => {
  const db = migrated();
  const id = pendingRequest(db);
  expect(decidePermissionRequest(db, id, "allow_session", { approver: "team-lead" }).ok).toBe(true);

  // 두 칸이 실제로 이 모양인지 먼저 고정한다 — 아니면 아래 기대값이 무엇을 재는지 알 수 없다.
  const row = db.prepare("SELECT status, decision_scope FROM permission_request WHERE id = ?").get(id) as {
    status: string; decision_scope: string | null;
  };
  expect(row.status).toBe("allowed_once");
  expect(row.decision_scope).toBe("session");

  expect(await pollDecision(db, id, 1_000, 5)).toBe("approved_for_session");
});

test("대조군 — '한번' 은 한번이다", async () => {
  const db = migrated();
  const id = pendingRequest(db);
  decidePermissionRequest(db, id, "allow_once", { approver: "team-lead" });
  expect(
    (db.prepare("SELECT decision_scope AS s FROM permission_request WHERE id = ?").get(id) as { s: string }).s,
  ).toBe("once");
  expect(await pollDecision(db, id, 1_000, 5)).toBe("approved");
});

test("★옛 행의 decision_scope 는 NULL 이다 — 그걸 session 으로 읽지 않는다★", async () => {
  const db = migrated();
  const id = "req_legacy_row";
  // #325 이전에 결정된 행: status 만 있고 범위 칸이 비어 있다.
  db.prepare(
    `INSERT INTO permission_request (id, scope_key, runtime, agent_id, action, target, status, decision_scope)
     VALUES (?, 'scope:legacy', 'codex', 'dex', 'shell', '/tmp/x', 'allowed_once', NULL)`,
  ).run(id);

  // NULL 을 세션으로 읽으면 옛 '한번' 결정이 소급해서 세션 허용이 된다.
  expect(await pollDecision(db, id, 1_000, 5)).toBe("approved");
});

test("칸 자체가 없는 옛 스키마에서도 '한번' 으로 떨어진다 — 조회 실패로 죽지 않는다", async () => {
  const db = new Database(":memory:");
  // decision_scope 가 붙기 전의 표(migrate 를 안 돌린 설치본).
  db.run(
    `CREATE TABLE permission_request (id TEXT PRIMARY KEY, scope_key TEXT, runtime TEXT, agent_id TEXT,
     action TEXT, target TEXT, payload_json TEXT, status TEXT, requested_by TEXT, created_at TEXT,
     decided_at TEXT, approver TEXT, provenance_json TEXT)`,
  );
  db.prepare(`INSERT INTO permission_request (id, status, runtime, action) VALUES ('req_old', 'allowed_once', 'codex', 'shell')`).run();

  expect(await pollDecision(db, "req_old", 1_000, 5)).toBe("approved");
});

test("모르는 범위 값은 좁은 쪽으로 떨어진다 — 세션으로 넓히지 않는다", async () => {
  const db = migrated();
  const id = "req_unknown_scope";
  db.prepare(
    `INSERT INTO permission_request (id, scope_key, runtime, agent_id, action, target, status, decision_scope)
     VALUES (?, 'scope:unknown', 'codex', 'dex', 'shell', '/tmp/x', 'allowed_once', 'everything')`,
  ).run(id);

  expect(await pollDecision(db, id, 1_000, 5)).toBe("approved");
});

test("회귀 — '항상 허용' 은 그대로 세션이다(범위 always)", async () => {
  const db = migrated();
  const id = pendingRequest(db, "req_always");
  decidePermissionRequest(db, id, "allow_always", { approver: "team-lead" });
  const row = db.prepare("SELECT status, decision_scope FROM permission_request WHERE id = ?").get(id) as {
    status: string; decision_scope: string | null;
  };
  expect(row.status).toBe("allowed_always");
  expect(row.decision_scope).toBe("always");
  expect(await pollDecision(db, id, 1_000, 5)).toBe("approved_for_session");
});
});

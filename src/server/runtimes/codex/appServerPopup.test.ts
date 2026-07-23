/** M5.1-2 팝업 plumbing 테스트 — buildOp 매핑 + pollDecision 상태별/타임아웃(codex 턴 불필요). */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { buildOperationFromApproval, pollDecision } from "./appServerPopup";

function dbWith(status: string): { db: Database; id: string } {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE permission_request (id TEXT PRIMARY KEY, scope_key TEXT, runtime TEXT, agent_id TEXT, action TEXT, target TEXT, payload_json TEXT, status TEXT, requested_by TEXT, created_at TEXT, decided_at TEXT, approver TEXT, provenance_json TEXT)`);
  const id = "req_test";
  db.prepare(`INSERT INTO permission_request (id, status, runtime, action) VALUES (?, ?, 'codex', 'shell')`).run(id, status);
  return { db, id };
}

test("M5.1 buildOp — exec 명령 → action=shell + command", () => {
  const op = buildOperationFromApproval({ method: "execCommandApproval", params: { command: ["bun", "test"], cwd: "/p", callId: "c1" } }, "dex", "/p");
  expect(op.action).toBe("shell");
  expect(op.command).toContain("bun test");
  expect((op.provenance as any).source).toBe("appserver_approval");
});

test("M5.1 buildOp — patch → action=write + path(전체 파일집합, CRITICAL 1-B)", () => {
  const op = buildOperationFromApproval({ method: "applyPatchApproval", params: { fileChanges: { "/p/b.ts": {}, "/p/a.ts": {} } } }, "dex");
  expect(op.action).toBe("write");
  expect(op.path).toBe("/p/a.ts|/p/b.ts"); // 정렬된 전체 파일집합(files[0]만 아님)
  expect(op.text).toContain("b.ts");
});

test("M5.2 pollDecision — allowed_once → approved", async () => {
  const { db, id } = dbWith("allowed_once");
  expect(await pollDecision(db, id, 1000, 5)).toBe("approved");
});

test("M5.2 pollDecision — allowed_always → approved_for_session", async () => {
  const { db, id } = dbWith("allowed_always");
  expect(await pollDecision(db, id, 1000, 5)).toBe("approved_for_session");
});

test("M5.2 pollDecision — denied → denied", async () => {
  const { db, id } = dbWith("denied");
  expect(await pollDecision(db, id, 1000, 5)).toBe("denied");
});

test("★M5.2 pollDecision — pending 1h 무응답 → hold(denied)★ (짧은 TTL로)", async () => {
  const { db, id } = dbWith("pending");
  expect(await pollDecision(db, id, 40, 10)).toBe("denied");
});

test("M5.2 pollDecision — 요청 사라짐 → fail-closed denied", async () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE permission_request (id TEXT PRIMARY KEY, status TEXT)`);
  expect(await pollDecision(db, "nope", 1000, 5)).toBe("denied");
});

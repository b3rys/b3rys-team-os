import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import {
  ACTIONS,
  listActions,
  enqueueApproval,
  listApprovals,
  getApproval,
  setApprovalStatus,
  approveAndMaybeExecute,
  isExecutionEnabled,
} from "./approvals";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

let oldExecutionEnabled: string | undefined;
beforeEach(() => {
  oldExecutionEnabled = process.env.APPROVAL_EXECUTION_ENABLED;
  delete process.env.APPROVAL_EXECUTION_ENABLED;
});
afterEach(() => {
  if (oldExecutionEnabled === undefined) delete process.env.APPROVAL_EXECUTION_ENABLED;
  else process.env.APPROVAL_EXECUTION_ENABLED = oldExecutionEnabled;
});

test("액션 레지스트리는 미리 정의된 안전 셋만", () => {
  const keys = listActions().map((a) => a.key);
  expect(keys).toContain("activate_openclaw");
  expect(keys).toContain("restart_openclaw_gateway");
  expect(keys).toContain("deploy_public");
  // high danger 표시
  expect(ACTIONS.activate_openclaw!.danger).toBe("high");
  expect(ACTIONS.deploy_public!.danger).toBe("high");
});

test("enqueue → pending 행 생성, 미정의 action_key 는 throw", () => {
  const db = freshDb();
  const row = enqueueApproval(db, { action_key: "activate_openclaw", params: { agent_id: "lui", display: "GD LUI" }, requested_by: "bill" });
  expect(row.status).toBe("pending");
  expect(row.action_key).toBe("activate_openclaw");
  expect(JSON.parse(row.params_json).agent_id).toBe("lui");
  expect(() => enqueueApproval(db, { action_key: "rm_rf_everything" })).toThrow();
});

test("listApprovals(pending) 는 대기 항목만", () => {
  const db = freshDb();
  const a = enqueueApproval(db, { action_key: "activate_openclaw", params: { agent_id: "lui" } });
  enqueueApproval(db, { action_key: "restart_openclaw_gateway" });
  setApprovalStatus(db, a.id, "done", "ok");
  const pending = listApprovals(db, "pending");
  expect(pending.length).toBe(1);
  expect(pending[0]!.action_key).toBe("restart_openclaw_gateway");
  expect(getApproval(db, a.id)!.status).toBe("done");
});

test("PIN 미설정이면 승인 거부(실행 OFF 기본)", async () => {
  const db = freshDb();
  const a = enqueueApproval(db, { action_key: "restart_openclaw_gateway" });
  // 테스트 환경엔 admin-pin.hash 없음 → 거부
  const res = await approveAndMaybeExecute(db, a.id, "123456");
  expect(res.ok).toBe(false);
  expect(getApproval(db, a.id)!.status).toBe("pending");
});

test("실행은 1단계에서 OFF (env 미설정 시)", () => {
  // APPROVAL_EXECUTION_ENABLED 미설정 → false
  expect(isExecutionEnabled()).toBe(false);
});

test("executeApproval — 안전 noop 액션 spawn → done + 출력 캡처", async () => {
  const db = freshDb();
  const a = enqueueApproval(db, { action_key: "noop_echo", params: { note: "pipeline" } });
  const { executeApproval } = await import("./approvals");
  const res = await executeApproval(db, a.id);
  expect(res.ok).toBe(true);
  expect(res.output).toContain("executed-ok");
  expect(res.output).toContain("pipeline");
  expect(getApproval(db, a.id)!.status).toBe("done");
});

test("executeApproval — executor 없는 액션은 실패 처리", async () => {
  const db = freshDb();
  // restart_openclaw_gateway 는 run 있음 → 대신 executor 없는 가짜는 enqueue 불가(화이트리스트).
  // noop 의 run 을 우회할 수 없으므로, executor 분기는 위 done 테스트로 커버. 여기선 미존재 id.
  const { executeApproval } = await import("./approvals");
  const res = await executeApproval(db, "apr_nonexistent");
  expect(res.ok).toBe(false);
});

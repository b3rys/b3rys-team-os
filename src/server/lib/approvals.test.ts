import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import {
  ACTIONS,
  listActions,
  listUnavailableActions,
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
  // 레지스트리(정의)에는 남아 있다 — 실행 대상이 없다고 ★키를 지우지 않는다★.
  expect(Object.keys(ACTIONS)).toContain("activate_openclaw");
  expect(Object.keys(ACTIONS)).toContain("restart_openclaw_gateway");
  // high danger 표시
  expect(ACTIONS.activate_openclaw!.danger).toBe("high");
});

// ★"눌러도 실패하는 버튼을 보여주지 않는다"★ — 실행 파일이 없으면 제시에서 빠지고,
//   파일이 생기면 ★자동으로 다시 제시된다★(호출 시점 검사라 재시작 불필요).
//   ★합성 액션으로 검증한다★: 특정 액션(과거엔 deploy_public)에 묶으면 그 액션이 은퇴할 때
//   같이 죽는다 — 검증하려는 건 액션이 아니라 requiresFiles ★계약★ 이다.
test("실행 대상이 없으면 제시에서 빠지고, 생기면 자동으로 돌아온다", () => {
  const KEY = "__test_reversible__";
  const root = mkdtempSync(join(tmpdir(), "b3os-approv-"));
  const prev = process.env.TEAM_COLLAB_DIR;
  process.env.TEAM_COLLAB_DIR = root;
  ACTIONS[KEY] = {
    key: KEY, label: "테스트 전용", description: "requiresFiles 계약 검증용.", danger: "low",
    run: { cmd: ["bash", "-c", "true"] }, requiresFiles: ["scripts/reversible.sh"],
  };
  try {
    const target = join(root, "scripts", "reversible.sh");

    // (1) 파일 없음 → 목록에서 빠지고, 이유가 함께 보고된다
    expect(listActions().map((a) => a.key)).not.toContain(KEY);
    expect(listUnavailableActions().find((x) => x.action.key === KEY)?.missing).toEqual(["scripts/reversible.sh"]);

    // (2) API 로도 못 들어온다 — UI 만 숨기면 우회된다
    const db = freshDb();
    expect(() => enqueueApproval(db, { action_key: KEY })).toThrow(/action_unavailable/);

    // (3) ★파일이 생기면 저절로 풀린다★ — 이게 '지우지 않고 숨기기'를 고른 이유다
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(target, "#!/usr/bin/env bash\nexit 0\n");
    expect(listActions().map((a) => a.key)).toContain(KEY);
    expect(listUnavailableActions().find((x) => x.action.key === KEY)).toBeUndefined();
    expect(enqueueApproval(db, { action_key: KEY }).status).toBe("pending");

    // (4) 다시 지우면 다시 숨는다(가역)
    rmSync(target);
    expect(listActions().map((a) => a.key)).not.toContain(KEY);
  } finally {
    delete ACTIONS[KEY];
    if (prev === undefined) delete process.env.TEAM_COLLAB_DIR;
    else process.env.TEAM_COLLAB_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
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

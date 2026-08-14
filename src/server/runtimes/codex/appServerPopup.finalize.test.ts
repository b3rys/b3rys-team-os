import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CodexApprovalCorrelationStore } from "./state";
import { finalizeApprovalDelivery } from "./appServerPopup";

// finalizeApprovalDelivery: 결정을 상관키 CAS로 마감(중복 결정·요청 불일치·orphan 거부) — Phase1 ③.
function setup() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE codex_approval_correlation (
    request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, server_request_id TEXT,
    thread_id TEXT, turn_id TEXT, item_id TEXT, operation_hash TEXT NOT NULL,
    process_instance TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','decided','delivered','expired','orphaned')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT)`);
  const store = new CodexApprovalCorrelationStore(db);
  const rec = (id = "r1", hash = "H", proc = "P") =>
    store.record({ requestId: id, agentId: "dex", operationHash: hash, processInstance: proc });
  return { db, store, rec };
}

describe("finalizeApprovalDelivery — CAS 배달 게이트", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  test("정상: record→approved(hash·proc 일치) → approved + delivered", () => {
    s.rec("r1", "H", "P");
    expect(finalizeApprovalDelivery(s.store, "r1", "H", "approved", "P")).toBe("approved");
    expect(s.store.get("r1")!.state).toBe("delivered");
  });

  test("★미기록 요청 → fail-closed denied★", () => {
    expect(finalizeApprovalDelivery(s.store, "ghost", "H", "approved", "P")).toBe("denied");
  });

  test("★중복 버튼: 두 번째 approved → denied(exactly-once)★", () => {
    s.rec("r1", "H", "P");
    expect(finalizeApprovalDelivery(s.store, "r1", "H", "approved", "P")).toBe("approved");
    expect(finalizeApprovalDelivery(s.store, "r1", "H", "approved", "P")).toBe("denied");
  });

  test("요청 지문 불일치(다른 요청의 결정) → denied", () => {
    s.rec("r1", "H", "P");
    expect(finalizeApprovalDelivery(s.store, "r1", "WRONG", "approved", "P")).toBe("denied");
    expect(s.store.get("r1")!.state).toBe("decided"); // decided까진 갔으나 delivered 거부
  });

  test("★재시작: process_instance 불일치 → denied★", () => {
    s.rec("r1", "H", "Pold");
    expect(finalizeApprovalDelivery(s.store, "r1", "H", "approved", "Pnew")).toBe("denied");
  });

  test("거절(denied): 그대로 denied + state expired(grant 없음)", () => {
    s.rec("r1", "H", "P");
    expect(finalizeApprovalDelivery(s.store, "r1", "H", "denied", "P")).toBe("denied");
    expect(s.store.get("r1")!.state).toBe("expired");
  });

  test("approved_for_session도 게이트 통과", () => {
    s.rec("r1", "H", "P");
    expect(finalizeApprovalDelivery(s.store, "r1", "H", "approved_for_session", "P")).toBe("approved_for_session");
    expect(s.store.get("r1")!.state).toBe("delivered");
  });
});

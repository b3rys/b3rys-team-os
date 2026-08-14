import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CodexApprovalCorrelationStore } from "./state";

// codex_approval_correlation 스토어 CAS/요청 불일치/orphan 실증(Phase1 ③).
function setup(): { db: Database; store: CodexApprovalCorrelationStore } {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE codex_approval_correlation (
    request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, server_request_id TEXT,
    thread_id TEXT, turn_id TEXT, item_id TEXT, operation_hash TEXT NOT NULL,
    process_instance TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','decided','delivered','expired','orphaned')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT)`);
  return { db, store: new CodexApprovalCorrelationStore(db) };
}
const base = (over: Partial<Parameters<CodexApprovalCorrelationStore["record"]>[0]> = {}) => ({
  requestId: "req1", agentId: "dex", operationHash: "hashAAA", processInstance: "proc1",
  threadId: "th1", turnId: "tn1", itemId: "it1", serverRequestId: "srv1", ...over,
});

describe("CodexApprovalCorrelationStore — CAS/요청대조/orphan", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  test("record → pending, 중복 request_id는 무시(exactly-once)", () => {
    s.store.record(base());
    s.store.record(base({ operationHash: "DIFFERENT" })); // 같은 request_id 재기록 시도
    const row = s.store.get("req1")!;
    expect(row.state).toBe("pending");
    expect(row.operation_hash).toBe("hashAAA"); // 최초 값 유지(IGNORE)
  });

  test("markDecided: pending→decided 정확히 1회(중복 버튼 차단)", () => {
    s.store.record(base());
    expect(s.store.markDecided("req1")).toBe(true);
    expect(s.store.markDecided("req1")).toBe(false); // 두 번째=false
    expect(s.store.get("req1")!.state).toBe("decided");
  });

  test("markDelivered: hash+proc 일치할 때만 성공(다른 요청의 결정 배달 거부 + 재시작 재결합 금지)", () => {
    s.store.record(base()); s.store.markDecided("req1");
    expect(s.store.markDelivered("req1", "WRONGHASH", "proc1")).toBe(false); // 요청 불일치 거부
    expect(s.store.get("req1")!.state).toBe("decided");
    expect(s.store.markDelivered("req1", "hashAAA", "proc2")).toBe(false);   // 다른 프로세스(재시작) 거부
    expect(s.store.markDelivered("req1", "hashAAA", "proc1")).toBe(true);    // 일치 → delivered
    expect(s.store.get("req1")!.state).toBe("delivered");
    expect(s.store.markDelivered("req1", "hashAAA", "proc1")).toBe(false);   // 재전달 차단
  });

  test("decided 아니면 delivered 불가(pending 직행 금지)", () => {
    s.store.record(base());
    expect(s.store.markDelivered("req1", "hashAAA", "proc1")).toBe(false);
  });

  test("expire: delivered 제외 임의 상태→expired", () => {
    s.store.record(base()); s.store.expire("req1");
    expect(s.store.get("req1")!.state).toBe("expired");
  });

  test("expireTurn: 그 turn의 pending/decided 전부 expire", () => {
    s.store.record(base({ requestId: "a" }));
    s.store.record(base({ requestId: "b" })); s.store.markDecided("b");
    s.store.record(base({ requestId: "c", turnId: "OTHER" }));
    const n = s.store.expireTurn("th1", "tn1");
    expect(n).toBe(2);
    expect(s.store.get("a")!.state).toBe("expired");
    expect(s.store.get("b")!.state).toBe("expired");
    expect(s.store.get("c")!.state).toBe("pending"); // 다른 turn은 유지
  });

  test("sweepOrphans: 다른 process_instance의 pending/decided→orphaned, 현재 proc은 유지", () => {
    s.store.record(base({ requestId: "old", processInstance: "procOLD" }));
    s.store.record(base({ requestId: "cur", processInstance: "procNEW" }));
    const n = s.store.sweepOrphans("procNEW");
    expect(n).toBe(1);
    expect(s.store.get("old")!.state).toBe("orphaned");
    expect(s.store.get("cur")!.state).toBe("pending");
  });
});

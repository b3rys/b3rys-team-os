import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { getPermissionRequest } from "../permissionGate";
import {
  closeUnpersistedAlways,
  createCogsApproval,
  endCogsSession,
  expireDueCogsApprovals,
  getBinding,
  handOffCogsApproval,
  hasCogsSessionGrant,
  invalidateCogsApprovals,
  pressCogsApproval,
  type PressInput,
} from "./approvals";
import { createCogsPermissionEvents, type CogsPermissionEvent } from "./events";

const T0 = 1_000_000;
const op = { runtime: "claude", agent_id: "flo", action: "run_command", command: "git push" };

function setup(over: Partial<Parameters<typeof createCogsApproval>[1]> = {}) {
  const db = new Database(":memory:");
  migrate(db);
  const { request } = createCogsApproval(db, {
    op, roomId: "42", policyStamp: "3:a", sessionId: "s1", processGen: "g1", ttlMs: 300_000, nowMs: T0, alwaysRule: "Bash(git push:*)", ...over,
  });
  return { db, id: request.id };
}

const press = (id: string, over: Partial<PressInput> = {}): PressInput => ({
  requestId: id, action: "pg1", actorUserId: 7, ownerUserId: 7, roomId: 42, bridgeAgentId: "flo", currentStamp: "3:a", nowMs: T0 + 1000, ...over,
});

describe("pending + 누름", () => {
  test("주인이 누르면 결정, 같은 카드 두 번째는 처리됨", () => {
    const { db, id } = setup();
    expect(pressCogsApproval(db, press(id))).toEqual({ kind: "decided", status: "allowed_once", decision: "allow_once" });
    expect(pressCogsApproval(db, press(id, { action: "pgd" }))).toEqual({ kind: "processed", status: "allowed_once" });
  });
  test("거절", () => {
    const { db, id } = setup();
    expect(pressCogsApproval(db, press(id, { action: "pgd" }))).toMatchObject({ kind: "decided", status: "denied" });
  });
  const forbidden: Array<[string, Partial<PressInput>]> = [
    ["주인 아님", { actorUserId: 8 }],
    ["주인 정보 없음(옛 cogs 서버)", { ownerUserId: undefined }],
    ["누른 사람 없음", { actorUserId: undefined }],
    ["방이 다름", { roomId: 43 }],
    ["방 정보 없음", { roomId: undefined }],
    ["다른 팀원 브리지", { bridgeAgentId: "mille" }],
  ];
  for (const [name, over] of forbidden) {
    test(`인가 실패: ${name} → 상태 그대로`, () => {
      const { db, id } = setup();
      expect(pressCogsApproval(db, press(id, over))).toEqual({ kind: "forbidden" });
      expect(getPermissionRequest(db, id)!.status).toBe("pending");
    });
  }
  test("만료 뒤 누름 → expired(timeout)", () => {
    const { db, id } = setup();
    expect(pressCogsApproval(db, press(id, { nowMs: T0 + 300_000 }))).toEqual({ kind: "expired" });
    expect(getPermissionRequest(db, id)!.status).toBe("expired");
    expect(getBinding(db, id)!.invalidation_reason).toBe("timeout");
  });
  test("정책 도장이 바뀐 뒤 누름(revision 이든 내용이든) → expired(policy_changed)", () => {
    const { db, id } = setup();
    expect(pressCogsApproval(db, press(id, { currentStamp: "4:a" }))).toEqual({ kind: "expired" });
    expect(getBinding(db, id)!.invalidation_reason).toBe("policy_changed");
  });
  test("정책이 깨졌거나 없으면(null) 결정 못 함", () => {
    const { db, id } = setup();
    expect(pressCogsApproval(db, press(id, { currentStamp: null }))).toEqual({ kind: "expired" });
  });
  test("없는 요청 → expired", () => {
    const { db } = setup();
    expect(pressCogsApproval(db, press("prm_000000000000000000"))).toEqual({ kind: "expired" });
  });
});

describe("항상 허용", () => {
  test("원본 저장이 성공해야 승인, 그 요청만 새 revision 에 묶인다", () => {
    const { db, id } = setup();
    const saved: string[] = [];
    const r = pressCogsApproval(db, press(id, { action: "pga", persistAlways: (rule) => { saved.push(rule); return { ok: true, stamp: "4:a" }; } }));
    expect(r).toMatchObject({ kind: "decided", status: "allowed_always" });
    expect(saved).toEqual(["Bash(git push:*)"]);
    expect(getBinding(db, id)!.policy_stamp).toBe("4:a");
    // 전역 24시간 grant 는 만들지 않는다
    expect(db.prepare("SELECT COUNT(*) AS n FROM permission_grant").get()).toEqual({ n: 0 });
  });
  test("원본 저장 실패 → 그 요청을 닫는다(실행되지 않음)", () => {
    const { db, id } = setup();
    expect(pressCogsApproval(db, press(id, { action: "pga", persistAlways: () => ({ ok: false }) }))).toEqual({ kind: "failed" });
    expect(getPermissionRequest(db, id)!.status).toBe("expired");
    expect(getBinding(db, id)!.invalidation_reason).toBe("always_persist_failed");
  });
  test("결정 경쟁에서 지면(세션 종료가 먼저) 원본에 규칙을 0번 쓴다", () => {
    const { db, id } = setup();
    let writes = 0;
    // 검사는 통과한 뒤, 결정(CAS) 직전에 세션 종료가 끼어든 순서를 만든다
    const real = db.transaction.bind(db);
    let injected = false;
    (db as any).transaction = (fn: any) => {
      if (!injected) { injected = true; endCogsSession(db, "flo", "s1"); }
      return real(fn);
    };
    const r = pressCogsApproval(db, press(id, { action: "pga", persistAlways: () => { writes++; return { ok: true, stamp: "4:a" }; } }));
    (db as any).transaction = real;
    expect(r).toEqual({ kind: "processed", status: "expired" });
    expect(writes).toBe(0);
  });
  test("결정은 됐는데 규칙 저장 전에 멈춤 → 실행에 넘기지 않고, 재시작 정리가 닫는다", () => {
    const { db, id } = setup();
    expect(() => pressCogsApproval(db, press(id, { action: "pga", persistAlways: () => { throw new Error("crash"); } }))).toThrow("crash");
    expect(getPermissionRequest(db, id)!.status).toBe("allowed_always");
    expect(handOffCogsApproval(db, { requestId: id, agentId: "flo", sessionId: "s1", processGen: "g1", currentStamp: "3:a", nowMs: T0 + 2000 })).toBe(false);
    expect(closeUnpersistedAlways(db)).toBe(1);
    expect(getBinding(db, id)!.invalidation_reason).toBe("always_persist_failed");
  });
  test("지속 규칙이 없는 요청은 '항상' 을 받지 않는다", () => {
    const { db, id } = setup({ alwaysRule: null });
    expect(pressCogsApproval(db, press(id, { action: "pga", persistAlways: () => ({ ok: true, stamp: "4:a" }) }))).toEqual({ kind: "failed" });
  });
});

describe("세션 허용", () => {
  test("같은 세션·세대·범위·revision 에서만 유효", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id, { action: "pgs" }));
    const q = { agentId: "flo", sessionId: "s1", processGen: "g1", op, currentStamp: "3:a" };
    expect(hasCogsSessionGrant(db, q)).toBe(true);
    expect(hasCogsSessionGrant(db, { ...q, sessionId: "s2" })).toBe(false);
    expect(hasCogsSessionGrant(db, { ...q, processGen: "g2" })).toBe(false);
    expect(hasCogsSessionGrant(db, { ...q, currentStamp: "4:a" })).toBe(false);
    expect(hasCogsSessionGrant(db, { ...q, op: { ...op, command: "rm x" } })).toBe(false);
  });
  test("세션이 끝나면 폐기", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id, { action: "pgs" }));
    endCogsSession(db, "flo", "s1");
    expect(hasCogsSessionGrant(db, { agentId: "flo", sessionId: "s1", processGen: "g1", op, currentStamp: "3:a" })).toBe(false);
  });
  test("넓히기만 한 정책 변경 → 새 revision 으로 옮겨 계속 유효, 축소 → 폐기", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id, { action: "pgs" }));
    invalidateCogsApprovals(db, { agentId: "flo", reason: "policy_changed", newStamp: "4:a", oldStamp: "3:a" });
    const q = { agentId: "flo", sessionId: "s1", processGen: "g1", op };
    expect(hasCogsSessionGrant(db, { ...q, currentStamp: "4:a" })).toBe(true);
    invalidateCogsApprovals(db, { agentId: "flo", reason: "policy_narrowed", newStamp: "5:a" });
    expect(hasCogsSessionGrant(db, { ...q, currentStamp: "5:a" })).toBe(false);
  });
  test("넓히기여도 바로 직전 revision 이 아닌(더 오래된) 세션 허용은 옮기지 않고 폐기", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id, { action: "pgs" })); // revision 3 에 묶임
    invalidateCogsApprovals(db, { agentId: "flo", reason: "policy_changed", newStamp: "5:a", oldStamp: "4:a" });
    const q = { agentId: "flo", sessionId: "s1", processGen: "g1", op };
    expect(hasCogsSessionGrant(db, { ...q, currentStamp: "5:a" })).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cogs_permission_session_grant").get()).toEqual({ n: 0 });
  });
});

describe("무효화 × 상태", () => {
  test("pending → expired(policy_narrowed), 이벤트 한 번", () => {
    const { db, id } = setup();
    const ev = createCogsPermissionEvents();
    const got: CogsPermissionEvent[] = [];
    ev.on((e) => { got.push(e); });
    expect(invalidateCogsApprovals(db, { agentId: "flo", reason: "policy_narrowed", events: ev })).toBe(1);
    expect(getPermissionRequest(db, id)!.status).toBe("expired");
    expect(got).toEqual([{ type: "approval_invalidated", request_id: id, agent_id: "flo", room_id: "42", card_message_id: null, reason: "policy_narrowed" }]);
  });
  test("허용됐지만 인계 전 → 실행권 무효", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id));
    invalidateCogsApprovals(db, { agentId: "flo", reason: "policy_narrowed" });
    expect(getPermissionRequest(db, id)!.status).toBe("expired");
    expect(handOffCogsApproval(db, { requestId: id, agentId: "flo", sessionId: "s1", processGen: "g1", currentStamp: "3:a", nowMs: T0 + 2000 })).toBe(false);
  });
  test("인계 뒤 → 결정 이력 유지", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id));
    expect(handOffCogsApproval(db, { requestId: id, agentId: "flo", sessionId: "s1", processGen: "g1", currentStamp: "3:a", nowMs: T0 + 2000 })).toBe(true);
    expect(invalidateCogsApprovals(db, { agentId: "flo", reason: "policy_narrowed" })).toBe(0);
    expect(getPermissionRequest(db, id)!.status).toBe("allowed_once");
  });
  test("denied·expired 는 어떤 사건에도 그대로", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id, { action: "pgd" }));
    expect(invalidateCogsApprovals(db, { agentId: "flo", reason: "policy_narrowed" })).toBe(0);
    expect(expireDueCogsApprovals(db, T0 + 10_000_000)).toBe(0);
    expect(getPermissionRequest(db, id)!.status).toBe("denied");
  });
  test("다른 팀원·다른 세션은 건드리지 않는다", () => {
    const { db, id } = setup();
    const other = createCogsApproval(db, { op: { ...op, agent_id: "mille" }, roomId: "43", policyStamp: "1:a", sessionId: "s9", processGen: "g1", ttlMs: 300_000, nowMs: T0 });
    endCogsSession(db, "flo", "s-other");
    expect(getPermissionRequest(db, id)!.status).toBe("pending");
    invalidateCogsApprovals(db, { agentId: "flo", reason: "policy_narrowed" });
    expect(getPermissionRequest(db, other.request.id)!.status).toBe("pending");
  });
  test("만료 시각이 지난 것만 만료", () => {
    const { db, id } = setup();
    expect(expireDueCogsApprovals(db, T0 + 299_999)).toBe(0);
    expect(expireDueCogsApprovals(db, T0 + 300_000)).toBe(1);
    expect(getBinding(db, id)!.invalidation_reason).toBe("timeout");
  });
});

describe("실행 인계 — 딱 한 번, 직전에 다시 본다", () => {
  const ho = (id: string, over: Partial<Parameters<typeof handOffCogsApproval>[1]> = {}) =>
    ({ requestId: id, agentId: "flo", sessionId: "s1", processGen: "g1", currentStamp: "3:a", nowMs: T0 + 2000, ...over });
  test("읽은 뒤 쓰기 전에 다른 인계가 끼어들어도 한 번만 넘긴다", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id));
    let inner: boolean | undefined;
    const outer = handOffCogsApproval(db, ho(id, { beforeClaim: () => { inner = handOffCogsApproval(db, ho(id)); } }));
    expect([outer, inner].filter(Boolean)).toHaveLength(1);
  });
  test("두 번째 인계는 false", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id));
    expect(handOffCogsApproval(db, ho(id))).toBe(true);
    expect(handOffCogsApproval(db, ho(id))).toBe(false);
  });
  test("pending·거절은 인계 안 됨", () => {
    const { db, id } = setup();
    expect(handOffCogsApproval(db, ho(id))).toBe(false);
  });
  test("결정 직후 정책 축소(revision 바뀜) → 인계 안 됨", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id));
    expect(handOffCogsApproval(db, ho(id, { currentStamp: "4:a" }))).toBe(false);
    expect(getPermissionRequest(db, id)!.status).toBe("expired");
  });
  test("다른 세션·프로세스 세대 → 인계 안 됨", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id));
    expect(handOffCogsApproval(db, ho(id, { sessionId: "s2" }))).toBe(false);
    expect(handOffCogsApproval(db, ho(id, { processGen: "g2" }))).toBe(false);
  });
  test("허용 뒤 만료 시각이 지나면 인계 안 됨", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id));
    expect(handOffCogsApproval(db, ho(id, { nowMs: T0 + 300_000 }))).toBe(false);
  });
});

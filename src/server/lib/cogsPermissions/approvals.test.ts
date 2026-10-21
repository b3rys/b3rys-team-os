import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { getPermissionRequest } from "../permissionGate";
import {
  createCogsApproval,
  endCogsSession,
  expireDueCogsApprovals,
  getBinding,
  handOffCogsApproval,
  hasCogsSessionGrant,
  invalidateCogsApprovals,
  pressCogsApproval,
  waitForCogsDecision,
  type PressInput,
} from "./approvals";
import { createCogsPermissionEvents, type CogsPermissionEvent } from "./events";

const T0 = 1_000_000;
const op = { runtime: "claude", agent_id: "flo", action: "run_command", command: "git push" };

function setup(over: Partial<Parameters<typeof createCogsApproval>[1]> = {}) {
  const db = new Database(":memory:");
  migrate(db);
  const { request } = createCogsApproval(db, {
    op, roomId: "42", policyRevision: 3, sessionId: "s1", processGen: "g1", ttlMs: 300_000, nowMs: T0, alwaysRule: "Bash(git push:*)", ...over,
  });
  return { db, id: request.id };
}

const press = (id: string, over: Partial<PressInput> = {}): PressInput => ({
  requestId: id, action: "pg1", actorUserId: 7, ownerUserId: 7, roomId: 42, bridgeAgentId: "flo", currentRevision: 3, nowMs: T0 + 1000, ...over,
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
  test("정책 revision 이 바뀐 뒤 누름 → expired(policy_changed)", () => {
    const { db, id } = setup();
    expect(pressCogsApproval(db, press(id, { currentRevision: 4 }))).toEqual({ kind: "expired" });
    expect(getBinding(db, id)!.invalidation_reason).toBe("policy_changed");
  });
  test("정책이 깨졌거나 없으면(null) 결정 못 함", () => {
    const { db, id } = setup();
    expect(pressCogsApproval(db, press(id, { currentRevision: null }))).toEqual({ kind: "expired" });
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
    const r = pressCogsApproval(db, press(id, { action: "pga", persistAlways: (rule) => { saved.push(rule); return { ok: true, revision: 4 }; } }));
    expect(r).toMatchObject({ kind: "decided", status: "allowed_always" });
    expect(saved).toEqual(["Bash(git push:*)"]);
    expect(getBinding(db, id)!.policy_revision).toBe(4);
    // 전역 24시간 grant 는 만들지 않는다
    expect(db.prepare("SELECT COUNT(*) AS n FROM permission_grant").get()).toEqual({ n: 0 });
  });
  test("원본 저장 실패 → 승인 안 됨, pending 그대로", () => {
    const { db, id } = setup();
    expect(pressCogsApproval(db, press(id, { action: "pga", persistAlways: () => ({ ok: false }) }))).toEqual({ kind: "failed" });
    expect(getPermissionRequest(db, id)!.status).toBe("pending");
  });
  test("지속 규칙이 없는 요청은 '항상' 을 받지 않는다", () => {
    const { db, id } = setup({ alwaysRule: null });
    expect(pressCogsApproval(db, press(id, { action: "pga", persistAlways: () => ({ ok: true, revision: 4 }) }))).toEqual({ kind: "failed" });
  });
});

describe("세션 허용", () => {
  test("같은 세션·세대·범위·revision 에서만 유효", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id, { action: "pgs" }));
    const q = { agentId: "flo", sessionId: "s1", processGen: "g1", op, currentRevision: 3 };
    expect(hasCogsSessionGrant(db, q)).toBe(true);
    expect(hasCogsSessionGrant(db, { ...q, sessionId: "s2" })).toBe(false);
    expect(hasCogsSessionGrant(db, { ...q, processGen: "g2" })).toBe(false);
    expect(hasCogsSessionGrant(db, { ...q, currentRevision: 4 })).toBe(false);
    expect(hasCogsSessionGrant(db, { ...q, op: { ...op, command: "rm x" } })).toBe(false);
  });
  test("세션이 끝나면 폐기", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id, { action: "pgs" }));
    endCogsSession(db, "flo", "s1");
    expect(hasCogsSessionGrant(db, { agentId: "flo", sessionId: "s1", processGen: "g1", op, currentRevision: 3 })).toBe(false);
  });
  test("넓히기만 한 정책 변경 → 새 revision 으로 옮겨 계속 유효, 축소 → 폐기", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id, { action: "pgs" }));
    invalidateCogsApprovals(db, { agentId: "flo", reason: "policy_changed", newRevision: 4 });
    const q = { agentId: "flo", sessionId: "s1", processGen: "g1", op };
    expect(hasCogsSessionGrant(db, { ...q, currentRevision: 4 })).toBe(true);
    invalidateCogsApprovals(db, { agentId: "flo", reason: "policy_narrowed", newRevision: 5 });
    expect(hasCogsSessionGrant(db, { ...q, currentRevision: 5 })).toBe(false);
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
    expect(handOffCogsApproval(db, { requestId: id, agentId: "flo", sessionId: "s1", processGen: "g1", currentRevision: 3, nowMs: T0 + 2000 })).toBe(false);
  });
  test("인계 뒤 → 결정 이력 유지", () => {
    const { db, id } = setup();
    pressCogsApproval(db, press(id));
    expect(handOffCogsApproval(db, { requestId: id, agentId: "flo", sessionId: "s1", processGen: "g1", currentRevision: 3, nowMs: T0 + 2000 })).toBe(true);
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
    const other = createCogsApproval(db, { op: { ...op, agent_id: "mille" }, roomId: "43", policyRevision: 1, sessionId: "s9", processGen: "g1", ttlMs: 300_000, nowMs: T0 });
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
    ({ requestId: id, agentId: "flo", sessionId: "s1", processGen: "g1", currentRevision: 3, nowMs: T0 + 2000, ...over });
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
    expect(handOffCogsApproval(db, ho(id, { currentRevision: 4 }))).toBe(false);
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

describe("결정 기다리기 — 이벤트로 깨고 만료 타이머로 끝", () => {
  test("같은 프로세스의 결정 이벤트로 바로 끝난다", async () => {
    const { db, id } = setup();
    const ev = createCogsPermissionEvents();
    const p = waitForCogsDecision(db, id, ev, { nowMs: () => T0, setTimer: () => 0, clearTimer: () => {} });
    pressCogsApproval(db, press(id, { events: ev }));
    expect(await p).toBe("allowed_once");
  });
  test("아무도 안 누르면 만료 타이머가 expired 로 끝낸다", async () => {
    const { db, id } = setup();
    const ev = createCogsPermissionEvents();
    let fire: () => void = () => {};
    let delay = -1;
    const p = waitForCogsDecision(db, id, ev, { nowMs: () => T0 + 300_000, setTimer: (fn, ms) => { fire = fn; delay = ms; return 1; }, clearTimer: () => {} });
    expect(delay).toBe(0);
    fire();
    expect(await p).toBe("expired");
  });
  test("다른 프로세스가 결정했으면(이벤트 없음) 타이머 때 DB 로 안다", async () => {
    const { db, id } = setup();
    const ev = createCogsPermissionEvents();
    let fire: () => void = () => {};
    const p = waitForCogsDecision(db, id, ev, { nowMs: () => T0, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
    pressCogsApproval(db, press(id, { action: "pgd" })); // events 없이 = 다른 프로세스
    fire();
    expect(await p).toBe("denied");
  });
});

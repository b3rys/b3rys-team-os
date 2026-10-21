/**
 * cogs 정책 코덱스 승인: 요청 → 카드 → 누름 → 인계 → 응답. 실제 DB·실제 대기·실제 판정, 카드 전송만 가짜.
 * 판정 기준은 "허용 응답 횟수" — 같은 요청에 허용이 두 번 나가면 안 된다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/migrate";
import { getPermissionRequest } from "../../lib/permissionGate";
import { getBinding, pressCogsApproval, type CardAction } from "../../lib/cogsPermissions/approvals";
import { createCogsDecisionWaiters } from "../../lib/cogsPermissions/waiters";
import type { ApprovalCardInput } from "../../lib/cogsPermissions/card";
import { createCogsCodexApprover } from "./cogsApprover";
import type { ApprovalRequest } from "./appServerClient";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const cmd = (command: string, threadId = "th1"): ApprovalRequest => ({
  method: "item/commandExecution/requestApproval", params: { command, threadId, turnId: "t1", itemId: "i1" }, serverRequestId: "7",
});

function setup(o: { stamp?: string | null; room?: string | null; cardOk?: boolean; ttlMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cogs-appr-"));
  dirs.push(dir);
  const dbPath = join(dir, "team.db");
  const db = openDb(dbPath);
  migrate(db);
  let stamp: string | null = o.stamp === undefined ? "1:aaaa" : o.stamp;
  const cards: ApprovalCardInput[] = [];
  const onCard: Array<(i: ApprovalCardInput) => void> = [];
  const waiters = createCogsDecisionWaiters({ agentId: "flo", openDb: () => openDb(dbPath), expirySlackMs: 5, report: () => {} });
  const approver = createCogsCodexApprover({
    agentId: "flo", roomId: o.room === undefined ? "42" : o.room, processGen: "g1", cwd: "/w",
    openDb: () => openDb(dbPath), currentStamp: () => stamp, waiters, ttlMs: o.ttlMs ?? 30_000, log: () => {},
    sendCard: async (input) => {
      cards.push(input);
      if (o.cardOk === false) return { ok: false };
      queueMicrotask(() => { for (const f of onCard.splice(0)) f(input); });
      return { ok: true, messageId: 900 + cards.length };
    },
  });
  /** 카드가 뜨면 주인이 누른다(브리지 카드 누름 경로와 같은 판정 + 대기 깨우기). */
  const pressOnCard = (action: CardAction, actor = 7) => onCard.push((input) => {
    pressCogsApproval(db, { requestId: input.requestId, action, actorUserId: actor, ownerUserId: 7, roomId: "42", bridgeAgentId: "flo", currentStamp: stamp, nowMs: Date.now() });
    waiters.poke(input.requestId);
  });
  return { db, cards, approver, waiters, pressOnCard, setStamp: (s: string | null) => { stamp = s; } };
}

describe("거절 쪽으로 닫히는 경우", () => {
  test("권한 묶음 요청은 카드 없이 거절(묶음 전체를 무검증으로 주지 않는다)", async () => {
    const s = setup();
    expect(await s.approver.approve({ method: "item/permissions/requestApproval", params: { permissions: { network: true } } })).toBe("denied");
    expect(s.cards).toEqual([]);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM permission_request").get()).toEqual({ n: 0 });
  });
  test("정책 도장을 못 읽으면 거절", async () => {
    const s = setup({ stamp: null });
    expect(await s.approver.approve(cmd("ls"))).toBe("denied");
    expect(s.approver.lastOutcome()).toBe("denied_no_policy");
  });
  test("카드 띄울 방이 없으면 거절", async () => {
    const s = setup({ room: null });
    expect(await s.approver.approve(cmd("ls"))).toBe("denied");
    expect(s.cards).toEqual([]);
  });
  test("카드 전송 실패 = 거절, 대기도 남지 않는다", async () => {
    const s = setup({ cardOk: false });
    expect(await s.approver.approve(cmd("ls"))).toBe("denied");
    expect(s.approver.lastOutcome()).toBe("card_failed");
    expect(s.waiters.size()).toBe(0);
  });
  test("아무도 안 누르면 만료로 거절", async () => {
    const s = setup({ ttlMs: 60 });
    expect(await s.approver.approve(cmd("ls"))).toBe("denied");
    expect(getPermissionRequest(s.db, s.cards[0]!.requestId)!.status).toBe("expired");
  });
  test("주인이 아닌 사람이 눌러도 결정되지 않는다(만료까지 대기 → 거절)", async () => {
    const s = setup({ ttlMs: 80 });
    s.pressOnCard("pg1", 99);
    expect(await s.approver.approve(cmd("ls"))).toBe("denied");
  });
  test("거절을 누르면 거절", async () => {
    const s = setup();
    s.pressOnCard("pgd");
    expect(await s.approver.approve(cmd("ls"))).toBe("denied");
  });
});

describe("허용", () => {
  test("이번만 → 허용 한 번, 인계 기록, '항상' 버튼 없음", async () => {
    const s = setup();
    s.pressOnCard("pg1");
    expect(await s.approver.approve(cmd("ls"))).toBe("approved");
    const id = s.cards[0]!.requestId;
    expect(getBinding(s.db, id)!.handed_off_at_ms).not.toBeNull();
    expect(s.cards[0]!.allowAlways).toBe(false);
    expect(s.cards[0]!.operationCode).toBe("run_command");
  });

  test("누른 뒤 인계 전에 정책이 바뀌면 실행하지 않는다", async () => {
    const s = setup();
    s.pressOnCard("pg1");
    // 누름과 인계 사이에 도장이 바뀐다.
    s.waiters.poke = ((orig) => (id?: string) => { s.setStamp("2:bbbb"); orig(id); })(s.waiters.poke);
    expect(await s.approver.approve(cmd("ls"))).toBe("denied");
    expect(s.approver.lastOutcome()).toBe("handoff_lost");
    expect(getBinding(s.db, s.cards[0]!.requestId)!.invalidation_reason).toBe("policy_changed");
  });

  test("세션 허용 → 같은 대화·같은 일은 카드 없이 허용, 다른 대화는 다시 묻는다", async () => {
    const s = setup();
    s.pressOnCard("pgs");
    expect(await s.approver.approve(cmd("ls"))).toBe("approved");
    expect(await s.approver.approve(cmd("ls"))).toBe("approved");
    expect(s.approver.lastOutcome()).toBe("session_grant");
    expect(s.cards.length).toBe(1);
    s.pressOnCard("pgd");
    expect(await s.approver.approve(cmd("ls", "th2"))).toBe("denied");
    expect(s.cards.length).toBe(2);
  });

  test("세션 허용도 정책이 바뀌면 다시 묻는다", async () => {
    const s = setup();
    s.pressOnCard("pgs");
    await s.approver.approve(cmd("ls"));
    s.setStamp("2:bbbb");
    s.pressOnCard("pgd");
    expect(await s.approver.approve(cmd("ls"))).toBe("denied");
    expect(s.cards.length).toBe(2);
  });

  test("위험 표시가 있는 일은 세션 허용이 있어도 매번 묻는다", async () => {
    const s = setup();
    s.pressOnCard("pgs");
    expect(await s.approver.approve(cmd("sudo rm -rf /tmp/x"))).toBe("approved");
    s.pressOnCard("pgd");
    expect(await s.approver.approve(cmd("sudo rm -rf /tmp/x"))).toBe("denied");
    expect(s.cards.length).toBe(2);
    expect(s.cards[0]!.risks.length).toBeGreaterThan(0);
  });

  test("같은 카드를 두 번 눌러도 허용 응답은 한 번", async () => {
    const s = setup();
    s.pressOnCard("pg1");
    s.pressOnCard("pg1");
    const results = await Promise.all([s.approver.approve(cmd("ls"))]);
    expect(results.filter((r) => r === "approved").length).toBe(1);
    const id = s.cards[0]!.requestId;
    // 이미 인계한 요청을 다시 넘기려 해도 실패한다.
    const { handOffCogsApproval } = await import("../../lib/cogsPermissions/approvals");
    expect(handOffCogsApproval(s.db, { requestId: id, agentId: "flo", sessionId: "th1", processGen: "g1", currentStamp: "1:aaaa", nowMs: Date.now() })).toBe(false);
  });
});

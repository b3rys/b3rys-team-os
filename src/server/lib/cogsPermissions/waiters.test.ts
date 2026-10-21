import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/migrate";
import { getPermissionRequest } from "../permissionGate";
import { createCogsApproval, getBinding, invalidateCogsApprovals, pressCogsApproval } from "./approvals";
import { closeStaleGenerationApprovals, createBridgeCogsApprovals, createCogsDecisionWaiters } from "./waiters";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const STAMP = "1:aaaa";

function setup(opts: { ttlMs?: number; gen?: string; agent?: string; alwaysRule?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cogs-wait-"));
  dirs.push(dir);
  const dbPath = join(dir, "team.db");
  const db = openDb(dbPath);
  migrate(db);
  const make = (o: { gen?: string; agent?: string; session?: string } = {}) => createCogsApproval(db, {
    op: { runtime: "codex", agent_id: o.agent ?? opts.agent ?? "flo", action: "run_command", command: "git push" },
    roomId: "42", policyStamp: STAMP, sessionId: o.session ?? "s", processGen: o.gen ?? opts.gen ?? "g1",
    ttlMs: opts.ttlMs ?? 60_000, nowMs: Date.now(), alwaysRule: opts.alwaysRule ?? null,
  }).request.id;
  const press = (id: string, action: "pg1" | "pgd" | "pga" | "pgs", persistAlways?: () => { ok: true; stamp: string } | { ok: false }) => pressCogsApproval(db, {
    requestId: id, action, actorUserId: 7, ownerUserId: 7, roomId: "42", bridgeAgentId: "flo", currentStamp: STAMP, nowMs: Date.now(),
    ...(persistAlways ? { persistAlways } : {}),
  });
  const waiters = createCogsDecisionWaiters({ agentId: "flo", openDb: () => openDb(dbPath), expirySlackMs: 5, report: () => {} });
  return { db, dbPath, make, press, waiters };
}

describe("승인 대기 — DB 가 진실, 신호는 다시 보는 계기", () => {
  test("대기 등록 전에 이미 결정됐으면 등록 즉시 끝난다", async () => {
    const s = setup();
    const id = s.make();
    s.press(id, "pg1");
    expect(await s.waiters.wait(id)).toEqual({ kind: "allowed", status: "allowed_once" });
    expect(s.waiters.size()).toBe(0);
  });

  test("기다리는 중 결정 → poke 로 끝난다", async () => {
    const s = setup();
    const id = s.make();
    const p = s.waiters.wait(id);
    expect(s.waiters.size()).toBe(1);
    s.press(id, "pgd");
    s.waiters.poke(id);
    expect(await p).toEqual({ kind: "denied" });
  });

  test("신호가 끝내 안 와도 만료 시각에 DB 를 보고 닫는다(타이머)", async () => {
    const s = setup({ ttlMs: 60 });
    const id = s.make();
    const out = await s.waiters.wait(id);
    expect(out).toEqual({ kind: "closed", reason: "timeout" });
    expect(getPermissionRequest(s.db, id)!.status).toBe("expired");
  });

  test("신호를 잃으면 만료 시각에 닫힌다 — 늦게 안 허용을 실행하지 않는다(닫힌 쪽)", async () => {
    const s = setup({ ttlMs: 80 });
    const id = s.make();
    const p = s.waiters.wait(id);
    s.press(id, "pg1"); // poke 없음 = 신호 유실
    expect(await p).toEqual({ kind: "closed", reason: "timeout" });
    expect(getPermissionRequest(s.db, id)!.status).toBe("expired");
  });

  test("중복·역순 poke 는 결과를 바꾸지 않는다", async () => {
    const s = setup();
    const id = s.make();
    const p = s.waiters.wait(id);
    s.waiters.poke(id); s.waiters.poke(); // 결정 전 신호(역순)
    s.press(id, "pgd");
    s.waiters.poke(id); s.waiters.poke(id);
    expect(await p).toEqual({ kind: "denied" });
  });

  test("무효화(정책 축소)는 닫힘 + 사유", async () => {
    const s = setup();
    const id = s.make();
    const p = s.waiters.wait(id);
    invalidateCogsApprovals(s.db, { agentId: "flo", reason: "policy_narrowed" });
    s.waiters.poke();
    expect(await p).toEqual({ kind: "closed", reason: "policy_narrowed" });
  });

  test("'항상' 은 원본 저장 전이면 허용으로 끝내지 않는다", async () => {
    const s = setup({ ttlMs: 120, alwaysRule: "Bash(git push:*)" });
    const id = s.make();
    // 결정만 이기고 저장 전에 멈춘 상태를 만든다.
    s.db.prepare("UPDATE permission_request SET status='allowed_always' WHERE id=?").run(id);
    const p = s.waiters.wait(id);
    s.waiters.poke(id);
    expect(s.waiters.size()).toBe(1);
    // 저장이 끝나면 허용.
    s.db.prepare("UPDATE cogs_permission_binding SET always_persisted=1 WHERE request_id=?").run(id);
    s.waiters.poke(id);
    expect(await p).toEqual({ kind: "allowed", status: "allowed_always" });
  });

  test("다른 팀원 요청은 기다리지 않는다", async () => {
    const s = setup();
    const id = s.make({ agent: "mille" });
    expect(await s.waiters.wait(id)).toEqual({ kind: "closed", reason: "unknown_request" });
  });

  test("같은 요청을 두 번 기다리면 두 번째는 바로 닫힌다(인계 두 번 방지)", async () => {
    const s = setup();
    const id = s.make();
    const first = s.waiters.wait(id);
    expect(await s.waiters.wait(id)).toEqual({ kind: "closed", reason: "duplicate_wait" });
    s.press(id, "pg1"); s.waiters.poke(id);
    expect(await first).toEqual({ kind: "allowed", status: "allowed_once" });
  });

  test("DB 읽기 실패는 허용이 아니다 — 계속 기다리고 닫을 때 닫힘", async () => {
    let fail = true;
    const s = setup();
    const id = s.make();
    const w = createCogsDecisionWaiters({ agentId: "flo", openDb: () => { if (fail) throw new Error("locked"); return openDb(s.dbPath); }, report: () => {} });
    const p = w.wait(id);
    s.press(id, "pg1");
    w.poke(id);
    expect(w.size()).toBe(1);
    w.close("bridge_closed");
    expect(await p).toEqual({ kind: "closed", reason: "bridge_closed" });
    fail = false;
  });
});

describe("브리지 재시작 — 예전 세대 정리", () => {
  test("예전 세대의 대기·허용 미인계와 세션 허용은 닫고, 지금 세대는 남긴다", () => {
    const s = setup();
    const oldId = s.make({ gen: "g0", session: "s0" });
    const oldAllowed = s.make({ gen: "g0", session: "s0" });
    s.press(oldAllowed, "pg1");
    const sess = s.make({ gen: "g0", session: "s0" });
    s.press(sess, "pgs");
    const cur = s.make({ gen: "g1", session: "s0" }); // 같은 세션 id 라도 세대가 다르면 별개
    const otherAgent = s.make({ gen: "g0", agent: "mille" });
    expect(closeStaleGenerationApprovals(s.db, "flo", "g1")).toBe(3);
    expect(getBinding(s.db, oldId)!.invalidation_reason).toBe("bridge_restart");
    expect(getBinding(s.db, oldAllowed)!.invalidation_reason).toBe("bridge_restart");
    expect(getBinding(s.db, sess)!.invalidation_reason).toBe("bridge_restart");
    expect(getPermissionRequest(s.db, cur)!.status).toBe("pending");
    expect(getPermissionRequest(s.db, otherAgent)!.status).toBe("pending");
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM cogs_permission_session_grant WHERE agent_id='flo'").get()).toEqual({ n: 0 });
  });

  test("이미 인계한 것은 건드리지 않는다", () => {
    const s = setup();
    const id = s.make({ gen: "g0" });
    s.press(id, "pg1");
    s.db.prepare("UPDATE cogs_permission_binding SET handed_off_at_ms=1 WHERE request_id=?").run(id);
    expect(closeStaleGenerationApprovals(s.db, "flo", "g1")).toBe(0);
    expect(getPermissionRequest(s.db, id)!.status).toBe("allowed_once");
  });

  test("createBridgeCogsApprovals 는 만들 때 정리하고 신호를 대기에 잇는다", async () => {
    const s = setup();
    const old = s.make({ gen: "g0" });
    const b = createBridgeCogsApprovals({ agentId: "flo", openDb: () => openDb(s.dbPath), processGen: "g1", report: () => {} });
    expect(getPermissionRequest(s.db, old)!.status).toBe("expired");
    const id = s.make({ gen: "g1" });
    const p = b.waiters.wait(id);
    s.press(id, "pg1");
    b.onControl({ requestId: id });
    expect(await p).toEqual({ kind: "allowed", status: "allowed_once" });
    b.close();
  });
});

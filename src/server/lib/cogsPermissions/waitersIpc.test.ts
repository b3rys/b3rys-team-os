const ownerFixture = {instance: "http://cogs", botId: 12, userId: 7, generation: 1};
/**
 * 서버 → 브리지 전달을 실제 별도 프로세스로 잰다. 한 프로세스 EventEmitter 로는 이 경계를 증명하지 못한다.
 * 부모 = 서버 역할(격리 DB 에 쓰고 bridge window 로 신호), 자식 = 가짜 브리지(waitersIpc.fixture.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { migrate, openDb } from "../../db/migrate";
import { readWindowFile, windowFilePathFor } from "../../runtimes/codex/bridgeWindow";
import { callCodexBridgeControl } from "../codexBridgeClient";
import { getPermissionRequest } from "../permissionGate";
import { createCogsApproval, getBinding, invalidateCogsApprovals, pressCogsApproval } from "./approvals";
import { pokeBridgesWithOpenApprovals, subscribeBridgeDelivery } from "./delivery";
import { createCogsPermissionEvents } from "./events";

const FIXTURE = join(import.meta.dir, "waitersIpc.fixture.ts");
const STAMP = "1:aaaa";
const dirs: string[] = [];
const kids: Subprocess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) { try { k.kill("SIGKILL"); } catch { /* 이미 끝남 */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function env() {
  const dir = mkdtempSync(join(tmpdir(), "cogs-ipc-"));
  dirs.push(dir);
  const dbPath = join(dir, "team.db");
  const pidFile = join(dir, "flo.pid");
  const db = openDb(dbPath);
  migrate(db);
  const make = (o: { gen?: string; ttlMs?: number } = {}) => createCogsApproval(db, { owner: ownerFixture,
    op: { runtime: "codex", agent_id: "flo", action: "run_command", command: "git push" },
    roomId: "42", policyStamp: STAMP, sessionId: "s", processGen: o.gen ?? "g1", ttlMs: o.ttlMs ?? 30_000, nowMs: Date.now(),
  }).request.id;
  const press = (id: string, action: "pg1" | "pgd") => pressCogsApproval(db, {
    requestId: id, action, actorUserId: 7, ownerUserId: 7, currentOwner: ownerFixture, callbackOwnerGeneration: 1, roomId: "42", bridgeAgentId: "flo", currentStamp: STAMP, nowMs: Date.now(),
  });
  const sendLog: string[] = [];
  const send = async (req: Parameters<typeof callCodexBridgeControl>[0]) => {
    const r = await callCodexBridgeControl(req, { pidFile, retryDelaysMs: [0, 50, 150] });
    sendLog.push(r.ok ? "ok" : r.reason);
    return r;
  };
  return { dir, db, dbPath, pidFile, make, press, send, sendLog };
}

/** 자식 하나 띄우고 stdout 줄을 모은다. ready 줄이 올 때까지 기다린다. */
async function bridge(e: ReturnType<typeof env>, gen: string, ids: string[]) {
  const proc = Bun.spawn(["bun", FIXTURE, e.dbPath, e.pidFile, "flo", gen, ids.join(",")], { stdout: "pipe", stderr: "inherit" });
  kids.push(proc);
  const lines: any[] = [];
  const waiters: Array<() => void> = [];
  void (async () => {
    let buf = "";
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        for (const w of waiters.splice(0)) w();
      }
    }
  })();
  const until = async (pred: (l: any[]) => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!pred(lines)) {
      if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(lines)}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  await until((l) => l.some((x) => x.ready));
  const outcome = (id: string) => lines.find((x) => x.id === id)?.outcome;
  return { proc, lines, until, outcome, controls: () => lines.filter((x) => "control" in x).length };
}

describe("서버 → 브리지 전달(별도 프로세스)", () => {
  test("서버의 무효화가 신호로 가서 만료 전에 대기가 닫힌다", async () => {
    const e = env();
    const id = e.make();
    const b = await bridge(e, "g1", [id]);
    const events = createCogsPermissionEvents(() => {});
    subscribeBridgeDelivery(events, { send: e.send, report: () => {} });
    const t0 = Date.now();
    invalidateCogsApprovals(e.db, { agentId: "flo", reason: "policy_narrowed", events });
    await b.until(() => b.outcome(id) !== undefined);
    expect(b.outcome(id)).toEqual({ kind: "closed", reason: "policy_narrowed" });
    expect(Date.now() - t0).toBeLessThan(3_000); // ttl 30초 — 타이머가 아니라 신호로 닫혔다
    // 브리지가 닫은 뒤에 보낸 쪽 응답이 도착할 수 있다 — 응답을 기다려서 본다.
    for (let i = 0; i < 50 && e.sendLog.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(e.sendLog).toEqual(["ok"]);
  });

  test("대기 등록 전에 이미 결정됐으면 브리지가 뜨자마자 끝난다", async () => {
    const e = env();
    const id = e.make();
    e.press(id, "pg1");
    const b = await bridge(e, "g1", [id]);
    await b.until(() => b.outcome(id) !== undefined);
    expect(b.outcome(id)).toEqual({ kind: "allowed", status: "allowed_once" });
  });

  test("신호를 잃어도 만료 시각에 DB 를 보고 닫는다(새 polling 없음)", async () => {
    const e = env();
    const id = e.make({ ttlMs: 1_200 });
    const b = await bridge(e, "g1", [id]);
    invalidateCogsApprovals(e.db, { agentId: "flo", reason: "policy_changed" }); // events 없음 = 신호 유실
    await new Promise((r) => setTimeout(r, 400));
    expect(b.outcome(id)).toBeUndefined();
    await b.until(() => b.outcome(id) !== undefined, 4_000);
    expect(b.outcome(id)).toEqual({ kind: "closed", reason: "policy_changed" });
    expect(b.controls()).toBe(0);
  });

  test("중복·역순 신호 — 결과는 한 줄, DB 가 정한 값", async () => {
    const e = env();
    const id = e.make();
    const b = await bridge(e, "g1", [id]);
    for (let i = 0; i < 3; i++) await e.send({ agentId: "flo", kind: "cogs_permission", eventId: `early${i}`, requestId: id });
    await b.until(() => b.controls() === 3);
    expect(b.outcome(id)).toBeUndefined(); // 결정 전 신호로는 아무것도 안 끝난다
    e.press(id, "pgd");
    await e.send({ agentId: "flo", kind: "cogs_permission", eventId: "d1", requestId: id });
    await e.send({ agentId: "flo", kind: "cogs_permission", eventId: "d1", requestId: id });
    await b.until(() => b.controls() === 5);
    expect(b.lines.filter((x) => x.id === id)).toEqual([{ id, outcome: { kind: "denied" } }]);
  });

  test("다른 팀원·옛 토큰 신호는 거절되고 아무것도 바꾸지 않는다", async () => {
    const e = env();
    const id = e.make();
    const b = await bridge(e, "g1", [id]);
    const w = readWindowFile(windowFilePathFor(e.pidFile, "flo")!)!;
    const post = (body: unknown, token: string) => fetch(`http://127.0.0.1:${w.port}/control`, {
      method: "POST", headers: { "content-type": "application/json", "x-b3os-token": token }, body: JSON.stringify(body),
    }).then((r) => r.status);
    expect(await post({ agentId: "flo", kind: "cogs_permission", eventId: "x" }, "f".repeat(64))).toBe(401);
    expect(await post({ agentId: "mille", kind: "cogs_permission", eventId: "x" }, w.token)).toBe(403);
    expect(await post({ agentId: "flo", kind: "turn", eventId: "x" }, w.token)).toBe(400);
    expect(await post({ agentId: "flo", kind: "cogs_permission", eventId: "x", requestId: "../etc" }, w.token)).toBe(400);
    expect(b.controls()).toBe(0);
    expect(getPermissionRequest(e.db, id)!.status).toBe("pending");
  });

  test("브리지 재시작 — 예전 세대 대기는 닫히고, 신호는 새 포트로 간다. 죽은 옛 창으로는 안 보낸다", async () => {
    const e = env();
    const oldId = e.make({ gen: "g1" });
    const b1 = await bridge(e, "g1", [oldId]);
    const oldWin = readWindowFile(windowFilePathFor(e.pidFile, "flo")!)!;
    b1.proc.kill("SIGKILL");
    await b1.proc.exited;
    // 죽은 프로세스의 창 파일이 남아 있어도 보내지 않는다.
    expect((await e.send({ agentId: "flo", kind: "cogs_permission", eventId: "dead" })).ok).toBe(false);
    expect(e.sendLog.at(-1)).toBe("no_window");

    const newId = e.make({ gen: "g2" });
    const b2 = await bridge(e, "g2", [newId]);
    const newWin = readWindowFile(windowFilePathFor(e.pidFile, "flo")!)!;
    expect(newWin.port).not.toBe(oldWin.port);
    expect(getBinding(e.db, oldId)!.invalidation_reason).toBe("bridge_restart");
    e.press(newId, "pg1");
    expect((await e.send({ agentId: "flo", kind: "cogs_permission", eventId: "n1", requestId: newId })).ok).toBe(true);
    await b2.until(() => b2.outcome(newId) !== undefined);
    expect(b2.outcome(newId)).toEqual({ kind: "allowed", status: "allowed_once" });
  });

  test("서버 재시작 — 꺼져 있던 사이 결정은 시작 신호로 회복된다", async () => {
    const e = env();
    const id = e.make();
    const other = e.make(); // 열린 채 남아 있는 다른 승인 — 이 팀원이 시작 신호 대상이 된다
    const b = await bridge(e, "g1", [id]);
    e.press(id, "pgd"); // 서버가 신호를 못 보낸 결정
    expect(await pokeBridgesWithOpenApprovals(e.db, { send: e.send })).toBe(1);
    await b.until(() => b.outcome(id) !== undefined);
    expect(b.outcome(id)).toEqual({ kind: "denied" });
    expect(getPermissionRequest(e.db, other)!.status).toBe("pending");
  });

  test("서버 재시작 — 하나뿐인 요청이 꺼져 있던 사이 거절돼도 대기가 회복된다", async () => {
    const e = env();
    const id = e.make();
    const b = await bridge(e, "g1", [id]);
    e.press(id, "pgd");
    expect(await pokeBridgesWithOpenApprovals(e.db, { send: e.send })).toBe(1);
    await b.until(() => b.outcome(id) !== undefined);
    expect(b.outcome(id)).toEqual({ kind: "denied" });
  });

  test("서버 재시작 — 하나뿐인 요청이 꺼져 있던 사이 무효화돼도 대기가 회복된다", async () => {
    const e = env();
    const id = e.make();
    const b = await bridge(e, "g1", [id]);
    invalidateCogsApprovals(e.db, { agentId: "flo", reason: "policy_narrowed" });
    expect(await pokeBridgesWithOpenApprovals(e.db, { send: e.send })).toBe(1);
    await b.until(() => b.outcome(id) !== undefined);
    expect(b.outcome(id)).toEqual({ kind: "closed", reason: "policy_narrowed" });
  });

  test("받은 뒤 응답(ACK)을 잃으면 다시 보낸다 — 신호가 두 번 가도 결과는 하나", async () => {
    const e = env();
    const id = e.make();
    const b = await bridge(e, "g1", [id]);
    e.press(id, "pgd");
    let calls = 0;
    const lossy = (async (url: string, init: RequestInit) => {
      const res = await fetch(url, init);
      calls++;
      if (calls === 1) throw new Error("socket hang up"); // 브리지는 받았는데 응답이 안 돌아온 것
      return res;
    }) as unknown as typeof fetch;
    const r = await callCodexBridgeControl({ agentId: "flo", kind: "cogs_permission", eventId: "ack", requestId: id }, { pidFile: e.pidFile, fetchImpl: lossy, retryDelaysMs: [0, 20, 50] });
    expect(r).toEqual({ ok: true, attempts: 2 });
    await b.until(() => b.controls() === 2);
    expect(b.lines.filter((x) => x.id === id)).toEqual([{ id, outcome: { kind: "denied" } }]);
  });

  test("보내는 중 브리지가 없다가 생기면 재시도가 새 창을 다시 읽어 닿는다", async () => {
    const e = env();
    const id = e.make();
    e.press(id, "pgd");
    const sending = callCodexBridgeControl({ agentId: "flo", kind: "cogs_permission", eventId: "late", requestId: id }, { pidFile: e.pidFile, retryDelaysMs: [0, 600, 1_500] });
    const b = await bridge(e, "g1", [id]);
    const r = await sending;
    expect(r.ok).toBe(true);
    expect(r.attempts).toBeGreaterThan(1);
    await b.until(() => b.controls() >= 1);
  });
});

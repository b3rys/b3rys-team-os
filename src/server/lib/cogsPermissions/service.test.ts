import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../db/migrate";
import { getPermissionRequest } from "../permissionGate";
import { createCogsApproval, handOffCogsApproval, hasCogsSessionGrant, pressCogsApproval } from "./approvals";
import { createCogsPermissionEvents, type CogsPermissionEvent } from "./events";
import { createCogsPolicyService, currentCogsStamp } from "./service";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const flo = { id: "flo", display_name: "플로", runtime: "claude_channel", team_official_member: false, channel: { kind: "b3chat", api_base: "http://127.0.0.1:1", allow_from: ["42"], owner_chat: "42" }, icon: "x" };
const dex = { id: "dex", display_name: "덱스", runtime: "codex", team_official_member: false, channel: { kind: "b3chat", api_base: "http://127.0.0.1:1", allow_from: ["43"], owner_chat: "43" } };
const lisa = { id: "lisa", display_name: "리사", runtime: "claude_channel", cogs_inbox: { api_base: "x", token_file: "y", allow_from: [16] } };

function setup(list: unknown[] = [flo, dex, lisa]) {
  const dir = mkdtempSync(join(tmpdir(), "cogs-perm-"));
  dirs.push(dir);
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify(list, null, 2));
  const db = new Database(":memory:");
  migrate(db);
  const events = createCogsPermissionEvents();
  const got: CogsPermissionEvent[] = [];
  events.on((e) => { got.push(e); });
  let reloads = 0;
  const svc = createCogsPolicyService({ registryPath, db, events, onRegistryChanged: () => { reloads++; }, lockTimeoutMs: 100 });
  const file = () => JSON.parse(readFileSync(registryPath, "utf-8")) as any[];
  return { dir, registryPath, db, svc, got, file, reloads: () => reloads };
}

describe("read", () => {
  test("cogs 팀원만 — 텔레그램 팀원(리사)은 대상이 아니다", () => {
    const { svc } = setup();
    expect(svc.read("flo")).toEqual({ ok: true, member: { id: "flo", runtime: "claude", roomId: "42" }, policy: { state: "absent" } });
    expect(svc.read("lisa")).toEqual({ ok: false, code: "not_found" });
    expect(svc.read("nobody")).toEqual({ ok: false, code: "not_found" });
    expect(svc.read("../x")).toEqual({ ok: false, code: "not_found" });
  });
  test("런타임이 cogs 정책을 모르면 unsupported_runtime", () => {
    const { svc } = setup([{ ...flo, id: "herm", runtime: "hermes_agent" }]);
    expect(svc.read("herm")).toEqual({ ok: false, code: "unsupported_runtime" });
  });
});

describe("update", () => {
  test("첫 설정은 expected 0, 다른 팀원·다른 칸은 그대로", () => {
    const { svc, file, got, reloads } = setup();
    const r = svc.update("flo", 0, { mode: "auto", allow: ["WebFetch"] });
    expect(r).toMatchObject({ ok: true, policy: { revision: 1, allow: ["WebFetch"] }, narrowed: true });
    const f = file();
    expect(f.find((a) => a.id === "flo").icon).toBe("x");
    expect(f.find((a) => a.id === "dex").cogs_permissions).toBeUndefined();
    expect(f.find((a) => a.id === "lisa")).toEqual(lisa);
    expect(got.filter((e) => e.type === "policy_changed")).toHaveLength(1);
    expect(reloads()).toBe(1);
  });
  test("revision 이 다르면 409 용 revision_conflict, 원본 그대로", () => {
    const { svc, file } = setup();
    svc.update("flo", 0, { mode: "auto", allow: [] });
    expect(svc.update("flo", 0, { mode: "auto", allow: ["Read"] })).toEqual({ ok: false, code: "revision_conflict" });
    expect(file().find((a) => a.id === "flo").cogs_permissions.allow).toEqual([]);
  });
  test("모르는 칸은 거절", () => {
    const { svc } = setup();
    expect(svc.update("dex", 0, { full: true, network: true, writable_roots: [], read_outside: true })).toEqual({ ok: false, code: "unsupported_field" });
  });
  test("깨진 정책은 주인이 expected 0 으로 고친다(자동으로 예전 권한에 떨어지지 않음)", () => {
    const { svc, registryPath } = setup([{ ...flo, cogs_permissions: { runtime: "claude", schema_version: 9 } }]);
    expect(svc.read("flo")).toMatchObject({ ok: true, policy: { state: "invalid" } });
    expect(currentCogsStamp(registryPath, "flo")).toBeNull();
    expect(svc.update("flo", 0, { mode: "auto", allow: [] })).toMatchObject({ ok: true, policy: { revision: 1 } });
  });
  test("축소면 대기 카드를 무효화한다", () => {
    const { svc, db, got, registryPath } = setup();
    svc.update("flo", 0, { mode: "auto", allow: ["Read", "WebFetch"] });
    const { request } = createCogsApproval(db, { op: { runtime: "claude", agent_id: "flo", action: "x", command: "ls" }, roomId: "42", policyStamp: currentCogsStamp(registryPath, "flo")!, sessionId: "s", processGen: "g", ttlMs: 1000, nowMs: Date.now() });
    const r = svc.update("flo", 1, { mode: "auto", allow: ["Read"] });
    expect(r).toMatchObject({ ok: true, narrowed: true, invalidated: 1 });
    expect(getPermissionRequest(db, request.id)!.status).toBe("expired");
    expect(got.some((e) => e.type === "approval_invalidated" && e.reason === "policy_narrowed")).toBe(true);
  });
  test("넓히기만 해도 옛 카드는 무효(다른 revision 의 카드는 결정하지 않는다)", () => {
    const { svc, db, registryPath } = setup();
    svc.update("flo", 0, { mode: "auto", allow: [] });
    const { request } = createCogsApproval(db, { op: { runtime: "claude", agent_id: "flo", action: "x", command: "ls" }, roomId: "42", policyStamp: currentCogsStamp(registryPath, "flo")!, sessionId: "s", processGen: "g", ttlMs: 1000, nowMs: Date.now() });
    expect(svc.update("flo", 1, { mode: "auto", allow: ["Read"] })).toMatchObject({ ok: true, narrowed: false, invalidated: 1 });
    expect(getPermissionRequest(db, request.id)!.status).toBe("expired");
  });
  test("다른 쓰기가 잠금을 잡고 있으면 busy, 원본 그대로", () => {
    const { svc, registryPath, file } = setup();
    writeFileSync(`${registryPath}.lock`, "");
    expect(svc.update("flo", 0, { mode: "auto", allow: [] })).toEqual({ ok: false, code: "busy" });
    expect(file().find((a) => a.id === "flo").cogs_permissions).toBeUndefined();
  });
  test("원본을 못 읽으면 registry_unreadable", () => {
    const { svc, registryPath } = setup();
    writeFileSync(registryPath, "{not json");
    expect(svc.update("flo", 0, { mode: "auto", allow: [] })).toEqual({ ok: false, code: "registry_unreadable" });
  });
});

describe("addAlways — '항상 허용'", () => {
  test("클로드는 allow 규칙, 코덱스는 정확한 경로를 더한다", () => {
    const { svc, file, registryPath } = setup();
    svc.update("flo", 0, { mode: "auto", allow: [] });
    svc.update("dex", 0, { full: false, network: true, writable_roots: [] });
    const r1 = svc.addAlways("flo", "Bash(git push:*)", "prm_a", currentCogsStamp(registryPath, "flo")!);
    expect(r1).toEqual({ ok: true, stamp: currentCogsStamp(registryPath, "flo")! });
    expect(currentCogsStamp(registryPath, "flo")!.startsWith("2:")).toBe(true);
    expect(svc.addAlways("dex", "/Users/x/proj/out.txt", "prm_b", currentCogsStamp(registryPath, "dex")!)).toMatchObject({ ok: true });
    const f = file();
    expect(f.find((a) => a.id === "flo").cogs_permissions.allow).toEqual(["Bash(git push:*)"]);
    expect(f.find((a) => a.id === "dex").cogs_permissions.writable_roots).toEqual(["/Users/x/proj/out.txt"]);
  });
  test("이미 있으면 규칙을 겹쳐 넣지 않는다", () => {
    const { svc, file, registryPath } = setup();
    svc.update("flo", 0, { mode: "auto", allow: ["Read"] });
    expect(svc.addAlways("flo", "Read", "prm_a", currentCogsStamp(registryPath, "flo")!)).toMatchObject({ ok: true });
    expect(file().find((a) => a.id === "flo").cogs_permissions.allow).toEqual(["Read"]);
  });
  test("정책이 없거나 깨졌으면, 또는 규칙이 틀리면 실패", () => {
    const { svc, registryPath } = setup();
    expect(svc.addAlways("flo", "Read", "prm_a", "1:x")).toEqual({ ok: false });
    svc.update("dex", 0, { full: false, network: true, writable_roots: [] });
    expect(svc.addAlways("dex", "relative", "prm_b", currentCogsStamp(registryPath, "dex")!)).toEqual({ ok: false });
  });
  test("결정 당시 도장과 원본이 다르면 쓰지 않는다", () => {
    const { svc, file, registryPath } = setup();
    svc.update("flo", 0, { mode: "auto", allow: ["Read", "WebFetch"] });
    const decided = currentCogsStamp(registryPath, "flo")!;
    svc.update("flo", 1, { mode: "auto", allow: ["Read"] });
    expect(svc.addAlways("flo", "Bash(git push:*)", "prm_a", decided)).toEqual({ ok: false });
    expect(file().find((a) => a.id === "flo").cogs_permissions).toMatchObject({ revision: 2, allow: ["Read"] });
  });
});

describe("항상 허용: 결정 뒤·원본 저장 전에 다른 쪽이 축소", () => {
  test("지운 권한이 원본에 다시 생기지 않고, 그 요청은 닫힌다", () => {
    const { svc, db, registryPath, file } = setup();
    svc.update("flo", 0, { mode: "auto", allow: ["Read", "WebFetch"] });
    const stamp = currentCogsStamp(registryPath, "flo")!;
    const { request } = createCogsApproval(db, { op: { runtime: "claude", agent_id: "flo", action: "x", command: "git push" }, roomId: "42", policyStamp: stamp, sessionId: "s", processGen: "g", ttlMs: 60_000, nowMs: Date.now(), alwaysRule: "Bash(git push:*)" });
    const r = pressCogsApproval(db, {
      requestId: request.id, action: "pga", actorUserId: 7, ownerUserId: 7, roomId: 42, bridgeAgentId: "flo", currentStamp: stamp, nowMs: Date.now(),
      persistAlways: (rule, row, decided) => {
        // CAS 는 이겼고, 저장 직전에 주인이 다른 화면에서 WebFetch 를 뺐다
        expect(svc.update("flo", 1, { mode: "auto", allow: ["Read"] })).toMatchObject({ ok: true });
        return svc.addAlways("flo", rule, row.id, decided);
      },
    });
    expect(r).toEqual({ kind: "failed" });
    expect(file().find((a) => a.id === "flo").cogs_permissions).toMatchObject({ revision: 2, allow: ["Read"] });
    expect(getPermissionRequest(db, request.id)!.status).toBe("expired");
    expect(handOffCogsApproval(db, { currentOwnerUserId: 7, requestId: request.id, agentId: "flo", sessionId: "s", processGen: "g", currentStamp: currentCogsStamp(registryPath, "flo"), nowMs: Date.now() })).toBe(false);
  });
});

describe("reconcile — 원본 저장 뒤 정리 전에 죽은 경우", () => {
  test("원본과 다른 revision 에 묶인 미인계 승인만 정리", () => {
    const { svc, db, registryPath } = setup();
    svc.update("flo", 0, { mode: "auto", allow: [] });
    const mk = (stamp: string) => createCogsApproval(db, { op: { runtime: "claude", agent_id: "flo", action: "x", command: `ls ${stamp}` }, roomId: "42", policyStamp: stamp, sessionId: "s", processGen: "g", ttlMs: 60_000, nowMs: Date.now() }).request.id;
    const old = mk("0:old");
    const cur = mk(currentCogsStamp(registryPath, "flo")!);
    expect(svc.reconcile()).toBe(1);
    expect(getPermissionRequest(db, old)!.status).toBe("expired");
    expect(getPermissionRequest(db, cur)!.status).toBe("pending");
  });
});

describe("축소 저장 직후 중단 → 재시작 → 넓히기", () => {
  test("축소 전 세션 허용이 되살아나지 않는다", () => {
    const { svc, db, registryPath } = setup();
    svc.update("flo", 0, { mode: "auto", allow: ["Read", "WebFetch"] }); // revision 1
    const op = { runtime: "claude", agent_id: "flo", action: "run_command", command: "git status" };
    const { request } = createCogsApproval(db, { op, roomId: "42", policyStamp: currentCogsStamp(registryPath, "flo")!, sessionId: "s", processGen: "g", ttlMs: 60_000, nowMs: Date.now() });
    const s1 = currentCogsStamp(registryPath, "flo");
    pressCogsApproval(db, { requestId: request.id, action: "pgs", actorUserId: 7, ownerUserId: 7, roomId: 42, bridgeAgentId: "flo", currentStamp: s1, nowMs: Date.now() });
    expect(handOffCogsApproval(db, { executionOperation: op, currentOwnerUserId: 7, requestId: request.id, agentId: "flo", sessionId: "s", processGen: "g", currentStamp: s1, nowMs: Date.now() })).toBe(true);
    const q = { agentId: "flo", sessionId: "s", processGen: "g", op };
    expect(hasCogsSessionGrant(db, { ...q, currentStamp: s1 })).toBe(true);
    // 축소된 revision 2 를 원본에만 쓰고 DB 정리 전에 서버가 죽었다
    const list = JSON.parse(readFileSync(registryPath, "utf-8"));
    list[0].cogs_permissions = { runtime: "claude", schema_version: 1, revision: 2, mode: "auto", allow: ["Read"] };
    writeFileSync(registryPath, JSON.stringify(list));
    // 재시작 정리: 세션 허용만 남은 팀원도 대상이다
    svc.reconcile();
    expect(db.prepare("SELECT COUNT(*) AS n FROM cogs_permission_session_grant").get()).toEqual({ n: 0 });
    // 나중에 다른 규칙을 더해 넓힌다(revision 3)
    expect(svc.update("flo", 2, { mode: "auto", allow: ["Read", "Grep"] })).toMatchObject({ ok: true, policy: { revision: 3 } });
    expect(hasCogsSessionGrant(db, { ...q, currentStamp: currentCogsStamp(registryPath, "flo") })).toBe(false);
  });
  test("재시작 정리가 없었더라도 넓히기는 직전 revision 의 허용만 옮긴다", () => {
    const { svc, db, registryPath } = setup();
    svc.update("flo", 0, { mode: "auto", allow: ["Read", "WebFetch"] });
    const op = { runtime: "claude", agent_id: "flo", action: "run_command", command: "git status" };
    const { request } = createCogsApproval(db, { op, roomId: "42", policyStamp: currentCogsStamp(registryPath, "flo")!, sessionId: "s", processGen: "g", ttlMs: 60_000, nowMs: Date.now() });
    const s1 = currentCogsStamp(registryPath, "flo");
    pressCogsApproval(db, { requestId: request.id, action: "pgs", actorUserId: 7, ownerUserId: 7, roomId: 42, bridgeAgentId: "flo", currentStamp: s1, nowMs: Date.now() });
    handOffCogsApproval(db, { executionOperation: op, currentOwnerUserId: 7, requestId: request.id, agentId: "flo", sessionId: "s", processGen: "g", currentStamp: s1, nowMs: Date.now() });
    const list = JSON.parse(readFileSync(registryPath, "utf-8"));
    list[0].cogs_permissions = { runtime: "claude", schema_version: 1, revision: 2, mode: "auto", allow: ["Read"] };
    writeFileSync(registryPath, JSON.stringify(list));
    svc.update("flo", 2, { mode: "auto", allow: ["Read", "Grep"] });
    expect(hasCogsSessionGrant(db, { agentId: "flo", sessionId: "s", processGen: "g", op, currentStamp: currentCogsStamp(registryPath, "flo") })).toBe(false);
  });
});

describe("다른 명부 쓰기(설정·기동)가 오래된 목록으로 써도 정책은 그대로", () => {
  test("축소 뒤 오래된 목록을 writeRegistrySafely 로 써도 축소가 되돌아가지 않는다", async () => {
    const { svc, registryPath, file } = setup();
    svc.update("flo", 0, { mode: "auto", allow: ["Read", "WebFetch"] });
    const stale = JSON.parse(readFileSync(registryPath, "utf-8")); // 설정이 먼저 읽어 둔 목록
    svc.update("flo", 1, { mode: "auto", allow: ["Read"] });       // 그사이 축소
    stale[0].icon = "y";                                            // 설정은 다른 칸을 고친다
    const { writeRegistrySafely } = await import("../registrySafety");
    writeRegistrySafely(registryPath, stale);
    const flo = file().find((a) => a.id === "flo");
    expect(flo.icon).toBe("y");
    expect(flo.cogs_permissions).toMatchObject({ revision: 2, allow: ["Read"] });
  });
  test("정책 서비스가 아닌 쓰기는 정책을 새로 만들거나 지우지 못한다", async () => {
    const { svc, registryPath, file } = setup();
    svc.update("flo", 0, { mode: "auto", allow: ["Read"] });
    const list = JSON.parse(readFileSync(registryPath, "utf-8"));
    delete list[0].cogs_permissions;
    list[1].cogs_permissions = { runtime: "codex", schema_version: 1, revision: 1, full: true, network: true, writable_roots: [] };
    const { writeRegistrySafely } = await import("../registrySafety");
    writeRegistrySafely(registryPath, list);
    expect(file().find((a) => a.id === "flo").cogs_permissions).toMatchObject({ allow: ["Read"] });
    expect(file().find((a) => a.id === "dex").cogs_permissions).toBeUndefined();
  });
  test("다른 프로세스가 잠금을 잡고 있으면 명부 쓰기도 기다리다 registry_busy", async () => {
    const { registryPath } = setup();
    writeFileSync(`${registryPath}.lock`, "");
    const { writeRegistrySafely } = await import("../registrySafety");
    const list = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(() => writeRegistrySafely(registryPath, list)).toThrow("registry_busy");
  });
});

test("재시작 정리: '항상 허용' 결정 뒤 규칙 저장 전에 멈춘 요청을 닫는다", () => {
  const { svc, db, registryPath } = setup();
  svc.update("flo", 0, { mode: "auto", allow: [] });
  const stamp = currentCogsStamp(registryPath, "flo")!;
  const { request } = createCogsApproval(db, { op: { runtime: "claude", agent_id: "flo", action: "x", command: "git push" }, roomId: "42", policyStamp: stamp, sessionId: "s", processGen: "g", ttlMs: 60_000, nowMs: Date.now(), alwaysRule: "Bash(git push:*)" });
  expect(() => pressCogsApproval(db, { requestId: request.id, action: "pga", actorUserId: 7, ownerUserId: 7, roomId: 42, bridgeAgentId: "flo", currentStamp: stamp, nowMs: Date.now(), persistAlways: () => { throw new Error("crash"); } })).toThrow("crash");
  expect(getPermissionRequest(db, request.id)!.status).toBe("allowed_always");
  expect(svc.reconcile()).toBeGreaterThanOrEqual(1);
  expect(getPermissionRequest(db, request.id)!.status).toBe("expired");
});

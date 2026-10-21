import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../db/migrate";
import { getPermissionRequest } from "../permissionGate";
import { createCogsApproval } from "./approvals";
import { createCogsPermissionEvents, type CogsPermissionEvent } from "./events";
import { createCogsPolicyService, currentCogsRevision } from "./service";

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
    expect(currentCogsRevision(registryPath, "flo")).toBeNull();
    expect(svc.update("flo", 0, { mode: "auto", allow: [] })).toMatchObject({ ok: true, policy: { revision: 1 } });
  });
  test("축소면 대기 카드를 무효화한다", () => {
    const { svc, db, got } = setup();
    svc.update("flo", 0, { mode: "auto", allow: ["Read", "WebFetch"] });
    const { request } = createCogsApproval(db, { op: { runtime: "claude", agent_id: "flo", action: "x", command: "ls" }, roomId: "42", policyRevision: 1, sessionId: "s", processGen: "g", ttlMs: 1000, nowMs: Date.now() });
    const r = svc.update("flo", 1, { mode: "auto", allow: ["Read"] });
    expect(r).toMatchObject({ ok: true, narrowed: true, invalidated: 1 });
    expect(getPermissionRequest(db, request.id)!.status).toBe("expired");
    expect(got.some((e) => e.type === "approval_invalidated" && e.reason === "policy_narrowed")).toBe(true);
  });
  test("넓히기만 해도 옛 카드는 무효(다른 revision 의 카드는 결정하지 않는다)", () => {
    const { svc, db } = setup();
    svc.update("flo", 0, { mode: "auto", allow: [] });
    const { request } = createCogsApproval(db, { op: { runtime: "claude", agent_id: "flo", action: "x", command: "ls" }, roomId: "42", policyRevision: 1, sessionId: "s", processGen: "g", ttlMs: 1000, nowMs: Date.now() });
    expect(svc.update("flo", 1, { mode: "auto", allow: ["Read"] })).toMatchObject({ ok: true, narrowed: false, invalidated: 1 });
    expect(getPermissionRequest(db, request.id)!.status).toBe("expired");
  });
  test("다른 쓰기가 잠금을 잡고 있으면 busy, 원본 그대로", () => {
    const { svc, registryPath, file } = setup();
    writeFileSync(`${registryPath}.cogs-permissions.lock`, "");
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
    const { svc, file } = setup();
    svc.update("flo", 0, { mode: "auto", allow: [] });
    svc.update("dex", 0, { full: false, network: true, writable_roots: [] });
    expect(svc.addAlways("flo", "Bash(git push:*)")).toEqual({ ok: true, revision: 2 });
    expect(svc.addAlways("dex", "/Users/x/proj/out.txt")).toEqual({ ok: true, revision: 2 });
    const f = file();
    expect(f.find((a) => a.id === "flo").cogs_permissions.allow).toEqual(["Bash(git push:*)"]);
    expect(f.find((a) => a.id === "dex").cogs_permissions.writable_roots).toEqual(["/Users/x/proj/out.txt"]);
  });
  test("이미 있으면 revision 을 올리지 않는다", () => {
    const { svc } = setup();
    svc.update("flo", 0, { mode: "auto", allow: ["Read"] });
    expect(svc.addAlways("flo", "Read")).toEqual({ ok: true, revision: 1 });
  });
  test("정책이 없거나 깨졌으면, 또는 규칙이 틀리면 실패", () => {
    const { svc } = setup();
    expect(svc.addAlways("flo", "Read")).toEqual({ ok: false });
    svc.update("dex", 0, { full: false, network: true, writable_roots: [] });
    expect(svc.addAlways("dex", "relative")).toEqual({ ok: false });
  });
});

describe("reconcile — 원본 저장 뒤 정리 전에 죽은 경우", () => {
  test("원본과 다른 revision 에 묶인 미인계 승인만 정리", () => {
    const { svc, db, registryPath } = setup();
    svc.update("flo", 0, { mode: "auto", allow: [] });
    const mk = (rev: number) => createCogsApproval(db, { op: { runtime: "claude", agent_id: "flo", action: "x", command: `ls ${rev}` }, roomId: "42", policyRevision: rev, sessionId: "s", processGen: "g", ttlMs: 60_000, nowMs: Date.now() }).request.id;
    const old = mk(0);
    const cur = mk(1);
    expect(currentCogsRevision(registryPath, "flo")).toBe(1);
    expect(svc.reconcile()).toBe(1);
    expect(getPermissionRequest(db, old)!.status).toBe("expired");
    expect(getPermissionRequest(db, cur)!.status).toBe("pending");
  });
});

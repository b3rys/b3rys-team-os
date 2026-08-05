// MCP HTTP 창구 — 권한 분리·신원 격리·거부 경로. ★뚫어보는 시험★.
// 인증 자체는 mcpAuth.test.ts 가 본다. 여기서는 인증을 대체(주입)하고 그 뒤 동작만 검증한다.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { buildMcpHttpApp } from "./mcpHttpRoute";
import { buildMcpServer, WRITE_TOOL_NAMES } from "./b3osMcpServer";
import type { McpAuthConfig, McpAuthResult } from "./mcpAuth";

function addAgent(d: Database, id: string, name: string): void {
  d.run(
    `insert into agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file,
      moderator_eligible, avatar_emoji, created_at) values (?,?,?,?,?,?,?,?,?,?)`,
    [id, name, "test", "claude_channel", "claude_tmux", `/tmp/${id}`, `/tmp/${id}/SOUL.md`, 0, "🙂", "2026-08-05 00:00:00"],
  );
}
function freshDb(): Database {
  const d = new Database(":memory:");
  migrate(d);
  addAgent(d, "demis", "Demis");
  addAgent(d, "bill", "Bill");
  return d;
}
const CFG: McpAuthConfig = { teamDomain: "t.example", audience: "aud", principals: new Map() };
const allow = (agentId: string, scope: "read" | "write"): McpAuthResult => ({
  ok: true,
  principal: { agentId, scope, subject: `${agentId}.token`, kind: "service_token" },
});
const post = (body: unknown) =>
  new Request("http://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

// ── 도구 노출 (권한 분리) ──

test("★read 신원에게는 쓰기 도구가 아예 없다★ — 목록에 안 뜬다", async () => {
  const db = freshDb();
  const readSrv = buildMcpServer(db, "demis", "read");
  const names = new Set(Object.keys((readSrv as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {}));
  for (const w of WRITE_TOOL_NAMES) expect(names.has(w)).toBe(false);
  expect(names.size).toBeGreaterThan(0); // 읽기 도구는 남아 있어야 한다
});

test("★대조군★ — write 신원에게는 쓰기 도구가 실제로 보인다(위 시험이 항상 0을 세는 게 아님)", () => {
  const db = freshDb();
  const writeSrv = buildMcpServer(db, "demis", "write");
  const names = new Set(Object.keys((writeSrv as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {}));
  for (const w of WRITE_TOOL_NAMES) expect(names.has(w)).toBe(true);
});

// ── 거부 경로 ──

test("인증 실패는 그대로 상태코드로 나간다(도구까지 안 간다)", async () => {
  const db = freshDb();
  const app = buildMcpHttpApp(db, {
    authConfig: CFG,
    authenticate: async () => ({ ok: false, status: 401, reason: "missing_access_jwt" }),
  });
  const res = await app.request(post(INIT));
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "missing_access_jwt" });
});

test("★CF 를 통과해도 레지스트리에 없는 신원은 거부★ — 이중 게이트", async () => {
  const db = freshDb();
  const app = buildMcpHttpApp(db, { authConfig: CFG, authenticate: async () => allow("ghost", "write") });
  const res = await app.request(post(INIT));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "actor_not_registered" });
});

test("★대조군★ — 등록된 신원은 통과한다(위 시험이 전부 막는 게 아님)", async () => {
  const db = freshDb();
  const app = buildMcpHttpApp(db, { authConfig: CFG, authenticate: async () => allow("demis", "read") });
  const res = await app.request(post(INIT));
  expect(res.status).toBe(200);
});

// ── 기록 ──

test("거부도 기록에 남는다 — 누가 두드렸는지 알아야 한다", async () => {
  const db = freshDb();
  const app = buildMcpHttpApp(db, {
    authConfig: CFG,
    authenticate: async () => ({ ok: false, status: 403, reason: "subject_not_mapped" }),
  });
  await app.request(post(INIT));
  const rows = db.query("select action, target from audit_event where action = 'mcp.http.denied'").all() as { action: string; target: string }[];
  expect(rows.length).toBe(1);
  expect(rows[0]!.target).toBe("subject_not_mapped");
});

test("통과한 요청도 기록에 남는다(신원·권한 포함)", async () => {
  const db = freshDb();
  const app = buildMcpHttpApp(db, { authConfig: CFG, authenticate: async () => allow("demis", "read") });
  await app.request(post(INIT));
  const rows = db.query("select actor, detail_json from audit_event where action = 'mcp.http.request'").all() as { actor: string; detail_json: string }[];
  expect(rows.length).toBe(1);
  expect(rows[0]!.actor).toBe("demis");
  expect(JSON.parse(rows[0]!.detail_json).scope).toBe("read");
});

// ── 신원 격리 ──

test("★요청마다 신원이 갈린다★ — 앞 요청의 신원이 다음 요청에 남지 않는다", async () => {
  const db = freshDb();
  let who: "demis" | "bill" = "demis";
  const app = buildMcpHttpApp(db, { authConfig: CFG, authenticate: async () => allow(who, "read") });
  await app.request(post(INIT));
  who = "bill";
  await app.request(post(INIT));
  const rows = db.query("select actor from audit_event where action = 'mcp.http.request' order by id").all() as { actor: string }[];
  expect(rows.map((r) => r.actor)).toEqual(["demis", "bill"]);
});

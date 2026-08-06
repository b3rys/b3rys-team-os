// MCP HTTP 창구 — 권한 분리·신원 격리·거부 경로. ★뚫어보는 시험★.
// 인증 자체는 mcpAuth.test.ts 가 본다. 여기서는 인증을 대체(주입)하고 그 뒤 동작만 검증한다.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { buildMcpHttpApp } from "./mcpHttpRoute";
import { buildMcpServer, WRITE_TOOL_NAMES, resolveActorStrict } from "./b3osMcpServer";
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

// ── 폴백 없음 (리뷰 P2) ──

test("★HTTP 경로는 env 신원으로 떨어지지 않는다★ — 빈 신원은 거부, 서버 자기 신원 승계 금지", () => {
  const db = freshDb();
  const prev = process.env.B3OS_AGENT_ID;
  process.env.B3OS_AGENT_ID = "demis"; // 서버가 자기 신원을 갖고 있는 상황
  try {
    expect(resolveActorStrict(db, "")).toBeNull();
    expect(resolveActorStrict(db, "   ")).toBeNull();
    expect(resolveActorStrict(db, undefined as unknown as string)).toBeNull();
    // 대조군 — 제대로 준 신원은 통과한다(위가 전부 null 만 뱉는 게 아님)
    expect(resolveActorStrict(db, "demis")).toBe("demis");
  } finally {
    if (prev === undefined) delete process.env.B3OS_AGENT_ID;
    else process.env.B3OS_AGENT_ID = prev;
  }
});

test("★쓰기 도구 목록은 한 곳뿐★ — 관문(WRITE_TOOL_NAMES)이 실제로 그 이름들을 막는다", () => {
  const db = freshDb();
  const readNames = new Set(Object.keys((buildMcpServer(db, "demis", "read") as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {}));
  const writeNames = new Set(Object.keys((buildMcpServer(db, "demis", "write") as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {}));
  // write 에만 있고 read 에 없는 도구 = 실제로 걸러진 것. 이게 WRITE_TOOL_NAMES 와 정확히 같아야 한다.
  const gated = new Set([...writeNames].filter((n) => !readNames.has(n)));
  expect(gated).toEqual(WRITE_TOOL_NAMES);
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

// ── 공개 빌드 격리 (팀 리드 지시 2026-08-05: "퍼블릭 기존소스에 영향없게") ──

test("★공개 빌드에는 MCP 창구가 아예 안 붙는다★ — 가드를 지우면 이 시험이 깨진다", async () => {
  // index.ts 는 `if (!PUBLIC_BUILD) app.route("/", buildMcpHttpApp(db))` 로 감싸고 있고,
  // PUBLIC_BUILD 는 B3OS_LIVE !== "1" 이다. 즉 공개 빌드에서는 라우트가 등록되지 않는다.
  // 실서버로 확인한 사실(B3OS_LIVE 없이 띄우면 /team/mcp 가 404)을 소스로 고정한다.
  const src = await Bun.file(new URL("../index.ts", import.meta.url)).text();
  const mount = src.split("\n").find((l) => l.includes("buildMcpHttpApp(db)"));
  expect(mount).toBeDefined();
  expect(mount).toContain("!PUBLIC_BUILD"); // 가드 없이 마운트하면 실패한다
});

test("★공개 빌드 판정 기준이 바뀌면 알아챈다★ — PUBLIC_BUILD = B3OS_LIVE !== '1'", async () => {
  const src = await Bun.file(new URL("../routes/settings.ts", import.meta.url)).text();
  expect(src).toContain('export const PUBLIC_BUILD = process.env.B3OS_LIVE !== "1"');
});

// ── 팀 리드 신원 (GD 2026-08-06: "쓰기 켤때 팀장이름이 필요해") ──

test("★팀 리드는 명부에 없어도 신원으로 통과한다★ — 대시보드가 이미 그렇게 쓴다", () => {
  const db = freshDb(); // demis·bill 만 등록. gd 는 없다
  expect(db.query("select count(*) as n from agent where id='gd'").get()).toEqual({ n: 0 });
  expect(resolveActorStrict(db, "gd")).toBe("gd");
});

test("★그렇다고 아무 미등록 이름이나 통과하지는 않는다★ — 리드 하나만 예외", () => {
  const db = freshDb();
  for (const ghost of ["ghost", "gd2", "GD", "admin", "root", ""]) {
    expect(resolveActorStrict(db, ghost)).toBeNull();
  }
});

test("리드 id 는 leadActorId 한 곳에서 온다 — LEAD_ACTOR_ID 를 바꾸면 따라간다", () => {
  const db = freshDb();
  const prev = process.env.LEAD_ACTOR_ID;
  process.env.LEAD_ACTOR_ID = "boss";
  try {
    expect(resolveActorStrict(db, "boss")).toBe("boss");
    expect(resolveActorStrict(db, "gd")).toBeNull(); // 옛 이름은 더 이상 리드가 아니다
  } finally {
    if (prev === undefined) delete process.env.LEAD_ACTOR_ID;
    else process.env.LEAD_ACTOR_ID = prev;
  }
});

test("★리드도 쓰기 권한은 매핑이 정한다★ — 리드라고 자동으로 쓰기가 열리지 않는다", () => {
  const db = freshDb();
  const readSrv = buildMcpServer(db, "gd", "read");
  const names = new Set(Object.keys((readSrv as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {}));
  for (const w of WRITE_TOOL_NAMES) expect(names.has(w)).toBe(false);
});

// P4 — POST /api/system-message 핀 테스트.
// safe-by-default(토큰 미설정=503), 인증(401), 성공(201, source=system), 중복(409).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createSystemMessageRoutes } from "./systemMessage";

function seedAgent(db: Database, id: string) {
  db.prepare(
    `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'P.md')`,
  ).run(id, id);
}

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  seedAgent(db, "bill");
  const app = createSystemMessageRoutes({
    db,
    broadcast: () => {},
    registeredAgentIds: () => new Set(["bill"]),
  });
  return { app, db };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x/system-message", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });

const ORIG = process.env.OP_MESSAGE_TOKEN;
afterEach(() => {
  if (ORIG === undefined) delete process.env.OP_MESSAGE_TOKEN;
  else process.env.OP_MESSAGE_TOKEN = ORIG;
});

describe("POST /api/system-message", () => {
  test("토큰 미설정 → 503 비활성(safe-by-default, 무인증 주입 표면 0)", async () => {
    delete process.env.OP_MESSAGE_TOKEN;
    const { app } = setup();
    const res = await app.request(post({ to_agent_id: "bill", body: "hi" }));
    expect(res.status).toBe(503);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe("system_message_disabled");
  });

  test("토큰 설정 + 헤더 불일치 → 401", async () => {
    process.env.OP_MESSAGE_TOKEN = "secret";
    const { app } = setup();
    const res = await app.request(post({ to_agent_id: "bill", body: "hi" }, { "x-op-token": "wrong" }));
    expect(res.status).toBe(401);
  });

  test("토큰 일치 → 201, source=system 메시지 적재", async () => {
    process.env.OP_MESSAGE_TOKEN = "secret";
    const { app, db } = setup();
    const res = await app.request(post({ to_agent_id: "bill", body: "op ping" }, { "x-op-token": "secret" }));
    expect(res.status).toBe(201);
    const j = (await res.json()) as { ok: boolean; message: { id: string } };
    expect(j.ok).toBe(true);
    const row = db.query("SELECT from_agent_id, source, body FROM message WHERE id = ?").get(j.message.id) as {
      from_agent_id: string;
      source: string;
      body: string;
    };
    expect(row.from_agent_id).toBe("system");
    expect(row.source).toBe("system");
    expect(row.body).toBe("op ping");
  });

  test("미등록 수신자 → 400", async () => {
    process.env.OP_MESSAGE_TOKEN = "secret";
    const { app } = setup();
    const res = await app.request(post({ to_agent_id: "ghost", body: "hi" }, { "x-op-token": "secret" }));
    expect(res.status).toBe(400);
  });

  test("동일 본문 60s 내 중복 → 409", async () => {
    process.env.OP_MESSAGE_TOKEN = "secret";
    const { app } = setup();
    const h = { "x-op-token": "secret" };
    await app.request(post({ to_agent_id: "bill", body: "dup" }, h));
    const res2 = await app.request(post({ to_agent_id: "bill", body: "dup" }, h));
    expect(res2.status).toBe(409);
  });
});

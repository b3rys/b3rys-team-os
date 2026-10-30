// 왕복 상한(agent 메시지 MAX_AUTO_ROUNDS 건)을 넘는 팀원 답장은 저장 전에 거절해 발신자가 바로 안다.
// 배달 단계 검사(checkPingpong)와 같은 셈을 쓰는지, 거절도 audit 에 남는지, 팀장·broadcast·direct_to_gd 는 막지 않는지를 고정한다.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createInboxRoutes } from "./inbox";
import { checkPingpong, MAX_AUTO_ROUNDS } from "../bus/antiPingpong";
import type { PendingDispatchRow } from "../bus/types";

function setup(): { db: Database; app: ReturnType<typeof createInboxRoutes> } {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["jane", "lisa"]) {
    db.prepare(
      `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'r', 'claude_channel', 'claude_tmux', '/tmp', 'P.md')`,
    ).run(a, a);
  }
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('thr1','t','dm','[]','jane')`,
  ).run();
  const app = createInboxRoutes({
    db,
    broadcast: () => {},
    registeredAgentIds: () => new Set(["jane", "lisa"]),
  } as unknown as Parameters<typeof createInboxRoutes>[0]);
  return { db, app };
}

/** 답장 체인을 직접 심는다. sources[i] 가 i 번째 메시지의 source. 마지막 id 를 돌려준다. */
function seedChain(db: Database, sources: string[]): string {
  let parent: string | null = null;
  sources.forEach((source, i) => {
    const id = `msg${i}`;
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, parent_message_id, in_reply_to, hop_count)
       VALUES (?, 'thr1', ?, ?, 'dm', 'b', ?, ?, ?, ?)`,
    ).run(id, i % 2 ? "lisa" : "jane", i % 2 ? "jane" : "lisa", source, parent, parent, i);
    parent = id;
  });
  return parent!;
}

const send = (app: ReturnType<typeof createInboxRoutes>, body: Record<string, unknown>) =>
  app.request("/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const reply = (inReplyTo: string, extra: Record<string, unknown> = {}) => ({
  from_agent_id: "lisa", to_agent_id: "jane", body: `답 ${Math.random()}`, type: "dm", priority: "normal",
  source: "agent", thread_id: "thr1", in_reply_to: inReplyTo, hop_count: 1, ...extra,
});

const messageCount = (db: Database) => (db.prepare(`SELECT COUNT(*) AS n FROM message`).get() as { n: number }).n;

describe("POST /api/inbox — 왕복 상한을 보낼 때 알린다", () => {
  test("★체인에 agent 메시지가 상한만큼 있으면 저장하지 않고 409 와 새 스레드 안내를 준다★", async () => {
    const { db, app } = setup();
    const last = seedChain(db, Array(MAX_AUTO_ROUNDS).fill("agent"));
    const before = messageCount(db);
    const res = await send(app, reply(last));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("pingpong_limit_exceeded");
    expect(body.messages).toBe(MAX_AUTO_ROUNDS);
    expect(String(body.next)).toContain("--thread");
    expect(messageCount(db)).toBe(before);
  });

  test("★거절도 audit 에 남는다★ — 측정이 사라지지 않게", async () => {
    const { db, app } = setup();
    const last = seedChain(db, Array(MAX_AUTO_ROUNDS).fill("agent"));
    await send(app, reply(last));
    const row = db.prepare(`SELECT actor, detail_json FROM audit_event WHERE action = 'send_rejected_pingpong'`).get() as
      { actor: string; detail_json: string } | undefined;
    expect(row?.actor).toBe("lisa");
    expect(JSON.parse(row!.detail_json)).toMatchObject({ to: "jane", in_reply_to: last, messages: MAX_AUTO_ROUNDS });
  });

  test("상한 바로 아래는 그대로 접수한다", async () => {
    const { db, app } = setup();
    const last = seedChain(db, Array(MAX_AUTO_ROUNDS - 1).fill("agent"));
    const res = await send(app, reply(last));
    expect(res.status).toBe(201);
  });

  test("★배달 단계 검사와 같은 경계에서 갈린다★ — 보낼 땐 통과·배달 땐 차단이 남지 않는다", async () => {
    for (const n of [MAX_AUTO_ROUNDS - 1, MAX_AUTO_ROUNDS]) {
      const { db, app } = setup();
      const last = seedChain(db, Array(n).fill("agent"));
      const accepted = (await send(app, reply(last))).status === 201;
      const atDispatch = checkPingpong(db, {
        source: "agent", parent_message_id: last, from_agent_id: "lisa", created_by: "lisa", hop_count: 1, max_hop: 99,
      } as unknown as PendingDispatchRow, new Set(["jane", "lisa"]));
      expect(accepted).toBe(atDispatch.allowed);
    }
  });

  test("팀장(source=user) 메시지는 세지 않는다 — 체인 중간에 팀장이 끼면 그만큼 여유가 생긴다", async () => {
    const { db, app } = setup();
    const sources = Array(MAX_AUTO_ROUNDS).fill("agent");
    sources[3] = "user";
    const last = seedChain(db, sources);
    const res = await send(app, reply(last));
    expect(res.status).toBe(201);
  });

  test("부모 없는 새 메시지는 검사하지 않는다", async () => {
    const { app } = setup();
    const res = await send(app, reply("", { in_reply_to: undefined }));
    expect(res.status).toBe(201);
  });

  test("direct_to_gd 보고는 저장 단계에서 막지 않는다", async () => {
    const { db, app } = setup();
    const last = seedChain(db, Array(MAX_AUTO_ROUNDS).fill("agent"));
    const res = await send(app, reply(last, { meta: { reply_mode: "direct_to_gd" } }));
    expect(res.status).not.toBe(409);
  });
});

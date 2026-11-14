// hop 한도는 접수와 배달이 같은 경계(hop_count >= max_hop)로 갈린다. 경계가 다르면 한도 값의 메시지가
// 접수(201)만 되고 배달 단계에서 막혀, 발신자는 성공을 보고 수신자는 아무것도 받지 못한다.
// 부모 없는 새 스레드라도 발신자가 넘긴 hop 은 그대로 남는다는 점, 답장 hop 보정 뒤에 검사한다는 점을 고정한다.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createInboxRoutes } from "./inbox";
import { checkPingpong } from "../bus/antiPingpong";
import { MAX_HOPS_DEFAULT } from "../../shared/envelopeSchema";
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

const send = (app: ReturnType<typeof createInboxRoutes>, body: Record<string, unknown>) =>
  app.request("/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const msg = (extra: Record<string, unknown> = {}) => ({
  from_agent_id: "lisa", to_agent_id: "jane", body: `본문 ${Math.random()}`, type: "dm", priority: "normal",
  source: "agent", thread_id: "thr1", ...extra,
});

const messageCount = (db: Database) => (db.prepare(`SELECT COUNT(*) AS n FROM message`).get() as { n: number }).n;

describe("POST /api/inbox — hop 한도를 보낼 때 알린다", () => {
  test("부모 없는 새 스레드여도 hop 이 한도면 저장하지 않고 400 과 --hop 을 빼라는 안내를 준다", async () => {
    const { db, app } = setup();
    const before = messageCount(db);
    const res = await send(app, msg({ hop_count: MAX_HOPS_DEFAULT }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("ttl_exceeded");
    expect(String(body.next)).toContain("--hop");
    expect(messageCount(db)).toBe(before);
    const audit = db.prepare(`SELECT COUNT(*) AS n FROM audit_event WHERE action = 'hop_limit_exceeded'`).get() as { n: number };
    expect(audit.n).toBe(1);
  });

  test("한도 바로 아래는 그대로 접수한다", async () => {
    const { app } = setup();
    const res = await send(app, msg({ hop_count: MAX_HOPS_DEFAULT - 1 }));
    expect(res.status).toBe(201);
  });

  test("답장 hop 보정(부모+1)이 한도에 닿으면 거절한다 — 보정 전 값으로 통과시키지 않는다", async () => {
    const { db, app } = setup();
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count)
       VALUES ('parent15', 'thr1', 'jane', 'lisa', 'dm', 'b', 'agent', ?)`,
    ).run(MAX_HOPS_DEFAULT - 1);
    const res = await send(app, msg({ in_reply_to: "parent15", hop_count: 1 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).your_hop).toBe(MAX_HOPS_DEFAULT);
  });

  test("배달 단계 검사와 같은 경계에서 갈린다 — 보낼 땐 통과·배달 땐 차단이 남지 않는다", async () => {
    for (const hop of [MAX_HOPS_DEFAULT - 1, MAX_HOPS_DEFAULT]) {
      const { db, app } = setup();
      const accepted = (await send(app, msg({ hop_count: hop }))).status === 201;
      const atDispatch = checkPingpong(db, {
        source: "agent", parent_message_id: null, from_agent_id: "lisa", created_by: "lisa",
        hop_count: hop, max_hop: MAX_HOPS_DEFAULT,
      } as unknown as PendingDispatchRow, new Set(["jane", "lisa"]));
      expect(accepted).toBe(atDispatch.allowed);
    }
  });
});

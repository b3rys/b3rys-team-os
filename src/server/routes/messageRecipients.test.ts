// GET /api/inbox/messages/:id 가 수신자별 배달 상태를 준다 — send.sh --confirm 의 판정 근거.
//
// 왜 필요했나 (2026-07-30 실측): POST /api/inbox 는 행 삽입만 하고 ok 를 주고, 차단 판정은 그 뒤
//   dispatcher 가 비동기로 한다. 보낸 사람이 사실을 확인할 경로가 ★없어서★ 미배달이 '성공' 으로
//   보였다 — 리사의 정정 메시지가 그렇게 사라졌고 send.sh 는 '✓ sent' 를 찍었다.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createInboxRoutes } from "./inbox";

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
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','[]','jane')`,
  ).run();
  const app = createInboxRoutes({
    db,
    broadcast: () => {},
    registeredAgentIds: () => new Set(["jane", "lisa"]),
  } as unknown as Parameters<typeof createInboxRoutes>[0]);
  return { db, app };
}

/** message + message_recipient 를 직접 심는다 — dispatcher 를 돌리지 않고 상태를 만든다. */
function seed(
  db: Database,
  id: string,
  recipients: Array<{ agent: string; state: string; err?: string | null; status?: string; rstate?: string }>,
): void {
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, delivery_status)
     VALUES (?, 't1', 'jane', 'lisa', 'dm', 'b', 'agent', ?)`,
  ).run(id, recipients[0]?.status ?? "delivered");
  for (const r of recipients) {
    db.prepare(
      `INSERT INTO message_recipient (message_id, agent_id, delivery_state, last_error, recipient_state)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, r.agent, r.state, r.err ?? null, r.rstate ?? "acknowledged");
  }
}

const get = async (app: ReturnType<typeof createInboxRoutes>, id: string) =>
  await (await app.request(`/messages/${id}`)).json();

describe("GET /api/inbox/messages/:id — recipients", () => {
  test("★수신자별 delivery_state 와 last_error 를 준다★", async () => {
    const { db, app } = setup();
    seed(db, "m1", [{ agent: "lisa", state: "blocked", err: "blocked:pingpong_limit_exceeded:rounds=8,max=8" }]);
    const body = (await get(app, "m1")) as { recipients: Array<Record<string, unknown>> };
    expect(Array.isArray(body.recipients)).toBe(true);
    expect(body.recipients).toHaveLength(1);
    expect(body.recipients[0]!.agent_id).toBe("lisa");
    expect(body.recipients[0]!.delivery_state).toBe("blocked");
    expect(String(body.recipients[0]!.last_error)).toContain("pingpong_limit_exceeded");
  });

  test("정상 배달은 completed 로 보인다", async () => {
    const { db, app } = setup();
    seed(db, "m2", [{ agent: "lisa", state: "completed" }]);
    const body = (await get(app, "m2")) as { recipients: Array<Record<string, unknown>> };
    expect(body.recipients[0]!.delivery_state).toBe("completed");
  });

  test("★수신자가 없으면 빈 배열★ — '모름' 과 구분되어야 한다", async () => {
    const { db, app } = setup();
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source)
       VALUES ('m3','t1','jane','lisa','dm','b','agent')`,
    ).run();
    const body = (await get(app, "m3")) as { recipients: unknown[] };
    expect(Array.isArray(body.recipients)).toBe(true);
    expect(body.recipients).toHaveLength(0);
  });

  test("여러 수신자 전부 준다 (broadcast)", async () => {
    const { db, app } = setup();
    seed(db, "m4", [
      { agent: "jane", state: "completed" },
      { agent: "lisa", state: "blocked", err: "blocked:x" },
    ]);
    const body = (await get(app, "m4")) as { recipients: unknown[] };
    expect(body.recipients).toHaveLength(2);
  });

  test("없는 id 는 404", async () => {
    const { app } = setup();
    const res = await app.request("/messages/nope");
    expect(res.status).toBe(404);
  });

  // ─── 사실 고정 (리사 요구 (b)) ───────────────────────────────────────────
  // ★변이 테스트가 아니라 '사실 고정' 이다★ — 두 컬럼이 실제로 어긋난다는 것 자체를 못박는다.
  //   나중에 누가 "delivery_status 로 충분한데?" 라고 할 때 이 단정이 근거가 된다.
  test("★같은 행에서 delivery_status='delivered' 인데 delivery_state='blocked' 다★ (실측 재현)", async () => {
    const { db, app } = setup();
    // 2026-07-30 차단된 메시지 l5T94re0n3p- 의 실제 값 조합을 그대로 재현한다.
    seed(db, "m5", [
      { agent: "jane", state: "blocked", err: "blocked:pingpong_limit_exceeded:rounds=8,max=8",
        status: "delivered", rstate: "acknowledged" },
    ]);
    const row = db.prepare(`SELECT delivery_status FROM message WHERE id='m5'`).get() as { delivery_status: string };
    const rec = db.prepare(`SELECT delivery_state, recipient_state FROM message_recipient WHERE message_id='m5'`)
      .get() as { delivery_state: string; recipient_state: string };
    expect(row.delivery_status).toBe("delivered");        // ★거짓★
    expect(rec.recipient_state).toBe("acknowledged");     // ★거짓★ (받은 적 없다)
    expect(rec.delivery_state).toBe("blocked");           // ✅ 진실

    // 그리고 API 는 ★진실만★ 노출한다 — 거짓 컬럼을 응답에 넣지 않는다.
    const body = (await get(app, "m5")) as { recipients: Array<Record<string, unknown>> };
    expect(body.recipients[0]!.delivery_state).toBe("blocked");
    expect(body.recipients[0]).not.toHaveProperty("delivery_status");
    expect(body.recipients[0]).not.toHaveProperty("recipient_state");
  });
});

// acceptInbound characterization tests — P2 안전망.
// 인라인이던 ingress 꼬리(dedupe→ensureThread→insertMessage→broadcast)를 추출한 acceptInbound가
// 핵심 불변식(completed-on-insert·dedupe·pending)을 보존하는지 핀. in-memory sqlite, 라이브 무관.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrate";
import { acceptInbound } from "./acceptInbound";

function setup(agents = ["bill", "steve"]): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of agents) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'persona.md')`,
    ).run(a, a);
  }
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','test','dm','["bill","steve"]','bill')`,
  ).run();
  return db;
}

const recipient = (db: Database, msgId: string, agentId: string) =>
  db.prepare(`SELECT * FROM message_recipient WHERE message_id=? AND agent_id=?`).get(msgId, agentId) as
    | Record<string, unknown>
    | undefined;

const env = (over: Record<string, unknown> = {}) => ({
  thread_id: "t1",
  from_agent_id: "bill",
  to_agent_id: "steve",
  body: "hello",
  source: "agent",
  type: "dm",
  ...over,
});

describe("acceptInbound — 채널 ingress 공통 꼬리 (P2)", () => {
  test("새 메시지 → ok:true + stored + broadcast 1회", () => {
    const db = setup();
    const events: Array<{ type: string }> = [];
    const r = acceptInbound(db, env() as never, { dedupeWindowSec: 60, broadcast: (e) => events.push(e as never) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stored.id).toBeTruthy();
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("message");
  });

  test("★불변식: USER 메시지 → recipient completed-on-insert", () => {
    const db = setup();
    const r = acceptInbound(db, env({ source: "user", from_agent_id: "user", to_agent_id: "steve" }) as never, {
      dedupeWindowSec: 60,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(recipient(db, r.stored.id, "steve")?.delivery_state).toBe("completed");
  });

  test("AGENT 메시지 → recipient pending (디스패처 대기)", () => {
    const db = setup();
    const r = acceptInbound(db, env({ source: "agent" }) as never, { dedupeWindowSec: 60 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(recipient(db, r.stored.id, "steve")?.delivery_state).toBe("pending");
  });

  // ★C fix (2026-07-16, GD): 개별보고 병합 = 스티브건★
  test("★C: direct_to_gd 보고 → recipient completed (수신자 안 깨움 = 병합 방지)", () => {
    const db = setup();
    // hermes 가 steve 에게 --direct-to-gd 로 답(개별보고). ingress 가 이미 GD DM 에 배달하므로
    //   steve 를 wake 후보로 만들면 안 된다 — N건이 몰리면 steve 가 릴레이하며 ★병합★.
    const r = acceptInbound(
      db,
      env({ source: "agent", meta: { reply_mode: "direct_to_gd" }, in_reply_to: "delegation-1" }) as never,
      { dedupeWindowSec: 60 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(recipient(db, r.stored.id, "steve")?.delivery_state).toBe("completed");
  });

  test("★C 반례: plain agent 답(수집 기여자)은 여전히 pending (수집 안 깨짐)", () => {
    const db = setup();
    // 수집 기여자 답은 --to collector plain(direct_to_gd 아님) → collector 를 깨워야 종합한다.
    const r = acceptInbound(db, env({ source: "agent" }) as never, { dedupeWindowSec: 60 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(recipient(db, r.stored.id, "steve")?.delivery_state).toBe("pending");
  });

  test("중복(같은 dedupe·window 내) → ok:false + duplicate id, 두번째 insert 안 함", () => {
    const db = setup();
    const e = env({ source: "user", from_agent_id: "user" });
    const r1 = acceptInbound(db, e as never, { dedupeWindowSec: 60 });
    expect(r1.ok).toBe(true);
    const r2 = acceptInbound(db, e as never, { dedupeWindowSec: 60 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.duplicate).toBeTruthy();
  });

  test("dedupe_key 미리지정 시 그 키 사용 (텔레그램 origin 레벨 — content-hash 재계산 안 함)", () => {
    const db = setup();
    const r1 = acceptInbound(db, env({ source: "user", from_agent_id: "user", dedupe_key: "tg:chat:99" }) as never, {
      dedupeWindowSec: 300,
    });
    expect(r1.ok).toBe(true);
    // 같은 dedupe_key면 본문이 달라도 중복으로 잡힘(= 키를 그대로 씀, body 해시 재계산 X)
    const r2 = acceptInbound(
      db,
      env({ source: "user", from_agent_id: "user", body: "완전 다른 본문", dedupe_key: "tg:chat:99" }) as never,
      { dedupeWindowSec: 300 },
    );
    expect(r2.ok).toBe(false);
  });

  test("순서 보존: onInserted(audit)가 broadcast '앞'에 실행 (Steve·Codex ②)", () => {
    const db = setup();
    const order: string[] = [];
    const r = acceptInbound(db, env({ source: "user", from_agent_id: "user" }) as never, {
      dedupeWindowSec: 60,
      onInserted: () => order.push("audit"),
      broadcast: () => order.push("broadcast"),
    });
    expect(r.ok).toBe(true);
    expect(order).toEqual(["audit", "broadcast"]); // 기존 insert→audit→broadcast 순서
  });

  test("broadcast/onInserted 정확히 1회 (성공 시) (Steve ④)", () => {
    const db = setup();
    const calls: string[] = [];
    acceptInbound(db, env({ source: "user", from_agent_id: "user" }) as never, {
      dedupeWindowSec: 60,
      onInserted: () => calls.push("audit"),
      broadcast: () => calls.push("broadcast"),
    });
    expect(calls.filter((c) => c === "broadcast").length).toBe(1);
    expect(calls.filter((c) => c === "audit").length).toBe(1);
  });

  test("중복이면 broadcast·onInserted 둘 다 호출 안 됨 (skip 경로)", () => {
    const db = setup();
    const calls: string[] = [];
    const e = env({ source: "user", from_agent_id: "user" });
    acceptInbound(db, e as never, { dedupeWindowSec: 60 }); // 1st insert
    const r2 = acceptInbound(db, e as never, {
      dedupeWindowSec: 60,
      onInserted: () => calls.push("audit"),
      broadcast: () => calls.push("broadcast"),
    });
    expect(r2.ok).toBe(false);
    expect(calls).toEqual([]); // dup → 어떤 콜백도 안 불림
  });
});

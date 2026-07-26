// 측정 W1 emit③ — request.created(acceptInbound) · ack.observed(applyAckClose) · episode_id 통일.
// ★로그 격리(팀 하드레슨): appendAuditFile이 라이브 logs/ 안 건드리게 temp dir.★
// 검증: (a)request.created=원요청만 (b)reply/broadcast 무emit (c)ack.observed=첫 open전이만·원요청 키
//       (d)request↔ack 같은 episode 조인 (e)re-ack/이미engaged/activity-auto-ack 무emit (f)best-effort (g)makeEpisodeId 단위.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { acceptInbound } from "../db/inbox/acceptInbound";
import { applyAckClose, applyActivityAutoAck, type ReplyLike } from "../bus/ackClose";
import { EVENT, LOOP_EVENT_SCHEMA, makeEpisodeId } from "./loopEvent";

let TMP: string;
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "w1-emit3-"));
  process.env.B3OS_AUDIT_LOG_DIR = TMP;
});
afterAll(() => {
  delete process.env.B3OS_AUDIT_LOG_DIR;
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function setup(agents = ["bill", "steve", "demis"]): Database {
  const db = new Database(":memory:");
  migrate(db);
  // main 이 나중에 넣은 metrics-emit 게이트(기본 OFF, 프로덕션 무영향)를 테스트에서 opt-in.
  //   이걸 안 켜면 emitLoopEventSafe 가 억제돼 emit③ 이벤트가 0건 → 테스트가 emit 부재를 오판(실측).
  db.prepare("INSERT OR REPLACE INTO setting(key, value) VALUES ('metrics_emit_enabled', 'on')").run();
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

const env = (over: Record<string, unknown> = {}) => ({
  thread_id: "t1",
  from_agent_id: "bill",
  to_agent_id: "steve",
  body: "please do X",
  source: "agent",
  type: "dm",
  ...over,
});

// 원 요청 메시지 + 수신자 open 행 수동 삽입(ack 경로 셋업 — mkOriginal 패턴).
function mkOriginal(db: Database, id: string, from = "bill", to = "steve") {
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source)
     VALUES (?, 't1', ?, ?, 'dm', 'please do X', 'agent')`,
  ).run(id, from, to);
  db.prepare(
    `INSERT INTO message_recipient (message_id, agent_id, delivery_state, recipient_state)
     VALUES (?, ?, 'wake_dispatched', 'open')`,
  ).run(id, to);
}

function reply(over: Partial<ReplyLike>): ReplyLike {
  return { id: "r1", from_agent_id: "steve", body: "완료했습니다", thread_id: "t1", in_reply_to: "orig1", source: "agent", type: "reply", ...over };
}

// audit_event 에서 loop_event 만 추출(raw detail — 내가 emit한 그대로 검증).
function loopEv(db: Database) {
  return (db.prepare(`SELECT action, detail_json FROM audit_event ORDER BY id`).all() as { action: string; detail_json: string }[])
    .map((r) => JSON.parse(r.detail_json) as Record<string, unknown>)
    .filter((d) => d?.schema === LOOP_EVENT_SCHEMA);
}
const byName = (db: Database, name: string) => loopEv(db).filter((d) => d.event_name === name);

describe("emit③ request.created (acceptInbound)", () => {
  test("directed 원요청 → request.created 1건 (episode=원msgid·first-seen)", () => {
    const db = setup();
    const r = acceptInbound(db, env() as never, { dedupeWindowSec: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const evs = byName(db, EVENT.request_created);
    expect(evs.length).toBe(1);
    expect(evs[0]!.request_message_id).toBe(r.stored.id);
    expect(evs[0]!.episode_id).toBe(`t1:${r.stored.id}`);
    expect(evs[0]!.actor).toBe("bill");
    expect(evs[0]!.target).toBe("steve");
    expect(evs[0]!.event_id).toBe(`req:${r.stored.id}`);
  });

  test("reply 인바운드(in_reply_to) → request.created 무emit", () => {
    const db = setup();
    acceptInbound(db, env({ type: "reply", in_reply_to: "someorig" }) as never, { dedupeWindowSec: 60 });
    expect(byName(db, EVENT.request_created).length).toBe(0);
  });

  test("broadcast → request.created 무emit (per-recipient ack 대상 아님)", () => {
    const db = setup();
    acceptInbound(db, env({ to_agent_id: "broadcast" }) as never, { dedupeWindowSec: 60 });
    expect(byName(db, EVENT.request_created).length).toBe(0);
  });

  test("dedupe로 막힌 재inbound(ok:false)는 무emit", () => {
    const db = setup();
    acceptInbound(db, env() as never, { dedupeWindowSec: 60 });
    acceptInbound(db, env() as never, { dedupeWindowSec: 60 }); // 동일 body → duplicate
    expect(byName(db, EVENT.request_created).length).toBe(1);
  });
});

describe("emit③ ack.observed (applyAckClose)", () => {
  test("첫 open→전이 → ack.observed 1건 (actor=owner·target=요청자·episode=원요청)", () => {
    const db = setup();
    mkOriginal(db, "orig1");
    const res = applyAckClose(db, reply({}));
    expect(res.applied).toBe(true);
    const evs = byName(db, EVENT.ack_observed);
    expect(evs.length).toBe(1);
    expect(evs[0]!.actor).toBe("steve"); // owner(응답자)
    expect(evs[0]!.target).toBe("bill"); // 원 요청자
    expect(evs[0]!.request_message_id).toBe("orig1");
    expect(evs[0]!.episode_id).toBe("t1:orig1"); // ★reply.id(r1) 아님 — 원요청 키★
    expect(evs[0]!.event_id).toBe("ack:orig1:steve");
  });

  test("★request↔ack 같은 episode로 조인 (통일 핵심)★", () => {
    const db = setup();
    const r = acceptInbound(db, env() as never, { dedupeWindowSec: 60 }); // request.created(episode t1:S)
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ackRes = applyAckClose(db, reply({ in_reply_to: r.stored.id, id: "reply-1" }));
    expect(ackRes.applied).toBe(true);
    const reqEp = byName(db, EVENT.request_created)[0]!.episode_id;
    const ackEp = byName(db, EVENT.ack_observed)[0]!.episode_id;
    expect(ackEp).toBe(reqEp); // 같은 episode → 요청→ack 조인 성립
  });

  test("이미 engaged(cur≠open) 전이 → ack.observed 무emit (분모 오염 방지)", () => {
    const db = setup();
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source)
       VALUES ('orig2','t1','bill','steve','dm','x','agent')`,
    ).run();
    db.prepare(
      `INSERT INTO message_recipient (message_id, agent_id, delivery_state, recipient_state)
       VALUES ('orig2','steve','wake_dispatched','acknowledged')`, // 이미 ack된 상태
    ).run();
    applyAckClose(db, reply({ in_reply_to: "orig2", body: "다 끝냈습니다 완료" }));
    expect(byName(db, EVENT.ack_observed).length).toBe(0);
  });

  test("re-ack(같은 reply 재적용) → 두번째는 무emit (첫 전이만)", () => {
    const db = setup();
    mkOriginal(db, "orig1");
    applyAckClose(db, reply({}));
    applyAckClose(db, reply({})); // 이미 open 아님 → noop
    expect(byName(db, EVENT.ack_observed).length).toBe(1);
  });

  test("activity-auto-ack(추론 ack) → ack.observed 무emit (spec §31)", () => {
    const db = setup();
    // 30초 grace 넘긴 open 행
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
       VALUES ('origold','t1','bill','steve','dm','x','agent', datetime('now','-120 seconds'))`,
    ).run();
    db.prepare(
      `INSERT INTO message_recipient (message_id, agent_id, delivery_state, recipient_state)
       VALUES ('origold','steve','wake_dispatched','open')`,
    ).run();
    const r = applyActivityAutoAck(db, "steve", "trigger-msg");
    expect(r.acked).toBeGreaterThanOrEqual(1);
    expect(byName(db, EVENT.ack_observed).length).toBe(0); // 추론 ack는 무emit
  });
});

describe("emit③ best-effort (측정 실패가 라이브 기능 안 깸)", () => {
  test("audit_event DROP → acceptInbound 여전히 ok:true·stored 커밋", () => {
    const db = setup();
    db.exec("DROP TABLE audit_event"); // emit(appendAudit INSERT) throw 유발
    const r = acceptInbound(db, env() as never, { dedupeWindowSec: 60 });
    expect(r.ok).toBe(true); // ★계측 실패해도 ingress 정상★
    if (r.ok) expect(r.stored.id).toBeTruthy();
  });

  test("emit 경로 실패(origin SELECT의 message 소실) → applyAckClose 여전히 상태 전이 적용", () => {
    // ★내 ack.observed 블록만 고립 실패시킴★: tier1(in_reply_to)은 message_recipient만 읽으므로
    //   recipient 행을 별도 삽입 후 message 테이블을 비우면, 기존 audit/ack-close는 정상이고 내 origin SELECT만 throw.
    const db = setup();
    db.exec("PRAGMA foreign_keys=OFF"); // orphan recipient 삽입 허용(고립 실패 주입용)
    db.prepare(
      `INSERT INTO message_recipient (message_id, agent_id, delivery_state, recipient_state)
       VALUES ('orig1','steve','wake_dispatched','open')`,
    ).run();
    db.exec("DROP TABLE message"); // 내 origin SELECT(from message)만 깨짐 — try/catch로 삼켜야 함
    const res = applyAckClose(db, reply({}));
    expect(res.applied).toBe(true); // ★측정 실패해도 ack-close 정상★
  });
});

describe("emit③ makeEpisodeId 통일 (spec §32)", () => {
  test("requestMessageId 우선(first-seen 고정) — task 붙어도 키 불변", () => {
    expect(makeEpisodeId("t1", { requestMessageId: "m9", taskId: "task5" })).toBe("t1:m9");
  });
  test("회귀0: requestMessageId 없으면 taskId fallback(emit④ tasks 경로 불변)", () => {
    expect(makeEpisodeId("task", { taskId: "task5" })).toBe("task:task5");
  });
  test("셋 다 없으면 '-'", () => {
    expect(makeEpisodeId("t1", {})).toBe("t1:-");
  });
});

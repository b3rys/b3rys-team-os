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

  // ★리뷰(Bill 2026-07-27)로 계약이 바뀐 지점★ — 예전엔 `in_reply_to` 가 있으면 무조건 무emit 이었다.
  //   그런데 우리 핵심룰이 버스 발신에 항상 `--in-reply-to` 를 붙이라고 해서, ★스레드 안에서 오는
  //   새 위임(실제 요청의 대다수)이 통째로 배제★ 됐다. ack 쪽은 그 배제를 모르니 ack.observed 는 그대로 떠서
  //   ★request 0 / ack 1 = 고아 ack + 분모 누락★ 이 됐다. 그래서 기준을 "ack 가능한 open 수신자 행을
  //   만들었는가" 로 바꿨다. 아래 두 테스트가 그 계약을 못박는다.
  test("★스레드 안 새 위임(in_reply_to 있음)도 request.created 1건★ — open 행을 만들면 요청이다", () => {
    const db = setup();
    const prev = acceptInbound(db, env({ body: "prev" }) as never, { dedupeWindowSec: 60 });
    expect(prev.ok).toBe(true);
    if (!prev.ok) return;
    const before = byName(db, EVENT.request_created).length;

    const r = acceptInbound(db, env({ body: "새 위임", in_reply_to: prev.stored.id }) as never, { dedupeWindowSec: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 이 메시지는 steve 에게 open 행을 만든다 = ack 이 날 수 있다 → request 로도 세어야 대칭이다
    const openRows = db
      .prepare(`SELECT COUNT(*) AS n FROM message_recipient WHERE message_id = ? AND recipient_state = 'open'`)
      .get(r.stored.id) as { n: number };
    expect(openRows.n).toBeGreaterThan(0);
    expect(byName(db, EVENT.request_created).length).toBe(before + 1);
  });

  test("★ack 이 불가능한 것은 request 로도 안 센다★ — open 행이 없으면 무emit", () => {
    const db = setup();
    // broadcast 수신자 행은 'acknowledged'(broadcast_fyi)로 생성돼 애초에 open 이 아니다.
    const r = acceptInbound(db, env({ to_agent_id: "broadcast" }) as never, { dedupeWindowSec: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const openRows = db
      .prepare(`SELECT COUNT(*) AS n FROM message_recipient WHERE message_id = ? AND recipient_state = 'open'`)
      .get(r.stored.id) as { n: number };
    expect(openRows.n).toBe(0);
    expect(byName(db, EVENT.request_created).length).toBe(0);
  });

  // ★Bill 권고★: broadcast 의 대칭을 request 쪽만 단언하면, 다른 모듈의 불변식(broadcast_fyi)이
  //   바뀔 때 ★조용히 깨진다★. request 와 ack 을 ★한 테스트에서 함께★ 못박는다.
  test("broadcast → request.created 0 ★그리고★ ack.observed 0 (대칭을 한 곳에서 고정)", () => {
    const db = setup();
    const r = acceptInbound(db, env({ to_agent_id: "broadcast" }) as never, { dedupeWindowSec: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 수신자 전원이 이미 acknowledged 라 ack 전이가 일어날 수 없다
    for (const who of ["steve", "demis"]) applyAckClose(db, { messageId: r.stored.id, agentId: who } as never);
    expect(byName(db, EVENT.request_created).length).toBe(0);
    expect(byName(db, EVENT.ack_observed).length).toBe(0);
  });

  // ─── 라벨(request_kind) — ★emit 여부에는 쓰지 않는다★ (Bill 판정 2026-07-27) ───────────
  //   "위임→응답" 과 "말 걸면 언제 답하나" 는 둘 다 볼 가치가 있지만 섞이면 둘 다 못 본다.
  //   그래서 emit 은 open 행 하나로 결정하고, 성격은 라벨로만 남겨 분석에서 나눈다.
  test("라벨: 선행 요청이 없으면 delegation", () => {
    const db = setup();
    const r = acceptInbound(db, env() as never, { dedupeWindowSec: 60 });
    expect(r.ok).toBe(true);
    expect(byName(db, EVENT.request_created)[0]!.request_kind).toBe("delegation");
  });

  test("★라벨: 내게 온 것에 답하면 followup★", () => {
    const db = setup();
    // bill → steve 질문
    const q = acceptInbound(db, env({ body: "질문" }) as never, { dedupeWindowSec: 60 });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    // steve → bill 답 (부모의 수신자가 steve = 나 → 내게 온 것에 답하는 것)
    const a = acceptInbound(
      db,
      env({ from_agent_id: "steve", to_agent_id: "bill", body: "답", in_reply_to: q.stored.id }) as never,
      { dedupeWindowSec: 60 },
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const ev = byName(db, EVENT.request_created).find((e) => e.request_message_id === a.stored.id);
    expect(ev?.request_kind).toBe("followup");
  });

  test("★라벨: 스레드 안 새 위임은 in_reply_to 가 있어도 delegation★ (이번 HIGH 의 그 케이스)", () => {
    const db = setup();
    // bill → steve 선행
    const prev = acceptInbound(db, env({ body: "prev" }) as never, { dedupeWindowSec: 60 });
    expect(prev.ok).toBe(true);
    if (!prev.ok) return;
    // bill → steve 새 위임 (부모의 수신자는 steve 인데 발신자는 bill = 내게 온 게 아니다)
    const r = acceptInbound(db, env({ body: "새 위임", in_reply_to: prev.stored.id }) as never, { dedupeWindowSec: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = byName(db, EVENT.request_created).find((e) => e.request_message_id === r.stored.id);
    expect(ev?.request_kind).toBe("delegation");
  });

  // ★Codex 리뷰(2026-07-27) 회귀★ — 부모가 broadcast/다중수신이면 to_agent_id 가 'broadcast' 라
  //   실제 수신자가 답해도 delegation 으로 오분류됐다. 수신 사실은 message_recipient 행이 정본이다.
  test("★부모가 broadcast 여도 실제 수신자가 답하면 followup★ (to_agent_id 대리값 금지)", () => {
    const db = setup();
    // 본문에 @all — 팀원 방 발언은 그 마커가 있어야 수신행이 생긴다(2026-08-01 규칙).
    //   이 시험이 재는 건 팬아웃이 아니라 ★수신자가 답하면 followup 으로 분류되는가★ 다.
    const b = acceptInbound(db, env({ to_agent_id: "broadcast", body: "@all 확인 부탁" }) as never, { dedupeWindowSec: 60 });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    // 부모의 to_agent_id 는 'broadcast' 지만, steve 는 수신자 행을 갖는다 = 받았다
    expect(
      (db.prepare(`SELECT to_agent_id FROM message WHERE id = ?`).get(b.stored.id) as { to_agent_id: string })
        .to_agent_id,
    ).toBe("broadcast");
    expect(
      db.prepare(`SELECT 1 FROM message_recipient WHERE message_id = ? AND agent_id = 'steve'`).get(b.stored.id),
    ).toBeTruthy();

    const r = acceptInbound(
      db,
      env({ from_agent_id: "steve", to_agent_id: "bill", body: "공지 답", in_reply_to: b.stored.id }) as never,
      { dedupeWindowSec: 60 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = byName(db, EVENT.request_created).find((e) => e.request_message_id === r.stored.id);
    expect(ev?.request_kind).toBe("followup");
  });

  test("★안 받은 사람이 그 부모를 인용해 보내면 delegation★ (수신 사실이 없으면 위임)", () => {
    const db = setup();
    // bill → steve 직접 (demis 는 수신자가 아니다)
    const q = acceptInbound(db, env({ body: "질문" }) as never, { dedupeWindowSec: 60 });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    // demis 가 그 메시지를 인용해 steve 에게 새 지시 → demis 는 부모 수신자가 아니므로 delegation
    const r = acceptInbound(
      db,
      env({ from_agent_id: "demis", to_agent_id: "steve", body: "이거 이어서 해줘", in_reply_to: q.stored.id }) as never,
      { dedupeWindowSec: 60 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = byName(db, EVENT.request_created).find((e) => e.request_message_id === r.stored.id);
    expect(ev?.request_kind).toBe("delegation");
  });

  test("★라벨은 emit 여부를 바꾸지 않는다★ — 두 종류 다 정확히 1건씩 emit", () => {
    const db = setup();
    const q = acceptInbound(db, env({ body: "질문" }) as never, { dedupeWindowSec: 60 });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    acceptInbound(
      db,
      env({ from_agent_id: "steve", to_agent_id: "bill", body: "답", in_reply_to: q.stored.id }) as never,
      { dedupeWindowSec: 60 },
    );
    const evs = byName(db, EVENT.request_created);
    expect(evs.length).toBe(2); // 라벨이 달라도 둘 다 emit — 대칭은 open 행이 정한다
    expect(evs.map((e) => e.request_kind).sort()).toEqual(["delegation", "followup"]);
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

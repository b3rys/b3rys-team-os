// 측정 지표 트랙 W1 — loop_event 계측 엔진 테스트.
// 핵심3+보조2 재계산(§2 event-only) + emit↔project 왕복 + route_decision projection(§7) + episode/정렬/dedupe.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import {
  EVENT,
  emitLoopEvent,
  emitLoopEventSafe,
  isMetricsEmitEnabled,
  makeEpisodeId,
  projectAuditRow,
  sortEvents,
  dedupeEvents,
  LOOP_EVENT_SCHEMA,
  type LoopEvent,
  type AuditRow,
} from "./loopEvent";
import {
  ackLatency,
  handoffLoss,
  verifiedClosure,
  reopenReworkRate,
  routingCorrectness,
  recomputeAll,
} from "./recompute";

let _id = 0;
function ev(name: string, p: Partial<LoopEvent> = {}): LoopEvent {
  _id += 1;
  return {
    event_id: p.event_id ?? `e${_id}`,
    event_name: name,
    schema_version: "0.2",
    occurred_at: p.occurred_at ?? "2026-07-02T03:00:00.000Z",
    episode_id: p.episode_id ?? "t1:task1",
    thread_id: p.thread_id ?? "t1",
    actor: p.actor ?? "bill",
    seq: p.seq ?? _id,
    ...p,
  };
}
const at = (s: string) => `2026-07-02T03:${s}.000Z`; // mm:ss 편의

afterEach(() => {
  delete process.env.B3OS_METRICS_EMIT;
});

describe("makeEpisodeId (Lui 보강① — '-' 금지)", () => {
  test("task 있으면 task 키", () => expect(makeEpisodeId("t1", { taskId: "k9" })).toBe("t1:k9"));
  test("task 없으면 request_message_id로 fallback(뭉침 방지)", () =>
    expect(makeEpisodeId("t1", { requestMessageId: "m42" })).toBe("t1:m42"));
});

describe("핵심① ack latency (parent 우선·quiet 제외)", () => {
  test("parent_event_id 직결 조인 + 초 단위 latency", () => {
    const events = [
      ev(EVENT.request_created, { event_id: "r1", occurred_at: at("00:00"), owner: "bill" }),
      ev(EVENT.ack_observed, { parent_event_id: "r1", occurred_at: at("02:00"), owner: "bill" }),
    ];
    const r = ackLatency(events);
    expect(r.acked).toBe(1);
    expect(r.missed).toBe(0);
    expect(r.p50Sec).toBe(120);
  });
  test("ack 없으면 miss", () => {
    const r = ackLatency([ev(EVENT.request_created, { event_id: "r9", owner: "bill" })]);
    expect(r.missed).toBe(1);
    expect(r.acked).toBe(0);
  });
  test("quiet_hours 요청은 SLA 산출 제외(별도 버킷)", () => {
    const events = [
      ev(EVENT.request_created, { event_id: "r1", occurred_at: at("00:00"), owner: "bill", quiet_hours: true }),
      ev(EVENT.ack_observed, { parent_event_id: "r1", occurred_at: at("05:00"), owner: "bill" }),
    ];
    const r = ackLatency(events);
    expect(r.acked).toBe(1);
    expect(r.quietExcluded).toBe(1);
    expect(r.p50Sec).toBeNull(); // 제외돼 산출값 없음
  });
});

describe("핵심② handoff loss (parent 조인·window)", () => {
  test("응답 없으면 loss", () => {
    const r = handoffLoss([ev(EVENT.handoff_sent, { event_id: "h1" })]);
    expect(r.loss).toBe(1);
    expect(r.rate).toBe(1);
  });
  test("window 내 ack면 loss 아님", () => {
    const events = [
      ev(EVENT.handoff_sent, { event_id: "h1", occurred_at: at("00:00") }),
      ev(EVENT.handoff_acknowledged, { parent_event_id: "h1", occurred_at: at("05:00") }),
    ];
    expect(handoffLoss(events).loss).toBe(0);
  });
  test("window 초과 응답은 loss", () => {
    const events = [
      ev(EVENT.handoff_sent, { event_id: "h1", occurred_at: "2026-07-01T00:00:00.000Z" }),
      ev(EVENT.handoff_acknowledged, { parent_event_id: "h1", occurred_at: "2026-07-03T00:00:00.000Z" }),
    ];
    expect(handoffLoss(events, 86_400).loss).toBe(1); // 48h > 24h
  });
});

describe("핵심③ verified closure (evidence+visible, 사후정정 강등)", () => {
  test("evidence+visible surface = verified", () => {
    const events = [
      ev(EVENT.task_closed, { episode_id: "t1:k1" }),
      ev(EVENT.closure_verified, { event_id: "v1", episode_id: "t1:k1", evidence_ref: "report#42", visible_surface: "telegram_group" }),
    ];
    const r = verifiedClosure(events);
    expect(r.verified).toBe(1);
    expect(r.rate).toBe(1);
  });
  test("사후 reopen(closure.corrected) → verified 강등", () => {
    const events = [
      ev(EVENT.task_closed, { episode_id: "t1:k1" }),
      ev(EVENT.closure_verified, { event_id: "v1", episode_id: "t1:k1", evidence_ref: "r", visible_surface: "slack" }),
      ev(EVENT.closure_corrected, { correction_of_event_id: "v1", episode_id: "t1:k1" }),
    ];
    expect(verifiedClosure(events).verified).toBe(0);
  });
  test("visible surface 아니면 verified 아님 + policy.violation = hard penalty", () => {
    const events = [
      ev(EVENT.task_closed, { episode_id: "t1:k1" }),
      ev(EVENT.closure_verified, { episode_id: "t1:k1", evidence_ref: "r", visible_surface: "none" }),
      ev(EVENT.policy_violation, {}),
    ];
    const r = verifiedClosure(events);
    expect(r.verified).toBe(0);
    expect(r.hardPenalty).toBe(1);
  });
});

describe("보조① reopen/rework rate (72h close 기준)", () => {
  test("72h 내 reopen이면 카운트", () => {
    const events = [
      ev(EVENT.task_closed, { episode_id: "t1:k1", occurred_at: "2026-07-02T00:00:00.000Z" }),
      ev(EVENT.thread_reopened, { episode_id: "t1:k1", occurred_at: "2026-07-03T00:00:00.000Z" }),
    ];
    expect(reopenReworkRate(events).reopened).toBe(1);
  });
  test("72h 지난 reopen은 제외", () => {
    const events = [
      ev(EVENT.task_closed, { episode_id: "t1:k1", occurred_at: "2026-07-02T00:00:00.000Z" }),
      ev(EVENT.rework_requested, { episode_id: "t1:k1", occurred_at: "2026-07-06T00:00:00.000Z" }),
    ];
    expect(reopenReworkRate(events).reopened).toBe(0);
  });
});

describe("보조② routing correctness (resolved_owner vs 응답자)", () => {
  test("resolved_owner == 응답자면 correct", () => {
    const events = [
      ev(EVENT.routing_resolved, { episode_id: "t1:k1", resolved_owner: "demis", method: "inference" }),
      ev(EVENT.ack_observed, { episode_id: "t1:k1", owner: "demis" }),
    ];
    expect(routingCorrectness(events).correct).toBe(1);
  });
  test("mention이면 mentioned_set 포함도 correct", () => {
    const events = [
      ev(EVENT.routing_resolved, { episode_id: "t1:k1", resolved_owner: "x", method: "mention", mentioned_set: ["demis", "bill"] }),
      ev(EVENT.ack_observed, { episode_id: "t1:k1", owner: "bill" }),
    ];
    expect(routingCorrectness(events).correct).toBe(1);
  });
  test("불일치 = incorrect(응답 있는 것만 분모)", () => {
    const events = [
      ev(EVENT.routing_resolved, { episode_id: "t1:k1", resolved_owner: "demis", method: "sticky" }),
      ev(EVENT.ack_observed, { episode_id: "t1:k1", owner: "steve" }),
      ev(EVENT.routing_resolved, { episode_id: "t1:k2", resolved_owner: "bill", method: "sticky" }), // ack 없음 → 분모 제외
    ];
    const r = routingCorrectness(events);
    expect(r.withAck).toBe(1);
    expect(r.correct).toBe(0);
    expect(r.rate).toBe(0);
  });
});

describe("emit ↔ project 왕복 + route_decision projection (§7)", () => {
  test("isMetricsEmitEnabled: default OFF, setting ON, env hard override", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(isMetricsEmitEnabled(db)).toBe(false);

    expect(isMetricsEmitEnabled(new Database(":memory:"))).toBe(false); // no schema/setting table → safe default OFF
    const dbWithSetting = new Database(":memory:");
    migrate(dbWithSetting);
    dbWithSetting.prepare(`INSERT OR REPLACE INTO setting (key,value) VALUES ('metrics_emit_enabled','on')`).run();
    expect(isMetricsEmitEnabled(dbWithSetting)).toBe(true);

    process.env.B3OS_METRICS_EMIT = "off";
    expect(isMetricsEmitEnabled(dbWithSetting)).toBe(false);
    process.env.B3OS_METRICS_EMIT = "true";
    dbWithSetting.prepare(`UPDATE setting SET value='off' WHERE key='metrics_emit_enabled'`).run();
    expect(isMetricsEmitEnabled(dbWithSetting)).toBe(true);
  });

  test("emitLoopEventSafe는 flag OFF면 appendAudit 전에 즉시 return", () => {
    const db = new Database(":memory:");
    migrate(db);
    emitLoopEventSafe(db, ev(EVENT.ack_observed, { event_id: "ack-off" }));
    const count = db.prepare(`SELECT COUNT(*) AS count FROM audit_event`).get() as { count: number };
    expect(count.count).toBe(0);
  });

  test("emitLoopEvent → audit_event → projectAuditRow 왕복(native)", () => {
    const db = new Database(":memory:");
    migrate(db);
    emitLoopEvent(db, ev(EVENT.ack_observed, { event_id: "ack1", episode_id: "t1:k1", owner: "bill" }));
    const row = db
      .prepare(`SELECT id, actor, action, target, detail_json, at FROM audit_event WHERE action=?`)
      .get(EVENT.ack_observed) as { id: number; actor: string; action: string; target: string | null; detail_json: string; at: string };
    const audit: AuditRow = { id: row.id, actor: row.actor, action: row.action, target: row.target, detail: JSON.parse(row.detail_json), at: row.at };
    const projected = projectAuditRow(audit);
    expect(projected?.event_id).toBe("ack1");
    expect(projected?.event_name).toBe(EVENT.ack_observed);
    expect(projected?.owner).toBe("bill");
    expect(projected?.seq).toBe(row.id);
  });

  test("legacy route_decision → routing.resolved 합성(event_id·episode·method·mentioned)", () => {
    const row: AuditRow = {
      id: 77,
      actor: "router",
      action: "route_decision",
      target: "msg preview",
      detail: { via: "mention", targets: ["demis"], reason: "mentioned", outcome: "assigned", activeAssigneeId: "demis" },
      at: at("00:00"),
    };
    const p = projectAuditRow(row, { threadId: "t1", requestMessageId: "m42", parentEventId: "req:1" });
    expect(p?.event_name).toBe(EVENT.routing_resolved);
    expect(p?.event_id).toBe("proj:route:77");
    expect(p?.episode_id).toBe("t1:m42"); // task 없어 request_message_id fallback
    expect(p?.method).toBe("mention");
    expect(p?.resolved_owner).toBe("demis");
    expect(p?.mentioned_set).toEqual(["demis"]);
    expect(p?.parent_event_id).toBe("req:1");
  });

  test("측정 비대상 audit → null", () => {
    const row: AuditRow = { id: 1, actor: "x", action: "some_other_action", target: null, detail: {}, at: at("00:00") };
    expect(projectAuditRow(row)).toBeNull();
  });
});

describe("정렬·dedupe (§7 contract)", () => {
  test("sortEvents = (occurred_at, seq) 안정 정렬", () => {
    const out = sortEvents([
      ev("x", { occurred_at: at("02:00"), seq: 5 }),
      ev("x", { occurred_at: at("01:00"), seq: 9 }),
      ev("x", { occurred_at: at("01:00"), seq: 3 }),
    ]);
    expect(out.map((e) => e.seq)).toEqual([3, 9, 5]);
  });
  test("dedupeEvents = event_id 멱등", () => {
    const out = dedupeEvents([ev("x", { event_id: "d1" }), ev("x", { event_id: "d1" }), ev("x", { event_id: "d2" })]);
    expect(out.length).toBe(2);
  });
});

describe("recomputeAll — 통합 episode(gold-style)", () => {
  test("한 episode: 요청→라우팅→ack→핸드오프→closed→verified 전 지표 산출", () => {
    const events = [
      ev(EVENT.request_created, { event_id: "r1", episode_id: "t1:k1", occurred_at: at("00:00"), owner: "demis" }),
      ev(EVENT.routing_resolved, { episode_id: "t1:k1", resolved_owner: "demis", method: "inference" }),
      ev(EVENT.ack_observed, { parent_event_id: "r1", episode_id: "t1:k1", occurred_at: at("01:30"), owner: "demis" }),
      ev(EVENT.handoff_sent, { event_id: "h1", episode_id: "t1:k1", occurred_at: at("02:00") }),
      ev(EVENT.handoff_acknowledged, { parent_event_id: "h1", episode_id: "t1:k1", occurred_at: at("04:00") }),
      ev(EVENT.task_closed, { episode_id: "t1:k1", occurred_at: at("10:00") }),
      ev(EVENT.closure_verified, { event_id: "v1", episode_id: "t1:k1", evidence_ref: "report#1", visible_surface: "telegram_group" }),
    ];
    const m = recomputeAll(sortEvents(dedupeEvents(events)));
    expect(m.ackLatency.p50Sec).toBe(90);
    expect(m.handoffLoss.loss).toBe(0);
    expect(m.verifiedClosure.verified).toBe(1);
    expect(m.reopenRework.reopened).toBe(0);
    expect(m.routingCorrectness.correct).toBe(1);
  });
});

/**
 * Pending follow-up tracker — deterministic (no LLM). Covers the all-of creation gate
 * (one-shot recipient AND direct_to_gd/team-lead-destined AND expect_report_by), member↔member
 * exclusion, fulfillment by a substantive report, ack-only NOT counting, re-wake on miss, and
 * one-fire (a fired row never fires twice).
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { runBusMigration, migratePendingFollowup } from "../db/migrate";
import {
  createSelfFollowup,
  maybeCreatePendingFollowup,
  createPendingFollowup,
  checkPendingFollowups,
  parseDurationSec,
  resolveDeadline,
  isOneShotRuntime,
} from "./followupTracker";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url).pathname, "utf8"));
  runBusMigration(db); // adds message_recipient bus columns used by insertMessage/acceptInbound
  migratePendingFollowup(db);
  const agent = (id: string, runtime: string, sp: string) =>
    db
      .prepare(
        `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
         VALUES (?, ?, 'x', ?, ?, '/tmp', '/tmp/x')`,
      )
      .run(id, id, runtime, sp);
  agent("luna", "openclaw", "openclaw_gateway"); // one-shot
  agent("hermy", "hermes_agent", "hermes_gateway"); // one-shot
  agent("bill", "claude_channel", "claude_tmux"); // continuous session — never tracked
  agent("gd", "claude_channel", "claude_tmux"); // requester/target
  return db;
}

function countRows(db: Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM pending_followup`).get() as { n: number }).n;
}

function insertMsg(
  db: Database,
  opts: { id: string; from: string; to: string; thread: string | null; body: string; created: string; meta?: string },
): void {
  // thread FK: ensure a thread row exists when a thread id is given.
  if (opts.thread) {
    db.prepare(
      `INSERT OR IGNORE INTO thread (id, title, kind, participants_json, opened_by) VALUES (?, 't','dm','[]','gd')`,
    ).run(opts.thread);
  }
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at, meta_json)
     VALUES (?, ?, ?, ?, 'dm', ?, 'agent', ?, ?)`,
  ).run(opts.id, opts.thread ?? "tnull", opts.from, opts.to, opts.body, opts.created, opts.meta ?? null);
}

// A due, unfired follow-up row with fully controlled timing.
function insertDueFollowup(
  db: Database,
  opts: { id: string; recipient: string; target: string; thread: string | null; created?: string; deadline?: string },
): void {
  if (opts.thread) {
    db.prepare(
      `INSERT OR IGNORE INTO thread (id, title, kind, participants_json, opened_by) VALUES (?, 't','dm','[]','gd')`,
    ).run(opts.thread);
  }
  db.prepare(
    `INSERT INTO pending_followup
       (id, recipient_agent_id, target_agent_id, thread_id, source_message_id, deadline_at, created_at, fired)
     VALUES (?, ?, ?, ?, 'srcmsg', ?, ?, 0)`,
  ).run(
    opts.id,
    opts.recipient,
    opts.target,
    opts.thread,
    opts.deadline ?? "2000-01-01 00:00:00", // past → due
    opts.created ?? "2000-01-01 00:00:00",
  );
}

function rewakeMsgs(db: Database, recipient: string): Array<{ body: string }> {
  return db
    .prepare(`SELECT body FROM message WHERE from_agent_id = 'system' AND to_agent_id = ?`)
    .all(recipient) as Array<{ body: string }>;
}

describe("followupTracker — duration parsing", () => {
  test("parseDurationSec handles s/m/h + bare minutes", () => {
    expect(parseDurationSec("30s")).toBe(30);
    expect(parseDurationSec("10m")).toBe(600);
    expect(parseDurationSec("2h")).toBe(7200);
    expect(parseDurationSec("15")).toBe(900); // bare → minutes
    expect(parseDurationSec("garbage")).toBeNull();
    expect(parseDurationSec("0m")).toBeNull();
    expect(parseDurationSec("")).toBeNull();
  });
  test("resolveDeadline produces a sqlite-format absolute time", () => {
    const d = resolveDeadline("10m", new Date("2026-07-10T00:00:00Z"));
    expect(d).toBe("2026-07-10 00:10:00");
    expect(resolveDeadline("bad")).toBeNull();
  });
  test("isOneShotRuntime only openclaw/hermes_agent", () => {
    expect(isOneShotRuntime("openclaw")).toBe(true);
    expect(isOneShotRuntime("hermes_agent")).toBe(true);
    expect(isOneShotRuntime("claude_channel")).toBe(false);
    expect(isOneShotRuntime("codex")).toBe(false);
    expect(isOneShotRuntime(null)).toBe(false);
  });
});

describe("followupTracker — creation gate (all-of: one-shot + direct_to_gd + expect_report_by)", () => {
  let db: Database;
  beforeEach(() => (db = freshDb()));

  test("(a) one-shot (openclaw/hermes) + direct_to_gd + expect_report_by → row created", () => {
    const id1 = maybeCreatePendingFollowup(db, {
      toAgentId: "luna",
      threadId: "th1",
      sourceMessageId: "m1",
      expectReportBy: "10m",
      replyMode: "direct_to_gd",
    });
    const id2 = maybeCreatePendingFollowup(db, {
      toAgentId: "hermy",
      threadId: "th2",
      sourceMessageId: "m2",
      expectReportBy: "30m",
      replyMode: "direct_to_gd",
    });
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(countRows(db)).toBe(2);
    // the stored target is the GENERIC role marker, never a user name/chat id (public-portable).
    const target = (db.prepare(`SELECT target_agent_id FROM pending_followup WHERE id=?`).get(id1!) as { target_agent_id: string }).target_agent_id;
    expect(target).toBe("team_lead");
  });

  test("(b) claude recipient (or unknown) → NO row, even with direct_to_gd", () => {
    expect(
      maybeCreatePendingFollowup(db, {
        toAgentId: "bill",
        threadId: "th",
        sourceMessageId: "m",
        expectReportBy: "10m",
        replyMode: "direct_to_gd",
      }),
    ).toBeNull();
    expect(
      maybeCreatePendingFollowup(db, {
        toAgentId: "nobody",
        threadId: "th",
        sourceMessageId: "m",
        expectReportBy: "10m",
        replyMode: "direct_to_gd",
      }),
    ).toBeNull();
    expect(countRows(db)).toBe(0);
  });

  test("(c) member→member request (no direct_to_gd) → NO row, even on a one-shot recipient", () => {
    // one-shot recipient + expect_report_by set, but NOT destined for the team lead → out of scope.
    expect(
      maybeCreatePendingFollowup(db, {
        toAgentId: "luna",
        threadId: "th",
        sourceMessageId: "m",
        expectReportBy: "10m",
        replyMode: null, // plain member↔member directed request
      }),
    ).toBeNull();
    expect(
      maybeCreatePendingFollowup(db, {
        toAgentId: "hermy",
        threadId: "th",
        sourceMessageId: "m",
        expectReportBy: "10m",
        replyMode: "reply", // some other reply mode, still not direct_to_gd
      }),
    ).toBeNull();
    expect(countRows(db)).toBe(0);
  });

  test("no expect_report_by / unparseable duration → no row even for one-shot + direct_to_gd", () => {
    expect(
      maybeCreatePendingFollowup(db, { toAgentId: "luna", threadId: "t", sourceMessageId: "m", expectReportBy: null, replyMode: "direct_to_gd" }),
    ).toBeNull();
    expect(
      maybeCreatePendingFollowup(db, { toAgentId: "luna", threadId: "t", sourceMessageId: "m", expectReportBy: "soon", replyMode: "direct_to_gd" }),
    ).toBeNull();
    expect(countRows(db)).toBe(0);
  });
});

describe("followupTracker — deadline check (step 3)", () => {
  let db: Database;
  beforeEach(() => (db = freshDb()));

  test("(d) deadline + substantive report exists → row deleted, no re-wake", () => {
    insertDueFollowup(db, { id: "pf1", recipient: "luna", target: "gd", thread: "th1" });
    insertMsg(db, {
      id: "rep1",
      from: "luna",
      to: "gd",
      thread: "th1",
      body: "결과는 3건이고 이슈 2개를 발견했습니다. 상세는 아래.",
      created: "2000-01-01 00:05:00",
    });
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual(["pf1"]);
    expect(r.rewoken).toEqual([]);
    expect(countRows(db)).toBe(0);
    expect(rewakeMsgs(db, "luna").length).toBe(0);
  });

  test("(d2) HARNESS-B: openclaw delivery AUDIT with NO message row → fulfilled, NO re-wake (real adapter path — no dup)", () => {
    // openclaw posts the direct_to_gd report straight to the owner DM and writes NO message row — only a
    // 'gd_report_delivered' DB audit. The old message-only scan missed this → false re-wake → DUPLICATE GD
    // DM report on ~every success. The audit-based fulfillment must catch it.
    insertDueFollowup(db, { id: "pfA", recipient: "luna", target: "gd", thread: "thA" });
    // openclaw's gd_report_delivered target = the dispatched message id = the follow-up's source_message_id ('srcmsg').
    db.prepare(`INSERT INTO audit_event (actor, action, target, detail_json, at) VALUES ('luna','gd_report_delivered','srcmsg',?,'2000-01-01 00:05:00')`)
      .run(JSON.stringify({ to: "direct_to_gd", via: "openclaw" }));
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual(["pfA"]);
    expect(r.rewoken).toEqual([]);
    expect(rewakeMsgs(db, "luna").length).toBe(0); // no duplicate report
  });

  test("(d2x) codex/demis fix-review: openclaw delivery for a DIFFERENT source msg does NOT fulfill this row (no missing reminder)", () => {
    insertDueFollowup(db, { id: "pfX", recipient: "luna", target: "gd", thread: "thX" });
    // same agent delivered a report, but for ANOTHER task (target != this row's source_message_id 'srcmsg')
    db.prepare(`INSERT INTO audit_event (actor, action, target, detail_json, at) VALUES ('luna','gd_report_delivered','OTHER_msg',?,'2000-01-01 00:05:00')`)
      .run(JSON.stringify({ to: "direct_to_gd", via: "openclaw" }));
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual([]); // NOT falsely fulfilled
    expect(r.rewoken).toEqual(["pfX"]);
  });

  test("(d3x) hermes delivery on a DIFFERENT thread does NOT fulfill this row", () => {
    insertDueFollowup(db, { id: "pfY", recipient: "hermy", target: "gd", thread: "thY" });
    db.prepare(`INSERT INTO audit_event (actor, action, target, detail_json, at) VALUES ('hermy','message_sent',null,?,'2000-01-01 00:05:00')`)
      .run(JSON.stringify({ thread_id: "OTHER_thread", to: "direct_to_gd", via: "hermes_agent" }));
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual([]);
    expect(r.rewoken).toEqual(["pfY"]);
  });

  test("(d3) HARNESS-B: hermes message_sent/direct_to_gd AUDIT with NO message row → fulfilled, NO re-wake", () => {
    insertDueFollowup(db, { id: "pfB", recipient: "hermy", target: "gd", thread: "thB" });
    db.prepare(`INSERT INTO audit_event (actor, action, target, detail_json, at) VALUES ('hermy','message_sent',null,?,'2000-01-01 00:05:00')`)
      .run(JSON.stringify({ thread_id: "thB", to: "direct_to_gd", via: "hermes_agent" }));
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual(["pfB"]);
    expect(r.rewoken).toEqual([]);
  });

  test("(d4) an UNRELATED audit (not a delivery) does NOT falsely fulfill → still re-wakes", () => {
    insertDueFollowup(db, { id: "pfC", recipient: "luna", target: "gd", thread: "thC" });
    db.prepare(`INSERT INTO audit_event (actor, action, target, detail_json, at) VALUES ('luna','message_sent',null,?,'2000-01-01 00:05:00')`)
      .run(JSON.stringify({ thread_id: "thC", to: "steve" })); // normal bus reply, NOT direct_to_gd
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual([]);
    expect(r.rewoken).toEqual(["pfC"]);
  });

  test("(e) deadline + only an ack (알았습니다) → NOT fulfilled → re-wake + fired", () => {
    insertDueFollowup(db, { id: "pf2", recipient: "luna", target: "gd", thread: "th2" });
    insertMsg(db, { id: "ack1", from: "luna", to: "gd", thread: "th2", body: "알았습니다", created: "2000-01-01 00:05:00" });
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual([]);
    expect(r.rewoken).toEqual(["pf2"]);
    expect(rewakeMsgs(db, "luna").length).toBe(1);
    const fired = (db.prepare(`SELECT fired FROM pending_followup WHERE id='pf2'`).get() as { fired: number }).fired;
    expect(fired).toBe(1);
  });

  test("(f) deadline + no message → re-wake + fired", () => {
    insertDueFollowup(db, { id: "pf3", recipient: "hermy", target: "gd", thread: "th3" });
    const r = checkPendingFollowups(db);
    expect(r.rewoken).toEqual(["pf3"]);
    expect(rewakeMsgs(db, "hermy").length).toBe(1);
    const fired = (db.prepare(`SELECT fired FROM pending_followup WHERE id='pf3'`).get() as { fired: number }).fired;
    expect(fired).toBe(1);
  });

  test("(g) a fired row never fires twice", () => {
    insertDueFollowup(db, { id: "pf4", recipient: "luna", target: "gd", thread: "th4" });
    const first = checkPendingFollowups(db);
    expect(first.rewoken).toEqual(["pf4"]);
    // Second sweep: still due, still no report, but fired=1 → must be a no-op.
    const second = checkPendingFollowups(db);
    expect(second.rewoken).toEqual([]);
    expect(second.fulfilled).toEqual([]);
    expect(rewakeMsgs(db, "luna").length).toBe(1); // exactly one re-wake ever
  });

  test("(h) GC: report lands AFTER the re-wake fired → fired row cleaned, no second poke", () => {
    // deadline just past `now` so the grace window (now-24h) does NOT apply — isolates the report path.
    insertDueFollowup(db, {
      id: "pfg1", recipient: "luna", target: "gd", thread: "thg1",
      deadline: "2026-07-10 00:00:00", created: "2026-07-10 00:00:00",
    });
    const first = checkPendingFollowups(db, { now: new Date("2026-07-10T00:05:00Z") });
    expect(first.rewoken).toEqual(["pfg1"]); // fired once
    // the report finally arrives, late
    insertMsg(db, { id: "lrep", from: "luna", to: "gd", thread: "thg1", body: "결과 보고: 3건 처리 완료, 이슈 없음.", created: "2026-07-10 00:06:00" });
    const second = checkPendingFollowups(db, { now: new Date("2026-07-10T00:07:00Z") });
    expect(second.gc).toEqual(["pfg1"]);
    expect(countRows(db)).toBe(0);
    expect(rewakeMsgs(db, "luna").length).toBe(1); // still exactly one re-wake ever (no double-send)
  });

  test("(i) GC: fired row past the grace window with no report → dropped, never re-poked", () => {
    db.prepare(
      `INSERT INTO pending_followup (id, recipient_agent_id, target_agent_id, thread_id, source_message_id, deadline_at, created_at, fired)
       VALUES ('pfg2','luna','gd',NULL,'src','2026-07-08 00:00:00','2026-07-08 00:00:00',1)`,
    ).run();
    const r = checkPendingFollowups(db, { now: new Date("2026-07-10T00:00:00Z") }); // >24h past deadline
    expect(r.gc).toEqual(["pfg2"]);
    expect(countRows(db)).toBe(0);
    expect(rewakeMsgs(db, "luna").length).toBe(0); // grace-expiry never sends a message
  });

  test("(j) fired row still within grace, no report → kept, NOT re-poked (중복보다 안 옴)", () => {
    db.prepare(
      `INSERT INTO pending_followup (id, recipient_agent_id, target_agent_id, thread_id, source_message_id, deadline_at, created_at, fired)
       VALUES ('pfg3','luna','gd',NULL,'src','2026-07-09 23:00:00','2026-07-09 23:00:00',1)`,
    ).run();
    const r = checkPendingFollowups(db, { now: new Date("2026-07-10T00:00:00Z") }); // 1h past, within grace
    expect(r.gc).toEqual([]);
    expect(countRows(db)).toBe(1); // still tracked
    expect(rewakeMsgs(db, "luna").length).toBe(0); // fired=0 loop skips it → no duplicate send
  });

  test("not-yet-due rows are left alone", () => {
    createPendingFollowup(db, {
      recipientAgentId: "luna",
      targetAgentId: "gd",
      threadId: "th5",
      sourceMessageId: "m5",
      deadlineAt: "2999-01-01 00:00:00", // far future
    });
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual([]);
    expect(r.rewoken).toEqual([]);
    expect(countRows(db)).toBe(1);
  });

  test("ack BEFORE the row is not mistaken for a report (created_at strictly after)", () => {
    // report predates the follow-up row → must NOT count as fulfilling it.
    insertDueFollowup(db, {
      id: "pf6",
      recipient: "luna",
      target: "gd",
      thread: "th6",
      created: "2000-01-01 00:10:00",
    });
    insertMsg(db, {
      id: "old",
      from: "luna",
      to: "gd",
      thread: "th6",
      body: "지난 보고 내용입니다 상세 결과 있음",
      created: "2000-01-01 00:05:00", // before the row
    });
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual([]);
    expect(r.rewoken).toEqual(["pf6"]);
  });
});

describe("createSelfFollowup (응답가드 자가등록, GD 2026-07-18)", () => {
  test("턴기반(openclaw) 등록자는 기본 10분 기한으로 row 가 생긴다 (합성 selfreg_ source id)", () => {
    const db = freshDb();
    const now = new Date("2026-07-18T03:00:00Z");
    const r = createSelfFollowup(db, { agentId: "luna", threadId: "work-thread-1", now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deadlineAt).toBe("2026-07-18 03:10:00"); // +10m 기본값
    const row = db.prepare("SELECT * FROM pending_followup WHERE id = ?").get(r.id) as any;
    expect(row.recipient_agent_id).toBe("luna");
    expect(row.thread_id).toBe("work-thread-1");
    expect(String(row.source_message_id).startsWith("selfreg_")).toBe(true); // NULL 금지 — audit 결합 SQL 이 '=NULL' 로 전부 불일치하는 함정
    expect(row.fired).toBe(0);
  });

  test("비-턴기반(claude_channel) 등록자는 ★명시적 reason★ 으로 거절된다 (조용한 no-op 금지)", () => {
    const db = freshDb();
    const r = createSelfFollowup(db, { agentId: "bill", threadId: "t" });
    expect(r).toEqual({ ok: false, reason: "not_one_shot_runtime" });
    expect((db.prepare("SELECT COUNT(*) c FROM pending_followup").get() as any).c).toBe(0);
  });

  test("thread 없음·기한 해석불가는 각각의 reason 으로 거절", () => {
    const db = freshDb();
    expect(createSelfFollowup(db, { agentId: "luna", threadId: "  " })).toEqual({ ok: false, reason: "missing_thread" });
    expect(createSelfFollowup(db, { agentId: "luna", threadId: "t", duration: "banana" })).toEqual({ ok: false, reason: "bad_duration" });
  });


  test("(회귀·hermes 2026-07-18) 다른 thread 의 direct_to_gd 보고는 ★thread 있는 row 를 fulfil 못 한다★ — 재알림이 맞다", () => {
    const db = freshDb();
    insertDueFollowup(db, { id: "pfA", recipient: "luna", target: "gd", thread: "thA" });
    insertMsg(db, {
      id: "repB", from: "luna", to: "gd", thread: "thB",
      body: "다른 작업 결과는 5건이고 상세 내역은 아래와 같습니다.",
      created: "2000-01-01 00:05:00",
      meta: JSON.stringify({ reply_mode: "direct_to_gd" }),
    });
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual([]); // thB 보고가 thA row 를 조용히 완료 처리하면 = 보고 유실
    expect(r.rewoken).toEqual(["pfA"]);
  });

  test("(회귀 짝) thread-NULL row 는 direct_to_gd meta 단독으로 여전히 fulfil 된다 (기존 동작 보존)", () => {
    const db = freshDb();
    insertDueFollowup(db, { id: "pfN", recipient: "luna", target: "gd", thread: null });
    insertMsg(db, {
      id: "repX", from: "luna", to: "gd", thread: "any-thread",
      body: "보고드립니다. 결과는 3건이고 이슈 없습니다.",
      created: "2000-01-01 00:05:00",
      meta: JSON.stringify({ reply_mode: "direct_to_gd" }),
    });
    const r = checkPendingFollowups(db);
    expect(r.fulfilled).toEqual(["pfN"]);
    expect(r.rewoken).toEqual([]);
  });

  test("자가등록 row 는 기존 워커 경로에서 정상 발화하고 ★딱 한 번★ 만 운다", () => {
    const db = freshDb();
    const now = new Date("2026-07-18T03:00:00Z");
    const r = createSelfFollowup(db, { agentId: "luna", threadId: "work-thread-2", now });
    expect(r.ok).toBe(true);
    const later = new Date("2026-07-18T03:11:00Z");
    const first = checkPendingFollowups(db, { now: later });
    expect(first.rewoken.length).toBe(1);
    const second = checkPendingFollowups(db, { now: new Date("2026-07-18T03:20:00Z") });
    expect(second.rewoken.length).toBe(0); // 1회성 — fired=1 재발화 없음
  });
});

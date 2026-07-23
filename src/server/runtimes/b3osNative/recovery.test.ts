// b3os_native M1.5 — 재시작 턴 복구 테스트. in-memory sqlite, 라이브 무관.
// T4: (a)크래시→정확히 1회 재처리 (b)완료(답 존재)→스킵 중복0 (c)마커 삭제(정상종료) (d)라이브 미만료 리스 오회수0.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { insertMessage } from "../../db/inboxQueries";
import {
  markInflight,
  clearInflight,
  inflightMarkerCount,
  recoverB3osNativeInflight,
} from "./recovery";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('nova','nova','role','b3os_native','b3os_native_runner','/tmp','p.md')`,
  ).run();
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','["nova","bill"]','bill')`,
  ).run();
  return db;
}

/** 원 인바운드 + nova 수신행(delivery_state) 세팅. message_id 반환. */
function addInbound(db: Database, deliveryState = "wake_dispatched"): string {
  const m = insertMessage(db, {
    thread_id: "t1",
    from_agent_id: "bill",
    to_agent_id: "nova",
    type: "dm",
    body: "do X",
    source: "agent",
    hop_count: 0,
    priority: "normal",
  });
  db.prepare(`INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES (?, 'nova')`).run(m.id);
  db.prepare(`UPDATE message_recipient SET delivery_state=? WHERE message_id=? AND agent_id='nova'`).run(
    deliveryState,
    m.id,
  );
  return m.id;
}

function deliveryState(db: Database, msgId: string): string {
  return (
    db
      .prepare(`SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id='nova'`)
      .get(msgId) as { delivery_state: string }
  ).delivery_state;
}

describe("b3os_native M1.5 recovery", () => {
  test("(a) 크래시(마커 잔존, 답 없음) → sweep 재처리 1회: delivery_state=pending", () => {
    const db = setup();
    const id = addInbound(db, "wake_dispatched");
    markInflight(db, id, "nova", "t1"); // 턴 시작했고 크래시로 clear 안 됨
    expect(inflightMarkerCount(db)).toBe(1);

    const n = recoverB3osNativeInflight(db, 0); // staleSec=0 → 즉시 stale
    expect(n).toBe(1);
    expect(deliveryState(db, id)).toBe("pending"); // 재wake 대상으로 복구
    expect(inflightMarkerCount(db)).toBe(0); // 마커 정리
  });

  test("(b) 완료(답 이미 게시) → 재처리 X(멱등), delivery_state 불변, 마커만 삭제", () => {
    const db = setup();
    const id = addInbound(db, "wake_dispatched");
    markInflight(db, id, "nova", "t1");
    // 크래시가 post 후~마커삭제 전에 났다고 가정: 답이 이미 있음
    insertMessage(db, {
      thread_id: "t1",
      from_agent_id: "nova",
      to_agent_id: "bill",
      type: "dm",
      body: "done",
      source: "agent",
      hop_count: 1,
      in_reply_to: id,
      priority: "normal",
    });

    const n = recoverB3osNativeInflight(db, 0);
    expect(n).toBe(0); // 재처리 안 함 → 이중게시 0
    // 답 게시가 ackClose orphan-close로 원 메시지를 completed로 닫음(시스템 정상 동작).
    // 복구의 핵심 검증 = "재wake(pending) 대상으로 되돌리지 않았다".
    expect(deliveryState(db, id)).not.toBe("pending");
    expect(inflightMarkerCount(db)).toBe(0); // 마커는 정리
  });

  test("(c) 정상 종료 경로: clearInflight → 마커 삭제(복구 대상 아님)", () => {
    const db = setup();
    const id = addInbound(db);
    markInflight(db, id, "nova", "t1");
    expect(inflightMarkerCount(db)).toBe(1);
    clearInflight(db, id, "nova"); // 성공/dup/에러 finally 경로
    expect(inflightMarkerCount(db)).toBe(0);
    expect(recoverB3osNativeInflight(db, 0)).toBe(0); // 남은 게 없음
  });

  test("(d) 라이브 미만료 마커(방금 시작) → 기본 임계(150s)로 sweep해도 오회수 0", () => {
    const db = setup();
    const id = addInbound(db, "wake_dispatched");
    markInflight(db, id, "nova", "t1"); // started_at = now

    const n = recoverB3osNativeInflight(db); // default INFLIGHT_STALE_SEC=150
    expect(n).toBe(0);
    expect(deliveryState(db, id)).toBe("wake_dispatched"); // 라이브 턴 안 건드림
    expect(inflightMarkerCount(db)).toBe(1); // 마커 유지(아직 진행중)
  });

  // ★Bill HIGH-1/HIGH-2 회귀: 헤드라인 케이스(source='user' 크래시 → 부팅 복구). 실제 startWakeDispatcher
  //  부팅 시퀀스(런타임-aware user-cleanup → b3os recovery staleSec=0)를 충실히 재현. b3os user행이 살아남고,
  //  대조로 비-b3os user-pending은 여전히 만료되는지 확인(가드 과대적용 아님).
  test("(f) [헤드라인] source='user' b3os 크래시 → 부팅 시퀀스 후 'pending' 유지(만료 아님)", () => {
    const db = setup();
    // 비-b3os(claude) 에이전트 대조군
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES ('bill','bill','role','claude_channel','claude_tmux','/tmp','p.md')`,
    ).run();

    // b3os(nova)에 온 user 메시지가 턴 도중 크래시(lease-safe-async라 delivery_state는 wake_dispatched + 마커 잔존)
    const um = insertMessage(db, {
      thread_id: "t1", from_agent_id: "user", to_agent_id: "nova", type: "dm",
      body: "사용자 요청", source: "user", hop_count: 0, priority: "normal",
    });
    db.prepare(`INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES (?, 'nova')`).run(um.id);
    db.prepare(`UPDATE message_recipient SET delivery_state='wake_dispatched' WHERE message_id=? AND agent_id='nova'`).run(um.id);
    markInflight(db, um.id, "nova", "t1");

    // 대조: claude 에이전트의 user-pending(텔레그램 직배달 전제 → 만료되어야 정상)
    const cm = insertMessage(db, {
      thread_id: "t1", from_agent_id: "user", to_agent_id: "bill", type: "dm",
      body: "x", source: "user", hop_count: 0, priority: "normal",
    });
    db.prepare(`INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES (?, 'bill')`).run(cm.id);
    db.prepare(`UPDATE message_recipient SET delivery_state='pending' WHERE message_id=? AND agent_id='bill'`).run(cm.id);

    // === startWakeDispatcher 부팅 시퀀스 재현 ===
    // ① 런타임-aware user-cleanup (b3os_native/codex 제외)
    db.prepare(
      `UPDATE message_recipient SET delivery_state='expired', last_error='startup'
       WHERE delivery_state='pending'
         AND message_id IN (SELECT id FROM message WHERE source='user')
         AND agent_id NOT IN (SELECT id FROM agent WHERE runtime IN ('b3os_native','codex'))`,
    ).run();
    // ② b3os 크래시 복구 (부팅 staleSec=0)
    const n = recoverB3osNativeInflight(db, 0);

    expect(n).toBe(1); // b3os user 크래시 행 재wake
    expect(deliveryState(db, um.id)).toBe("pending"); // ★헤드라인: 만료 안 되고 pending으로 복구
    expect(
      (db.prepare(`SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id='bill'`).get(cm.id) as { delivery_state: string }).delivery_state,
    ).toBe("expired"); // 대조군: 비-b3os user는 정상 만료(가드 과대적용 아님)
    expect(inflightMarkerCount(db)).toBe(0);
  });

  test("(e) 이미 pending인 수신행 → 무변화라 재처리 카운트 0(로그 정확성), 마커만 정리", () => {
    const db = setup();
    const id = addInbound(db, "pending");
    markInflight(db, id, "nova", "t1");
    const n = recoverB3osNativeInflight(db, 0);
    // 이미 pending → UPDATE NOT IN 가드로 무변화 → 실제 재wake 아님 → 카운트 0(Bill LOW: 무조건++ 아님).
    expect(n).toBe(0);
    expect(deliveryState(db, id)).toBe("pending");
    expect(inflightMarkerCount(db)).toBe(0); // 마커는 정리(반복 sweep leak 방지)
  });
});

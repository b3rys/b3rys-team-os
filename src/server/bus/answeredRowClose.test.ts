// ★답장 뒤 wake 실패 행을 닫는다★ — 2026-09-07 실측 재현 (proposal prop_db4f21bcff46)
//
// steve→devon 메시지 하나가 답장(45초 뒤) 이후 6시간 동안 64회 재-wake 됐다. 두 분기(exception ·
// returned-false)가 답장을 알아채고 audit 만 남긴 채 return 해서 행이 dispatching + 살아 있는 lease 로
// 남았고, lease 만료 뒤 recoverStaleClaims(dispatching→pending) 가 되살려 6분마다 반복됐다.
//
// 여기서 재는 것 세 가지:
//   ① 헬퍼가 행을 닫는다 (delivery_state='expired', lease·claim NULL) — 그리고 recipient_state 는 안 건드린다
//   ② 닫힌 행은 recoverStaleClaims 와 같은 UPDATE 가 ★되살리지 못한다★ (루프의 실제 차단 지점)
//   ③ 두 분기 모두 return 전에 헬퍼를 부른다 — 소스에서 직접 확인 (한 분기만 고치면 exception 경로가 남는다)
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { closeAnsweredRecipient } from "./wakeDispatcher";
import { recoverStaleClaims } from "../db/inbox/dispatch";

const SRC = readFileSync(join(import.meta.dir, "wakeDispatcher.ts"), "utf8");

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE message_recipient (
       message_id TEXT, agent_id TEXT,
       delivery_state TEXT, recipient_state TEXT,
       lease_until TEXT, claimed_at TEXT, last_error TEXT
     )`,
  );
  // 실측 모양: 답장으로 recipient_state 는 completed, 그런데 delivery_state 는 dispatching + lease 살아 있음
  db.prepare(
    `INSERT INTO message_recipient VALUES
       ('ask-1','devon','dispatching','completed', datetime('now','+240 seconds'), datetime('now'), NULL)`,
  ).run();
  return db;
}

// 원본 recoverStaleClaims 를 그대로 부른다 — SQL 을 베끼면 원본이 바뀔 때 시험이 조용히 낡는다(리뷰 steve).
//   시험 테이블에는 그 UPDATE 가 만지는 컬럼(delivery_state·claimed_at·lease_until)이 다 있다.
function staleClaimsSweep(db: Database): number {
  return recoverStaleClaims(db);
}

describe("★답장 뒤 wake 실패 — 행을 닫아 재-wake 루프를 끊는다★", () => {
  it("① 헬퍼가 delivery_state 를 닫고 lease·claim 을 지운다 — recipient_state 는 그대로", () => {
    const db = freshDb();
    expect(closeAnsweredRecipient(db, "ask-1", "devon", "openclaw_directed_no_response_in_window")).toBe(1);
    const row = db.prepare("SELECT * FROM message_recipient").get() as Record<string, unknown>;
    expect(row.delivery_state).toBe("expired");
    expect(row.lease_until).toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(String(row.last_error)).toContain("answered_before_wake_result");
    expect(row.recipient_state, "★완료/후속보고 추적을 덮어썼다★").toBe("completed");
  });

  it("② 닫힌 행은 lease 가 지나도 stale-claim 복구가 되살리지 못한다 (루프 차단)", () => {
    const db = freshDb();
    // 고치기 전 모양: 행을 안 닫고 lease 만 지나가면 → 되살아난다 (이게 6분 루프였다)
    db.prepare("UPDATE message_recipient SET lease_until = datetime('now','-1 seconds')").run();
    expect(staleClaimsSweep(db), "★대조군: 안 닫으면 되살아나야 한다★").toBe(1);
    // 고친 뒤 모양: 닫고 나면 lease 가 지나도 0건
    const db2 = freshDb();
    closeAnsweredRecipient(db2, "ask-1", "devon", "x");
    db2.prepare("UPDATE message_recipient SET lease_until = datetime('now','-1 seconds')").run();
    expect(staleClaimsSweep(db2), "★닫았는데도 되살아났다 — 루프가 안 끊긴다★").toBe(0);
  });

  it("③ 다른 행·다른 수신자는 건드리지 않는다", () => {
    const db = freshDb();
    db.prepare("INSERT INTO message_recipient VALUES ('ask-1','ames','dispatching','open', datetime('now','+240 seconds'), datetime('now'), NULL)").run();
    db.prepare("INSERT INTO message_recipient VALUES ('ask-2','devon','pending','open', NULL, NULL, NULL)").run();
    expect(closeAnsweredRecipient(db, "ask-1", "devon", "x")).toBe(1);
    const others = db.prepare("SELECT delivery_state FROM message_recipient WHERE NOT (message_id='ask-1' AND agent_id='devon') ORDER BY message_id, agent_id").all() as { delivery_state: string }[];
    expect(others.map((r) => r.delivery_state)).toEqual(["dispatching", "pending"]);
  });

  it("④ 두 분기(exception · returned-false) 모두 return 전에 헬퍼를 부른다", () => {
    // 한 분기만 고치면 exception 경로에서 같은 루프가 남는다. 소스에서 호출 수를 센다.
    const calls = SRC.match(/closeAnsweredRecipient\(db, row\.message_id, row\.agent_id, /g) ?? [];
    expect(calls.length, "★late_wake_failure_ignored_after_reply 분기 둘 다 닫아야 한다★").toBe(2);
    // 각 호출이 그 audit 바로 뒤 · return 바로 앞에 있는지
    const pattern = /late_wake_failure_ignored_after_reply[\s\S]{0,200}?closeAnsweredRecipient\([\s\S]{0,120}?\);\s*\n\s*return;/g;
    expect((SRC.match(pattern) ?? []).length, "★헬퍼 호출이 audit 과 return 사이에 있지 않다★").toBe(2);
  });
});

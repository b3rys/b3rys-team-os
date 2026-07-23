/**
 * broadcast complete 로직 — broadcast(@all/announce)는 FYI라 비응답자도 inbox에 action-required로 쌓이면 안 됨.
 * GD 2026-06-22 버그: @all 인사 후 답한 듯해도 inbox에 주르륵 — 비응답자 recipient_state=open이 영구히 action-required.
 * fix: broadcast 수신행은 'acknowledged'(broadcast_fyi)로 생성 → InboxView action-required(=open/needs_match_review)에서 빠짐.
 * directed(1:1)는 그대로 'open'(응답 필요) 유지.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, broadcastOpenBackfill } from "../migrate";
import { insertMessage } from "./messages";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["bill", "steve", "demis", "dbak"]) {
    db.prepare(
      `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'r', 'claude_channel', 'claude_tmux', '/tmp', 'P.md')`,
    ).run(a, a);
  }
  db.prepare(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','broadcast','[]','gd')`).run();
  return db;
}
function rcpts(db: Database, msgId: string) {
  return db.prepare(`SELECT agent_id, recipient_state, close_reason FROM message_recipient WHERE message_id=? ORDER BY agent_id`).all(msgId) as Array<{ agent_id: string; recipient_state: string; close_reason: string | null }>;
}
// InboxView.isActionRequired 동치: recipient 중 하나라도 open/needs_match_review면 action-required(noise).
const isActionRequired = (rows: ReturnType<typeof rcpts>) => rows.some((r) => r.recipient_state === "open" || r.recipient_state === "needs_match_review");

describe("broadcast complete — FYI 수신행은 action-required로 안 쌓임", () => {
  test("@all(agent broadcast) 수신행은 acknowledged(broadcast_fyi), open 아님", () => {
    const db = setup();
    const m = insertMessage(db, { thread_id: "t1", from_agent_id: "gd", to_agent_id: "broadcast", type: "broadcast", body: "@all 인사", source: "agent" } as never);
    const rows = rcpts(db, m.id);
    expect(rows.length).toBe(4); // bill·steve·demis·dbak (sender gd 제외)
    for (const r of rows) {
      expect(r.recipient_state).toBe("acknowledged");
      expect(r.close_reason).toBe("broadcast_fyi");
    }
    // 핵심: 비응답자가 있어도 broadcast는 inbox action-required로 안 뜸
    expect(isActionRequired(rows)).toBe(false);
  });

  test("directed(1:1)는 그대로 open(응답 필요) — broadcast fix가 directed 안 건드림", () => {
    const db = setup();
    const m = insertMessage(db, { thread_id: "t1", from_agent_id: "gd", to_agent_id: "steve", type: "dm", body: "스티브 이것 좀", source: "agent" } as never);
    const rows = rcpts(db, m.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.recipient_state).toBe("open");
    expect(isActionRequired(rows)).toBe(true); // directed는 action-required 유지
  });

  test("user-source broadcast도 FYI로 acknowledged (텔레그램 그룹 인사)", () => {
    const db = setup();
    const m = insertMessage(db, { thread_id: "t1", from_agent_id: "gd", to_agent_id: "broadcast", type: "broadcast", body: "@all 점심", source: "user" } as never);
    const rows = rcpts(db, m.id);
    expect(rows.every((r) => r.recipient_state === "acknowledged")).toBe(true);
    expect(isActionRequired(rows)).toBe(false);
  });
});

describe("broadcastOpenBackfill — 기존 open broadcast 행 일회 정리", () => {
  test("기존 open broadcast 행 → acknowledged(broadcast_fyi), directed open은 유지", () => {
    const db = setup();
    // 옛 broadcast 행을 강제로 open 으로(fix 전 상태 재현)
    const m = insertMessage(db, { thread_id: "t1", from_agent_id: "gd", to_agent_id: "broadcast", type: "broadcast", body: "@all 옛인사", source: "agent" } as never);
    db.prepare(`UPDATE message_recipient SET recipient_state='open', close_reason=NULL WHERE message_id=?`).run(m.id);
    // directed open 도 하나
    const d = insertMessage(db, { thread_id: "t1", from_agent_id: "gd", to_agent_id: "steve", type: "dm", body: "directed", source: "agent" } as never);
    db.prepare(`DELETE FROM runtime_lock WHERE key='broadcast_open_close_v1'`).run(); // 게이트 해제(테스트)
    broadcastOpenBackfill(db);
    expect(rcpts(db, m.id).every((r) => r.recipient_state === "acknowledged")).toBe(true); // broadcast 정리됨
    expect(rcpts(db, d.id)[0]!.recipient_state).toBe("open"); // directed 는 그대로
  });

  test("idempotent: flag-guard로 2회차 no-op", () => {
    const db = setup();
    const m = insertMessage(db, { thread_id: "t1", from_agent_id: "gd", to_agent_id: "broadcast", type: "broadcast", body: "@all", source: "agent" } as never);
    db.prepare(`UPDATE message_recipient SET recipient_state='open' WHERE message_id=?`).run(m.id);
    broadcastOpenBackfill(db); // migrate()가 이미 한 번 돌려 flag set 됨 → 이건 no-op일 수 있음
    db.prepare(`DELETE FROM runtime_lock WHERE key='broadcast_open_close_v1'`).run();
    broadcastOpenBackfill(db); // 해제 후 1회 → 닫힘
    const after = rcpts(db, m.id).every((r) => r.recipient_state === "acknowledged");
    db.prepare(`UPDATE message_recipient SET recipient_state='open' WHERE message_id=?`).run(m.id); // 다시 open
    broadcastOpenBackfill(db); // flag set 상태 → no-op
    expect(after).toBe(true);
    expect(rcpts(db, m.id)[0]!.recipient_state).toBe("open"); // 2회차는 안 건드림(guard)
  });
});

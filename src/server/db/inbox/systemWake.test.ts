/**
 * ★system 알림이 팀원에게 한 번도 안 갔다.★ (2026-07-13 실측)
 *
 * 디스패처가 pending 을 고르는 쿼리가 system 발신을 ★수집 번들일 때만★ 통과시켰다:
 *   AND (m.source IN ('agent','user')
 *        OR (m.source='system' AND m.meta_json LIKE '%"kind":"team_collect_bundle"%'))
 * 그 수집 기능은 2026-07-13 에 삭제됐다 → ★system 은 전부 막혔다.★
 *
 * 실측 (카드 알림 29건의 운명):
 *   expired  21   배달 안 되고 만료
 *   pending   8   7/04 부터 아직 대기 중
 *   ★배달됨   0★
 *
 * "[카드 배정] 카드 'X' 담당이 되셨습니다" 가 ★단 한 번도 안 갔다.★
 * 그래서 팀원이 자기 카드를 스스로 못 챙겼다.
 *
 * ★에러가 안 난다.★ 메시지는 DB 에 잘 들어가고 '대기 중' 으로 조용히 남는다.
 * 보낸 쪽은 보냈다고 믿고, 받는 쪽은 온 적이 없다. ★오늘 하루 종일 본 그 패턴이다.★
 *
 * ★시각 컷오프가 필수★ (GD 승인): 안 열면 안 가고, 그냥 열면 7/04 부터 쌓인 게 한꺼번에 터진다.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { pendingDispatch } from "./dispatch";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE message (
    id TEXT PRIMARY KEY, thread_id TEXT, from_agent_id TEXT, to_agent_id TEXT,
    type TEXT, body TEXT, source TEXT, hop_count INTEGER DEFAULT 0,
    in_reply_to TEXT, parent_message_id TEXT, sync TEXT, priority TEXT,
    attachments_json TEXT, meta_json TEXT, max_hop INTEGER, created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE message_recipient (
    message_id TEXT, agent_id TEXT, delivery_state TEXT, retry_count INTEGER DEFAULT 0,
    last_error TEXT, lease_until TEXT, claimed_at TEXT)`);
  return db;
}

function put(db: Database, id: string, source: string, minutesAgo: number) {
  db.run(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
     VALUES (?, 'th', ?, 'hermes', 'dm', '[카드 배정] 카드 X 담당이 되셨습니다', ?,
             datetime('now', '-' || ? || ' minutes'))`,
    [id, source === "system" ? "system" : "bill", source, String(minutesAgo)],
  );
  db.run(
    `INSERT INTO message_recipient (message_id, agent_id, delivery_state) VALUES (?, 'hermes', 'pending')`,
    [id],
  );
}

describe("★system 알림 — 깨우되, 오래된 건 깨우지 않는다★", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  it("★방금 온 system 알림은 배달된다★ (카드 배정을 팀원이 알아야 자기 일을 챙긴다)", () => {
    put(db, "sys-new", "system", 1);
    const rows = pendingDispatch(db);
    expect(rows.map((r) => r.message_id)).toContain("sys-new");
  });

  it("★오래된 system 알림은 안 깨운다★ — 안 그러면 7/04 부터 쌓인 게 한꺼번에 터진다", () => {
    put(db, "sys-old", "system", 60 * 24 * 9);   // 9일 전 (실측된 좀비와 같은 나이)
    const rows = pendingDispatch(db);
    expect(rows.map((r) => r.message_id)).not.toContain("sys-old");
  });

  it("★agent/user 는 나이와 무관하게 배달된다★ (컷오프는 system 에만 — 팀장 메시지를 나이로 버리면 안 된다)", () => {
    put(db, "user-old", "user", 60 * 24 * 9);
    put(db, "agent-old", "agent", 60 * 24 * 9);
    const ids = pendingDispatch(db).map((r) => r.message_id);
    expect(ids).toContain("user-old");
    expect(ids).toContain("agent-old");
  });

  it("★죽은 수집 예외가 남아 있지 않다★ (team_collect_bundle — 그 기능은 삭제됐다)", () => {
    const SRC = readFileSync(join(import.meta.dir, "dispatch.ts"), "utf8");
    expect(SRC).not.toContain("team_collect_bundle");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

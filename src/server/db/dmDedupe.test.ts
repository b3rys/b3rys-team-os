/**
 * dm_message 멤버별 dedup 회귀 (Devon 리뷰 MUST-FIX 2026-07-09).
 * dedupe_key 전역 UNIQUE 였을 때: 같은 telegram user/message_id 가 멤버 간 충돌하면 뒤 멤버 DM 이
 * 조용히 누락(recall=0)됐다. UNIQUE(member_id, dedupe_key) 복합키로 멤버별 격리됨을 고정한다.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { insertDmMessage, recallDmMessages } from "./dmCapture";

const mk = (memberId: string) => ({
  memberId, runtime: "claude_channel", direction: "in" as const, body: "hi",
  createdAt: new Date("2026-07-09T00:00:00Z"), dedupeKey: "telegram:1000000001:261", sourceRef: "x",
});

describe("dm_message dedup — 멤버별 격리 (Devon MUST-FIX)", () => {
  test("같은 dedupe_key, 다른 멤버 → 둘 다 저장(전역 UNIQUE 누락버그 방지)", () => {
    const db = new Database(":memory:"); migrate(db);
    expect(insertDmMessage(db, mk("steve"))).toBe(true);
    expect(insertDmMessage(db, mk("devon"))).toBe(true); // 전역 UNIQUE 였으면 false(누락)
    expect(recallDmMessages(db, "steve", 10).length).toBe(1);
    expect(recallDmMessages(db, "devon", 10).length).toBe(1);
  });

  test("같은 멤버 같은 dedupe_key → 중복 skip(멤버 내 dedup 유지)", () => {
    const db = new Database(":memory:"); migrate(db);
    expect(insertDmMessage(db, mk("steve"))).toBe(true);
    expect(insertDmMessage(db, mk("steve"))).toBe(false);
    expect(recallDmMessages(db, "steve", 10).length).toBe(1);
  });
});

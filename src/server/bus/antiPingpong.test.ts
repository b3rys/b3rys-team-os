/**
 * hop_limit 정렬 테스트 (2026-06-11).
 * 버그: hop cap(max_hop, 옛 기본 5)이 pingpong cap(MAX_AUTO_ROUNDS=6)보다 낮아, 정당한 다단계 협의/handoff가
 *   hop=5 에서 먼저 차단됨(Hermes→Forin handoff·Hermes→Steve 답 둘 다 hop_limit_exceeded). fix=max_hop 5→16.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { checkPingpong } from "./antiPingpong";
import type { PendingDispatchRow } from "./types";

const roster = new Set(["steve", "hermes", "forin", "bill"]);

function row(over: Partial<PendingDispatchRow>): PendingDispatchRow {
  return {
    message_id: "m1", agent_id: "forin", delivery_state: "pending", retry_count: 0, last_error: null,
    from_agent_id: "hermes", to_agent_id: "forin", body: "x", source: "agent", created_by: null,
    max_hop: 16, hop_count: 0, in_reply_to: null, parent_message_id: null, sync: "none",
    thread_id: "t1", type: "dm", created_at: "2026-06-11", priority: "normal",
    ...over,
  };
}

describe("hop_limit (max_hop=16 정렬, hop cap이 pingpong cap보다 높아야)", () => {
  const db = new Database(":memory:");

  test("hop=15, max_hop=16 → allowed (정당한 깊은 체인 통과)", () => {
    expect(checkPingpong(db, row({ hop_count: 15, max_hop: 16 }), roster).allowed).toBe(true);
  });

  test("hop=16, max_hop=16 → blocked (backstop은 16에서 작동)", () => {
    const v = checkPingpong(db, row({ hop_count: 16, max_hop: 16 }), roster);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("hop_limit_exceeded");
  });

  test("Forin/Steve 버그 재현: hop=5 가 옛 max_hop=5 에선 차단, 새 max_hop=16 에선 통과", () => {
    // 옛 값(5): 깊은 thread 참조한 handoff/답이 hop=5 에서 차단되던 버그
    expect(checkPingpong(db, row({ hop_count: 5, max_hop: 5 }), roster).allowed).toBe(false);
    // fix(16): 같은 hop=5 통과 → Forin handoff·Steve가 받을 Hermes 답 둘 다 정상 배달
    expect(checkPingpong(db, row({ hop_count: 5, max_hop: 16 }), roster).allowed).toBe(true);
  });
});

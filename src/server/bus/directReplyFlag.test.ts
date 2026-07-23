/**
 * case 6 — direct_to_gd 플래그 해석 (2026-06-05).
 *
 * "받은 팀원이 GD 에게 직접 응답"은 자연어 추측이 아니라 라우팅 계약으로 푼다:
 * 발신자(Bill, LLM)가 directed 메시지에 meta.reply_mode="direct_to_gd" + source_thread_id(GD 그룹 tg- thread)를
 * 붙인다. dispatcher 의 resolveDirectToGd 가 이 플래그를 보고 수신자를 "그룹 직접 응답" 경로로 보낸다.
 * 수신자는 본문 해석 없이 플래그만 따른다.
 */
import { describe, expect, test } from "bun:test";
import { resolveChannelSurfaceTarget, resolveDirectToGd } from "./wakeDispatcher";
import type { PendingDispatchRow } from "./types";

function mkRow(over: Partial<PendingDispatchRow>): PendingDispatchRow {
  return {
    message_id: "m1",
    agent_id: "codex",
    delivery_state: "pending",
    retry_count: 0,
    last_error: null,
    from_agent_id: "bill",
    to_agent_id: "codex",
    body: "GD 검색 플젝 상태 정리해서 GD에게 직접 보고해",
    source: "agent",
    created_by: "bill",
    max_hop: 5,
    hop_count: 0,
    in_reply_to: null,
    parent_message_id: null,
    sync: "none",
    thread_id: "abc123", // directed(비-tg) 버스 thread
    type: "dm",
    created_at: "2026-06-05T00:00:00Z",
    priority: "normal",
    ...over,
  };
}

const GD_GROUP_THREAD = "tg--1009999999999";

const OWNER_DM = "1000000001"; // GD 1:1 DM chat_id (setting owner_chat_id)

describe("resolveDirectToGd — case 6 플래그 계약 (DM 릴레이, 2026-07-08 GD)", () => {
  test("direct_to_gd + ownerChatId → GD 1:1 DM 좌표 반환", () => {
    const row = mkRow({
      meta_json: JSON.stringify({ reply_mode: "direct_to_gd", source_thread_id: GD_GROUP_THREAD, requested_by: "bill" }),
    });
    const r = resolveDirectToGd(row, OWNER_DM);
    expect(r).not.toBeNull();
    expect(r?.groupId).toBe(OWNER_DM); // 타겟 = GD DM (그룹 아님)
    expect(r?.threadId).toBe(`dm-${OWNER_DM}`);
  });

  test("meta 없음 → null (일반 directed)", () => {
    expect(resolveDirectToGd(mkRow({ meta_json: null }), OWNER_DM)).toBeNull();
  });

  test("reply_mode 다름(collect_only) → null", () => {
    const row = mkRow({ meta_json: JSON.stringify({ reply_mode: "collect_only" }) });
    expect(resolveDirectToGd(row, OWNER_DM)).toBeNull();
  });

  test("direct_to_gd 인데 ownerChatId 없음 → null (owner DM 미설정 시 릴레이 불가)", () => {
    const row = mkRow({ meta_json: JSON.stringify({ reply_mode: "direct_to_gd", source_thread_id: GD_GROUP_THREAD }) });
    expect(resolveDirectToGd(row)).toBeNull();
  });

  test("source_thread_id 는 무시 — ownerChatId 있으면 DM 반환 (그룹 불요)", () => {
    const row = mkRow({ meta_json: JSON.stringify({ reply_mode: "direct_to_gd", source_thread_id: "dm-xyz" }) });
    expect(resolveDirectToGd(row, OWNER_DM)?.groupId).toBe(OWNER_DM);
  });

  test("이미 tg- 그룹 thread 로 온 메시지 → null (텔레그램 경로라 별도 처리 불필요)", () => {
    const row = mkRow({
      thread_id: GD_GROUP_THREAD,
      meta_json: JSON.stringify({ reply_mode: "direct_to_gd", source_thread_id: GD_GROUP_THREAD }),
    });
    expect(resolveDirectToGd(row, OWNER_DM)).toBeNull();
  });

  test("깨진 meta_json → null (예외 안전)", () => {
    expect(resolveDirectToGd(mkRow({ meta_json: "{not json" }), OWNER_DM)).toBeNull();
  });
});

describe("resolveChannelSurfaceTarget — visible surface 좌표", () => {
  test("directed direct_to_gd 는 GD 1:1 DM 을 표면 대상으로 쓴다", () => {
    const row = mkRow({
      thread_id: "direct-bus-thread",
      meta_json: JSON.stringify({ reply_mode: "direct_to_gd", source_thread_id: GD_GROUP_THREAD }),
    });
    expect(resolveChannelSurfaceTarget(row, "-100capture", OWNER_DM)).toEqual({
      groupId: OWNER_DM,
      threadId: `dm-${OWNER_DM}`,
      directToGd: true,
    });
  });

  test("일반 tg- thread 는 capture group fallback 을 표면 대상으로 쓴다", () => {
    const row = mkRow({ thread_id: "tg--100capture", meta_json: null });
    expect(resolveChannelSurfaceTarget(row, "-100capture")).toEqual({
      groupId: "-100capture",
      threadId: "tg--100capture",
      directToGd: false,
    });
  });

  test("일반 directed thread 는 표면 대상이 없다", () => {
    expect(resolveChannelSurfaceTarget(mkRow({ thread_id: "direct-bus-thread", meta_json: null }), "-100capture")).toBeNull();
  });
});

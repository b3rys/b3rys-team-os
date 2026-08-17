// ★진행 중 턴에 말을 끼워 넣는다★
//
// 실측 2026-08-12: dex 가 74초 작업 중일 때 보낸 메시지가 ★20번 연기되다 blocked★ 로 끝났다.
// 턴도 답도 없었고, recipient_state 는 'acknowledged/activity_assumed' — ★활동 중이라는 이유로 봤다고 처리★ 됐다.
import { describe, test, expect } from "bun:test";
import { registerActiveTurn, unregisterActiveTurn, steerActiveTurn, activeTurnAgents } from "./activeTurns";
import { buildSteerText } from "./adapter";

describe("codex 중간 주입 — 도는 턴에 끼워 넣는 조건", () => {

const fakeTurn = (turnId: string | null, sink: string[] = [], fail = false) => ({
  currentTurnId: turnId,
  async steer(t: string) { if (fail) throw new Error("boom"); sink.push(t); },
});

test("★진행 중 턴이 있으면 끼워 넣는다★", async () => {
  const sink: string[] = [];
  const turn = fakeTurn("t1", sink);
  registerActiveTurn("dex", turn);
  expect(await steerActiveTurn("dex", "중간 말")).toBe(true);
  expect(sink).toEqual(["중간 말"]);
  unregisterActiveTurn("dex", turn);
});

test("대조군 — 도는 턴이 없으면 끼워 넣지 않는다(연기 경로로 간다)", async () => {
  expect(await steerActiveTurn("nobody", "x")).toBe(false);
});

test("★turnId 가 아직 없으면 넣지 않는다★ — codex 가 expectedTurnId 를 요구한다", async () => {
  const turn = fakeTurn(null);
  registerActiveTurn("dex", turn);
  expect(await steerActiveTurn("dex", "x")).toBe(false);
  unregisterActiveTurn("dex", turn);
});

test("끼워 넣기가 실패하면 false — 조용히 삼키지 않는다(연기로 되돌아간다)", async () => {
  const turn = fakeTurn("t1", [], true);
  registerActiveTurn("dex", turn);
  expect(await steerActiveTurn("dex", "x")).toBe(false);
  unregisterActiveTurn("dex", turn);
});

test("★늦게 끝난 앞 턴이 새 턴의 등록을 지우지 않는다★", () => {
  const oldTurn = fakeTurn("t1"), newTurn = fakeTurn("t2");
  registerActiveTurn("dex", oldTurn);
  registerActiveTurn("dex", newTurn);   // 새 턴이 덮는다
  unregisterActiveTurn("dex", oldTurn); // 앞 턴이 뒤늦게 끝남
  expect(activeTurnAgents()).toContain("dex"); // 새 턴은 살아있어야 한다
  unregisterActiveTurn("dex", newTurn);
  expect(activeTurnAgents()).not.toContain("dex");
});

test("끼워 넣는 문장에 보낸 사람·스레드가 들어간다(맥락 없이 던지면 못 알아듣는다)", () => {
  const t = buildSteerText({ from_agent_id: "demis", body: "이거 먼저 해줘", message_id: "m9", thread_id: "th1" });
  expect(t).toContain("demis");
  expect(t).toContain("이거 먼저 해줘");
  expect(t).toContain("th1");
  expect(t).toContain("m9");
});
});

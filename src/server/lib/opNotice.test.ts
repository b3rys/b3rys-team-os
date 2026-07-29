// opNotice — team op 상황 알림의 계약 테스트.
//
// 지키는 것 (2026-07-30 사고에서 나온 요구):
//   ① 부팅 오탐을 내지 않는다 — 짧게 미충족했다 회복하면 아무 알림도 안 나간다(jane: 34초).
//   ② 지속되면 반드시 1회 알린다 — 그리고 반복 스팸하지 않는다(lisa: 28분).
//   ③ 알림은 고장난 본인에게 가지 않는다 — 그 멤버가 못 듣는 상태가 사고 본체다(블랙홀 금지).
//   ④ coordinator 가 고장이면 다른 멤버로 폴백한다.
import { describe, test, expect } from "bun:test";
import {
  EssentialsOpNotifier,
  pickOpNoticeRecipient,
  buildEssentialsDownBody,
  buildEssentialsRecoveredBody,
} from "./opNotice";
import type { AgentRecord } from "../types";

const agent = (id: string, capabilities: string[] = []): AgentRecord =>
  ({ id, runtime: "claude_channel", capabilities } as unknown as AgentRecord);

const TEAM = [
  agent("lisa", ["coordinator", "full_context"]),
  agent("jane"),
  agent("clo"),
  agent("herm"),
];

describe("pickOpNoticeRecipient — 알림은 살아있는 사람에게", () => {
  test("기본은 coordinator 로 간다", () => {
    expect(pickOpNoticeRecipient(TEAM, "jane")).toBe("lisa");
  });

  test("★고장난 본인에게는 절대 안 보낸다★ (블랙홀 방지)", () => {
    // lisa 가 고장이면 lisa 에게 보내면 아무도 못 듣는다 → 다른 멤버로.
    const to = pickOpNoticeRecipient(TEAM, "lisa");
    expect(to).not.toBe("lisa");
    expect(to).toBe("jane");
  });

  test("coordinator 가 없으면 남은 아무 멤버", () => {
    expect(pickOpNoticeRecipient([agent("clo"), agent("herm")], "clo")).toBe("herm");
  });

  test("예약 id(system 등)는 수신자가 될 수 없다", () => {
    expect(pickOpNoticeRecipient([agent("system"), agent("broadcast")], "jane")).toBeNull();
  });

  test("혼자인 팀에서 그 1인이 고장이면 null (호출부가 audit 만 남긴다)", () => {
    expect(pickOpNoticeRecipient([agent("jane")], "jane")).toBeNull();
  });
});

describe("EssentialsOpNotifier — 부팅 오탐 억제 + 1회 발행", () => {
  test("★임계 미달이면 알리지 않는다★ — 부팅 직후 잠깐 미충족은 정상(jane 34초 케이스)", () => {
    const n = new EssentialsOpNotifier(3);
    expect(n.observe("jane", ["poller:claude bot.pid"])).toBeNull(); // 1
    expect(n.observe("jane", ["poller:claude bot.pid"])).toBeNull(); // 2
    expect(n.observe("jane", null)).toBeNull(); // 회복 — down 을 안 보냈으니 recovered 도 없다
    expect(n.streakOf("jane")).toBe(0);
  });

  test("연속 임계 도달 시 down 1회 (lisa 28분 케이스)", () => {
    const n = new EssentialsOpNotifier(3);
    n.observe("lisa", ["poller:claude bot.pid"]);
    n.observe("lisa", ["poller:claude bot.pid"]);
    expect(n.observe("lisa", ["poller:claude bot.pid"])).toBe("down");
  });

  test("★down 이후 매 tick 반복 알림 금지★ (스팸 방지)", () => {
    const n = new EssentialsOpNotifier(2);
    n.observe("lisa", ["x"]);
    expect(n.observe("lisa", ["x"])).toBe("down");
    for (let i = 0; i < 10; i++) expect(n.observe("lisa", ["x"])).toBeNull();
  });

  test("down 을 보낸 뒤 회복하면 recovered 1회", () => {
    const n = new EssentialsOpNotifier(2);
    n.observe("lisa", ["x"]);
    expect(n.observe("lisa", ["x"])).toBe("down");
    expect(n.observe("lisa", null)).toBe("recovered");
    expect(n.observe("lisa", null)).toBeNull(); // 반복 없음
  });

  test("회복 후 다시 고장나면 또 알린다 (한 번 알렸다고 영구 침묵하지 않는다)", () => {
    const n = new EssentialsOpNotifier(2);
    n.observe("lisa", ["x"]);
    n.observe("lisa", ["x"]);
    n.observe("lisa", null);
    n.observe("lisa", ["x"]);
    expect(n.observe("lisa", ["x"])).toBe("down");
  });

  test("멤버별로 독립 추적된다 (한 명의 streak 이 다른 명을 오염시키지 않는다)", () => {
    const n = new EssentialsOpNotifier(2);
    n.observe("lisa", ["x"]);
    n.observe("jane", ["x"]);
    expect(n.observe("lisa", ["x"])).toBe("down");
    expect(n.streakOf("jane")).toBe(1);
  });

  test("빈 missing 배열은 정상으로 취급한다", () => {
    const n = new EssentialsOpNotifier(1);
    expect(n.observe("jane", [])).toBeNull();
  });
});

describe("본문 — 사람이 바로 조치할 수 있어야 한다", () => {
  const body = buildEssentialsDownBody({
    agentId: "lisa",
    runtime: "claude_channel",
    missing: ["poller:claude bot.pid"],
    elapsedSec: 90,
  });

  test("누가·무엇이·얼마나 를 담는다", () => {
    expect(body).toContain("lisa");
    expect(body).toContain("poller:claude bot.pid");
    expect(body).toContain("90초");
  });

  test("★복구 명령에 --force 가 있다★ (없으면 'Session already running' no-op 함정)", () => {
    expect(body).toContain("--force");
    expect(body).toContain("Session already running");
  });

  test("system 발신이라 회신 대상이 없음을 명시한다 (--to system 블랙홀 방지)", () => {
    expect(body).toContain("팀장님께 직접 보고");
  });

  test("회복 본문은 앞선 down 을 해소로 연결한다", () => {
    expect(buildEssentialsRecoveredBody("lisa")).toContain("lisa");
    expect(buildEssentialsRecoveredBody("lisa")).toContain("해소");
  });
});

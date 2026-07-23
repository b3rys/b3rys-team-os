// P1 SEND seam 핀 테스트 — behavior-preserving 보장.
// 핵심: resolveThreadKind가 기존 startsWith("tg-") 제어흐름과 byte-동일해야 함(채널 추상화가 라우팅을 안 깨야 함).
import { test, expect, describe } from "bun:test";
import { resolveThreadKind, getChannel, channelRegistry } from "./registry";
import { telegramChannel } from "./telegram";
import { slackChannel } from "./slack";

describe("resolveThreadKind — startsWith('tg-')와 byte-동일(제어흐름 불변)", () => {
  const cases: Array<[string, "telegram_group" | "bus_directed"]> = [
    ["tg-1000000000001", "telegram_group"],
    ["tg-", "telegram_group"],
    ["th-abc123", "bus_directed"],
    ["directed-xyz", "bus_directed"],
    ["bus-1", "bus_directed"],
    ["", "bus_directed"],
  ];
  for (const [tid, expected] of cases) {
    test(`${JSON.stringify(tid)} → ${expected}`, () => {
      expect(resolveThreadKind(tid)).toBe(expected);
      // 기존 매직 비교와 동일 판정임을 직접 대조
      expect(resolveThreadKind(tid) === "telegram_group").toBe(tid.startsWith("tg-"));
    });
  }
});

describe("channelRegistry", () => {
  test("telegram·slack 등록 + id 일치", () => {
    expect(getChannel("telegram").id).toBe("telegram");
    expect(getChannel("slack").id).toBe("slack");
    expect(channelRegistry.size).toBe(2);
  });
  test("등록 안 된 kind는 throw(조용한 누락 방지) — kakao는 타입엔 있으나 레지스트리 미등록", () => {
    expect(() => getChannel("kakao")).toThrow();
  });
});

describe("send 입력 가드(behavior-preserving — 잘못된 호출은 ok:false, 예외 안 던짐)", () => {
  test("telegram: agent 없으면 ok:false + error", async () => {
    const r = await telegramChannel.send({ target: "g1", text: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
  test("slack: botToken 없으면 ok:false + error", async () => {
    const r = await slackChannel.send({ target: "C1", text: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe("resolveAgentId — P3 신원 seam (legacy 폴백 byte-동일 + channel_identities 우선)", () => {
  const A = (over: Record<string, unknown>) =>
    ({ id: "x", display_name: "x", role: "r", runtime: "hermes_agent", ...over }) as unknown as Parameters<
      typeof telegramChannel.resolveAgentId
    >[1][number];

  test("telegram legacy(telegram_bot_username) — @·대소문자 정규화 매칭(기존 동작)", () => {
    const agents = [A({ id: "bill", telegram_bot_username: "@EXAMPLE_Bill_Bot" })];
    expect(telegramChannel.resolveAgentId("example_bill_bot", agents)).toBe("bill");
    expect(telegramChannel.resolveAgentId("@EXAMPLE_Bill_BOT", agents)).toBe("bill");
    expect(telegramChannel.resolveAgentId("nobody", agents)).toBeNull();
  });
  test("telegram channel_identities.telegram 우선", () => {
    const agents = [A({ id: "kai", telegram_bot_username: null, channel_identities: { telegram: "kai_bot" } })];
    expect(telegramChannel.resolveAgentId("kai_bot", agents)).toBe("kai");
  });
  test("slack legacy(slack_bot_user_id) 정확 일치(기존 동작)", () => {
    const agents = [A({ id: "steve", slack_bot_user_id: "U0STEVE" })];
    expect(slackChannel.resolveAgentId("U0STEVE", agents)).toBe("steve");
    expect(slackChannel.resolveAgentId("U0OTHER", agents)).toBeNull();
  });
  test("slack channel_identities.slack 우선", () => {
    const agents = [A({ id: "kai", slack_bot_user_id: null, channel_identities: { slack: "U0KAI" } })];
    expect(slackChannel.resolveAgentId("U0KAI", agents)).toBe("kai");
  });
});

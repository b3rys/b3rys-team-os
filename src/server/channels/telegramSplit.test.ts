import { test, expect, mock } from "bun:test";

const sent: string[] = [];
mock.module("../lib/openclawBridge", () => ({
  postTelegramAsOpenclaw: async (_a: unknown, _c: string, text: string) => { sent.push(text); return { ok: true, messageId: sent.length }; },
}));
mock.module("../lib/hermesBridge", () => ({ postTelegramAsHermes: async () => true }));
mock.module("../lib/telegramBotSend", () => ({ TELEGRAM_SEND_LIMIT: 4000, canSendAsBot: () => false, sendAsAgentBot: async () => ({ ok: true }) }));

const { telegramChannel } = await import("./telegram");
const agent = { id: "x", runtime: "openclaw" } as never;

test("9000자 보고는 텔레그램 출구에서 3조각으로 순서대로 나간다", async () => {
  sent.length = 0;
  const text = Array.from({ length: 9 }, (_, i) => String(i).repeat(999)).join("\n");
  const r = await telegramChannel.send({ agent, target: "1", text });
  expect(r.ok).toBe(true);
  expect(sent.length).toBe(3);
  expect(sent.every((p) => p.length <= 4000)).toBe(true);
  expect(sent.join("\n")).toBe(text);
});

test("4000자 이하는 그대로 1번", async () => {
  sent.length = 0;
  await telegramChannel.send({ agent, target: "1", text: "a".repeat(4000) });
  expect(sent.length).toBe(1);
});

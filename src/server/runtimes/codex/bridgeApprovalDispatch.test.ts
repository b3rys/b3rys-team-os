import { expect, test } from "bun:test";
import { dispatchApprovalCallback } from "./bridge";

const ctx = { allowFrom: new Set([42]), apiBase: "http://cogs", agentId: "flo", registryPath: "/tmp/none.json", dbPath: "/tmp/none.db" };
const cb = { id: "1", data: "pg1:prm_aa", from: { id: 42 }, message: { message_id: 9, chat: { id: 42 } } };

function handlers() {
  const seen: string[] = [];
  return {
    seen,
    h: {
      cogs: (async () => { seen.push("cogs"); return "decided"; }) as any,
      telegram: (async () => { seen.push("telegram"); return "decided"; }) as any,
    },
  };
}

test("cogs(b3chat) 방의 누름은 봇 주인으로 인가하는 cogs 처리로 간다", async () => {
  const { seen, h } = handlers();
  await dispatchApprovalCallback("T", cb, { ...ctx, channelKind: "b3chat" }, h);
  expect(seen).toEqual(["cogs"]);
});

test("텔레그램(채널 없음 포함)은 기존 처리 그대로", async () => {
  const { seen, h } = handlers();
  await dispatchApprovalCallback("T", cb, { ...ctx, channelKind: undefined }, h);
  await dispatchApprovalCallback("T", cb, { ...ctx, channelKind: "telegram" }, h);
  expect(seen).toEqual(["telegram", "telegram"]);
});

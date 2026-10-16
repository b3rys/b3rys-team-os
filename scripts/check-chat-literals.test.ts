import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { newFindings, scanChatLiterals } from "./check-chat-literals";
const file = "src/server/runtimes/codex/bridge.ts";

test("PR #550 receipt source fails; empty coded receipt passes", () => {
  // Source: 80f4c13, src/server/runtimes/codex/bridge.ts:1070.
  expect(scanChatLiterals(file, 'send(chatId, "받았어요", { state: "waiting", replyTo: messageId, idempotencyKey })')).toHaveLength(1);
  expect(scanChatLiterals(file, 'send(chatId, "", { state: "waiting", activityCode: "received" })')).toHaveLength(0);
});

test("transport bodies, aliases, templates, conditional and transformed text", () => {
  for (const source of [
    'sendMessage(id, "fixed")', 'editMessageText(id, mid, `fixed ${id}`)',
    'const body = {chat_id: id, text: "fixed"}; post(body)',
    'tg("sendMessage", {chat_id: id, text: "fixed"})',
    'const label = "fixed"; const text = label; fetch(url, {body: JSON.stringify({chat_id: id, text})})',
    'send(id, cogs ? "fixed" : answer)', 'edit(id, mid, toPlain("fixed"))',
  ]) expect(scanChatLiterals(file, source)).toHaveLength(1);
});

test("LLM text, status args, empty payloads, logs and fixtures are exceptions", () => {
  for (const source of [
    'send(id, answer, {activityCode: "working"})', 'edit(id, mid, "")',
    'console.log({chat_id: id, text: "debug"})',
    'const text = "outer"; function deliver(text) { send(id, text); }',
  ]) expect(scanChatLiterals(file, source)).toHaveLength(0);
  expect(scanChatLiterals("src/server/bridge.test.ts", 'send(id, "fixture")')).toHaveLength(0);
});

test("baseline is an exact expression count; duplicates and changed literals fail", () => {
  const one = scanChatLiterals(file, 'send(id, "legacy")');
  const baseline = { [one[0]!.key]: 1 };
  expect(newFindings(one, baseline)).toHaveLength(0);
  expect(newFindings([...one, ...one], baseline)).toHaveLength(1);
  expect(newFindings(scanChatLiterals(file, 'send(id, "new")'), baseline)).toHaveLength(1);
});

test("production bridge cannot restore #550 receipt under baseline", () => {
  const source = readFileSync(file, "utf8");
  const needle = 'send(chatId, "", { state: "waiting", replyTo: messageId, idempotencyKey })';
  expect(source.includes(needle)).toBe(true);
  const mutant = source.replace(needle, 'send(chatId, "받았어요", { state: "waiting", replyTo: messageId, idempotencyKey })');
  const baseline = JSON.parse(readFileSync("scripts/chat-literals-baseline.json", "utf8")).counts;
  expect(newFindings(scanChatLiterals(file, source), baseline)).toHaveLength(0);
  expect(newFindings(scanChatLiterals(file, mutant), baseline).length).toBeGreaterThan(0);
});

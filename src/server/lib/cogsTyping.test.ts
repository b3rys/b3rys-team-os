import { afterEach, expect, test } from "bun:test";
import { activeCogsTypingCount, startCogsTyping, stopCogsTyping } from "./cogsTyping";

const config = { api_base: "http://127.0.0.1:1" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recorder() {
  const calls: { method: string; body: unknown }[] = [];
  const call = (async (_c: unknown, _t: string, method: string, body: unknown) => { calls.push({ method, body }); return true; }) as any;
  return { calls, call };
}

afterEach(() => { stopCogsTyping("a", "42"); stopCogsTyping("a", "43"); stopCogsTyping("b", "42"); });

test("sends typing at once and then every interval until stopped", async () => {
  const r = recorder();
  startCogsTyping("a", "42", config, "tok", { intervalMs: 20, capMs: 10_000, call: r.call });
  expect(r.calls).toEqual([{ method: "sendChatAction", body: { chat_id: "42", action: "typing" } }]);
  await wait(70);
  const sent = r.calls.length;
  expect(sent).toBeGreaterThanOrEqual(3);
  stopCogsTyping("a", "42");
  expect(activeCogsTypingCount()).toBe(0);
  await wait(50);
  expect(r.calls.length).toBe(sent);
});

test("stops by itself at the cap", async () => {
  const r = recorder();
  startCogsTyping("a", "42", config, "tok", { intervalMs: 10, capMs: 35, call: r.call });
  await wait(60);
  expect(activeCogsTypingCount()).toBe(0);
  const sent = r.calls.length;
  await wait(40);
  expect(r.calls.length).toBe(sent);
});

test("a new message in the same room restarts one loop, not two", async () => {
  const r = recorder();
  startCogsTyping("a", "42", config, "tok", { intervalMs: 1000, capMs: 10_000, call: r.call });
  startCogsTyping("a", "42", config, "tok", { intervalMs: 1000, capMs: 10_000, call: r.call });
  expect(activeCogsTypingCount()).toBe(1);
});

test("rooms and members are separate; stopping one leaves the others", () => {
  const r = recorder();
  startCogsTyping("a", "42", config, "tok", { intervalMs: 1000, call: r.call });
  startCogsTyping("a", "43", config, "tok", { intervalMs: 1000, call: r.call });
  startCogsTyping("b", "42", config, "tok", { intervalMs: 1000, call: r.call });
  stopCogsTyping("a", "42");
  expect(activeCogsTypingCount()).toBe(2);
});

test("a failing typing call is swallowed and the loop keeps going", async () => {
  let n = 0;
  const call = (async () => { n++; throw new Error("cogs_api_failed"); }) as any;
  startCogsTyping("a", "42", config, "tok", { intervalMs: 15, capMs: 10_000, call });
  await wait(50);
  expect(n).toBeGreaterThanOrEqual(2);
  expect(activeCogsTypingCount()).toBe(1);
});

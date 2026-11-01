import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createCogsProgressRoutes, progressCode } from "./cogsProgress";
import { completeCogsProgress, endCogsTypingWithoutReply, isActive, startCogsTyping, stopCogsTyping, updateCogsProgress } from "../lib/cogsTyping";
import { CogsDeliveryUnknown } from "../lib/cogsRelay";
import type { AgentRecord } from "../types";

const config = { api_base: "http://127.0.0.1:1" };
let calls: { method: string; body: any }[];
let agents: AgentRecord[];
let oldEnv: string | undefined;
let opening: (() => Promise<any>) | undefined;
const wait = (ms = 0) => new Promise(r => setTimeout(r, ms));
const call = (async (_c: unknown, _t: string, method: string, body: any) => {
  calls.push({ method, body });
  if (method === "sendMessage") return opening ? opening() : { message_id: 99 };
  return true;
}) as any;
const start = (capMs = 10000) => startCogsTyping("fixture", "42", config, "fixture", { call, capMs });
const progressCalls = () => calls.filter(c => c.method !== "sendChatAction");
const request = async (extra = {}) => {
const response = await createCogsProgressRoutes(() => agents).request("/cogs/progress", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ agent: "fixture", session_id: "session", chat_id: "42", tool_name: "Read", tool_input: { file_path: "PRIVATE_INPUT_SENTINEL" }, ...extra }),
});
await wait(); // Let background fixture calls settle without waiting for the remote promise.
return response;
};

beforeEach(() => {
  calls = []; opening = undefined;
  oldEnv = process.env.B3OS_COGS_PROGRESS;
  delete process.env.B3OS_COGS_PROGRESS;
  agents = [{ id: "fixture", runtime: "claude_channel", tmux_session: "claude-fixture", channel: { kind: "telegram" },
    cogs_inbox: { ...config, token_file: "/tmp/unused-fixture-token", allow_from: ["42"], allow_senders: [] } } as unknown as AgentRecord];
});
afterEach(async () => {
  stopCogsTyping("fixture", "42");
  await wait();
  if (oldEnv === undefined) delete process.env.B3OS_COGS_PROGRESS; else process.env.B3OS_COGS_PROGRESS = oldEnv;
});

test("first tool opens one activity, later tools edit it, first answer completes it", async () => {
  start();
  expect(await (await request()).json()).toEqual({ ok: true, accepted: true });
  await request({ tool_name: "Edit" });
  const id = await completeCogsProgress("fixture", "42", "actual answer");
  expect(id).toBe(99);
  expect(await completeCogsProgress("fixture", "42", "second answer part")).toBeUndefined();
  expect(progressCalls()).toEqual([
    { method: "sendMessage", body: { chat_id: "42", text: "", cogs_response_state: "activity", cogs_activity_code: "read_files", cogs_activity_args: {} } },
    { method: "editMessageText", body: { chat_id: "42", message_id: 99, text: "", cogs_response_state: "activity", cogs_activity_code: "edit_files", cogs_activity_args: {} } },
    { method: "editMessageText", body: { chat_id: "42", message_id: 99, text: "actual answer", cogs_response_state: "complete" } },
  ]);
  expect(isActive("fixture", "42")).toBe(false);
});

test("inactive, wrong member/room, ended, unconfigured and disabled requests are discarded", async () => {
  expect((await request()).status).toBe(202);
  start();
  for (const body of [{ agent: "other" }, { chat_id: "43" }]) expect((await request(body)).status).toBe(202);
  agents = [];
  expect((await request()).status).toBe(202);
  process.env.B3OS_COGS_PROGRESS = "0";
  expect((await request()).status).toBe(202);
  delete process.env.B3OS_COGS_PROGRESS;
  stopCogsTyping("fixture", "42");
  expect((await request()).status).toBe(202);
  expect(progressCalls()).toEqual([]);
});

test("raw tool input is absent from response, outgoing request and console on success and failure", async () => {
  const spies = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
  try {
    start();
    const response = await (await request()).text();
    stopCogsTyping("fixture", "42"); await wait();
    start(); opening = async () => { throw new Error("PRIVATE_INPUT_SENTINEL"); };
    const failure = await (await request()).text();
    expect(response + failure + JSON.stringify(calls)).not.toContain("PRIVATE_INPUT_SENTINEL");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { spies.forEach(s => s.mockRestore()); }
});

test("no reply and expiry cancel the same empty response", async () => {
  for (const expire of [false, true]) {
    calls = []; start(expire ? 20 : 10000);
    await request();
    if (expire) await wait(40); else { stopCogsTyping("fixture", "42"); await wait(); }
    expect(progressCalls().at(-1)).toEqual({ method: "editMessageText", body: { chat_id: "42", message_id: 99, text: "", cogs_response_state: "cancelled" } });
    expect(isActive("fixture", "42")).toBe(false);
  }
});

test("ending without a reply lets the decline remove the open response before anything cancels it", async () => {
  start();
  await request();
  const order: string[] = [];
  const result = await endCogsTypingWithoutReply("fixture", "42", async () => {
    order.push(...progressCalls().map(c => `${c.method}:${c.body.cogs_response_state ?? ""}`));
    return { declined: true };
  });
  await wait();
  expect(result).toEqual({ declined: true });
  // At the decline the response was still the open activity, never cancelled; a taken decline leaves nothing to cancel.
  expect(order).toEqual(["sendMessage:activity"]);
  expect(progressCalls().map(c => c.method)).toEqual(["sendMessage"]);
  expect(isActive("fixture", "42")).toBe(false);
});

test("ending without a reply waits for an in-flight opening, and cancels only what the decline did not take", async () => {
  for (const outcome of ["refused", "failed"] as const) {
    calls = [];
    let release!: () => void;
    opening = () => new Promise(r => { release = () => r({ message_id: 99 }); });
    start();
    await request();
    let seenAtDecline: string[] = [];
    const ending = endCogsTypingWithoutReply("fixture", "42", async () => {
      seenAtDecline = progressCalls().map(c => c.method);
      if (outcome === "failed") throw new Error("decline_failed");
      return { declined: false };
    });
    await wait();
    expect(seenAtDecline).toEqual([]); // the decline waits for the opening to return
    release();
    if (outcome === "failed") await expect(ending).rejects.toThrow("decline_failed"); else await ending;
    await wait();
    expect(seenAtDecline).toEqual(["sendMessage"]);
    expect(progressCalls().at(-1)).toEqual({ method: "editMessageText", body: { chat_id: "42", message_id: 99, text: "", cogs_response_state: "cancelled" } });
    expect(isActive("fixture", "42")).toBe(false);
  }
});

test("ending without a reply in a room with no progress only declines", async () => {
  const result = await endCogsTypingWithoutReply("fixture", "42", async () => ({ declined: false }));
  await wait();
  expect(result).toEqual({ declined: false });
  expect(progressCalls()).toEqual([]);
});

test("a quick answer before the queued first tool never opens a progress message", async () => {
  start();
  const progress = updateCogsProgress("fixture", "42", "read_files");
  const answer = completeCogsProgress("fixture", "42", "quick answer");
  expect(await progress).toBe(false);
  expect(await answer).toBeUndefined();
  expect(progressCalls()).toEqual([]);
});

test("an in-flight opening is completed, not followed by a duplicate message or late activity", async () => {
  let release!: (v: any) => void;
  opening = () => new Promise(resolve => { release = resolve; });
  start();
  const progress = updateCogsProgress("fixture", "42", "read_files");
  await wait();
  const queued = updateCogsProgress("fixture", "42", "edit_files");
  const answer = completeCogsProgress("fixture", "42", "answer");
  release({ message_id: 99 });
  expect(await progress).toBe(true);
  expect(await queued).toBe(false);
  expect(await answer).toBe(99);
  expect(progressCalls().map(c => c.body.cogs_response_state)).toEqual(["activity", "complete"]);
});

test("lost opening acknowledgment suppresses another open but permits normal answer delivery", async () => {
  start(); opening = async () => { throw new CogsDeliveryUnknown(); };
  await request(); await request();
  expect(progressCalls().length).toBe(1);
  expect(await completeCogsProgress("fixture", "42", "answer")).toBeUndefined();
  expect(isActive("fixture", "42")).toBe(false);
});

test("new input in the active room retains its response message", async () => {
  start(); await request(); start(); await request({ tool_name: "Write" });
  expect(progressCalls().map(c => c.method)).toEqual(["sendMessage", "editMessageText"]);
});

test("only tool kinds enter the shared activity code table", () => {
  expect(["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "TodoWrite", "PRIVATE_INPUT_SENTINEL"].map(progressCode))
    .toEqual(["read_files", "read_files", "read_files", "edit_files", "writing", "run_command", "fetch_web", "search", "plan", "run_command"]);
});


for (const failure of [new Error("transport lost"), new CogsDeliveryUnknown()]) {
test(`completion ${failure.constructor.name} can retry the same message without a new opening`, async () => {
  let reject = true;
  const rejecting = (async (c: any, t: string, method: string, body: any) => {
    if (method === "editMessageText" && body.cogs_response_state === "complete" && reject) {
      reject = false; throw failure;
    }
    return call(c, t, method, body);
  }) as any;
  startCogsTyping("fixture", "42", config, "fixture", { call: rejecting });
  await request();
  await expect(completeCogsProgress("fixture", "42", "answer")).rejects.toThrow();
  expect(await completeCogsProgress("fixture", "42", "answer")).toBe(99);
  expect(progressCalls().map(c => c.method)).toEqual(["sendMessage", "editMessageText"]);
});

}


test("a two-second cogs opening does not delay the progress route beyond 100ms", async () => {
  let finished = false;
  let finish!: () => void;
  const completion = new Promise<void>(resolve => { finish = resolve; });
  opening = async () => {
    await wait(2000);
    finished = true; finish();
    return { message_id: 99 };
  };
  start();
  const began = performance.now();
  const response = await request();
  const elapsed = performance.now() - began;
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true, accepted: true });
  expect(elapsed).toBeLessThan(100);
  expect(finished).toBe(false);
  console.log(`slow cogs route response: ${elapsed.toFixed(3)} ms`);
  await completion;
});

test("Read Grep Read sends one activity; only a changed code edits the response", async () => {
  start();
  await Promise.all([request(), request({ tool_name: "Grep" }), request()]);
  expect(progressCalls().map(c => c.method)).toEqual(["sendMessage"]);
  await request({ tool_name: "Edit" });
  expect(progressCalls().map(c => c.method)).toEqual(["sendMessage", "editMessageText"]);
});

test("the completed activity response keeps its original reply connection", async () => {
  startCogsTyping("fixture", "42", config, "fixture", { call, replyToMessageId: 77 });
  await request();
  startCogsTyping("fixture", "42", config, "fixture", { call, replyToMessageId: 88 });
  expect(await completeCogsProgress("fixture", "42", "answer")).toBe(99);
  const [opened, completed] = progressCalls();
  expect(opened?.body.reply_to_message_id).toBe(77);
  expect(completed?.body).toMatchObject({ message_id: 99, text: "answer", cogs_response_state: "complete" });
  expect(isActive("fixture", "42")).toBe(false);
});


test("relay transport does not import the activity lifecycle", async () => {
  const source = await Bun.file(new URL("../lib/cogsRelay.ts", import.meta.url)).text();
  expect(source).not.toMatch(/(?:from\s*|import\s*\()\s*["']\.\/cogsTyping["']/);
});

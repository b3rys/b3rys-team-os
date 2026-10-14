import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "./appServerClient";
import { handleMessage, routeIncoming, sendCogsReceipt, tgEdit, tgSend, resetChatThreads, type BridgeDeps } from "./bridge";
import { createSerialTurnQueue } from "./serialTurnQueue";
import { cogsActivityCode } from "./cogsActivity";

const channel = { kind: "b3chat" as const, apiBase: "http://fixture.invalid", allowFrom: ["1"], ownerChat: "1" };
const oldFc = process.env.B3OS_FIRST_CONTACT_DIR;
afterEach(() => {
  resetChatThreads();
  if (oldFc === undefined) delete process.env.B3OS_FIRST_CONTACT_DIR;
  else process.env.B3OS_FIRST_CONTACT_DIR = oldFc;
});
function client() {
  const c = new CodexAppServerClient();
  const wire: any[] = [];
  (c as any).threadId = "thread";
  (c as any).send = (msg: any) => wire.push(msg);
  const notify = (method: string, params: any) => (c as any).handleNotification(method, params);
  const response = (msg: any) => (c as any).dispatch(msg);
  return { c, wire, notify, response };
}
function fixture(extra: BridgeDeps = {}): BridgeDeps {
  const home = mkdtempSync(join(tmpdir(), "dex-cogs-"));
  process.env.B3OS_FIRST_CONTACT_DIR = home;
  return { channel, agentId: "fixture", workdir: home, codexHome: home, sandbox: "read-only", ...extra };
}

test("cogs reliability: multiple item/phase answers + accepted steer preserve completion-only text", async () => {
  const { c, wire, notify, response } = client();
  let streamed = "";
  const p = c.runTurn("question", { onDelta: t => { streamed += t; } });
  notify("turn/started", { turn: { id: "turn" } });
  notify("item/started", { item: { id: "a", type: "agentMessage", phase: "commentary" } });
  notify("item/agentMessage/delta", { itemId: "a", delta: "앞 답" });
  notify("item/completed", { item: { id: "a", type: "agentMessage", phase: "commentary", text: "앞 답입니다" } });
  let accepted = false;
  const steer = c.steer("추가 지시").then(() => { accepted = true; });
  await Bun.sleep(1);
  expect(accepted).toBe(false);
  response({ id: wire.at(-1).id, result: { turnId: "turn" } });
  await steer;
  notify("item/completed", { item: { id: "b", type: "agentMessage", phase: "final_answer", text: "완료 본문만" } });
  notify("turn/completed", { turn: { status: "completed" } });
  expect((await p).finalText).toBe("앞 답입니다\n\n완료 본문만");
  expect(streamed).toBe("앞 답입니다\n\n완료 본문만");
  // A new turn cannot inherit the previous answer.
  const next = c.runTurn("next");
  notify("turn/completed", { turn: { status: "completed" } });
  expect((await next).finalText).toBe("");
});

test("cogs reliability: rejected steer queues its message and original turn completes normally", async () => {
  const { c, wire, notify, response } = client();
  const p = c.runTurn("original");
  notify("turn/started", { turn: { id: "turn" } });
  let queued = 0;
  const routed = routeIncoming(1, "next message", {
    isRunning: () => true,
    steer: async text => { try { await c.steer(text); return true; } catch { return false; } },
    note: () => { throw new Error("rejected steer cannot be noted as accepted"); },
    enqueue: () => { queued++; }, runTurnFor: async () => {},
  });
  response({ id: wire.at(-1).id, error: { code: -32000, message: "turn no longer steerable" } });
  expect(await routed).toBe("newTurn");
  expect(queued).toBe(1);
  notify("item/completed", { item: { id: "a", type: "agentMessage", text: "original complete" } });
  notify("turn/completed", { turn: { status: "completed" } });
  expect(await p).toMatchObject({ status: "completed", finalText: "original complete" });
});

test("cogs reliability: receipt precedes blocked serial queue and its id is reused", async () => {
  let release!: () => void;
  const queue = createSerialTurnQueue(() => {});
  queue.enqueue(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const sends: any[] = [], edits: any[] = [];
  const deps = fixture({
    sendMessage: async (_chat, text, metadata) => { sends.push({ text, ...metadata }); return 77; },
    editMessage: async (_chat, id, text, state) => { edits.push({ id, text, state }); return true; },
    runTurn: async o => { o.onDelta?.("앞 답"); return { ok: true, reply: "뒤 답", elapsedMs: 0, detail: "ok" }; },
  });
  let receipt!: Promise<number | null>;
  let finished!: () => void;
  const done = new Promise<void>(r => { finished = r; });
  await routeIncoming(1, "message", {
    receive: () => (receipt = sendCogsReceipt(1, 9, deps.sendMessage!)),
    isRunning: () => false, steer: async () => false, note: () => {}, enqueue: run => queue.enqueue(run),
    runTurnFor: async () => { await handleMessage(1, "message", 9, deps, undefined, "poll", false, receipt); finished(); },
  });
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ text: "받았어요", state: "waiting", replyTo: 9 });
  expect(edits).toHaveLength(0);
  release(); await done;
  expect(sends).toHaveLength(1);
  expect(edits.at(-1)).toMatchObject({ id: 77, text: "앞 답\n\n뒤 답", state: "complete" });
});

test("cogs reliability: first actual tool update is immediate, no tool keeps receipt/waiting", async () => {
  let firstEditAt = 0;
  const started = Date.now();
  let noToolCount = -1, immediateCount = -1;
  const edits: any[] = [];
  await handleMessage(1, "message", 9, fixture({
    sendMessage: async () => 77,
    editMessage: async (_chat, _id, text, state, activity, code) => { firstEditAt ||= Date.now() - started; edits.push({ text, state, activity, code }); return true; },
    runTurn: async o => {
      o.onStatus?.("🧠 생각하는 중…"); o.onActivity?.("받음: 다음 말");
      await Bun.sleep(20); noToolCount = edits.length;
      o.onActivity?.("실행", "t", { type: "commandExecution", command: "bun test" });
      immediateCount = edits.length;
      return { ok: true, reply: "done", elapsedMs: 0, detail: "ok" };
    },
  }));
  expect(noToolCount).toBe(0);
  expect(immediateCount).toBe(1);
  expect(firstEditAt).toBeGreaterThan(0);
  expect(firstEditAt).toBeLessThan(250);
  expect(edits[0]).toMatchObject({ state: "activity", code: "run_tests" });
  expect(edits.at(-1).state).toBe("complete");
});

test("cogs reliability: receipt timeout/retry is bounded and reuses the same key", async () => {
  const keys: string[] = [];
  const result = await sendCogsReceipt(1, 9, async (_chat, _text, meta) => {
    keys.push(meta!.idempotencyKey!);
    return new Promise(() => {});
  }, 15);
  expect(result).toBeNull(); expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(Buffer.byteLength(keys[0]!)).toBeLessThanOrEqual(128);
});

test("cogs reliability: every plain send has a distinct intent key, network retry reuses it", async () => {
  const bodies: any[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) throw new Error("response lost after storage");
    return Response.json({ ok: true, result: { message_id: 77 } });
  }) as typeof fetch;
  const send = tgSend("fixture", fetchFn, { plainOnly: true, apiBase: channel.apiBase });
  expect(await send(1, "hello")).toBe(77);
  await send(1, "hello");
  expect(bodies).toHaveLength(3);
  expect(bodies[0].cogs_idempotency_key).toBe(bodies[1].cogs_idempotency_key);
  expect(bodies[2].cogs_idempotency_key).not.toBe(bodies[1].cogs_idempotency_key);
  expect(bodies.every(b => typeof b.cogs_idempotency_key === "string" && Buffer.byteLength(b.cogs_idempotency_key) <= 128)).toBe(true);
});

test("cogs reliability: activity code is carried in send and edit requests", async () => {
  const bodies: any[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, result: { message_id: 77 } });
  }) as typeof fetch;
  await tgSend("fixture", fetchFn, { plainOnly: true })(1, "code", { state: "activity", activity: "수정", activityCode: "code_edit" });
  await tgEdit("fixture", fetchFn, { plainOnly: true })(1, 77, "code", "activity", "수정", "code_edit");
  expect(bodies.map(b => b.cogs_activity_code)).toEqual(["code_edit", "code_edit"]);
  expect(cogsActivityCode({ type: "fileChange", changes: [{ path: "app.ts" }] })).toBe("code_edit");
  expect(cogsActivityCode({ type: "fileChange", changes: [{ path: "readme.md" }] })).toBe("writing");
  expect(cogsActivityCode({ type: "webSearch", action: { type: "openPage" } })).toBe("fetch_web");
  expect(cogsActivityCode({ type: "mcpToolCall", name: "update_plan" })).toBe("plan");
});

test("cogs reliability: unsupported schedule completes the existing receipt without another send", async () => {
  const sends: any[] = [], edits: any[] = [];
  const deps = fixture({
    scheduleToolEnabled: false,
    sendMessage: async (_chat, text, meta) => { sends.push({ text, ...meta }); return 77; },
    editMessage: async (_chat, id, text, state) => { edits.push({ id, text, state }); return true; },
    runTurn: async () => { throw new Error("unsupported schedule must not run the model"); },
  });
  const receipt = sendCogsReceipt(1, 9, deps.sendMessage!);
  const result = await handleMessage(1, "5분 뒤에 나한테 메시지를 보내줘", 9, deps, undefined, "poll", false, receipt);
  expect(result.detail).toBe("schedule_unsupported");
  expect(sends).toHaveLength(1);
  expect(edits).toHaveLength(1);
  expect(edits[0]).toMatchObject({ id: 77, state: "complete" });
  expect(edits[0].text).toContain("예약");
});

test("cogs reliability: interleaved item completion renders ordered text through complete", async () => {
  const { c, notify } = client();
  const edits: any[] = [];
  await handleMessage(1, "question", 9, fixture({
    sendMessage: async () => 77,
    editMessage: async (_chat, _id, text, state) => { edits.push({ text, state }); return true; },
    runTurn: async o => {
      const p = c.runTurn("question", {
        onDelta: o.onDelta,
        onAnswerText: o.onAnswerText,
      });
      notify("item/agentMessage/delta", { itemId: "a", delta: "앞" });
      notify("item/agentMessage/delta", { itemId: "b", delta: "뒤" });
      notify("item/completed", { item: { id: "a", type: "agentMessage", phase: "commentary", text: "앞 보완" } });
      await Bun.sleep(450);
      notify("item/completed", { item: { id: "b", type: "agentMessage", phase: "final_answer", text: "뒤 완료" } });
      notify("turn/completed", { turn: { status: "completed" } });
      const r = await p;
      return { ok: true, reply: r.finalText, detail: "ok", elapsedMs: 0 };
    },
  }));
  expect(edits.find(e => e.text === "앞 보완\n\n뒤" && e.state === "streaming")).toBeDefined();
  expect(edits.at(-1)).toMatchObject({ text: "앞 보완\n\n뒤 완료", state: "complete" });
});

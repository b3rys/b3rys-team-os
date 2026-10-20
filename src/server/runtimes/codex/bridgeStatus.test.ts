import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "./appServerClient";
import { runViaAppServer } from "./appServerRunner";
import { handleMessage, resetChatThreads, tgEdit, tgSend } from "./bridge";

const oldFc = process.env.B3OS_FIRST_CONTACT_DIR;
afterEach(() => {
  resetChatThreads();
  if (oldFc === undefined) delete process.env.B3OS_FIRST_CONTACT_DIR;
  else process.env.B3OS_FIRST_CONTACT_DIR = oldFc;
});
type Request = Record<string, any>;
type Emit = (method: string, item: Record<string, unknown>) => void;

// Only process IO is replaced: events pass through client, runner, bridge and HTTP encoding.
async function turn(script: (emit: Emit, requests: Request[]) => Promise<void>, telegram = false) {
  const home = mkdtempSync(join(tmpdir(), "bridge-status-"));
  process.env.B3OS_FIRST_CONTACT_DIR = home;
  const requests: Request[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 6 } });
  }) as typeof fetch;
  const transport = { apiBase: "http://app.invalid", plainOnly: true };
  const client = new CodexAppServerClient();
  const internal = client as unknown as {
    threadId: string; notify: () => Promise<void>;
    handleNotification: (method: string, params: unknown) => void;
  };
  internal.threadId = "fixture-thread";
  internal.notify = async () => {};
  client.start = async () => {};
  client.startThread = async () => "fixture-thread";
  const run = client.runTurn.bind(client);
  client.runTurn = async (...args) => {
    const pending = run(...args);
    try {
      await script((method, item) => internal.handleNotification(method, method === "item/agentMessage/delta" ? item : { item }), requests);
      internal.handleNotification("item/completed", { item: { id: "final", type: "agentMessage", text: "done" } });
    } finally {
      internal.handleNotification("turn/completed", { turn: { status: "completed" } });
    }
    return pending;
  };
  const result = await handleMessage(91, "question", 5, {
    agentId: "statusfixture", workdir: home, codexHome: home, sandbox: "read-only",
    channel: telegram ? { kind: "telegram", apiBase: "http://telegram.invalid", allowFrom: ["91"], ownerChat: "91" } :
      { kind: "b3chat", apiBase: transport.apiBase, allowFrom: ["91"], ownerChat: "91" },
    sendMessage: tgSend("fixture", fetchFn, transport), editMessage: tgEdit("fixture", fetchFn, transport),
    reactMessage: async () => true,
    runTurn: options => runViaAppServer(options, undefined, () => client),
  });
  expect(result.turnOk).toBe(true);
  return requests;
}
const updates = (requests: Request[]) => requests.filter(r => r.message_id === 6 && r.cogs_response_state !== "complete");
const reasoning = (summary: string | string[] = []) => ({ id: "r1", type: "reasoning", summary, content: [] });

test("cogs reasoning sends changed first lines as thinking args, suppresses duplicates and empty summaries", async () => {
  const requests = await turn(async (emit, requests) => {
    emit("item/started", reasoning());
    emit("item/completed", reasoning(["", "\n  \n"]));
    await Bun.sleep(30);
    expect(updates(requests)).toHaveLength(0);
    emit("item/started", reasoning(["", "\n 첫 요약 \n두 번째 줄", "다음 원소"]));
    await Bun.sleep(450);
    expect(updates(requests)).toHaveLength(1);
    emit("item/completed", reasoning(["첫 요약", "다른 두 번째 줄"]));
    await Bun.sleep(450);
    expect(updates(requests)).toHaveLength(1);
    emit("item/started", { id: "s", type: "webSearch", query: "query" });
    await Bun.sleep(450);
    emit("item/completed", reasoning(["첫 요약"]));
    await Bun.sleep(450);
    expect(updates(requests)).toHaveLength(2);
    emit("item/completed", reasoning(["😀".repeat(65)]));
    await Bun.sleep(450);
  });
  const stages = updates(requests).filter((r, i, all) => i === 0 ||
    r.cogs_activity_code !== all[i-1]?.cogs_activity_code ||
    JSON.stringify(r.cogs_activity_args) !== JSON.stringify(all[i-1]?.cogs_activity_args));
  expect(stages.map(r => [r.cogs_activity_code, r.cogs_activity_args])).toEqual([
    ["thinking", { target: "첫 요약" }], ["search", { target: "query" }], ["thinking", { target: "😀".repeat(60) }],
  ]);
  expect(updates(requests).slice(0, 3).every(r => r.text === "" && r.cogs_response_state === "activity")).toBe(true);
  expect(requests.every(r => !("cogs_activity" in r))).toBe(true);
});

test("cogs search started without target is enriched on completed, including queued completion", async () => {
  const requests = await turn(async (emit, requests) => {
    emit("item/started", { id: "s", type: "webSearch", query: "", action: null });
    await Bun.sleep(30);
    expect(updates(requests).at(-1)?.cogs_activity_args).toEqual({ target: "" });
    emit("item/completed", { id: "s", type: "webSearch", action: { query: "completed query" } });
  });
  expect(updates(requests).filter(r => r.cogs_activity_code).at(-1)?.cogs_activity_code).toBe("search");
  expect(updates(requests).filter(r => r.cogs_activity_code).at(-1)?.cogs_activity_args).toEqual({ target: "completed query" });
});

for (const delta of [false, true]) {
  test(`first commentary agentMessage reaches app before tools and turn completion (delta=${delta})`, async () => {
    await turn(async (emit, requests) => {
      const item = { id: "a", type: "agentMessage", phase: "commentary", text: "확인하겠습니다" };
      emit("item/started", item);
      await Bun.sleep(30);
      expect(updates(requests)).toHaveLength(0);
      if (delta) {
        emit("item/agentMessage/delta", { itemId: "a", delta: "확인", phase: "commentary" });
        await Bun.sleep(30);
        expect(updates(requests).at(-1)?.text).toBe("확인");
      }
      emit("item/completed", item);
      await Bun.sleep(450);
      expect(updates(requests).at(-1)?.text).toBe("확인하겠습니다");
      expect(updates(requests).at(-1)?.cogs_response_state).toBe("streaming");
      expect(requests.some(r => r.cogs_response_state === "complete")).toBe(false);
      emit("item/started", { id: "s", type: "webSearch", query: "query" });
      await Bun.sleep(450);
      expect(updates(requests).at(-1)?.text).toBe("확인하겠습니다");
    });
  });
}

test("cogs reasoning after a tool and answer preserves streaming text", async () => {
  await turn(async (emit, requests) => {
    emit("item/started", { id: "s", type: "webSearch", query: "query" });
    await Bun.sleep(450);
    emit("item/completed", { id: "a", type: "agentMessage", text: "앞 답" });
    await Bun.sleep(450);
    emit("item/completed", reasoning(["후속 요약"]));
    await Bun.sleep(450);
    expect(updates(requests).at(-1)).toMatchObject({ text: "앞 답", cogs_response_state: "streaming", cogs_activity_code: "thinking", cogs_activity_args: { target: "후속 요약" } });
  });
});

test("Telegram receives protocol array summary headers without cogs thinking metadata", async () => {
  const requests = await turn(async (emit, requests) => {
    emit("item/started", reasoning(["첫 요약"]));
    await Bun.sleep(30);
    expect(requests.some(r => String(r.text).includes("첫 요약"))).toBe(true);
    emit("item/completed", reasoning(["둘째 요약"]));
  }, true);
  expect(requests.every(r => !r.cogs_activity_code)).toBe(true);
});


test("cogs retains legacy string reasoning summary support", async () => {
  const requests = await turn(async emit => {
    emit("item/completed", reasoning("기존 문자열 요약\n둘째 줄"));
  });
  expect(updates(requests).find(r => r.cogs_activity_code === "thinking")?.cogs_activity_args)
    .toEqual({ target: "기존 문자열 요약" });
});

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
async function turn(script: (emit: Emit, requests: Request[]) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "bridge-status-"));
  process.env.B3OS_FIRST_CONTACT_DIR = home;
  const requests: Request[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 6 } });
  }) as typeof fetch;
  const transport = { apiBase: "http://telegram.invalid" };
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
    channel: { kind: "telegram", apiBase: transport.apiBase, allowFrom: ["91"], ownerChat: "91" },
    sendMessage: tgSend("fixture", fetchFn, transport), editMessage: tgEdit("fixture", fetchFn, transport),
    reactMessage: async () => true,
    runTurn: options => runViaAppServer(options, undefined, () => client),
  });
  expect(result.turnOk).toBe(true);
  return requests;
}
const reasoning = (summary: string | string[] = []) => ({ id: "r1", type: "reasoning", summary, content: [] });

test("Telegram receives protocol array summary headers", async () => {
  const requests = await turn(async (emit, requests) => {
    emit("item/started", reasoning(["첫 요약"]));
    await Bun.sleep(30);
    expect(requests.some(r => String(r.text).includes("첫 요약"))).toBe(true);
    emit("item/completed", reasoning(["둘째 요약"]));
  });
  expect(requests.length).toBeGreaterThan(0);
});

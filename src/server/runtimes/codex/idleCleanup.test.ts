import { afterEach, expect, test } from "bun:test";
import { CodexAppServerClient } from "./appServerClient";
import { acquireClient, dropAllClients, dropClient, pooledAgents, releaseIdleClient } from "./clientPool";

afterEach(() => dropAllClients());

function clientWith(states: Record<string, string>, changeList = false) {
  const c = new CodexAppServerClient();
  let reads = 0;
  (c as any).request = async (method: string, params: any) => method === "thread/loaded/list"
    ? { data: changeList && reads++ > 0 ? [...Object.keys(states), "new-child"] : Object.keys(states) }
    : { thread: { status: { type: states[params.threadId] } } };
  return c;
}

test("A completed parent with an active child is kept; idle parent and child can close", async () => {
  expect(await clientWith({ parent: "idle", child: "active" }).isIdle()).toBe(false);
  expect(await clientWith({ parent: "idle", child: "idle" }).isIdle()).toBe(true);
});

test("Unknown status, a new child during inspection, or a failed query never permits closure", async () => {
  expect(await clientWith({ parent: "unknown" }).isIdle()).toBe(false);
  expect(await clientWith({ parent: "idle" }, true).isIdle()).toBe(false);
  const c = new CodexAppServerClient();
  (c as any).request = async () => { throw new Error("fixture unavailable"); };
  expect(await c.isIdle()).toBe(false);
});

test("Loaded thread pagination includes an active child on the next page", async () => {
  const c = new CodexAppServerClient();
  (c as any).request = async (method: string, p: any) => method === "thread/loaded/list"
    ? p.cursor ? { data: ["child"] } : { data: ["parent"], nextCursor: "page2" }
    : { thread: { status: { type: p.threadId === "child" ? "active" : "idle" } } };
  expect(await c.isIdle()).toBe(false);
});

function poolClient(idle: () => Promise<boolean>) {
  return { isClosed: false, closed: 0, isIdle: idle, close() { this.closed++; this.isClosed = true; } };
}

test("An idle pooled client closes once and is removed", async () => {
  const { client } = acquireClient("probe", () => poolClient(async () => true));
  await releaseIdleClient("probe", client);
  expect(client.closed).toBe(1);
  expect(pooledAgents()).toEqual([]);
});

test("An active child is retained, then cleaned after becoming idle", async () => {
  let idle = false;
  const { client } = acquireClient("probe", () => poolClient(async () => idle));
  await releaseIdleClient("probe", client, 10);
  expect(client.closed).toBe(0);
  idle = true;
  for (let i = 0; i < 20 && !client.closed; i++) await Bun.sleep(5);
  expect(client.closed).toBe(1);
});

test("A new turn acquired during the idle query invalidates the old cleanup result", async () => {
  let finish!: (value: boolean) => void;
  const { client } = acquireClient("probe", () => poolClient(() => new Promise((r) => { finish = r; })));
  const cleanup = releaseIdleClient("probe", client);
  expect(acquireClient("probe", () => { throw new Error("must reuse"); }).reused).toBe(true);
  finish(true);
  await cleanup;
  expect(client.closed).toBe(0);
  expect(pooledAgents()).toEqual(["probe"]);
});

test("A new turn cancels a pending idle retry; failed-turn drop cancels it too", async () => {
  let checks = 0;
  const { client } = acquireClient("probe", () => poolClient(async () => { checks++; return false; }));
  await releaseIdleClient("probe", client, 10);
  acquireClient("probe", () => client);
  await Bun.sleep(25);
  expect(checks).toBe(1);
  await releaseIdleClient("probe", client, 10);
  dropClient("probe");
  await Bun.sleep(25);
  expect(checks).toBe(2);
  expect(client.closed).toBe(1);
});

test("The production caller releases an idle pooled process and retains a running child", async () => {
  const script = `
    import { CodexAppServerClient } from ${JSON.stringify(import.meta.dir + "/appServerClient.ts")};
    import { runViaAppServer } from ${JSON.stringify(import.meta.dir + "/appServerRunner.ts")};
    import { dropAllClients, pooledAgents } from ${JSON.stringify(import.meta.dir + "/clientPool.ts")};
    let idle = true;
    CodexAppServerClient.prototype.start = async function() {};
    CodexAppServerClient.prototype.startThread = async function() { this.threadId = 'fixture'; return 'fixture'; };
    CodexAppServerClient.prototype.runTurn = async function() { return {status:'completed',finalText:'ok',turnId:'fixture'}; };
    CodexAppServerClient.prototype.isIdle = async function() { return idle; };
    const a = await runViaAppServer({agentId:'idle-probe',prompt:'fixture'});
    if (!a.ok || pooledAgents().length) throw new Error('idle process leaked');
    idle = false;
    const b = await runViaAppServer({agentId:'active-probe',prompt:'fixture'});
    if (!b.ok || !pooledAgents().includes('active-probe')) throw new Error('running child was lost');
    dropAllClients();
  `;
  const p = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(code, err).toBe(0);
});

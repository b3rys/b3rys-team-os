import { spawn } from "node:child_process";
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

test("A child followup during the last loaded/list invalidates idle even with identical IDs", async () => {
  for (const method of ["turn/started", "thread/status/changed"]) {
    const c = new CodexAppServerClient();
    let lists = 0;
    (c as any).request = async (m: string) => {
      if (m === "thread/read") return { thread: { status: { type: "idle" } } };
      if (++lists === 2) (c as any).handleNotification(method, { threadId: "child", status: { type: "active" }, turn: { id: "followup" } });
      return { data: ["parent", "child"] };
    };
    acquireClient("probe", () => c);
    await releaseIdleClient("probe", c);
    expect(c.isClosed).toBe(false);
    expect(pooledAgents()).toEqual(["probe"]);
    dropClient("probe");
  }
});

test("Failed close stays tracked, blocks replacement, warns, and retries successfully", async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args) => { warnings.push(args); };
  let fail = true;
  let closes = 0;
  const c = { isClosed: false, close() { closes++; if (fail) throw new Error("fixture kill failure"); this.isClosed = true; } };
  try {
    acquireClient("probe", () => c);
    expect(dropClient("probe")).toBe(false);
    expect(pooledAgents()).toEqual(["probe"]);
    expect(() => acquireClient("probe", () => { throw new Error("must not spawn"); })).toThrow("cleanup pending");
    expect(warnings.length).toBeGreaterThan(0);
    fail = false;
    for (let i = 0; i < 30 && !c.isClosed; i++) await Bun.sleep(50);
    expect(c.isClosed).toBe(true);
    expect(closes).toBeGreaterThanOrEqual(3);
    expect(pooledAgents()).toEqual([]);
  } finally { fail = false; console.warn = originalWarn; }
});

test("Client preserves a process on kill false or exception and can close it on retry", () => {
  for (const result of [false, "throw"]) {
    const warnings: string[] = [];
    const c = new CodexAppServerClient({ warn: (line) => warnings.push(line) });
    let fail = true;
    const proc = { exitCode: null, signalCode: null, kill() { if (fail) { if (result === "throw") throw new Error("fixture"); return false; } this.exitCode = 0 as any; return true; }, once() {} };
    (c as any).proc = proc;
    expect(() => c.close()).toThrow();
    expect(c.isClosed).toBe(false);
    expect((c as any).proc).toBe(proc);
    expect(warnings.length).toBe(1);
    fail = false;
    c.close();
    expect(c.isClosed).toBe(true);
  }
});

test("A process ignoring TERM receives KILL; a failed KILL warns and retries", async () => {
  const warnings: string[] = [];
  const signals: string[] = [];
  const c = new CodexAppServerClient({ warn: (line) => warnings.push(line) });
  const proc = {
    exitCode: null as number | null, signalCode: null,
    kill(signal: string) {
      signals.push(signal);
      if (signals.length === 2) return false;
      if (signal === "SIGKILL") this.exitCode = 0;
      return true;
    }, once() {},
  };
  (c as any).proc = proc;
  c.close();
  for (let i = 0; i < 55 && proc.exitCode === null; i++) await Bun.sleep(50);
  expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
  expect(warnings).toHaveLength(1);
  expect(proc.exitCode).toBe(0);
});


test("A real child ignoring TERM is forcibly reaped", async () => {
  const proc = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { proc.stdout.once("data", () => resolve()); proc.once("error", reject); });
    const exited = new Promise<string | null>((resolve) => proc.once("close", (_code, signal) => resolve(signal)));
    const c = new CodexAppServerClient();
    (c as any).proc = proc;
    c.close();
    expect(await exited).toBe("SIGKILL");
    expect((c as any).proc).toBeNull();
  } finally { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); }
});

test("Failed idle TERM retries must recheck a child that becomes active", async () => {
  const c = new CodexAppServerClient({ warn() {} });
  let idle = true;
  const signals:string[]=[];
  (c as any).isIdle = async () => idle;
  (c as any).proc = {exitCode:null,signalCode:null,kill(signal:string){signals.push(signal);return false;}};
  acquireClient("probe",()=>c);
  await releaseIdleClient("probe",c);
  expect(signals).toEqual(["SIGTERM"]);
  idle=false;
  await Bun.sleep(1100);
  expect(signals).toEqual(["SIGTERM"]);
  expect(pooledAgents()).toEqual(["probe"]);
  (c as any).proc=null;
});

test("Idle escalation rechecks activity; a new message cancels escalation entirely", async () => {
 for (const newMessage of [false,true]) {
  const c=new CodexAppServerClient();let idle=true;const signals:string[]=[];
  (c as any).isIdle=async()=>idle;
  (c as any).proc={exitCode:null,signalCode:null,kill(signal:string){signals.push(signal);return true;}};
  acquireClient("probe",()=>c);
  await releaseIdleClient("probe",c);
  expect(signals).toEqual(["SIGTERM"]);
  if(newMessage) acquireClient("probe",()=>{throw new Error("reuse expected")});else idle=false;
  await Bun.sleep(1100);
  expect(signals).toEqual(["SIGTERM"]);
  (c as any).proc=null;dropClient("probe");
 }
});

test("Idle escalation occurs only after a fresh successful query; in-query reuse cancels it", async () => {
  const c=new CodexAppServerClient();const signals:string[]=[];let queries=0;
  const proc={exitCode:null as number|null,signalCode:null,kill(signal:string){signals.push(signal);if(signal==="SIGKILL")this.exitCode=0;return true;}};
  (c as any).proc=proc;(c as any).isIdle=async()=>{queries++;return true};
  acquireClient("probe",()=>c);await releaseIdleClient("probe",c);
  for(let i=0;i<30&&proc.exitCode===null;i++)await Bun.sleep(50);
  expect(signals).toEqual(["SIGTERM","SIGKILL"]);expect(queries).toBeGreaterThanOrEqual(4);
  expect(pooledAgents()).toEqual([]);
  const d=new CodexAppServerClient();const sent:string[]=[];let finish!:(idle:boolean)=>void;
  (d as any).proc={exitCode:null,signalCode:null,kill(signal:string){sent.push(signal);return true}};
  (d as any).isIdle=()=>new Promise<boolean>(resolve=>{finish=resolve});
  acquireClient("probe",()=>d);
  let reused=false;
  const attempt=d.terminateIfIdle(()=>pooledAgents().includes("probe") && !reused);
  acquireClient("probe",()=>d);reused=true;finish(true);
  expect(await attempt).toBe("cancelled");expect(sent).toEqual([]);
  (d as any).proc=null;
});

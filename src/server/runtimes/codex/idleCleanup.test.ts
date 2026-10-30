import { spawn } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { CodexAppServerClient } from "./appServerClient";
import { acquireClient, dropAllClients, dropClient, pooledAgents, releaseIdleClient, retiredClientCount, IDLE_CLIENT_GRACE_MS } from "./clientPool";

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
  await releaseIdleClient("probe", client, 10000, 0);
  expect(client.closed).toBe(1);
  expect(pooledAgents()).toEqual([]);
});

test("An active child is retained, then cleaned after becoming idle", async () => {
  let idle = false;
  const { client } = acquireClient("probe", () => poolClient(async () => idle));
  await releaseIdleClient("probe", client, 10, 0);
  expect(client.closed).toBe(0);
  idle = true;
  for (let i = 0; i < 20 && !client.closed; i++) await Bun.sleep(5);
  expect(client.closed).toBe(1);
});

test("A new turn acquired during the idle query invalidates the old cleanup result", async () => {
  let finish!: (value: boolean) => void;
  const { client } = acquireClient("probe", () => poolClient(() => new Promise((r) => { finish = r; })));
  const cleanup = releaseIdleClient("probe", client, 10000, 0);
  expect(acquireClient("probe", () => { throw new Error("must reuse"); }).reused).toBe(true);
  finish(true);
  await cleanup;
  expect(client.closed).toBe(0);
  expect(pooledAgents()).toEqual(["probe"]);
});

test("A new turn cancels a pending idle retry; failed-turn drop cancels it too", async () => {
  let checks = 0;
  const { client } = acquireClient("probe", () => poolClient(async () => { checks++; return false; }));
  await releaseIdleClient("probe", client, 10, 0);
  acquireClient("probe", () => client);
  await Bun.sleep(25);
  expect(checks).toBe(1);
  await releaseIdleClient("probe", client, 10, 0);
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
  const p = Bun.spawn([process.execPath, "-e", script], { env: {...process.env,B3OS_CODEX_IDLE_GRACE_MS:"0"}, stdout: "pipe", stderr: "pipe" });
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
    await releaseIdleClient("probe", c, 10000, 0);
    expect(c.isClosed).toBe(false);
    expect(pooledAgents()).toEqual(["probe"]);
    dropClient("probe");
  }
});

test("Failed termination stays retired and never targets a replacement", async () => {
  const originalWarn = console.warn; const warnings: unknown[][]=[];
  console.warn=(...args)=>{warnings.push(args)};
  let fail=true;let closes=0;
  const old={isClosed:false,close(){closes++;if(fail)throw new Error("fixture");this.isClosed=true}};
  const fresh=poolClient(async()=>false);
  try {
    acquireClient("probe",()=>old);dropClient("probe");
    expect(pooledAgents()).toEqual([]);expect(retiredClientCount()).toBe(1);
    expect(acquireClient("probe",()=>fresh).reused).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);fail=false;
    for(let i=0;i<30&&!old.isClosed;i++)await Bun.sleep(50);
    expect(old.isClosed).toBe(true);expect(closes).toBeGreaterThanOrEqual(2);
    expect(fresh.closed).toBe(0);expect(pooledAgents()).toEqual(["probe"]);expect(retiredClientCount()).toBe(0);
  }finally{fail=false;console.warn=originalWarn}
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

test("A failed idle TERM stays retired even if activity changes; only the old process is retried",async()=>{
  const c=new CodexAppServerClient({warn(){}});let queries=0;const signals:string[]=[];
  (c as any).isIdle=async()=>{queries++;return true};
  const proc={exitCode:null as number|null,signalCode:null,kill(signal:string){signals.push(signal);if(signals.length===1)return false;this.exitCode=0;return true},once(){}};
  (c as any).proc=proc;acquireClient("probe",()=>c);await releaseIdleClient("probe", c, 10000, 0);
  expect(signals).toEqual(["SIGTERM"]);expect(pooledAgents()).toEqual([]);expect(c.isClosed).toBe(true);
  (c as any).isIdle=async()=>{queries++;return false};
  const fresh=acquireClient("probe",()=>poolClient(async()=>false)).client;
  for(let i=0;i<30&&proc.exitCode===null;i++)await Bun.sleep(50);
  expect(queries).toBe(1);expect(signals).toEqual(["SIGTERM","SIGTERM"]);
  expect(fresh.closed).toBe(0);expect(pooledAgents()).toEqual(["probe"]);
});

test("The entry is retired before the very first signal; acquisition inside kill gets a new client",async()=>{
  const c=new CodexAppServerClient();(c as any).isIdle=async()=>true;
  const fresh=poolClient(async()=>false);let reused:boolean|undefined;
  (c as any).proc={exitCode:null,signalCode:null,kill(){reused=acquireClient("probe",()=>fresh).reused;this.exitCode=0;return true},once(){}};
  acquireClient("probe",()=>c);await releaseIdleClient("probe", c, 10000, 0);
  expect(reused).toBe(false);expect(c.isClosed).toBe(true);expect(fresh.closed).toBe(0);
  expect(acquireClient<ReturnType<typeof poolClient>>("probe",()=>{throw new Error("fresh client must stay pooled")}).client).toBe(fresh);
});

test("A final idle query cannot retire after another message acquired the client",async()=>{
  const c=new CodexAppServerClient();let finish!:(idle:boolean)=>void;
  (c as any).isIdle=()=>new Promise<boolean>(resolve=>{finish=resolve});
  acquireClient("probe",()=>c);const cleanup=releaseIdleClient("probe", c, 10000, 0);
  expect(acquireClient("probe",()=>{throw new Error("reuse")}).reused).toBe(true);
  finish(true);await cleanup;expect(c.isClosed).toBe(false);expect(pooledAgents()).toEqual(["probe"]);
});

test("A real JSON-RPC process retiring after TERM cannot receive the next turn",async()=>{
  const script=`
    const rl=require('node:readline').createInterface({input:process.stdin});
    const send=x=>console.log(JSON.stringify(x));let lists=0;
    process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),300));
    rl.on('line',line=>{const q=JSON.parse(line);const id=q.id;
      if(q.method==='initialize')send({id,result:{}});
      if(q.method==='thread/start')send({id,result:{thread:{id:'thread'}}});
      if(q.method==='thread/loaded/list'){if(++lists===2&&process.env.CHILD_RESTART)send({method:process.env.CHILD_RESTART,params:{threadId:'child',status:{type:'active'},turn:{id:'child-followup'}}});send({id,result:{data:['thread','child']}})}
      if(q.method==='thread/read')send({id,result:{thread:{status:{type:'idle'}}}});
      if(q.method==='turn/start'){
        send({id,result:{}});send({method:'turn/started',params:{turn:{id:'turn'}}});
        setTimeout(()=>{send({method:'item/completed',params:{item:{id:'answer',type:'agentMessage',text:'fresh turn survived'}}});send({method:'turn/completed',params:{turn:{status:'completed'}}})},550);
      }
    });`;
  const make=async(notify="")=>{
    const client=new CodexAppServerClient();
    const proc=spawn(process.execPath,['-e',script],{stdio:['pipe','pipe','pipe'],env:{...process.env,CHILD_RESTART:notify}});
    (client as any).proc=proc;proc.stdout.on('data',d=>(client as any).onData(d.toString()));
    proc.on('close',()=>{(client as any).closed=true;(client as any).failAll(new Error('fixture closed'))});
    await (client as any).request('initialize',{},1000);
    return {client,proc};
  };
  for(const method of ["turn/started","thread/status/changed"]){
    const child=await make(method);
    try{
      acquireClient("child-probe",()=>child.client);await releaseIdleClient("child-probe", child.client, 10000, 0);
      expect(pooledAgents()).toContain("child-probe");expect(child.proc.killed).toBe(false);
    }finally{dropClient("child-probe");child.proc.kill("SIGKILL")}
  }
  for(let i=0;i<30&&retiredClientCount();i++)await Bun.sleep(50);
  const old=await make();let next:Awaited<ReturnType<typeof make>>|undefined;
  try{
    acquireClient('probe',()=>old.client);await releaseIdleClient('probe', old.client, 10000, 0);
    expect(pooledAgents()).toEqual([]);expect(old.proc.killed).toBe(true);
    next=await make();const acquired=acquireClient('probe',()=>next!.client);
    expect(acquired.reused).toBe(false);expect(next.proc.pid).not.toBe(old.proc.pid);
    await acquired.client.startThread({});const result=await acquired.client.runTurn('fixture',{},2000);
    expect(result.status).toBe('completed');expect(result.finalText).toBe('fresh turn survived');
    expect(next.proc.exitCode).toBeNull();expect(next.proc.signalCode).toBeNull();
    for(let i=0;i<30&&retiredClientCount();i++)await Bun.sleep(50);
    expect(retiredClientCount()).toBe(0);
  }finally{
    dropAllClients();old.proc.kill('SIGKILL');next?.proc.kill('SIGKILL');
  }
});


test("Production grace defaults to fifteen minutes and preserves reuse without an idle query",async()=>{
 expect(IDLE_CLIENT_GRACE_MS).toBe(15*60*1000);
 let queries=0;const c=poolClient(async()=>{queries++;return true});
 acquireClient("probe",()=>c);await releaseIdleClient("probe",c);
 expect(queries).toBe(0);expect(c.closed).toBe(0);
 expect(acquireClient("probe",()=>{throw new Error("must reuse during grace")}).reused).toBe(true);
 expect(queries).toBe(0);
});

test("Short grace starts at turn end and an activity notification restarts the clock",async()=>{
 const c=new CodexAppServerClient();let queries=0;
 (c as any).isIdle=async()=>{queries++;return true};
 acquireClient("probe",()=>c);await releaseIdleClient("probe",c,10,120);
 expect(queries).toBe(0);
 await Bun.sleep(70);(c as any).handleNotification("thread/status/changed",{threadId:"child",status:{type:"idle"}});
 await Bun.sleep(75);expect(queries).toBe(0);expect(pooledAgents()).toEqual(["probe"]);
 for(let i=0;i<30&&queries===0;i++)await Bun.sleep(10);
 expect(queries).toBe(1);expect(pooledAgents()).toEqual([]);
});

test("A new message cancels the old timer, and its completed turn gets a fresh grace",async()=>{
 let queries=0;const c=poolClient(async()=>{queries++;return true});
 acquireClient("probe",()=>c);await releaseIdleClient("probe",c,10,120);
 await Bun.sleep(65);acquireClient("probe",()=>c);await Bun.sleep(80);
 expect(queries).toBe(0);expect(c.closed).toBe(0);
 await releaseIdleClient("probe",c,10,120);await Bun.sleep(65);expect(queries).toBe(0);
 for(let i=0;i<30&&!c.closed;i++)await Bun.sleep(10);
 expect(c.closed).toBe(1);
});

test("Activity during the final query prevents retirement even if the query reports idle",async()=>{
 const c=new CodexAppServerClient();let queries=0;
 (c as any).isIdle=async()=>{queries++;c.notePoolActivity();return true};
 acquireClient("probe",()=>c);await releaseIdleClient("probe",c,100,30);
 await Bun.sleep(50);expect(queries).toBe(1);expect(pooledAgents()).toEqual(["probe"]);
});

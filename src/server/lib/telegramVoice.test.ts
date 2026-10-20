import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { createVoiceIngress, transcribeTelegramVoice, transcribeLocalVoice, runVoiceProcess, assertAudibleVoice, VoiceProcessUnreapedError, VOICE_STOPPED_NOTICE, VOICE_FAILURE_NOTICE, voiceDeliveryText } from "./telegramVoice";
import { routeTeamMessageHybrid } from "./teamRouter";
import type { AgentRecord } from "../types";
const agents = [{id:"bill",display_name:"Bill",nicknames:["빌"]}, {id:"dex",display_name:"Dex",nicknames:["덱스"]}] as AgentRecord[];
const msg = {from:{id:7},voice:{file_id:"voice-id"}};

test("authorized voice/audio enters existing router before the delivery label", async () => {
  const bodies: string[] = [];
  const targets: string[][] = [];
  const ingress = createVoiceIngress({allowedIds:()=>["7"], transcribe:async()=>"빌, 이거 확인해줘",notify:async()=>{throw new Error("unexpected");}, handle:async text=>{
    targets.push((await routeTeamMessageHybrid(text,agents,{source:"user",activeAssigneeIds:["dex"]})).targetAgentIds);
    bodies.push(voiceDeliveryText(text));
  }});
  expect(await ingress(msg)).toBe(true);
  expect(await ingress({from:{id:7},audio:{file_id:"audio-id"}})).toBe(true);
  expect(targets).toEqual([["bill"],["bill"]]);
  expect(bodies[0]).toBe("🎤 음성(받아씀): 빌, 이거 확인해줘");
});

test("bots, unapproved/missing senders, text and captions do not trigger STT", async () => {
 let calls=0;
 const ingress=createVoiceIngress({allowedIds:()=>["7"],transcribe:async()=>{calls++;return "빌 확인";},handle:async()=>{},notify:async()=>{}});
 for (const value of [{...msg,from:{id:7,is_bot:true}}, {...msg,from:{id:8}}, {...msg,from:undefined}, {...msg,text:"text"}, {...msg,caption:"caption"}, {from:{id:7}}]) expect(await ingress(value)).toBe(false);
 expect(calls).toBe(0);
});

test("errors, empty results and timeouts notify sender only, queue continues in arrival order", async () => {
 const order:string[]=[]; const notices:unknown[]=[];
 const ingress=createVoiceIngress({allowedIds:()=>["7"],transcribe:async id=>{
   order.push(id); if(id==="empty") return " \n"; if(id!=="ok") throw new Error("timeout or download failure"); return "빌 확인";
 },handle:async t=>{order.push(t);},notify:async(id,t)=>{notices.push([id,t]);}});
 await Promise.all(["download-error","empty","timeout","ok"].map(file_id=>ingress({...msg,voice:{file_id}})));
 expect(order).toEqual(["download-error","empty","timeout","ok","빌 확인"]);
 expect(notices).toEqual(Array(3).fill(["7",VOICE_FAILURE_NOTICE]));
});

test("getFile/download errors cannot expose token; temporary files removed on every exit", async () => {
 const token="SENTINEL_SECRET";
 for(const mode of ["getFile","download","transcribe","empty","success"]){
  let local=""; let dir=""; let calls=0;
  const request=(async()=>{
   calls++;
   if(mode==="getFile" || (mode==="download" && calls===2)) throw new Error(`https://api.telegram.org/bot${token}/getFile`);
   return calls===1 ? Response.json({ok:true,result:{file_path:"voice/file.oga"}}) : new Response("fake audio");
  }) as unknown as typeof fetch;
  const job=transcribeTelegramVoice(token,"id","빌",{fetch:request,transcribe:async(path,root)=>{
    local=path; dir=root; expect(existsSync(path)).toBe(true);
    await Bun.write(`${root}/voice.txt`,"temporary");
    if(mode==="transcribe")throw new Error(token);
    return mode==="empty"?"":"빌, 확인";
  }});
  if(mode==="success")expect(await job).toBe("빌, 확인");
  else {try{await job;throw new Error("unexpected success");}catch(e){expect(String(e)).toBe("Error: voice transcription failed");expect(String(e)).not.toContain(token);}}
  if(local) expect(existsSync(local)).toBe(false);
  if(dir) expect(existsSync(dir)).toBe(false);
 }
});

test("download timeout aborts the request without returning sensitive errors", async()=>{
 const request=((_:unknown,init?:RequestInit)=>new Promise((_,reject)=>{init?.signal?.addEventListener("abort",()=>reject(new Error("secret URL")));})) as unknown as typeof fetch;
 await expect(transcribeTelegramVoice("secret","id","",{fetch:request,timeoutMs:10})).rejects.toThrow("voice transcription failed");
});


test("MLX is preferred with bounded offline adapter and no CPU fallback on success", async () => {
 const {mkdtemp,rm}=await import("node:fs/promises");
 const root=await mkdtemp("/tmp/voice-mlx-test-");
 const oldRoot=process.env.B3OS_STT_HOME;
 process.env.B3OS_STT_HOME=`${root}/engine`;
 const calls:{argv:string[];timeout?:number}[]=[];
 try {
  const text=await transcribeLocalVoice(`${root}/voice.ogg`,root,"빌".repeat(1100),{
   checkAudio:async()=>{},run:async(argv,timeout)=>{
    calls.push({argv,timeout}); await Bun.write(`${root}/voice-mlx.txt`,"빌, 확인");
   },
  });
  expect(text).toBe("빌, 확인"); expect(calls).toHaveLength(1);
  expect(calls[0]!.timeout).toBe(30_000);
  expect(calls[0]!.argv).toEqual([`${root}/engine/.venv/bin/python`,`${root}/engine/transcribe.py`,`${root}/voice.ogg`,`${root}/engine/model`,`${root}/voice-mlx.txt`,"빌".repeat(1000)]);
 }finally{if(oldRoot===undefined)delete process.env.B3OS_STT_HOME;else process.env.B3OS_STT_HOME=oldRoot;await rm(root,{recursive:true,force:true});}
});

for(const mode of ["missing", "failed", "no-output", "empty", "timeout", "unreaped", "both-failed"]){
 test(`MLX ${mode}: CPU fallback only after confirmed cleanup`, async()=>{
  const {mkdtemp,rm}=await import("node:fs/promises");
  const root=await mkdtemp("/tmp/voice-fallback-test-");
  const oldHome=process.env.HOME;
  process.env.HOME=root;
  const calls:{argv:string[];timeout?:number}[]=[];
  try{
   await Bun.write(`${root}/.cache/whisper/large-v3-turbo.pt`,"fixture");
   await Bun.write(`${root}/voice-mlx.txt`,"stale result");
   await Bun.write(`${root}/voice.txt`,"stale fallback");
   const job=transcribeLocalVoice(`${root}/voice.ogg`,root,"빌",{checkAudio:async()=>{},run:async(argv,timeout)=>{
    calls.push({argv,timeout});
    if(calls.length===1){
     if(mode==="unreaped")throw new VoiceProcessUnreapedError();
     if(mode==="empty"){await Bun.write(`${root}/voice-mlx.txt`," ");return;}
     if(mode==="no-output")return;
     throw new Error(mode);
    }
    if(mode==="both-failed")throw new Error("fallback failed");
    await Bun.write(`${root}/voice.txt`,"빌, 확인");
   }});
   if(mode==="unreaped")await expect(job).rejects.toBeInstanceOf(VoiceProcessUnreapedError);
   else if(mode==="both-failed")await expect(job).rejects.toThrow("fallback failed");
   else expect(await job).toBe("빌, 확인");
   expect(calls).toHaveLength(mode==="unreaped"?1:2);
   expect(calls[0]!.timeout).toBe(30_000);
   if(calls[1]){
    expect(calls[1].timeout).toBe(120_000);
    expect(calls[1].argv[0]).toBe("/opt/homebrew/bin/whisper");
    expect(calls[1].argv).toContain(`${root}/.cache/whisper/large-v3-turbo.pt`);
   }
  }finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;await rm(root,{recursive:true,force:true});}
 });
}

test("timeout reaps an actual Python parent and its ffmpeg decoder before the next queued voice", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const root = await mkdtemp("/tmp/voice-process-tree-");
  const pidPath = `${root}/pids.json`;
  const python = Bun.which("python3");
  expect(python).not.toBeNull();
  const script = `import subprocess,os,json,sys
child=subprocess.Popen(["/opt/homebrew/bin/ffmpeg","-v","error","-re","-f","lavfi","-i","anullsrc","-f","null","-"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
with open(sys.argv[1],"w") as f: json.dump([os.getpid(),child.pid],f)
child.wait()
`;
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; }
  };
  let pids: number[] = [];
  let nextRan = false;
  let notices = 0;
  const { spawn } = await import("node:child_process");
  const fixture = spawn(python!, ["-c", script, pidPath], { detached: true, stdio: "ignore" });
  let fixtureClosed = false;
  fixture.once("close", () => { fixtureClosed = true; });
  try {
    const readyDeadline = Date.now() + 10_000;
    while (!pids.length && Date.now() < readyDeadline) {
      try { pids = JSON.parse(await readFile(pidPath, "utf8")); } catch {}
      if (!pids.length) await Bun.sleep(10);
    }
    expect(pids).toHaveLength(2);
    expect(pids.map(alive)).toEqual([true, true]);
    const ingress = createVoiceIngress({
      allowedIds: () => ["7"],
      transcribe: async id => {
        if (id === "slow") {
          await runVoiceProcess([python!, "-c", script, pidPath], 500, undefined, { spawn: () => fixture });
          throw new Error("timeout was not enforced");
        }
        pids = JSON.parse(await readFile(pidPath, "utf8"));
        expect(pids).toHaveLength(2);
        expect(pids.map(alive)).toEqual([false, false]);
        nextRan = true;
        return "빌 확인";
      },
      handle: async () => {},
      notify: async () => { notices++; },
    });
    await Promise.all(["slow", "next"].map(file_id => ingress({ ...msg, voice: { file_id } })));
    expect(nextRan).toBe(true);
    expect(notices).toBe(1);
  } finally {
    // Retain signal ownership only until this test's direct child is reaped.
    if (!fixtureClosed && fixture.pid) { try { process.kill(-fixture.pid, "SIGKILL"); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);


test("actual Opus silence fails with sender DM and no routed message", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const dir = await mkdtemp("/tmp/voice-silence-");
  const path = `${dir}/silence.ogg`;
  try {
    await runVoiceProcess(["/opt/homebrew/bin/ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "3", "-c:a", "libopus", path]);
    await expect(assertAudibleVoice(path)).rejects.toThrow("local voice audio is silent");
    const notices: string[] = [];
    let routed = false;
    const ingress = createVoiceIngress({
      allowedIds: () => ["7"],
      transcribe: async () => transcribeLocalVoice(path, dir, "빌, 모두", {
        run: async () => { await Bun.write(`${dir}/voice.txt`, "감사합니다."); },
      }),
      handle: async () => { routed = true; },
      notify: async (_, notice) => { notices.push(notice); },
    });
    await ingress(msg);
    expect(routed).toBe(false);
    expect(notices).toEqual([VOICE_FAILURE_NOTICE]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


function fakeVoiceChild() {
  const callbacks: Record<string, (...args: any[]) => void> = {};
  const child = { pid: 424242, stderr: null, once: (name: string, fn: (...args: any[]) => void) => { callbacks[name] = fn; return child; } };
  return { child: child as unknown as import("node:child_process").ChildProcess, close: (code = 0) => callbacks.close?.(code) };
}

test("normal close retires the leader; ESRCH is terminal even if its PGID could be reused", async () => {
  const fake = fakeVoiceChild();
  const signals: unknown[] = [];
  const task = runVoiceProcess(["fixture"], 10, undefined, {
    spawn: () => fake.child,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      throw Object.assign(new Error("no such group"), { code: "ESRCH" });
    }, cleanupMs: 20,
  });
  fake.close();
  await task;
  await Bun.sleep(30);
  expect(signals).toEqual([[-424242, 0]]);
});

test("ESRCH while timing out is terminal: close/finalization never signals the PGID again", async () => {
  const fake = fakeVoiceChild();
  const signals: unknown[] = [];
  await expect(runVoiceProcess(["fixture"], 5, undefined, {
    spawn: () => fake.child,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      setTimeout(() => fake.close(1), 1);
      throw Object.assign(new Error("no such group"), { code: "ESRCH" });
    }, cleanupMs: 20,
  })).rejects.toThrow("local voice process failed");
  await Bun.sleep(30);
  expect(signals).toEqual([[-424242, "SIGKILL"]]);
});

for (const mode of ["EPERM", "no-close"] as const) {
  test(`unconfirmed cleanup (${mode}) has a bound, stops queued voices and notifies only the sender`, async () => {
    const fake = fakeVoiceChild();
    const signals: unknown[] = [];
    const notices: string[] = [];
    let attempts = 0;
    let routed = false;
    const ingress = createVoiceIngress({
      allowedIds: () => ["7"],
      transcribe: async () => {
        attempts++;
        let requests = 0;
        return transcribeTelegramVoice("SENTINEL_SECRET", "fixture", "", {
          fetch: (async () => ++requests === 1
            ? Response.json({ ok: true, result: { file_path: "voice/fixture.oga" } })
            : new Response("fixture")) as unknown as typeof fetch,
          transcribe: async () => {
            await runVoiceProcess(["fixture"], 5, undefined, {
              spawn: () => fake.child,
              signal: (pid, signal) => {
                signals.push([pid, signal]);
                if (mode === "EPERM") throw Object.assign(new Error("secret error"), { code: "EPERM" });
              }, cleanupMs: 20,
            });
            return "빌 확인";
          },
        });
      },
      handle: async () => { routed = true; },
      notify: async (_, notice) => { notices.push(notice); },
    });
    const start = performance.now();
    await Promise.all([ingress(msg), ingress(msg)]);
    expect(performance.now() - start).toBeLessThan(500);
    expect(attempts).toBe(1);
    expect(routed).toBe(false);
    expect(notices).toEqual([VOICE_STOPPED_NOTICE, VOICE_STOPPED_NOTICE]);
    fake.close();
    await Bun.sleep(30);
    expect(signals).toEqual([[-424242, "SIGKILL"]]);
  });
}


test("stopped voice notice explains recovery and the voice/text delivery scope", () => {
  expect(VOICE_STOPPED_NOTICE).toBe("음성 받아쓰기를 멈췄어요. 받아쓰기 프로세스를 정리하지 못했고, 자동으로 다시 켜지지 않아요. 운영 담당자에게 남은 프로세스를 정리한 뒤 음성 수신 기능(capture worker) 또는 b3os를 재시작해 달라고 요청해 주세요. 그동안 음성 메시지는 전달되지 않고, 글 메시지는 계속 전달돼요.");
});

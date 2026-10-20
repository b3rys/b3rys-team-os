import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { createVoiceIngress, transcribeTelegramVoice, transcribeLocalVoice, VOICE_FAILURE_NOTICE, voiceDeliveryText } from "./telegramVoice";
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


test("local Whisper argv has only cached model/local audio, timeout kills process", async () => {
 const {mkdtemp,rm}=await import("node:fs/promises");
 const root=await mkdtemp("/tmp/voice-process-test-");
 let killed=false; let argv:string[]=[];
 try {
  await Bun.write(`${root}/.cache/whisper/large-v3-turbo.pt`, "fixture");
  const oldHome=process.env.HOME;
  process.env.HOME=root;
  try {
   await expect(transcribeLocalVoice(`${root}/voice.ogg`,root,"빌",{timeoutMs:10,spawn:args=>{
    argv=args;let done!:(code:number)=>void;
    const exited=new Promise<number>(r=>{done=r;});
    return {exited,kill:()=>{killed=true;done(137);}};
   }})).rejects.toThrow("local voice process failed");
  } finally { if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome; }
  expect(killed).toBe(true);
  expect(argv[1]).toBe(`${root}/voice.ogg`);
  expect(argv).toContain(`${root}/.cache/whisper/large-v3-turbo.pt`);
  expect(argv.join(" ")).not.toMatch(/https?:|getFile|botSECRET/);
 }finally{await rm(root,{recursive:true,force:true});}
});

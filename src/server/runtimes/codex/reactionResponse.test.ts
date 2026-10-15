import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReactionInbox, REACTION_INSTRUCTIONS, type ReactionUpdate, type ReactionRef } from "../../lib/reactionInput";
import { handleMessage, resetChatThreads, routeReactionUpdate, tgSend, tgEdit, type BridgeDeps } from "./bridge";
import { runViaAppServer } from "./appServerRunner";
import { DEFAULT_CHANNEL } from "../../lib/memberChannel";

const channel = { kind: "b3chat" as const, apiBase: "http://fixture.invalid", allowFrom: ["2"], ownerChat: "2" };
const previous = process.env.B3OS_FIRST_CONTACT_DIR;
let home: string;
beforeEach(() => {home=mkdtempSync(join(tmpdir(),"reaction-response-"));process.env.B3OS_FIRST_CONTACT_DIR=home;});
afterEach(() => {resetChatThreads();if(previous===undefined)delete process.env.B3OS_FIRST_CONTACT_DIR;else process.env.B3OS_FIRST_CONTACT_DIR=previous;});
function reaction(emoji="👌", message_id=130): ReactionUpdate {
 return {chat:{id:2},message_id,user:{id:1,is_bot:false},old_reaction:[],new_reaction:[{type:"emoji",emoji}],cogs_message_sender_id:7,cogs_message_text:"proposal",cogs_reactor_is_master:true};
}
function fixture(extra:BridgeDeps={}){
 const wire:Array<{method:string;body:any}>=[];
 let nextId=200;
 const fetchFn=(async(url:any,opts:any)=>{wire.push({method:String(url).split("/").at(-1)!,body:JSON.parse(opts.body)});return new Response(JSON.stringify({ok:true,result:{message_id:++nextId}}));}) as typeof fetch;
 const deps:BridgeDeps={channel,agentId:"fixture",workdir:home,codexHome:home,sandbox:"read-only",reactionInbox:createReactionInbox(),sendMessage:tgSend("fixture",fetchFn,{plainOnly:true}),editMessage:tgEdit("fixture",fetchFn,{plainOnly:true}),runTurn:async()=>({ok:true,reply:"done",detail:"ok",elapsedMs:1}),...extra};
 return {wire,deps};
}
function router(deps:BridgeDeps,running=false){
 const queued:Array<()=>Promise<void>>=[];
 return {queued,route:{isRunning:()=>running,steer:async()=>true,note:()=>{},enqueue:(run:()=>Promise<void>)=>queued.push(run)},runTurn:async(input:string,ref?:ReactionRef)=>{await handleMessage(2,input,undefined,deps,undefined,"poll",false,undefined,ref);}};
}

test("reaction wake sends numeric reference without automatic reply_to or receipt",async()=>{
 const {wire,deps}=fixture();const r=router(deps);
 await routeReactionUpdate(1,reaction(),{channel,allowFrom:new Set([2]),ownBotId:7,inbox:deps.reactionInbox!,...r});await r.queued[0]!();
 expect(wire).toHaveLength(1);expect(wire[0]!.method).toBe("sendMessage");expect(wire[0]!.body.cogs_reaction_ref).toEqual({message_id:130,emoji:"👌"});expect(wire[0]!.body).not.toHaveProperty("reply_to_message_id");
 expect(deps.reactionInbox!.captureResponse(2)).toBeUndefined();
});

test("ordinary messages keep reply_to and do not inherit a previous reaction",async()=>{
 const {wire,deps}=fixture();await handleMessage(2,"reaction",undefined,deps,undefined,"poll",false,undefined,{message_id:130,emoji:"👌"});wire.length=0;
 await handleMessage(2,"ordinary",23,deps);
 expect(wire[0]!.body.reply_to_message_id).toBe(23);for(const row of wire)expect(row.body).not.toHaveProperty("cogs_reaction_ref");
});

test("successful reaction turn can stay silent while ordinary empty response remains an error",async()=>{
 const {wire,deps}=fixture({runTurn:async()=>({ok:true,reply:"",detail:"ok",elapsedMs:1})});
 const result=await handleMessage(2,"OK",undefined,deps,undefined,"poll",false,undefined,{message_id:130,emoji:"👌"});
 expect(result).toMatchObject({ok:true,turnOk:true,detail:"reaction_silent"});expect(wire).toHaveLength(0);
 const normal=await handleMessage(2,"ordinary",23,deps);expect(normal.turnOk).toBe(false);expect(wire.length).toBeGreaterThan(0);
 expect(REACTION_INSTRUCTIONS).toContain("마스터 OK 승인 뒤 이어서 할 일이 없으면 말 없이 끝낸다");expect(REACTION_INSTRUCTIONS).toContain("의문·취소도 응답이 필요한 경우에만");
});

test("successful active-turn reaction uses last OK/uncertainty on final edit",async()=>{
 const {wire,deps}=fixture();const r=router(deps,true);
 deps.runTurn=async()=>{
  for(const [id,emoji] of [[1,"👌"],[2,"🤔"]] as const)await routeReactionUpdate(id,reaction(emoji,id+130),{channel,allowFrom:new Set([2]),ownBotId:7,inbox:deps.reactionInbox!,...r});
  return {ok:true,reply:"continued",detail:"ok",elapsedMs:1};
 };
 await handleMessage(2,"ordinary",23,deps);
 expect(r.queued).toHaveLength(0);expect(wire.at(-1)!.method).toBe("editMessageText");expect(wire.at(-1)!.body.cogs_reaction_ref).toEqual({message_id:132,emoji:"🤔"});
});

test("queued reaction turns retain separate references",async()=>{
 const {wire,deps}=fixture();const r=router(deps);
 await routeReactionUpdate(1,reaction("👌",130),{channel,allowFrom:new Set([2]),ownBotId:7,inbox:deps.reactionInbox!,...r});
 await routeReactionUpdate(2,reaction("🤔",140),{channel,allowFrom:new Set([2]),ownBotId:7,inbox:deps.reactionInbox!,...r});
 for(const run of r.queued)await run();
 expect(wire.map(x=>x.body.cogs_reaction_ref)).toEqual([{message_id:130,emoji:"👌"},{message_id:140,emoji:"🤔"}]);
});

test("failed steer cannot update active reply metadata",async()=>{
 const {deps}=fixture();const lease=deps.reactionInbox!.beginResponse(2,{message_id:120,emoji:"👌"});const r=router(deps,true);r.route.steer=async()=>false;
 await routeReactionUpdate(1,reaction("🤔",130),{channel,allowFrom:new Set([2]),ownBotId:7,inbox:deps.reactionInbox!,...r});
 expect(lease.context.ref).toEqual({message_id:120,emoji:"👌"});expect(r.queued).toHaveLength(1);lease.close();
});

test("cancelled OK and multiple emoji updates use last wake reference",async()=>{
 const {wire,deps}=fixture();const r=router(deps);const update=reaction();update.old_reaction=[{type:"emoji",emoji:"👌"}];update.new_reaction=[{type:"emoji",emoji:"🤔"}];
 await routeReactionUpdate(1,update,{channel,allowFrom:new Set([2]),ownBotId:7,inbox:deps.reactionInbox!,...r});await r.queued[0]!();
 expect(wire[0]!.body.cogs_reaction_ref).toEqual({message_id:130,emoji:"🤔"});
});

for (const source of ["delta", "answer"] as const) {
 test(`reaction ${source} output is preserved even when final reply is empty`,async()=>{
  const {wire,deps}=fixture({runTurn:async opts=>{
   if(source === "delta") opts.onDelta?.("streamed answer"); else opts.onAnswerText?.("streamed answer");
   return {ok:true,reply:"",detail:"ok",elapsedMs:1};
  }});
  const result=await handleMessage(2,"reaction",undefined,deps,undefined,"poll",false,undefined,{message_id:130,emoji:"👌"});
  expect(result.ok).toBe(true);expect(wire.at(-1)!.body.text).toBe("streamed answer");
 });
}

test("Telegram transport omits reaction metadata",async()=>{
 const wire:any[]=[];const fetchFn=(async(_url:any,opts:any)=>{wire.push(JSON.parse(opts.body));return new Response(JSON.stringify({ok:true,result:{message_id:1}}));}) as typeof fetch;
 await tgSend("fixture",fetchFn,{plainOnly:false})(2,"text",{state:"complete",reactionRef:{message_id:130,emoji:"👌"}});
 await tgEdit("fixture",fetchFn,{plainOnly:false})(2,1,"text","complete",undefined,undefined,{message_id:130,emoji:"👌"});
 for(const body of wire)expect(body).not.toHaveProperty("cogs_reaction_ref");
 const {deps}=fixture({channel:DEFAULT_CHANNEL});const r=router(deps);expect(await routeReactionUpdate(1,reaction(),{channel:DEFAULT_CHANNEL,allowFrom:new Set([2]),ownBotId:7,inbox:deps.reactionInbox!,...r})).toBeNull();
});


test("delayed steer metadata belongs to captured turn, never its replacement",async()=>{
 const {deps}=fixture();const inbox=deps.reactionInbox!;
 const old=inbox.beginResponse(2,{message_id:120,emoji:"👌"});
 let release!:()=>void;let accepted!:()=>void;
 const entered=new Promise<void>(r=>{accepted=r});const gate=new Promise<void>(r=>{release=r});
 const r=router(deps,true);r.route.steer=async()=>{accepted();await gate;return true;};
 const routed=routeReactionUpdate(1,reaction("🤔",130),{channel,allowFrom:new Set([2]),ownBotId:7,inbox,...r});
 await entered;old.close();const replacement=inbox.beginResponse(2,{message_id:140,emoji:"👌"});release();await routed;
 expect(old.context.ref).toEqual({message_id:130,emoji:"🤔"});expect(replacement.context.ref).toEqual({message_id:140,emoji:"👌"});
 old.close();expect(inbox.captureResponse(2)).toBe(replacement.context);replacement.close();
});


test("reaction silence works through the actual app-server result mapping",async()=>{
 const client=()=>({currentThreadId:"silent-thread",async start(){},async startThread(){return "silent-thread";},async runTurn(){return {status:"completed",finalText:"",turnId:"silent-turn",detail:""};},close(){}}) as unknown as import("./appServerClient").CodexAppServerClient;
 const {wire,deps}=fixture({runTurn:opts=>runViaAppServer(opts,undefined,client)});
 expect((await handleMessage(2,"OK",undefined,deps,undefined,"poll",false,undefined,{message_id:130,emoji:"👌"})).detail).toBe("reaction_silent");
 expect(wire).toHaveLength(0);
 expect((await handleMessage(2,"ordinary",23,deps)).turnOk).toBe(false);
});

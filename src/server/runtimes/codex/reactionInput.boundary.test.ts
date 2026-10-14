import {test,expect} from "bun:test";
import {createReactionInbox,type ReactionUpdate} from "../../lib/reactionInput";
const r=(emoji:string):ReactionUpdate=>({chat:{id:2},message_id:123,user:{id:1,is_bot:false},old_reaction:[],new_reaction:[{type:"emoji",emoji}],cogs_message_sender_id:7,cogs_message_text:"target",cogs_reactor_is_master:true});
test("new-turn must not consume quiet entries claimed by an in-flight steer",async()=>{
 const inbox=createReactionInbox();inbox.accept(1,r("❤️"),7);
 let release!:(x:boolean)=>void;let started!:()=>void;const entered=new Promise<void>(v=>started=v);let steered="";
 const task=inbox.steer(2,"wake",async body=>{steered=body;started();return await new Promise<boolean>(v=>release=v)});
 await entered;
 const nextTurn=inbox.prepend(2,"next human input");
 release(true);await task;
 expect(steered).toContain("<반응:고마워요");
 expect(nextTurn).not.toContain("<반응:고마워요");
});
test("steer completion must not erase new quiet entries after another consumer",async()=>{
 const inbox=createReactionInbox();inbox.accept(1,r("❤️"),7);
 let release!:(x:boolean)=>void;let started!:()=>void;const entered=new Promise<void>(v=>started=v);
 const task=inbox.steer(2,"wake",async()=>{started();return await new Promise<boolean>(v=>release=v)});
 await entered;inbox.prepend(2,"concurrent turn");inbox.accept(2,r("👍"),7);
 release(true);await task;
 expect(inbox.prepend(2,"later input")).toContain("<반응:좋아요");
});
test("rejected steer keeps quiet prefix and subsequent steer can claim it",async()=>{
 const inbox=createReactionInbox();inbox.accept(1,r("❤️"),7);
 await expect(inbox.steer(2,"bad",async()=>{throw new Error("injected")})).rejects.toThrow("injected");
 let sent="";expect(await inbox.steer(2,"next",async body=>{sent=body;return true})).toBe(true);expect(sent).toContain("<반응:고마워요");expect(inbox.prepend(2,"done")).toBe("done");
});

import {routeReactionUpdate} from "./bridge";
import {parseMemberChannel} from "../../lib/memberChannel";
test("serialized steer must revalidate running conversation before sending",async()=>{
 const inbox=createReactionInbox();let current=2;let calls=0;const received:Array<{chat:number,body:string}>=[];
 let release!:(x:boolean)=>void;let started!:()=>void;const entered=new Promise<void>(v=>started=v);
 const queued:Array<()=>Promise<void>>=[];
 const deps={channel:parseMemberChannel({kind:"b3chat",api_base:"http://127.0.0.1:1",owner_chat:"2"}),allowFrom:new Set([2]),ownBotId:7,inbox,
 route:{isRunning:(chat:number)=>current===chat,note:()=>{},enqueue:(f:()=>Promise<void>)=>queued.push(f),steer:async(body:string)=>{received.push({chat:current,body});if(++calls===1){started();return await new Promise<boolean>(v=>release=v)}return true}},runTurn:async()=>{}};
 const first=routeReactionUpdate(1,r("👌"),deps);await entered;
 const second=routeReactionUpdate(2,r("🤔"),deps);
 current=3;release(true);await Promise.all([first,second]);
 expect(received.filter(x=>x.chat===3)).toHaveLength(0);
});

import {captureActiveTurnSteer,registerActiveTurn,unregisterActiveTurn} from './activeTurns';
import {captureConversationSteer,routeIncoming,handleMessage,type BridgeDeps} from './bridge';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('captured sender cannot be replaced or reused for a different turn in the same room',async()=>{
 const received:string[]=[];const old={currentTurnId:'one',steer:async(t:string)=>{received.push(t)}};
 const replacement={currentTurnId:'two',steer:async(t:string)=>{received.push(t)}};
 registerActiveTurn('pinned',old);const send=captureActiveTurnSteer('pinned')!;
 registerActiveTurn('pinned',replacement);
 expect(await send('old approval')).toBe(false);expect(received).toEqual([]);
 unregisterActiveTurn('pinned',replacement);
 registerActiveTurn('pinned',old);const reused=captureActiveTurnSteer('pinned')!;
 old.currentTurnId='three';expect(await reused('old approval')).toBe(false);expect(received).toEqual([]);
 unregisterActiveTurn('pinned',old);
});

test('ordinary input delayed by attachments falls back in original room when active turn changes',async()=>{
 const inbox=createReactionInbox();let current=2;const received:string[]=[];const queued:Array<()=>Promise<void>>=[];
 const old={currentTurnId:'one',steer:async(t:string)=>{received.push(t)}};
 const other={currentTurnId:'two',steer:async(t:string)=>{received.push(t)}};
 let release!:()=>void;let started!:()=>void;const entered=new Promise<void>(v=>started=v);
 registerActiveTurn('attachments',old);
 let ran=false;
 const call=routeIncoming(2,'ordinary message',{
  isRunning:c=>c===current,
  captureSteer:()=>captureConversationSteer(2,{isRunning:c=>c===current,inbox,captureSend:()=>captureActiveTurnSteer('attachments'),fetchAttachments:async()=>{started();await new Promise<void>(v=>release=v);return {files:[],failed:[],imagePaths:[]}}}),
  steer:async()=>false,note:()=>{},enqueue:run=>queued.push(run),runTurnFor:async()=>{ran=true},
 });
 await entered;current=3;registerActiveTurn('attachments',other);release();
 expect(await call).toBe('newTurn');expect(received).toEqual([]);expect(queued).toHaveLength(1);
 await queued[0]!();expect(ran).toBe(true);unregisterActiveTurn('attachments',other);
});

test('rollback restores only reserved entries in order and can settle only once',()=>{
 const inbox=createReactionInbox();inbox.accept(1,r('❤️'),7);const claim=inbox.claim(2,'input');
 expect(claim.text).toContain('<반응:고마워요');inbox.accept(2,r('👍'),7);
 claim.rollback();claim.rollback();const restored=inbox.prepend(2,'next');
 expect(restored.match(/<반응:고마워요/g)).toHaveLength(1);expect(restored).toContain('<반응:좋아요');
 expect(restored.indexOf('고마워요')).toBeLessThan(restored.indexOf('<반응:좋아요'));
});

test('new-turn failure rolls back its quiet claim without consuming arrivals during the turn',async()=>{
 const inbox=createReactionInbox();inbox.accept(1,r('❤️'),7);
 const prev=process.env.B3OS_FIRST_CONTACT_DIR;process.env.B3OS_FIRST_CONTACT_DIR=mkdtempSync(join(tmpdir(),'dex-claim-'));
 try {
  const deps:BridgeDeps={reactionInbox:inbox,channel:parseMemberChannel({kind:'b3chat',api_base:'http://127.0.0.1:1'}),sandbox:'read-only',sendMessage:async()=>1,editMessage:async()=>true,runTurn:async()=>{inbox.accept(2,r('👍'),7);throw new Error('injected')}};
  await handleMessage(2,'input',undefined,deps);
  const next=inbox.prepend(2,'next');expect(next).toContain('<반응:고마워요');expect(next).toContain('<반응:좋아요');
 } finally {if(prev===undefined)delete process.env.B3OS_FIRST_CONTACT_DIR;else process.env.B3OS_FIRST_CONTACT_DIR=prev}
});

test('queued reaction cannot retarget a later turn in the same room',async()=>{
 const inbox=createReactionInbox();const received:string[]=[];const queued:Array<()=>Promise<void>>=[];
 let release!:()=>void;let started!:()=>void;const entered=new Promise<void>(v=>started=v);
 let calls=0;const client={currentTurnId:'original',steer:async(body:string)=>{received.push(body);if(++calls===1){started();await new Promise<void>(v=>release=v)}}};
 registerActiveTurn('same-room',client);
 const deps={channel:parseMemberChannel({kind:'b3chat',api_base:'http://127.0.0.1:1'}),allowFrom:new Set([2]),ownBotId:7,inbox,
  route:{isRunning:()=>true,captureSteer:()=>captureActiveTurnSteer('same-room'),steer:async()=>false,note:()=>{},enqueue:(run:()=>Promise<void>)=>queued.push(run)},runTurn:async()=>{}};
 try {
  const first=routeReactionUpdate(1,r('👌'),deps);await entered;
  const second=routeReactionUpdate(2,r('🤔'),deps);client.currentTurnId='later';release();
  expect(await first).toBe('steered');expect(await second).toBe('newTurn');
  expect(received).toHaveLength(1);expect(queued).toHaveLength(1);
 } finally {unregisterActiveTurn('same-room',client)}
});

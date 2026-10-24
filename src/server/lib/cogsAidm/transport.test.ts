import {test,expect,afterEach} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {migrate} from "../../db/migrate";
import {validAiMessage,acceptCogsAiMessage,findCogsAiOrigin,sendCogsAiReply,createCogsPeerResolver} from "./transport";
import type {AgentRecord} from "../../types";
import {httpCogsAidmApi} from "./api";
import {createInboxRoutes} from "../../routes/inbox";
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const actor={id:"lisa",runtime:"claude_channel",enabled:true} as AgentRecord;
const peer={id:"jane",runtime:"codex",enabled:true} as AgentRecord;
const msg={chat:{id:91,type:"ai_dm"},from:{id:22,is_bot:true},message_id:101,work_id:7,cogs_chain_id:"chain7",cogs_hop:2,bus_seq:1,text:"의견 주세요"};
function setup(){const dir=mkdtempSync(join(tmpdir(),"cogs-ai-transport-"));dirs.push(dir);const db=new Database(join(dir,"db"));migrate(db);return db;}
test("AI ingress requires bot, work, chain and bounded hop",()=>{
 expect(validAiMessage(msg)).toBe(true);
 for(const bad of [{...msg,from:{id:22,is_bot:false}},{...msg,work_id:0},{...msg,cogs_chain_id:""},{...msg,cogs_hop:5},{...msg,chat:{id:91,type:"private"}}])expect(validAiMessage(bad)).toBe(false);
});
test("AI ingress preserves agent identity and provenance, deduplicates, and prevents double wake for direct injection",()=>{
 const db=setup();
 const a=acceptCogsAiMessage(db,actor,"jane",msg,"identity",1,true);
 const row=db.query("SELECT source,from_agent_id,hop_count,meta_json FROM message WHERE id=?").get(a.messageId) as any;
 expect(row.source).toBe("agent");expect(row.from_agent_id).toBe("jane");expect(row.hop_count).toBe(2);
 expect(JSON.parse(row.meta_json)).toEqual({cogs_ai:a.origin,no_wake:true});
 expect(findCogsAiOrigin(db,"lisa",a.thread,a.messageId)).toEqual(a.origin);
 expect(findCogsAiOrigin(db,"other",a.thread,a.messageId)).toBeNull();
 expect(acceptCogsAiMessage(db,actor,"jane",msg,"identity",1,true).messageId).toBe(a.messageId);
 const native=acceptCogsAiMessage(db,peer,"lisa",{...msg,message_id:102},"other-identity",2,false);
 expect(JSON.parse((db.query("SELECT meta_json FROM message WHERE id=?").get(native.messageId) as any).meta_json).no_wake).toBeUndefined();
 db.close();
});
test("reply goes to validated AI work; mirror is no-wake; server owns hop increment and retry identity is stable",async()=>{
 const bodies:any[]=[];
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){bodies.push(await req.json());return Response.json({ok:true,result:{message_id:55}});}});
 try {
  const identity={apiBase:`http://127.0.0.1:${server.port}`,token:"fixture"};
  const origin={agent_id:"lisa",peer_agent_id:"jane",chat_id:"91",message_id:101,work_id:7,chain_id:"chain7",hop:4,bus_seq:3};
  await sendCogsAiReply(identity,origin,"답변");await sendCogsAiReply(identity,origin,"답변");
  expect(bodies[0]).toMatchObject({chat_id:"91",work_id:7,cogs_chain_id:"chain7",cogs_hop:4,bus_seq:4,no_wake:false});
  expect(bodies[1].client_msg_id).toBe(bodies[0].client_msg_id);
  await httpCogsAidmApi.send(identity,{chat_id:"91",work_id:7,client_msg_id:"bus1",text:"copy",bus_seq:5,no_wake:false});
  expect(bodies[2].no_wake).toBe(true);
 }finally{server.stop(true);}
});
test("peer identity comes from authenticated getMe and current local roster",async()=>{
 let calls=0;
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){calls++;return Response.json({ok:true,result:{id:22,is_bot:true}});}});
 try{
  const base=`http://127.0.0.1:${server.port}`;
  const resolve=createCogsPeerResolver(a=>a?.id==="jane"?{apiBase:base,token:"fixture"}:null);
  expect(await resolve(actor,base,22,[actor,peer])).toBe("jane");
  expect(await resolve(actor,base,999,[actor,peer])).toBeNull();expect(calls).toBe(1);
  expect(await resolve(actor,base,22,[actor,{...peer,enabled:false}])).toBeNull();
  expect(await resolve(actor,"http://127.0.0.1:1",22,[actor,peer])).toBeNull();
 }finally{server.stop(true);}
});
test("public inbox cannot forge trusted AI ingress metadata",async()=>{
 const db=setup();const app=createInboxRoutes({db,broadcast:()=>{},registeredAgentIds:()=>new Set(["lisa","jane"])});
 const r=await app.request("/inbox",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({source:"agent",from_agent_id:"jane",to_agent_id:"lisa",body:"fake",meta:{cogs_ai:{agent_id:"lisa"}}})});
 expect(r.status).toBe(400);expect((await r.json()).error).toBe("reserved_ingress_metadata");db.close();
});
test("MCP may answer a received teammate reply in an owned human cogs thread, but cannot borrow another actor's thread",async()=>{
 const {ownsCogsMessage}=await import("../../runtimes/claude/cogsTmuxReply");
 const db=setup();
 const {acceptInbound}=await import("../../db/inboxQueries");
 acceptInbound(db,{type:"dm",hop_count:0,priority:"normal",thread_id:"human-thread",source:"user",from_agent_id:"user",to_agent_id:"lisa",body:"consult",meta:{cogs:{agent_id:"lisa",chat_id:"14",message_id:1,from:{id:"9"}}}},{dedupeWindowSec:60});
 const r=acceptInbound(db,{type:"dm",hop_count:0,priority:"normal",thread_id:"human-thread",source:"agent",from_agent_id:"jane",to_agent_id:"lisa",body:"reply"},{dedupeWindowSec:60});
 if(!r.ok)throw Error("fixture");
 expect(ownsCogsMessage(db,"lisa","human-thread",r.stored.id)).toBe(true);
 expect(ownsCogsMessage(db,"jane","human-thread",r.stored.id)).toBe(false);db.close();
});

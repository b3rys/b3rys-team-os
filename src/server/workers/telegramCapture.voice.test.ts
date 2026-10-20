import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRecord } from "../types";
import { migrate } from "../db/migrate";

test("capture voice uses original handle: leading name, sticky owner, all confirmation and system-only failure", async () => {
 const dir=await mkdtemp(join(tmpdir(),"capture-voice-test-"));
 const env={CAPTURE_TOKEN_FILE:join(dir,"none"),CAPTURE_BOT_TOKEN:"TEST_SECRET",CAPTURE_GROUP_FILE:join(dir,"group"),CAPTURE_GROUP_ID:"-123",CAPTURE_OFFSET_PATH:join(dir,"offset"),B3OS_AUDIT_LOG_DIR:join(dir,"audit"),APPROVAL_ALLOWED_USER_IDS:"7",TEAM_AGENT_REGISTRY:join(dir,"agents.json")};
 const oldEnv=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
 Object.assign(process.env,env);
 await Bun.write(env.CAPTURE_OFFSET_PATH,"1");
 const db=new Database(":memory:"); migrate(db);
 db.prepare("INSERT INTO setting(key,value) VALUES ('router_enabled','true')").run();
 const agents=[{id:"bill",display_name:"Bill",nicknames:["빌"],enabled:false},{id:"dex",display_name:"Dex",nicknames:["덱스"]}] as AgentRecord[];
 const messages=[
  {from:{id:7,is_bot:true},voice:{file_id:"bot"}},
  {from:{id:8},voice:{file_id:"stranger"}},
  {from:{id:7},voice:{file_id:"bill"}},
  {from:{id:7},voice:{file_id:"sticky"}},
  {from:{id:7},audio:{file_id:"all"}},
  {from:{id:7},voice:{file_id:"fail"}},
 ].map((m,i)=>({update_id:i+1,message:{...m,message_id:i+100,chat:{id:-123,type:"supergroup"}}}));
 const posted:any[]=[];const calls:string[]=[];let poll=0;let stop=()=>{};
 const originalFetch=globalThis.fetch;
 globalThis.fetch=(async(url: RequestInfo | URL, init?: RequestInit)=>{
  const u=String(url);
  if(u.includes("getUpdates")) {
   if(poll++===0) return Response.json({ok:true,result:messages});
   stop();return Response.json({ok:true,result:[]});
  }
  if(u.endsWith("sendMessage"))posted.push(JSON.parse(String(init?.body)));
  return Response.json({ok:true,result:[]});
 }) as unknown as typeof fetch;
 try {
  const {setGroupOwner}=await import("../lib/groupOwner");setGroupOwner([]);
  const {startTelegramCapture}=await import("./telegramCapture");
  stop=startTelegramCapture({db,agents:()=>agents,transcribeVoice:async(id)=>{
   calls.push(id);if(id==="fail")throw new Error("TEST_SECRET");
   return id==="bill"?"빌, 이거 확인해줘.":id==="all"?"모두 회의하자.":"이어서 확인해줘";
  }});
  const deadline=Date.now()+2000;
  while(poll<2 && Date.now()<deadline)await Bun.sleep(5);
  expect(poll).toBe(2);
  expect(calls).toEqual(["bill","sticky","all","fail"]);
  const rows=db.query("SELECT body,meta_json FROM message ORDER BY rowid").all() as {body:string;meta_json:string}[];
  expect(rows).toHaveLength(3);
  expect(rows.every(r=>r.body.startsWith("🎤 음성(받아씀): "))).toBe(true);
  expect(JSON.parse(rows[0]!.meta_json).route).toEqual({reason:"explicit_mention",targets:["bill"]});
  expect(JSON.parse(rows[1]!.meta_json).route.targets).toEqual(["bill"]);
  expect(JSON.parse(rows[2]!.meta_json).route.reason).toBe("broadcast_marker");
  expect(posted.some(p=>p.chat_id==="-123" && p.reply_markup?.inline_keyboard[0][0].callback_data.startsWith("bcapv:"))).toBe(true);
  expect(posted.filter(p=>p.text==="음성을 못 알아들었어요 — 다시 보내 주세요")).toEqual([{chat_id:"7",text:"음성을 못 알아들었어요 — 다시 보내 주세요"}]);
  expect(JSON.stringify(rows)).not.toContain("TEST_SECRET");
 }finally{
  stop();globalThis.fetch=originalFetch;db.close();
  for(const [k,v]of Object.entries(oldEnv))if(v===undefined)delete process.env[k];else process.env[k]=v;
  await rm(dir,{recursive:true,force:true});
 }
});

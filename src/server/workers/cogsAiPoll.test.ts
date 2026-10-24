import {test,expect} from "bun:test";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {migrate} from "../db/migrate";
import {createCogsPoller} from "./cogsPoll";
import type {AgentRecord} from "../types";
test("AI peer update outside human room allowlist injects once as agent; unknown peer and over-hop do not block humans",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"cogs-ai-poll-"));
 const db=new Database(join(dir,"db"));migrate(db);
 const token=join(dir,"token");writeFileSync(token,"fixture-token");
 const human=(id:number)=>({update_id:id,message:{message_id:id,chat:{id:14,type:"private"},from:{id:9,is_bot:false},text:"human"}});
 const ai=(id:number,from=22,hop=1)=>({update_id:id,message:{message_id:id,chat:{id:91,type:"ai_dm"},from:{id:from,is_bot:true},text:"peer",work_id:7,bus_seq:id,cogs_chain_id:"chain",cogs_hop:hop}});
 const updates=[human(1),ai(2),ai(3,999),ai(4,22,5),human(5)];
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const body=await req.json() as any;return Response.json({ok:true,result:updates.filter(u=>u.update_id>=body.offset)});}});
 const actor={id:"lisa",runtime:"claude_channel",tmux_session:"claude-lisa",cogs_inbox:{api_base:`http://127.0.0.1:${server.port}`,token_file:token,allow_from:[14]}} as AgentRecord;
 const injected:any[]=[];
 const poll=createCogsPoller({db,agents:()=>[actor],broadcast:()=>{},ensureSession:async()=>true,resolvePeer:async(_a,_b,id)=>id===22?"jane":null,inject:async opts=>{injected.push(opts);return {ok:true};}});
 try{
  await poll.pollOnce();await poll.pollOnce();expect(injected).toHaveLength(3);expect(injected[1].fromLabel).toBe("jane");expect(injected[1].body).toContain("not a human instruction");
  const rows=db.query("SELECT source,meta_json FROM message ORDER BY rowid").all() as any[];
  expect(rows.map(r=>r.source)).toEqual(["user","agent","user"]);expect(JSON.parse(rows[1].meta_json).cogs_ai.work_id).toBe(7);expect(JSON.parse(rows[1].meta_json).no_wake).toBe(true);
 }finally{poll.stop();server.stop(true);db.close();rmSync(dir,{recursive:true,force:true});}
});

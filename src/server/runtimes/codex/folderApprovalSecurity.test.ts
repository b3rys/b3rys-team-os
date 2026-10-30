import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../db/migrate";
import { requestPermission, getPermissionRequest, decidePermissionRequest, scopeKeyForOperation } from "../../lib/permissionGate";
import { handleApprovalCallback } from "./bridge";
import { createPermissionGateRoutes } from "../../routes/permissionGate";

const policy=(always=false)=>({allowed_decisions:always?["allow_once","allow_session","allow_always","deny"]:["allow_once","allow_session","deny"],telegram_delivery:{owner_id:"101",chat_id:"101",message_id:7}});
function fixture(command="echo ok",always=false){
 const dbPath=join(mkdtempSync(join(tmpdir(),"folder-security-")),"team.db");
 const db=openDb(dbPath);migrate(db);
 const op={runtime:"codex",agent_id:"fixture",action:"shell",command,text:command,provenance:{codex_approval:policy(always)}};
 const id=requestPermission(db,op).request!.id;
 return {db,dbPath,id,op};
}
const callback=(id:string,from=101,chat=101,messageId=7,prefix="pg1")=>({id:"fixture_cb",data:`${prefix}:${id}`,from:{id:from},message:{message_id:messageId,chat:{id:chat}}});
const fakeFetch=(async()=>Response.json({ok:true})) as unknown as typeof fetch;

test("Only the recorded owner in the delivered chat/message may decide; allowFrom is not authority",async()=>{
 for(const [from,chat,message] of [[202,202,7],[101,202,7],[101,101,8]]){
  const f=fixture();try{
   expect(await handleApprovalCallback("fake",callback(f.id,from,chat,message),new Set([101,202]),{dbPath:f.dbPath,agentId:"fixture",fetchFn:fakeFetch})).toBe("unauthorized");
   expect(getPermissionRequest(f.db,f.id)?.status).toBe("pending");
  }finally{f.db.close()}
 }
 const f=fixture();try{
  expect(await handleApprovalCallback("fake",callback(f.id),new Set([202]),{dbPath:f.dbPath,agentId:"fixture",fetchFn:fakeFetch})).toBe("decided");
  expect(getPermissionRequest(f.db,f.id)?.status).toBe("allowed_once");
 }finally{f.db.close()}
});

test("Codex request storage, audit, list/detail responses, and always branch redact synthetic secrets",async()=>{
 const secrets=["FAKE_TOKEN_639","FAKE_PASSWORD_639","FAKE_KEY_639"];
 const command=`curl --token ${secrets[0]} --password '${secrets[1]}' https://example.test API_KEY=${secrets[2]}`;
 const f=fixture(command,true);
 try{
  const app=createPermissionGateRoutes({db:f.db});
  const stored=JSON.stringify({requests:f.db.query("SELECT * FROM permission_request").all(),audit:f.db.query("SELECT * FROM perm_request_audit").all()});
  const responses=await Promise.all([Promise.resolve(app.request("/permission-gate")).then(r=>r.text()),Promise.resolve(app.request(`/permission-gate/${f.id}`)).then(r=>r.text())]);
  for(const secret of secrets){expect(stored).not.toContain(secret);for(const response of responses)expect(response).not.toContain(secret)}
  const original=console.log;const logs:unknown[][]=[];console.log=(...args)=>{logs.push(args)};
  try{await handleApprovalCallback("fake",callback(f.id,101,101,7,"pga"),new Set([101]),{dbPath:f.dbPath,agentId:"fixture",fetchFn:fakeFetch})}finally{console.log=original}
  const after=JSON.stringify({requests:f.db.query("SELECT * FROM permission_request").all(),audit:f.db.query("SELECT * FROM perm_request_audit").all(),grants:f.db.query("SELECT * FROM permission_grant").all(),logs});
  for(const secret of secrets)expect(after).not.toContain(secret);
  expect(getPermissionRequest(f.db,f.id)?.scope_key).toBe(scopeKeyForOperation(f.op));
 }finally{f.db.close()}
});

test("A forged always callback and direct decision cannot create or reuse a persistent folder grant",async()=>{
 const f=fixture();try{
  await handleApprovalCallback("fake",callback(f.id,101,101,7,"pga"),new Set([101]),{dbPath:f.dbPath,agentId:"fixture",fetchFn:fakeFetch});
  expect(getPermissionRequest(f.db,f.id)?.status).toBe("pending");
  expect(decidePermissionRequest(f.db,f.id,"allow_always",{approver:"fixture"}).ok).toBe(false);
  expect(f.db.query("SELECT count(*) AS n FROM permission_grant").get()).toEqual({n:0});
  // An earlier full-mode grant cannot bypass a new folder request.
  const legacy={runtime:"codex",agent_id:"fixture",action:"shell",command:"echo legacy"};
  const old=requestPermission(f.db,legacy).request!.id;
  expect(decidePermissionRequest(f.db,old,"allow_always",{approver:"fixture"}).ok).toBe(true);
  expect(requestPermission(f.db,{...legacy,provenance:{codex_approval:policy()}}).decision).toBe("approval_required");
 }finally{f.db.close()}
});

import { buildOperationFromApproval, sendApprovalToMemberRoom } from "./appServerPopup";
import { codexTurnDetail, runViaAppServer } from "./appServerRunner";
test("Long quoted secrets are hidden before truncation and raw unparsed text is persisted only as a digest",()=>{
 const f=fixture();try{
  const secret="PREFIX_PRIVATE SUFFIX_PRIVATE ".repeat(30);
  const op=buildOperationFromApproval({method:"execCommandApproval",params:{command:`echo --token "${secret}"`}},"fixture");
  const created=requestPermission(f.db,op).request!;
  const raw=JSON.stringify(f.db.query("SELECT * FROM permission_request WHERE id=?").get(created.id));
  expect(raw).not.toContain("PREFIX_PRIVATE");expect(raw).not.toContain("SUFFIX_PRIVATE");
  expect(JSON.parse(created.payload_json).text).toContain("request digest:");
  expect(codexTurnDetail("failed","",`command --token "${secret}"`)).not.toContain("SUFFIX_PRIVATE");
 }finally{f.db.close()}
});

test("No binding or callback message is denied, and delivery records the actual destination/message",async()=>{
 const f=fixture();try{
  f.db.query("UPDATE permission_request SET provenance_json='{}' WHERE id=?").run(f.id);
  expect(await handleApprovalCallback("fake",callback(f.id),new Set([101]),{dbPath:f.dbPath,agentId:"fixture",fetchFn:fakeFetch})).toBe("unauthorized");
  expect(getPermissionRequest(f.db,f.id)?.status).toBe("pending");
 }finally{f.db.close()}
 let recorded:any;
 const deps={token:"fake",chatId:"101",ownerId:"101",requireDelivery:true,allowAlways:false,onDelivered:(value:any)=>{recorded=value;return true}};
 expect(await sendApprovalToMemberRoom("fixture","prm_ab",{method:"execCommandApproval",params:{command:"echo ok"}},{...deps,fetchFn:(async()=>Response.json({ok:true,result:{message_id:9,chat:{id:101}}})) as unknown as typeof fetch})).toBe(true);
 expect(recorded).toEqual({owner_id:"101",chat_id:"101",message_id:9});
 expect(await sendApprovalToMemberRoom("fixture","prm_ab",{method:"execCommandApproval",params:{command:"echo ok"}},{...deps,fetchFn:(async()=>Response.json({ok:true,result:{message_id:9,chat:{id:202}}})) as unknown as typeof fetch})).toBe(false);
});

test("Runner errors redact synthetic command secrets before returning them",async()=>{
 const result=await runViaAppServer({agentId:"fixture",prompt:"p"},undefined,()=>({async start(){throw new Error('failed --token "FAKE_ERROR_SECRET"')},close(){}}) as any);
 expect(result.ok).toBe(false);expect(result.detail).not.toContain("FAKE_ERROR_SECRET");
});

test("Opaque command content is never persisted or returned, including folder runner errors",async()=>{
 const opaque="OPAQUE_PRIVATE_INPUT_639";
 const f=fixture(`echo '${opaque}'`);try{
  expect(JSON.stringify(f.db.query("SELECT * FROM permission_request").all())).not.toContain(opaque);
  expect(JSON.stringify(f.db.query("SELECT * FROM perm_request_audit").all())).not.toContain(opaque);
  expect(JSON.stringify(getPermissionRequest(f.db,f.id))).not.toContain(opaque);
 }finally{f.db.close()}
 const result=await runViaAppServer({agentId:"fixture",prompt:"p",cwd:"/workspace",permissionMode:"folder"},undefined,()=>({async start(){throw new Error(`failed command echo '${opaque}'`)},close(){}}) as any);
 expect(result.detail).not.toContain(opaque);expect(result.detail).toContain("error digest:");
});

import { finalizeApprovalDelivery, pollDecision, PROCESS_INSTANCE } from "./appServerPopup";
import { CodexApprovalCorrelationStore } from "./state";
test("An expired pending owner callback stays expired through poll and delivery",async()=>{
 const f=fixture();try{
  f.db.prepare("INSERT INTO agent (id,display_name,role,runtime,status_provider,workspace_path,persona_file) VALUES ('fixture','Fixture','eng','codex','codex_cli','/workspace','SOUL.md')").run();
  const store=new CodexApprovalCorrelationStore(f.db);
  store.record({requestId:f.id,agentId:"fixture",operationHash:"expiry-test",processInstance:PROCESS_INSTANCE});
  f.db.prepare("UPDATE permission_request SET expires_at=datetime('now','-1 second') WHERE id=?").run(f.id);
  expect(await handleApprovalCallback("fake",callback(f.id),new Set([101]),{dbPath:f.dbPath,agentId:"fixture",fetchFn:fakeFetch})).not.toBe("decided");
  expect(getPermissionRequest(f.db,f.id)?.status).toBe("expired");
  const decision=await pollDecision(f.db,f.id,20,1);
  expect(decision).toBe("denied");
  expect(finalizeApprovalDelivery(store,f.id,"expiry-test",decision)).toBe("denied");
  expect(store.get(f.id)?.state).toBe("expired");
 }finally{f.db.close()}
});

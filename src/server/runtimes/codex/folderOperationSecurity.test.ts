import { test, expect } from "bun:test";
import { openDb, migrate } from "../../db/migrate";
import { decidePermissionRequest } from "../../lib/permissionGate";
import { requestApprovalPopup } from "./appServerPopup";
import { FolderSessionApprovals, folderOperationDigest } from "./folderSessionApprovals";
import { CodexTurnItemIndex } from "./appServerItemIndex";
import { encodeApproval, classifyServerRequest } from "./serverRequestCodec";
import type { ApprovalRequest } from "./appServerClient";

const command=(text="echo safe",amendment?:string[]):ApprovalRequest=>({method:"item/commandExecution/requestApproval",params:{threadId:"thread",turnId:"turn",itemId:"item",command:text,availableDecisions:["accept","acceptForSession","cancel"],...(amendment?{proposedExecpolicyAmendment:amendment}:{})}});
function fixture() {
 const db=openDb(":memory:"); migrate(db);
 db.prepare("INSERT INTO agent (id,display_name,role,runtime,status_provider,workspace_path,persona_file) VALUES ('fixture','Fixture','eng','codex','codex_cli','/workspace','SOUL.md')").run();
 const sessions=new FolderSessionApprovals(); let sent=0;
 const options=(mutate?:()=>void,session=true)=>({allowAlways:false,failOnSendError:true,folderSessions:sessions,deliveryDeps:{
  token:"fixture",ownerId:"101",chatId:"101",channel:{kind:"telegram" as const,apiBase:"https://fixture.invalid",allowFrom:[],ownerChat:null},
  fetchFn:(async(_url:any,init:any)=>{
   const card=JSON.parse(init.body); const id=card.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1]; sent++;
   setTimeout(()=>{mutate?.();decidePermissionRequest(db,id,session?"allow_session":"allow_once",{approver:"101"})},1);
   return Response.json({ok:true,result:{message_id:sent,chat:{id:101}}});
  }) as unknown as typeof fetch,
 }});
 return {db,sessions,options,sent:()=>sent};
}

test("Folder session approval is per digest; every reuse has correlation/CAS/delivery/audit and emits accept only",async()=>{
 const f=fixture();try{
  const req=command("echo safe",["echo"]);
  expect(await requestApprovalPopup(f.db,req,"fixture",undefined,2500,f.options())).toBe("approved");
  expect(f.sent()).toBe(1);
  const next={...req,serverRequestId:"request2",params:{...req.params,itemId:"item2",turnId:"turn2"}};
  expect(await requestApprovalPopup(f.db,next,"fixture",undefined,2500,f.options())).toBe("approved");
  expect(f.sent()).toBe(1);
  const rows=f.db.query("SELECT * FROM codex_approval_correlation ORDER BY rowid").all() as any[];
  expect(rows).toHaveLength(2); expect(rows.every(r=>r.state==="delivered")).toBe(true);
  expect(rows[1].server_request_id).toBe("request2");
  const requests=f.db.query("SELECT provenance_json FROM permission_request ORDER BY rowid").all() as any[];
  const source=JSON.parse(requests[1].provenance_json).codex_approval;
  expect(source.telegram_delivery).toEqual({owner_id:"101",chat_id:"101",message_id:1});
  expect(source.session_source_request).toBe(rows[0].request_id);
  expect(f.db.query("SELECT count(*) AS n FROM audit_event WHERE action='codex_session_approval_reused'").get()).toEqual({n:1});
  expect(f.db.query("SELECT count(*) AS n FROM permission_grant").get()).toEqual({n:0});
  const encoded=encodeApproval(classifyServerRequest(req.method),"once",req.params);
  expect(encoded).toEqual({kind:"result",result:{decision:"accept"}});
  expect(JSON.stringify(encoded)).not.toContain("acceptForSession");
  expect(JSON.stringify(encoded)).not.toContain("Amendment");
  expect(f.sessions.has("fixture",command("echo safe",["echo","different"]))).toBe(false);
 }finally{f.db.close()}
});

test("Folder denies changes while waiting, including amendments, and never remembers changed content",async()=>{
 for(const kind of ["command","amendment","unknown","file","identity"]){
  const f=fixture();try{
   const req=kind==="file"?{method:"applyPatchApproval",params:{threadId:"thread",fileChanges:{"same.ts":{type:"update",unified_diff:"before"}}}} as ApprovalRequest:command("echo safe",["echo"]);
   const mutate=()=>{if(kind==="file") (req.params.fileChanges as any)["same.ts"].unified_diff="after";else if(kind==="amendment")req.params.proposedExecpolicyAmendment=["different"];else if(kind==="identity")req.params.threadId="different-thread";else req.params.command=kind==="unknown"?null:"echo changed"};
   expect(await requestApprovalPopup(f.db,req,"fixture",undefined,2500,f.options(mutate))).toBe("denied");
   expect(f.sessions.has("fixture",req)).toBe(false);
   expect(f.db.query("SELECT state FROM codex_approval_correlation").get()).toEqual({state:"expired"});
  }finally{f.db.close()}
 }
},15000);

test("Folder once and session distinguish 240-character prefixes and same-file content, unknown contents are denied",async()=>{
 const f=fixture();try{
  const a=command("x".repeat(240)+"safe"), b=command("x".repeat(240)+"other");
  expect(folderOperationDigest(a)).not.toBe(folderOperationDigest(b));
  expect(await requestApprovalPopup(f.db,a,"fixture",undefined,2500,f.options(undefined,false))).toBe("approved");
  expect(f.sessions.has("fixture",a)).toBe(false);
  expect(await requestApprovalPopup(f.db,b,"fixture",undefined,2500,f.options())).toBe("approved");expect(f.sent()).toBe(2);
  for(const req of [{method:"item/fileChange/requestApproval",params:{}},{method:"applyPatchApproval",params:{fileChanges:{"same.ts":{type:"update"}}}},command("")]){
   expect(await requestApprovalPopup(f.db,req,"fixture",undefined,2500,f.options())).toBe("denied");
  }
  expect(f.sent()).toBe(2);
  const file=(diff:string):ApprovalRequest=>({method:"applyPatchApproval",params:{threadId:"thread",fileChanges:{"same.ts":{type:"update",unified_diff:diff}}}});
  expect(await requestApprovalPopup(f.db,file("one"),"fixture",undefined,2500,f.options())).toBe("approved");
  expect(f.sessions.has("fixture",file("two"))).toBe(false);
 }finally{f.db.close()}
});

test("Folder re-reads observed file updates and hashes full diffs beyond the display limit",()=>{
 const index=new CodexTurnItemIndex();
 const put=(diff?:string)=>index.observe("item/fileChange/patchUpdated",{itemId:"item",turnId:"turn",threadId:"thread",changes:[{path:"same.ts",kind:{type:"update"},...(diff===undefined?{}:{diff})}]});
 put("x".repeat(20000)+"one");
 const req:ApprovalRequest={method:"item/fileChange/requestApproval",params:{threadId:"thread",turnId:"turn",itemId:"item"},get observedItem(){return index.lookup("item","turn")??undefined}};
 const before=folderOperationDigest(req);
 put("x".repeat(20000)+"two");expect(folderOperationDigest(req)).not.toBe(before);
 put();expect(folderOperationDigest(req)).toBeNull();
});

import { CodexAppServerClient } from "./appServerClient";
test("App-server approval getter observes a later patch update before the folder delivery decision",async()=>{
 const client=new CodexAppServerClient() as any;
 const put=(diff:string)=>client.itemIndex.observe("item/fileChange/patchUpdated",{itemId:"item",turnId:"turn",threadId:"thread",changes:[{path:"same.ts",kind:{type:"update"},diff}]});
 put("one"); const replies:any[]=[];
 client.respond=(id:any,result:any)=>replies.push({id,result});
 client.activeHandlers={onApproval:async(req:ApprovalRequest)=>{
  const original=folderOperationDigest(req); await Promise.resolve(); put("two");
  expect(folderOperationDigest(req)).not.toBe(original);
  return "denied";
 }};
 await client.handleServerRequest(7,"item/fileChange/requestApproval",{threadId:"thread",turnId:"turn",itemId:"item"});
 expect(replies).toEqual([{id:7,result:{decision:"decline"}}]); client.close();
});

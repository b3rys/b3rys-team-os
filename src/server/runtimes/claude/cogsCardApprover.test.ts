import {test,expect} from "bun:test";
import {mkdtempSync,rmSync,readFileSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openDb,migrate} from "../../db/migrate";
import {pressCogsApproval,getBinding} from "../../lib/cogsPermissions/approvals";
import {createCogsDecisionWaiters} from "../../lib/cogsPermissions/waiters";
import {createClaudeCardApprover} from "./cogsCardApprover";

test("Claude card binds input and owner generation, then claims once; changed owner denies",async()=>{
 for(const changed of [false,true]) {
  const dir=mkdtempSync(join(tmpdir(),"claude-card-")),path=join(dir,"fixture.db"),db=openDb(path);migrate(db);
  const waiters=createCogsDecisionWaiters({agentId:"fixture",openDb:()=>openDb(path)});
  let calls=0,requestId="";
  const owner={instance:"http://fixture",botId:12,userId:7,generation:1};
  const approve=createClaudeCardApprover({agentId:"fixture",roomId:"42",processGen:"g",openDb:()=>openDb(path),currentStamp:()=>"stamp",waiters,
   apiBase:"http://fixture",token:"synthetic",
   fetchFn:(async()=>{calls++;return new Response(JSON.stringify({ok:true,result:{id:12,owner_user_id:7,owner_generation:changed&&calls>1?2:1}}));}) as unknown as typeof fetch,
   sendCard:async card=>{requestId=card.requestId;
    expect(pressCogsApproval(db,{requestId,action:"pg1",actorUserId:7,ownerUserId:7,currentOwner:owner,callbackOwnerGeneration:1,roomId:"42",bridgeAgentId:"fixture",currentStamp:"stamp",nowMs:Date.now()}).kind).toBe("decided");
    waiters.poke(requestId);return {ok:true,messageId:1};},
  });
  try {
   const result=await approve({method:"claude/permission",params:{executionId:"e1",normalizedPath:"/fixture/note.txt",candidate:{tool_name:"Write",input:{file_path:"/fixture/note.txt",content:"fixture"}}}});
   expect(result).toBe(changed?"denied":"approved");expect(calls).toBe(2);
   expect(getBinding(db,requestId)?.handed_off_at_ms!==null).toBe(!changed);
  } finally {waiters.close();db.close();rmSync(dir,{recursive:true,force:true});}
 }
});

// Only synthetic content is used; scan logical rows and physical SQLite/WAL bytes.
test("approval stores metadata only on allow, denial and card failure; digest rejects changed input",async()=>{
 for(const mode of ["allow","deny","card-failed","changed-input","changed-digest"] as const) {
  const dir=mkdtempSync(join(tmpdir(),"claude-card-privacy-")),path=join(dir,"fixture.db"),db=openDb(path);migrate(db);
  const waiters=createCogsDecisionWaiters({agentId:"fixture",openDb:()=>openDb(path)});
  const content="SYNTHETIC_PRIVATE_CONTENT_한글_636";
  const input={file_path:"/fixture/.env",content,extra:"SYNTHETIC_EXTRA_INPUT_636"};
  const owner={instance:"http://fixture",botId:12,userId:7,generation:1};
  let requestId="";
  const approve=createClaudeCardApprover({agentId:"fixture",roomId:"42",processGen:"g",openDb:()=>openDb(path),currentStamp:()=>"stamp",waiters,
   apiBase:"http://fixture",token:"synthetic",
   fetchFn:(async()=>new Response(JSON.stringify({ok:true,result:{id:12,owner_user_id:7,owner_generation:1}}))) as unknown as typeof fetch,
   sendCard:async card=>{
    requestId=card.requestId;
    expect(card.detail).toBe(`/fixture/.env · ${Buffer.byteLength(content,"utf8")} bytes`);
    expect(JSON.stringify(card)).not.toContain(content);
    if(mode==="card-failed") return {ok:false};
    if(mode==="changed-input") input.content="different";
    if(mode==="changed-digest") {
     const row=db.query("SELECT payload_json FROM permission_request WHERE id=?").get(requestId) as {payload_json:string};
     const payload=JSON.parse(row.payload_json),metadata=JSON.parse(payload.text);
     metadata.inputDigest="0".repeat(64);payload.text=JSON.stringify(metadata);
     db.query("UPDATE permission_request SET payload_json=? WHERE id=?").run(JSON.stringify(payload),requestId);
    }
    expect(pressCogsApproval(db,{requestId,action:mode==="deny"?"pgd":"pg1",actorUserId:7,ownerUserId:7,currentOwner:owner,callbackOwnerGeneration:1,roomId:"42",bridgeAgentId:"fixture",currentStamp:"stamp",nowMs:Date.now()}).kind).toBe("decided");
    waiters.poke(requestId);return {ok:true,messageId:1};
   },
  });
  try {
   const result=await approve({method:"claude/permission",params:{executionId:"e1",normalizedPath:"/fixture/.env",candidate:{tool_name:"Write",input}}});
   expect(result).toBe(mode==="allow"?"approved":"denied");
   const rows=db.query("SELECT * FROM permission_request").all();expect(rows).toHaveLength(1);
   const payload=JSON.parse((rows[0] as {payload_json:string}).payload_json);
   expect(Object.keys(payload).sort()).toEqual(["path","text"]);
   const metadata=JSON.parse(payload.text);
   expect(Object.keys(metadata).sort()).toEqual(["checkerCode","contentBytes","inputDigest","tool"]);
   expect(metadata.tool).toBe("Write");expect(metadata.checkerCode).toBe("checker_allowed");
   expect(metadata.contentBytes).toBe(Buffer.byteLength(content,"utf8"));expect(metadata.inputDigest).toMatch(/^[a-f0-9]{64}$/);
   expect(getBinding(db,requestId)?.handed_off_at_ms!==null).toBe(mode==="allow");
   for(const file of readdirSync(dir)) {
    const bytes=readFileSync(join(dir,file));
    expect(bytes.includes(Buffer.from(content))).toBe(false);
    expect(bytes.includes(Buffer.from(input.extra))).toBe(false);
   }
  } finally {waiters.close();db.close();rmSync(dir,{recursive:true,force:true});}
 }
});

import {test,expect} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
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

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleMessage, resetChatThreads, SCHEDULE_MARKER } from "./bridge";
const previous=process.env.B3OS_FIRST_CONTACT_DIR;
afterEach(()=>{resetChatThreads();if(previous===undefined)delete process.env.B3OS_FIRST_CONTACT_DIR;else process.env.B3OS_FIRST_CONTACT_DIR=previous;});
for(const mode of ["success","summary_error","register_error"]) {
 const failure=mode==="summary_error";
 const userReply=mode==="register_error"?"예약 등록에 실패했습니다":"예약을 등록했습니다";
 test(`scheduler ${mode}: tool data stays internal and response closes`,async()=>{
  const home=mkdtempSync(join(tmpdir(),"schedule-ui-"));process.env.B3OS_FIRST_CONTACT_DIR=home;
  const writes:{text:string;state?:string;errorCode?:string}[]=[];let turns=0;
  const marker=`${SCHEDULE_MARKER} {"body":"fixture reminder","delay_seconds":300}`;
  const result=await handleMessage(91,"5분 뒤 알려줘",1,{
   agentId:"schedule-fixture",workdir:home,codexHome:home,sandbox:"read-only",scheduleToolEnabled:true,
   channel:{kind:"b3chat",apiBase:"http://app.invalid",ownerChat:"91",allowFrom:["91"]},
   sendMessage:async(_chat,text,meta)=>{writes.push({text,state:meta?.state,errorCode:meta?.errorCode});return 2;},
   editMessage:async(_chat,_id,text,state,_activity,_code,_ref,_args,errorCode)=>{writes.push({text,state,errorCode});return true;},
   registerScheduleReminder:async()=>{if(mode==="register_error")throw new Error("fixture registration error");return JSON.stringify({code:"schedule_registered",job:{id:"fixture-job"}});},
   runTurn:async options=>{
    if(++turns===1){options.onDelta?.(marker);options.onAnswerText?.(marker);return {ok:true,reply:marker,sessionId:"fixture-session",detail:"ok",elapsedMs:1};}
    expect(options.prompt).toContain(mode==="register_error"?"schedule_failed":"schedule_registered");expect(options.resumeSessionId).toBe("fixture-session");
    if(failure)throw new Error("fixture summary failure");
    return {ok:true,reply:userReply,detail:"ok",elapsedMs:1};
   },
  });
  expect(turns).toBe(2);
  for(const write of writes){expect(write.text.replaceAll("\\","")).not.toContain(SCHEDULE_MARKER);expect(write.text).not.toContain("schedule_registered");}
  if(failure){expect(result.turnOk).toBe(false);expect(writes.at(-1)).toMatchObject({text:"",state:"error",errorCode:"response_failed"});}
  else {expect(result.turnOk).toBe(true);expect(writes.at(-1)).toMatchObject({text:userReply,state:"complete"});}
 });
}

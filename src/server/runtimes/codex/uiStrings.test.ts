import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiText } from "./uiStrings";
import { sendApprovalToMemberRoom, buildOperationFromApproval } from "./appServerPopup";
import { handleApprovalCallback } from "./bridge";
import { grantKey } from "../../lib/permissionGate";
import type { ApprovalRequest } from "./appServerClient";

const previousLocale=process.env.B3OS_UI_LOCALE;
const previousDir=process.env.B3OS_UI_LOCALES_DIR;
afterEach(()=>{
 if(previousLocale===undefined)delete process.env.B3OS_UI_LOCALE;else process.env.B3OS_UI_LOCALE=previousLocale;
 if(previousDir===undefined)delete process.env.B3OS_UI_LOCALES_DIR;else process.env.B3OS_UI_LOCALES_DIR=previousDir;
});
test("locale keys match and external wording changes require no source edit",()=>{
 const ko=JSON.parse(readFileSync(new URL("./locales/ko.json",import.meta.url),"utf8"));
 const en=JSON.parse(readFileSync(new URL("./locales/en.json",import.meta.url),"utf8"));
 expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
 for(const value of Object.values(en))expect(typeof value==="string" && value.length>0).toBe(true);
 const dir=mkdtempSync(join(tmpdir(),"codex-ui-locale-"));
 writeFileSync(join(dir,"ko.json"),JSON.stringify({working:"fixture ko",approval_files:"files {count}"}));
 writeFileSync(join(dir,"en.json"),JSON.stringify({working:"fixture en"}));
 process.env.B3OS_UI_LOCALES_DIR=dir;process.env.B3OS_UI_LOCALE="en";
 expect(uiText("working")).toBe("fixture en");expect(uiText("approval_files",{count:3})).toBe("Edit 3 files?");
 writeFileSync(join(dir,"en.json"),JSON.stringify({working:"replaced"}));expect(uiText("working")).toBe("replaced");
 process.env.B3OS_UI_LOCALE="unsupported";expect(uiText("working")).toBe("fixture ko");
});
for(const locale of ["ko","en"]){
 test(`cogs approval uses codes and sanitized data in ${locale}, including retry`,async()=>{
  process.env.B3OS_UI_LOCALE=locale;
  const bodies:any[]=[];
  const fetchFn=(async (_url:unknown,init?:RequestInit)=>{
   bodies.push(JSON.parse(String(init?.body)));
   return Response.json(bodies.length===1?{ok:false,error_code:400}:{ok:true,result:{message_id:1}});
  }) as typeof fetch;
  const ok=await sendApprovalToMemberRoom("fixture","apr_fixture",{method:"execCommandApproval",params:{command:'curl --header "X-Fake: secret_fixture" https://user:secret_fixture@example.com/?token=secret_fixture'}} as ApprovalRequest,{token:"fake_token",risks:["sudo"],channel:{kind:"b3chat",apiBase:"http://app.invalid",ownerChat:"1",allowFrom:["1"]},fetchFn});
  expect(ok).toBe(true);expect(bodies).toHaveLength(2);
  for(const body of bodies){
   expect(body.text).toBe("");expect(body.cogs_response_state).toBe("activity");expect(body.cogs_activity_code).toBe("approval_required");
   expect(body.cogs_activity_args).toEqual({request_id:"apr_fixture",operation_code:"run_command",detail:"curl",risks:"sudo"});
   expect(JSON.stringify(body)).not.toContain("secret_fixture");expect(body).not.toHaveProperty("cogs_activity");
  }
  const buttons=bodies[0].reply_markup.inline_keyboard[0];expect(buttons.map((b:any)=>b.text_code)).toEqual(["approval_allow_once","approval_allow_session","approval_deny"]);
  expect(buttons.every((b:any)=>!("text" in b))).toBe(true);expect(bodies[1]).not.toHaveProperty("reply_markup");
 });
}
test("permission identity is independent of UI language",()=>{
 const req={method:"applyPatchApproval",params:{fileChanges:{"/tmp/fixture.ts":{type:"update",diff:"fixture"}},grantRoot:"/tmp/work"}} as ApprovalRequest;
 process.env.B3OS_UI_LOCALE="ko";const ko=buildOperationFromApproval(req,"fixture","/tmp/work");
 process.env.B3OS_UI_LOCALE="en";const en=buildOperationFromApproval(req,"fixture","/tmp/work");
 expect(grantKey(ko.requested_by??"fixture",ko.path??ko.text??"")).toBe(grantKey(en.requested_by??"fixture",en.path??en.text??""));
 expect(en).toEqual(ko);
});
test("cogs callback denial uses text_code without rendered prose",async()=>{
 const bodies:any[]=[];
 const fetchFn=(async (_url:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json({ok:true});}) as typeof fetch;
 const result=await handleApprovalCallback("fake_token",{id:"fixture_cb",from:{id:2},data:"pg1:apr_abc"},new Set([1]),{plainOnly:true,fetchFn});
 expect(result).toBe("unauthorized");expect(bodies[0]).toMatchObject({text_code:"callback_forbidden",text_args:{},show_alert:true});expect(bodies[0]).not.toHaveProperty("text");
});

test("folder-wide approval keeps its root separate from sanitized activity targets",async()=>{
 const bodies:any[]=[];
 const fetchFn=(async (_url:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json({ok:true});}) as typeof fetch;
 const req={method:"applyPatchApproval",params:{fileChanges:{"/tmp/work/fixture.ts":{}},grantRoot:"/tmp/work"}} as ApprovalRequest;
 expect(await sendApprovalToMemberRoom("fixture","apr_root",req,{token:"fake",channel:{kind:"b3chat",apiBase:"http://app.invalid",ownerChat:"1",allowFrom:["1"]},fetchFn})).toBe(true);
 expect(bodies[0].cogs_activity_args).toEqual({request_id:"apr_root",operation_code:"edit_files",detail:"fixture.ts",grant_root:"/tmp/work"});
});

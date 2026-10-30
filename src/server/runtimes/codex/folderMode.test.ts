import { expect, test } from "bun:test";
import { codexPermissionMode } from "../../../shared/codexPermissionMode";
import { runModeFor, runViaAppServer } from "./appServerRunner";
import { approvalOperationHash, approvalSummary, redactApprovalText, sendApprovalToMemberRoom } from "./appServerPopup";
import { acquireClient, dropAllClients } from "./clientPool";

test("Existing and new members default to full; malformed settings are rejected", () => {
  expect(codexPermissionMode(undefined)).toBe("full");
  expect(codexPermissionMode(null)).toBe("full");
  expect(runModeFor({})).toEqual({approvalPolicy:"never",sandbox:"danger-full-access"});
  expect(() => codexPermissionMode("unrecognized")).toThrow();
});

test("Folder limits writes to the workspace, removes tmp exceptions, allows network and asks", async () => {
  const seen:any[]=[];
  await runViaAppServer({agentId:"fixture",prompt:"p",cwd:"/workspace",permissionMode:"folder"},undefined,()=>({
    async start(){},async startThread(options:any){seen.push(options)},async runTurn(){return {status:"completed",finalText:"ok"}},close(){},
  }) as any);
  expect(seen[0]).toMatchObject({approvalPolicy:"on-request",sandbox:"workspace-write",writableRoots:["/workspace"],networkAccess:true,excludeSlashTmp:true,excludeTmpdirEnvVar:true});
  expect(()=>runModeFor({permissionMode:"folder"})).toThrow("folder_mode_requires_workspace");
});

test("Changing full/folder recycles only that member's pool entry",()=>{
 const create=()=>({isClosed:false,close(){this.isClosed=true}});
 try {
  const other=acquireClient("other",create).client;
  const full=acquireClient("fixture",create,runModeFor({}).poolKey).client;
  const folder=acquireClient("fixture",create,runModeFor({permissionMode:"folder",cwd:"/workspace"}).poolKey).client;
  expect(full.isClosed).toBe(true);expect(other.isClosed).toBe(false);
  expect(acquireClient("fixture",create,runModeFor({permissionMode:"folder",cwd:"/workspace"}).poolKey).reused).toBe(true);
  acquireClient("fixture",create,runModeFor({}).poolKey);
  expect(folder.isClosed).toBe(true);expect(other.isClosed).toBe(false);
 }finally{dropAllClients()}
});

test("Approval display preserves command and paths while hiding secret flags and credentials",()=>{
 const command='curl --token "example secret" https://user:pass@example.test --output /outside/result';
 const summary=approvalSummary({method:"execCommandApproval",params:{command}});
 expect(summary.detail).toContain("/outside/result");expect(summary.detail).toContain("curl");
 expect(summary.detail).not.toContain("example secret");expect(summary.detail).not.toContain("user:pass");
 expect(redactApprovalText("API_KEY=private-value --password p4ss")).not.toContain("private-value");
 expect(redactApprovalText("API_KEY=private-value --password p4ss")).not.toContain("p4ss");
 const a={method:"item/permissions/requestApproval",params:{permissions:{fileSystem:{write:["/outside/one"]}}}};
 const b={...a,params:{permissions:{fileSystem:{write:["/outside/two"]}}}};
 expect(approvalSummary(a).detail).toContain("/outside/one");
 expect(approvalOperationHash(a)).not.toBe(approvalOperationHash(b));
});

test("Folder Telegram card offers once/session/deny, targets the owner and fails on transport error",async()=>{
 const sent:any[]=[];
 const req={method:"execCommandApproval",params:{command:"echo ok > /outside/probe"}};
 expect(await sendApprovalToMemberRoom("fixture","prm_ab12",req,{token:"fake",chatId:"101",allowAlways:false,channel:{kind:"telegram",apiBase:"http://127.0.0.1:9999",allowFrom:["999"],ownerChat:null},fetchFn:(async(url:any,init:any)=>{sent.push({url,body:JSON.parse(init.body)});return new Response("{}",{status:200})}) as any})).toBe(true);
 expect(sent[0].url).toBe("http://127.0.0.1:9999/botfake/sendMessage");
 expect(sent[0].body.chat_id).toBe("101");
 expect(sent[0].body.reply_markup.inline_keyboard.flat().map((b:any)=>b.callback_data.split(":")[0])).toEqual(["pg1","pgs","pgd"]);
 expect(await sendApprovalToMemberRoom("fixture","prm_ab12",req,{token:"fake",chatId:"101",allowAlways:false,fetchFn:(async()=>{throw new Error("fixture")}) as any})).toBe(false);
});

import { FolderSessionApprovals } from "./folderSessionApprovals";
test("Session fallback remembers only the same member/thread/request and never writes execpolicy",()=>{
 const cache=new FolderSessionApprovals();
 const req={method:"item/commandExecution/requestApproval",params:{threadId:"one",turnId:"turn1",itemId:"item1",command:"echo ok > /outside/file",cwd:"/workspace",availableDecisions:["accept","cancel"]}};
 expect(cache.has("fixture",req)).toBe(false);
 expect(cache.remember("fixture",req)).toBe(true);
 expect(cache.has("fixture",{...req,params:{...req.params,turnId:"turn2",itemId:"item2"}})).toBe(true);
 expect(cache.has("other",req)).toBe(false);
 expect(cache.has("fixture",{...req,params:{...req.params,threadId:"two"}})).toBe(false);
 expect(cache.has("fixture",{...req,params:{...req.params,command:"echo bad > /outside/other"}})).toBe(false);
 expect(cache.remember("fixture",{...req,params:{...req.params,availableDecisions:["acceptForSession"]}})).toBe(false);
 cache.clear("fixture");expect(cache.has("fixture",req)).toBe(false);
});

test("Missing folder workspace fails without starting any process",async()=>{
 let starts=0;
 const result=await runViaAppServer({agentId:"fixture",prompt:"p",permissionMode:"folder"},undefined,()=>{starts++;throw new Error("must not start")});
 expect(result.ok).toBe(false);expect(starts).toBe(0);expect(result.detail).toBe("codex_permission_configuration_invalid");
});

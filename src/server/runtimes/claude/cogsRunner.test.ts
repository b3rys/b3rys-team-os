import { expect,test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cogsActivityArgs, cogsActivityCode, cogsActivityLine } from "../codex/cogsActivity";
import { claudeCogsArguments, claudeToolItem, runClaudeCogsTurn } from "./cogsRunner";
import { claudeCogsPaths,renderClaudeCogsWrapper,writeClaudeCogsFilesAt } from "./cogsLauncher";

test("app Claude launch strips Telegram credentials and ignores workspace plugin configuration",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cogs-claude-isolation-"));
 const workspace=join(root,"member"),home=join(root,"state"),capture=join(root,"capture.json"),binary=join(root,"fake-claude");
 mkdirSync(join(workspace,".claude"),{recursive:true});mkdirSync(home);
 writeFileSync(join(workspace,".claude","settings.json"),JSON.stringify({enabledPlugins:{"telegram@claude-plugins-official":true},hooks:{Stop:[{hooks:[{type:"command",command:"exit 99"}]}]}}));
 writeFileSync(binary,`#!/usr/bin/env python3
import json,os,sys
if "--version" in sys.argv: print("2.1.296 (Claude Code)"); sys.exit(0)
args=sys.argv[1:]
json.dump({'telegram_keys':[k for k in os.environ if k.startswith('TELEGRAM_')],'bot_key': 'CODEX_BOT_TOKEN' in os.environ,'cwd':os.getcwd(),'project_settings':os.path.exists('.claude/settings.json'),'args':args,'pgid':os.getpgrp(),'parent_pgid':os.getpgid(os.getppid())},open(${JSON.stringify(capture)},'w'))
print(json.dumps({'type':'stream_event','event':{'type':'content_block_start','content_block':{'name':'WebSearch'}}}),flush=True)
print(json.dumps({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'input_json_delta','partial_json':json.dumps({'query':'fixture search'})}}}),flush=True)
print(json.dumps({'type':'stream_event','session_id':'session-probe','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'첫 글자'}}}),flush=True)
print(json.dumps({'type':'result','result':'완료','is_error':False,'session_id':'session-probe'}),flush=True)
`);chmodSync(binary,0o700);
 const prior={binary:process.env.CLAUDE_BIN,token:process.env.TELEGRAM_BOT_TOKEN,state:process.env.TELEGRAM_STATE_DIR,bot:process.env.CODEX_BOT_TOKEN};
 process.env.CLAUDE_BIN=binary;process.env.TELEGRAM_BOT_TOKEN="fixture-token";process.env.TELEGRAM_STATE_DIR=workspace;process.env.CODEX_BOT_TOKEN="fixture-app-token";
 try {
  const activities:string[]=[];const deltas:string[]=[];const result=await runClaudeCogsTurn({agentId:"testmate",cwd:workspace,codexHome:home,prompt:"question",model:"sonnet",onActivity:(_line,_id,item)=>activities.push(cogsActivityLine(item)),onDelta:text=>deltas.push(text)});
  expect(activities).toEqual(["검색 · fixture search"]);expect(result.ok).toBe(true);expect(deltas).toEqual(["첫 글자"]);expect(result.reply).toBe("완료");
  const observed=JSON.parse(readFileSync(capture,"utf-8"));
  expect(observed.pgid).toBe(observed.parent_pgid);
  expect(observed.telegram_keys).toEqual([]);expect(observed.bot_key).toBe(false);expect(observed.cwd).toBe(realpathSync(workspace));expect(observed.project_settings).toBe(true);
  expect(observed.args).toContain("--safe-mode");expect(observed.args).toContain("--strict-mcp-config");expect(observed.args).toContain("--include-partial-messages");
  expect(JSON.parse(observed.args[observed.args.indexOf("--mcp-config")+1])).toEqual({mcpServers:{}});
  const settings=JSON.parse(observed.args[observed.args.indexOf("--settings")+1]);expect(settings.enabledPlugins).toEqual({});expect(settings.disableAllHooks).toBe(true);
  expect(existsSync(join(workspace,".claude","settings.json"))).toBe(true);
  expect(claudeCogsArguments({agentId:"testmate",cwd:workspace,prompt:"next",model:"opus",resumeSessionId:result.sessionId},"")).toContain("--resume");
 } finally {
  for(const [key,value] of Object.entries({CLAUDE_BIN:prior.binary,TELEGRAM_BOT_TOKEN:prior.token,TELEGRAM_STATE_DIR:prior.state,CODEX_BOT_TOKEN:prior.bot})) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(root,{recursive:true,force:true});
 }
});
test("Claude app wrapper uses its app channel and no Telegram launcher",()=>{
 const channel={kind:"b3chat" as const,apiBase:"http://127.0.0.1:8741",allowFrom:["5"],ownerChat:"5"};
 const wrapper=renderClaudeCogsWrapper(claudeCogsPaths("testmate",channel),"testmate");
 expect(wrapper).toContain('unset "$cogs_env_key"');expect(wrapper).toContain("cogsBridge.ts");expect(wrapper).not.toContain("start-telegram-channel");expect(wrapper).not.toContain("TELEGRAM_BOT_TOKEN=");
});
test("Claude model values are validated before spawn",()=>{
 expect(()=>claudeCogsArguments({agentId:"testmate",prompt:"x",model:"gpt-6-luna"},"")).toThrow("unsupported_model");
});

test("Claude timeout force-kills an unresponsive CLI without replacing bridge signal handlers",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cogs-claude-timeout-"));
 const binary=join(root,"fake-claude"),capture=join(root,"pid");
 writeFileSync(binary,`#!/usr/bin/env python3
import json,os,signal,time,sys
if "--version" in sys.argv: print("2.1.296 (Claude Code)"); sys.exit(0)
signal.signal(signal.SIGTERM,signal.SIG_IGN)
open(${JSON.stringify(capture)},'w').write(str(os.getpid()))
print(json.dumps({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'ready'}}}),flush=True)
while True: time.sleep(1)
`);chmodSync(binary,0o700);
 const prior=process.env.CLAUDE_BIN;
 const termListeners=process.listeners("SIGTERM"),intListeners=process.listeners("SIGINT");
 process.env.CLAUDE_BIN=binary;
 let childPid:number|undefined;
 try {
  let handlersUnchanged=false;
  const result=await runClaudeCogsTurn({agentId:"testmate",prompt:"x",timeoutMs:1000,onDelta:()=>{
   childPid=Number(readFileSync(capture,"utf-8"));
   handlersUnchanged=process.listeners("SIGTERM").length===termListeners.length && process.listeners("SIGINT").length===intListeners.length;
  }});
  expect(result.ok).toBe(false);expect(result.detail).toBe("timeout");
  expect(handlersUnchanged).toBe(true);expect(childPid).toBeDefined();
  expect(()=>process.kill(childPid!,0)).toThrow();
  expect(process.listeners("SIGTERM")).toEqual(termListeners);expect(process.listeners("SIGINT")).toEqual(intListeners);
 } finally {
  if(childPid){try{process.kill(childPid,"SIGKILL");}catch{/* already gone */}}
  if(prior===undefined)delete process.env.CLAUDE_BIN;else process.env.CLAUDE_BIN=prior;
  rmSync(root,{recursive:true,force:true});
 }
});

 test("Claude app launcher seeds Sonnet only for a missing config",()=>{
  const root=mkdtempSync(join(tmpdir(),"claude-app-launcher-"));
  const channel={kind:"b3chat" as const,apiBase:"http://127.0.0.1:8741",allowFrom:["5"],ownerChat:"5"};
  const paths={...claudeCogsPaths("testmate",channel),wrapper:join(root,"launch.sh"),plist:join(root,"launch.plist"),codexHome:join(root,"state"),tokenFile:join(root,"token")};
  try {
   writeClaudeCogsFilesAt(paths,"testmate");expect(readFileSync(join(paths.codexHome,"config.toml"),"utf-8")).toBe('model = "sonnet"\n');
   writeFileSync(join(paths.codexHome,"config.toml"),'model = "opus"\n');writeClaudeCogsFilesAt(paths,"testmate");
   expect(readFileSync(join(paths.codexHome,"config.toml"),"utf-8")).toBe('model = "opus"\n');
   expect(readFileSync(paths.plist,"utf-8")).toContain("claude-cogs-testmate");
  } finally {rmSync(root,{recursive:true,force:true});}
 });

test("folder rejects older CLI before executing any prompt", async()=>{
 const root=mkdtempSync(join(tmpdir(),"cogs-old-cli-")),binary=join(root,"fake-cli"),sentinel=join(root,"executed");
 writeFileSync(binary,`#!/usr/bin/env python3
import sys
if "--version" in sys.argv: print("2.1.256 (Claude Code)")
else: open(${JSON.stringify(sentinel)},"w").write("executed")
`);chmodSync(binary,0o700);
 const prior=process.env.CLAUDE_BIN;process.env.CLAUDE_BIN=binary;
 try {
  const result=await runClaudeCogsTurn({agentId:"fixture",cwd:root,prompt:"fixture"});
  expect(result.ok).toBe(false);expect(result.detail).toBe("cogs_folder_cli_unsupported");expect(existsSync(sentinel)).toBe(false);
 } finally {if(prior===undefined)delete process.env.CLAUDE_BIN;else process.env.CLAUDE_BIN=prior;rmSync(root,{recursive:true,force:true});}
});

test("unsafe workspace is rejected before even launching the CLI",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cogs-unsafe-workspace-")),registry=join(root,"agents.json"),binary=join(root,"fake-cli"),sentinel=join(root,"executed");
 writeFileSync(registry,'[{"id":"fixture","cogs_tool_scope":"folder"}]');
 writeFileSync(binary,`#!/usr/bin/env python3
open(${JSON.stringify(sentinel)},"w").write("executed")
`);chmodSync(binary,0o700);
 const priorBinary=process.env.CLAUDE_BIN,priorRegistry=process.env.TEAM_AGENT_REGISTRY;
 process.env.CLAUDE_BIN=binary;process.env.TEAM_AGENT_REGISTRY=registry;
 try {
  const result=await runClaudeCogsTurn({agentId:"fixture",cwd:root,prompt:"fixture"});
  expect(result.ok).toBe(false);expect(result.detail).toBe("cogs_workspace_contains_control_files");expect(existsSync(sentinel)).toBe(false);
 } finally {
  if(priorBinary===undefined)delete process.env.CLAUDE_BIN;else process.env.CLAUDE_BIN=priorBinary;
  if(priorRegistry===undefined)delete process.env.TEAM_AGENT_REGISTRY;else process.env.TEAM_AGENT_REGISTRY=priorRegistry;
  rmSync(root,{recursive:true,force:true});
 }
});

test("Claude tools map to the same activity codes as codex, without raw inputs",()=>{
 const cases:[string,unknown,string|undefined,ReturnType<typeof cogsActivityArgs>][]=[
  ["Read",{file_path:"/Users/x/secret-project/notes.md"},"read_files",{target:"notes.md"}],
  ["Glob",{pattern:"**/*password*"},"read_files",{}],
  ["Grep",{pattern:"api_key=sk-live",path:"/tmp"},"read_files",{}],
  ["Edit",{file_path:"/w/app/main.swift",old_string:"a",new_string:"b"},"code_edit",{target:"main.swift"}],
  ["Write",{file_path:"/w/README.md",content:"x"},"writing",{target:"README.md"}],
  ["MultiEdit",{file_path:"/w/config.json",edits:[]},"edit_files",{target:"config.json"}],
  ["WebFetch",{url:"https://example.com/a?token=abc",prompt:"p"},"fetch_web",{target:"example.com"}],
  ["WebSearch",{query:"오늘 날씨"},"search",{target:"오늘 날씨"}],
  ["Bash",{command:"bun test src"},"run_tests",{target:"bun test"}],
  ["TodoWrite",{todos:[]},"plan",{}],
 ];
 for(const [name,input,code,args] of cases){
  const item=claudeToolItem(name,input);
  expect(cogsActivityCode(item),name).toBe(code);expect(cogsActivityArgs(item),name).toEqual(args);
 }
 for(const [name,input] of [["Read",{}],["Edit",{file_path:""}],["Task",{prompt:"x"}],["WebSearch",{query:5}]] as const) expect(claudeToolItem(name,input),name).toBeUndefined();
});

test("each Claude tool call is announced once across partial JSON, block stop and the assistant message",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cogs-claude-activity-"));
 const workspace=join(root,"member"),home=join(root,"state"),binary=join(root,"fake-claude");
 mkdirSync(workspace);mkdirSync(home);
 writeFileSync(binary,`#!/usr/bin/env python3
import json,sys
if "--version" in sys.argv: print("2.1.296 (Claude Code)"); sys.exit(0)
def out(o): print(json.dumps(o),flush=True)
def block(i,bid,name,inp):
  out({'type':'stream_event','event':{'type':'content_block_start','index':i,'content_block':{'type':'tool_use','id':bid,'name':name,'input':{}}}})
  s=json.dumps(inp); h=len(s)//2
  out({'type':'stream_event','event':{'type':'content_block_delta','index':i,'delta':{'type':'input_json_delta','partial_json':s[:h]}}})
  out({'type':'stream_event','event':{'type':'content_block_delta','index':i,'delta':{'type':'input_json_delta','partial_json':s[h:]}}})
  out({'type':'stream_event','event':{'type':'content_block_stop','index':i}})
block(0,'t1','Read',{'file_path':'/w/README.md'})
block(1,'t2','Grep',{'pattern':'TODO'})
out({'type':'assistant','message':{'content':[{'type':'tool_use','id':'t1','name':'Read','input':{'file_path':'/w/README.md'}},{'type':'tool_use','id':'t2','name':'Grep','input':{'pattern':'TODO'}}]}})
out({'type':'stream_event','event':{'type':'content_block_start','index':0,'content_block':{'type':'tool_use','id':'t3','name':'WebFetch','input':{}}}})
out({'type':'stream_event','event':{'type':'content_block_stop','index':0}})
out({'type':'assistant','message':{'content':[{'type':'tool_use','id':'t3','name':'WebFetch','input':{'url':'https://example.com/x','prompt':'p'}}]}})
block(1,'t4','Edit',{'file_path':'/w/a.ts','old_string':'1','new_string':'2'})
out({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'답'}}})
out({'type':'result','result':'답','is_error':False,'session_id':'s'})
`);chmodSync(binary,0o700);
 const prior=process.env.CLAUDE_BIN;process.env.CLAUDE_BIN=binary;
 try {
  const items:unknown[]=[];
  const result=await runClaudeCogsTurn({agentId:"testmate",cwd:workspace,codexHome:home,prompt:"q",model:"sonnet",onActivity:(_l,_i,item)=>items.push(item)});
  expect(result.ok).toBe(true);
  expect(items.map(cogsActivityCode)).toEqual(["read_files","read_files","fetch_web","code_edit"]);
  expect(items.map(cogsActivityArgs)).toEqual([{target:"README.md"},{},{target:"example.com"},{target:"a.ts"}]);
 } finally {if(prior===undefined)delete process.env.CLAUDE_BIN;else process.env.CLAUDE_BIN=prior;rmSync(root,{recursive:true,force:true});}
});

test("card mode enables only explicit MCP configuration and disables inherited hooks/plugins/commands",()=>{
 const root=mkdtempSync(join(tmpdir(),"cogs-card-args-"));
 try {
  const args=claudeCogsArguments({agentId:"fixture",cwd:root,prompt:""},"",root,"folder","/fixture/gate.sock");
  expect(args).not.toContain("--safe-mode");expect(args).not.toContain("--restricted");
  expect(args).toContain("--disable-slash-commands");expect(args).toContain("--strict-mcp-config");
  expect(args[args.indexOf("--setting-sources")+1]).toBe("");
  expect(args[args.indexOf("--permission-mode")+1]).toBe("default");
  expect(args[args.indexOf("--permission-prompt-tool")+1]).toBe("mcp__cogs_permission__ask");
  const settings=JSON.parse(args[args.indexOf("--settings")+1]!);
  expect(settings.disableAllHooks).toBe(true);expect(settings.enabledPlugins).toEqual({});expect(settings.autoMemoryEnabled).toBe(false);
 } finally {rmSync(root,{recursive:true,force:true});}
});

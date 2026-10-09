import { expect,test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCogsArguments, runClaudeCogsTurn } from "./cogsRunner";
import { claudeCogsPaths,renderClaudeCogsWrapper,writeClaudeCogsFilesAt } from "./cogsLauncher";

test("app Claude launch strips Telegram credentials and ignores workspace plugin configuration",async()=>{
 const root=mkdtempSync(join(tmpdir(),"cogs-claude-isolation-"));
 const workspace=join(root,"member"),home=join(root,"state"),capture=join(root,"capture.json"),binary=join(root,"fake-claude");
 mkdirSync(join(workspace,".claude"),{recursive:true});mkdirSync(home);
 writeFileSync(join(workspace,".claude","settings.json"),JSON.stringify({enabledPlugins:{"telegram@claude-plugins-official":true},hooks:{Stop:[{hooks:[{type:"command",command:"exit 99"}]}]}}));
 writeFileSync(binary,`#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
json.dump({'telegram_keys':[k for k in os.environ if k.startswith('TELEGRAM_')],'bot_key': 'CODEX_BOT_TOKEN' in os.environ,'cwd':os.getcwd(),'project_settings':os.path.exists('.claude/settings.json'),'args':args},open(${JSON.stringify(capture)},'w'))
print(json.dumps({'type':'stream_event','session_id':'session-probe','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'첫 글자'}}}),flush=True)
print(json.dumps({'type':'result','result':'완료','is_error':False,'session_id':'session-probe'}),flush=True)
`);chmodSync(binary,0o700);
 const prior={binary:process.env.CLAUDE_BIN,token:process.env.TELEGRAM_BOT_TOKEN,state:process.env.TELEGRAM_STATE_DIR,bot:process.env.CODEX_BOT_TOKEN};
 process.env.CLAUDE_BIN=binary;process.env.TELEGRAM_BOT_TOKEN="fixture-token";process.env.TELEGRAM_STATE_DIR=workspace;process.env.CODEX_BOT_TOKEN="fixture-app-token";
 try {
  const deltas:string[]=[];const result=await runClaudeCogsTurn({agentId:"testmate",cwd:workspace,codexHome:home,prompt:"question",model:"sonnet",onDelta:text=>deltas.push(text)});
  expect(result.ok).toBe(true);expect(deltas).toEqual(["첫 글자"]);expect(result.reply).toBe("완료");
  const observed=JSON.parse(readFileSync(capture,"utf-8"));
  expect(observed.telegram_keys).toEqual([]);expect(observed.bot_key).toBe(false);expect(observed.cwd).toBe(realpathSync(join(home,"runtime")));expect(observed.project_settings).toBe(false);
  expect(observed.args).toContain("--safe-mode");expect(observed.args).toContain("--strict-mcp-config");expect(observed.args).toContain("--include-partial-messages");
  expect(JSON.parse(observed.args[observed.args.indexOf("--mcp-config")+1])).toEqual({mcpServers:{}});
  const settings=JSON.parse(observed.args[observed.args.indexOf("--settings")+1]);expect(settings.enabledPlugins).toEqual({});expect(settings.disableAllHooks).toBe(true);
  expect(existsSync(join(workspace,".claude","settings.json"))).toBe(true);
  expect(claudeCogsArguments({agentId:"testmate",prompt:"next",model:"opus",resumeSessionId:result.sessionId},"")).toContain("--resume");
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

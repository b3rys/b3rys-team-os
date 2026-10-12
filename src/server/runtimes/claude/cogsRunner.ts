import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { CodexTurnOptions, CodexTurnResult } from "../codex/runner";
import { assertCogsWorkspace, cogsToolPolicy, readCogsToolScope, type CogsToolScope } from "./cogsToolPolicy";
import { COGS_MODELS } from "../../lib/b3chatModels";

export function claudeCogsEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key])=>
    !key.startsWith("TELEGRAM_") && !key.startsWith("CODEX_") && key !== "CLAUDECODE" && key !== "CLAUDE_CODE_SESSION_ID"));
}
export function claudeCogsArguments(opts: CodexTurnOptions, system: string, workspace = opts.cwd ?? process.cwd(), scope: CogsToolScope = readCogsToolScope(opts.agentId)): string[] {
  const model=opts.model ?? "sonnet";
  if (!(COGS_MODELS.claude as readonly string[]).includes(model)) throw new Error("unsupported_model");
  const policy = cogsToolPolicy(workspace, scope);
  return ["-p","--model",model,"--output-format","stream-json","--include-partial-messages","--verbose",
    "--safe-mode","--setting-sources","","--settings",JSON.stringify(policy.settings),
    "--strict-mcp-config","--mcp-config",JSON.stringify({mcpServers:{}}),
    ...policy.flags,"--permission-mode","dontAsk","--permission-prompts","none",
    "--tools",policy.tools,"--allowedTools",...policy.allowed,"--append-system-prompt",system,
    ...(opts.resumeSessionId ? ["--resume",opts.resumeSessionId] : [])];
}
export async function runClaudeCogsTurn(opts: CodexTurnOptions): Promise<CodexTurnResult> {
  const started=Date.now();
  // Safe/restricted mode ignores workspace customizations; cwd is the allowed member folder.
  const temporary = !opts.cwd && !opts.codexHome;
  const cwd=opts.cwd ?? (opts.codexHome ? join(opts.codexHome,"runtime") : mkdtempSync(join(tmpdir(),"b3chat-claude-")));
  mkdirSync(cwd,{recursive:true,mode:0o700});
  let text="", sessionId:string|undefined, failure=false, detail="complete", sawPartial=false;
  let toolName="", toolInput="";
  try {
    const scope = readCogsToolScope(opts.agentId);
    const workspace = assertCogsWorkspace(cwd);
    const binary = process.env.CLAUDE_BIN || "claude";
    if (scope === "folder") {
      const version = spawnSync(binary, ["--version"], {env:claudeCogsEnvironment(process.env),encoding:"utf8",timeout:5000});
      const match = /^(\d+)\.(\d+)\.(\d+)\s/.exec(version.stdout ?? "");
      if (version.status !== 0 || !match || Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 296)))) {
        return {ok:false,reply:"",detail:"cogs_folder_cli_unsupported",elapsedMs:Date.now()-started};
      }
    }
    const persona=[`You are AI teammate ${opts.agentId}. Reply directly in Korean. Your workspace is ${workspace}.`,
      ...["SOUL.md","CLAUDE.md"].map(name=>{try{return readFileSync(join(opts.cwd ?? cwd,name),"utf-8");}catch{return "";}}),
      "This conversation is in the cogs app. Return your answer as assistant text; the bridge delivers it. Do not use Telegram plugins or messenger sending scripts."].join("\n");
    const child=spawn(binary,claudeCogsArguments(opts,persona,workspace,scope),
      // Keep the CLI in the bridge's process group for LaunchAgent teardown.
      {cwd:workspace,env:claudeCogsEnvironment(process.env),stdio:["pipe","pipe","ignore"],detached:false});
    const kill=()=>{try{child.kill("SIGTERM");}catch{/* already gone */}};
    const force=()=>{try{child.kill("SIGKILL");}catch{/* already gone */}};
    let forceTimer:ReturnType<typeof setTimeout>|undefined;
    const timer=setTimeout(()=>{failure=true;detail="timeout";kill();forceTimer=setTimeout(force,1000);},opts.timeoutMs ?? 210000);
    const stop=()=>{kill();force();};
    const ended=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
    // Register rejection handler before reading the stream.
    void ended.catch(()=>{});
    child.stdin.on("error",()=>{}); child.stdin.end(opts.prompt);
    try {
      for await(const line of createInterface({input:child.stdout})) {
        let event:any; try{event=JSON.parse(line);}catch{continue;}
        if(typeof event.session_id === "string") sessionId=event.session_id;
        const e=event.type === "stream_event" ? event.event : undefined;
        if(e?.type === "content_block_start") {toolName=e.content_block?.name ?? "";toolInput="";}
        if(e?.type === "content_block_delta") {
          if(e.delta?.type === "text_delta") {const delta=e.delta.text ?? "";sawPartial=true;text+=delta;opts.onDelta?.(delta);}
          if(e.delta?.type === "thinking_delta") opts.onStatus?.("생각 중");
          if(e.delta?.type === "input_json_delta" && toolName === "WebSearch") {
            toolInput+=e.delta.partial_json ?? "";
            try{const query=JSON.parse(toolInput).query;if(typeof query === "string") opts.onActivity?.(`웹 검색: ${query}`);}catch{/* incomplete JSON */}
          }
        }
        if(event.type === "assistant" && !sawPartial) {
          const full=(event.message?.content ?? []).filter((item:any)=>item.type === "text").map((item:any)=>item.text).join("");
          if(full){opts.onDelta?.(full);text=full;}
        }
        if(event.type === "result") {failure ||= event.is_error === true;if(typeof event.result === "string" && !event.is_error) text=event.result;}
      }
      if(await ended !== 0){failure=true;if(detail !== "timeout")detail="runtime_failed";}
    } finally {
      clearTimeout(timer);if(forceTimer)clearTimeout(forceTimer);
      stop();
    }
    return {ok:!failure && !!text.trim(),reply:text,sessionId,detail,elapsedMs:Date.now()-started};
  } catch (error) {return {ok:false,reply:text,sessionId,detail:error instanceof Error && error.message === "cogs_workspace_contains_control_files" ? error.message : "runtime_failed",elapsedMs:Date.now()-started};}
  finally {if(temporary)rmSync(cwd,{recursive:true,force:true});}
}

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { CodexTurnOptions, CodexTurnResult } from "../codex/runner";
import { COGS_MODELS } from "../../lib/b3chatModels";

export function claudeCogsEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key])=>
    !key.startsWith("TELEGRAM_") && !key.startsWith("CODEX_") && key !== "CLAUDECODE" && key !== "CLAUDE_CODE_SESSION_ID"));
}
export function claudeCogsArguments(opts: CodexTurnOptions, system: string): string[] {
  const model=opts.model ?? "sonnet";
  if (!(COGS_MODELS.claude as readonly string[]).includes(model)) throw new Error("unsupported_model");
  return ["-p","--model",model,"--output-format","stream-json","--include-partial-messages","--verbose",
    "--safe-mode","--setting-sources","","--settings",JSON.stringify({disableAllHooks:true,enabledPlugins:{}}),
    "--strict-mcp-config","--mcp-config",JSON.stringify({mcpServers:{}}),
    "--tools","WebSearch","--allowedTools","WebSearch","--append-system-prompt",system,
    ...(opts.resumeSessionId ? ["--resume",opts.resumeSessionId] : [])];
}
export async function runClaudeCogsTurn(opts: CodexTurnOptions): Promise<CodexTurnResult> {
  const started=Date.now();
  // No project .claude directory or plugin settings from the member workspace.
  const temporary = !opts.codexHome;
  const cwd=opts.codexHome ? join(opts.codexHome,"runtime") : mkdtempSync(join(tmpdir(),"b3chat-claude-"));
  mkdirSync(cwd,{recursive:true,mode:0o700});
  let text="", sessionId:string|undefined, failure=false, detail="complete", sawPartial=false;
  let toolName="", toolInput="";
  try {
    const persona=[`You are AI teammate ${opts.agentId}. Reply directly in Korean. Your workspace is ${opts.cwd ?? ""}.`,
      ...["SOUL.md","CLAUDE.md"].map(name=>{try{return readFileSync(join(opts.cwd ?? cwd,name),"utf-8");}catch{return "";}}),
      "This conversation is in the cogs app. Return your answer as assistant text; the bridge delivers it. Do not use Telegram plugins or messenger sending scripts."].join("\n");
    const child=spawn(process.env.CLAUDE_BIN || "claude",claudeCogsArguments(opts,persona),
      {cwd,env:claudeCogsEnvironment(process.env),stdio:["pipe","pipe","ignore"],detached:true});
    const kill=()=>{if(child.pid){try{process.kill(-child.pid,"SIGTERM");}catch{/* already gone */}}};
    const force=()=>{if(child.pid){try{process.kill(-child.pid,"SIGKILL");}catch{/* already gone */}}};
    let forceTimer:ReturnType<typeof setTimeout>|undefined;
    const timer=setTimeout(()=>{failure=true;detail="timeout";kill();forceTimer=setTimeout(force,1000);},opts.timeoutMs ?? 210000);
    const stop=()=>{kill();force();};
    process.once("SIGTERM",stop);process.once("SIGINT",stop);
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
      process.off("SIGTERM",stop);process.off("SIGINT",stop);stop();
    }
    return {ok:!failure && !!text.trim(),reply:text,sessionId,detail,elapsedMs:Date.now()-started};
  } catch {return {ok:false,reply:text,sessionId,detail:"runtime_failed",elapsedMs:Date.now()-started};}
  finally {if(temporary)rmSync(cwd,{recursive:true,force:true});}
}

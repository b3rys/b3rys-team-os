import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { CodexTurnOptions, CodexTurnResult } from "../codex/runner";
import { assertCogsWorkspace, cogsToolPolicy, readCogsToolScope, type CogsToolScope } from "./cogsToolPolicy";
import { startPermissionHost } from "./cogsPermissionMcp";
import { gateClaudePermission } from "./cogsPermissionGate";
import { REPO_ROOT } from "../../lib/personaTemplates";
import { cogsRegistryPath } from "./cogsToolPolicy";
import { COGS_MODELS } from "../../lib/b3chatModels";
import { cogsActivityLine } from "../codex/cogsActivity";

/**
 * Claude 도구 호출을 코덱스 진행 신호와 같은 모양으로 바꾼다 — bridge 가 같은 코드표(cogsActivityCode)로 앱에 보낸다.
 * 필요한 값이 아직 없으면(입력이 덜 왔거나 모르는 도구) undefined. 입력 원문은 여기서 끝나고, 넘어가는 건 code·이름뿐이다.
 */
export function claudeToolItem(name: string, input: unknown): unknown {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (key: string) => typeof i[key] === "string" && i[key] !== "" ? i[key] as string : undefined;
  switch (name) {
    case "WebSearch": return str("query") ? { type: "webSearch", query: str("query") } : undefined;
    case "WebFetch": return str("url") ? { type: "webSearch", action: { type: "openPage", url: str("url") } } : undefined;
    case "Read": return str("file_path") ? { type: "readFiles", path: str("file_path") } : undefined;
    case "Glob": case "Grep": return str("pattern") ? { type: "readFiles" } : undefined;
    case "Write": case "Edit": case "MultiEdit": return str("file_path") ? { changes: [{ path: str("file_path") }] } : undefined;
    case "NotebookEdit": return str("notebook_path") ? { changes: [{ path: str("notebook_path") }] } : undefined;
    case "Bash": return str("command") ? { command: str("command") } : undefined;
    case "TodoWrite": return Array.isArray(i.todos) ? { type: "mcpToolCall", name: "update_plan" } : undefined;
    default: return undefined;
  }
}

import { claudeCogsEnvironment } from "./cogsEnvironment";
export { claudeCogsEnvironment } from "./cogsEnvironment";
export function claudeCogsArguments(opts: CodexTurnOptions, system: string, workspace = opts.cwd ?? process.cwd(), scope: CogsToolScope = readCogsToolScope(opts.agentId), permissionSocket?: string): string[] {
  const model=opts.model ?? "sonnet";
  if (!(COGS_MODELS.claude as readonly string[]).includes(model)) throw new Error("unsupported_model");
  const policy = cogsToolPolicy(workspace, scope);
  return ["-p","--model",model,"--output-format","stream-json","--include-partial-messages","--verbose",
    ...(permissionSocket ? ["--disable-slash-commands"] : ["--safe-mode"]),"--setting-sources","","--settings",JSON.stringify(policy.settings),
    "--strict-mcp-config","--mcp-config",JSON.stringify({mcpServers:permissionSocket ? {cogs_permission:{command:process.execPath,args:[join(import.meta.dir,"cogsPermissionMcp.ts"),permissionSocket]}} : {}}),
    ...(permissionSocket ? [] : policy.flags),"--permission-mode",permissionSocket ? "default" : "dontAsk",
    ...(permissionSocket ? ["--permission-prompt-tool","mcp__cogs_permission__ask"] : ["--permission-prompts","none"]),
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
  let toolName="", toolInput="", toolId="";
  // 한 도구 호출에 신호는 한 번. 부분 JSON 이 완성되는 순간·블록 끝·완성된 assistant 메시지 중 먼저 오는 쪽.
  const announced=new Set<string>();
  let permissionHost: Awaited<ReturnType<typeof startPermissionHost>> | undefined;
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
    if (scope === "folder" && opts.onCogsApproval) {
      permissionHost = await startPermissionHost(candidate => gateClaudePermission(candidate, {
        paths: { workspace, protectedPaths: [REPO_ROOT, join(import.meta.dir,"../../../.."), cogsRegistryPath(),
          join(process.env.HOME ?? "/nonexistent", ".claude"), join(process.env.HOME ?? "/nonexistent", ".openclaw"),
          join(process.env.HOME ?? "/nonexistent", ".codex"), permissionHost!.dir] },
        card: async (candidate, executionId, normalizedPath) => (await opts.onCogsApproval!({
          method:"claude/permission", params:{candidate, executionId, normalizedPath}
        })) === "approved",
        audit: row => console.log(JSON.stringify({type:"cogs_permission_check", ...row})),
      }));
    }
    const persona=[`You are AI teammate ${opts.agentId}. Reply directly in Korean. Your workspace is ${workspace}.`,
      ...["SOUL.md","CLAUDE.md"].map(name=>{try{return readFileSync(join(opts.cwd ?? cwd,name),"utf-8");}catch{return "";}}),
      "This conversation is in the cogs app. Return your answer as assistant text; the bridge delivers it. Do not use Telegram plugins or messenger sending scripts."].join("\n");
    const child=spawn(binary,claudeCogsArguments(opts,persona,workspace,scope,permissionHost?.path),
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
        const announce=(id:string,name:string,input:unknown)=>{
          if(!name || announced.has(id)) return;
          const item=claudeToolItem(name,input);
          if(!item) return;
          announced.add(id);opts.onActivity?.(cogsActivityLine(item), undefined, item);
        };
        if(e?.type === "content_block_start") {toolName=e.content_block?.name ?? "";toolInput="";toolId=e.content_block?.id ?? `block-${e.index ?? announced.size}-${toolName}`;}
        if(e?.type === "content_block_delta") {
          if(e.delta?.type === "text_delta") {const delta=e.delta.text ?? "";sawPartial=true;text+=delta;opts.onDelta?.(delta);}
          if(e.delta?.type === "thinking_delta") opts.onStatus?.("생각 중");
          if(e.delta?.type === "input_json_delta" && toolName) {
            toolInput+=e.delta.partial_json ?? "";
            try{announce(toolId,toolName,JSON.parse(toolInput));}catch{/* incomplete JSON */}
          }
        }
        if(e?.type === "content_block_stop" && toolName) {try{announce(toolId,toolName,JSON.parse(toolInput || "{}"));}catch{/* malformed */}toolName="";}
        if(event.type === "assistant") {
          for(const item of event.message?.content ?? []) if(item?.type === "tool_use") announce(item.id ?? `${item.name}`,item.name ?? "",item.input);
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
  finally {permissionHost?.close();if(temporary)rmSync(cwd,{recursive:true,force:true});}
}

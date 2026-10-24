import { isAgentOff } from "../../lib/agentControl";
import { cogsToolPolicy, readCogsToolScope } from "./cogsToolPolicy";
import { readBridgePid, descendantPids, waitForExit } from "../codex/bridgeProcess";
import { pidAlive } from "../../lib/codexBridgeClient";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRecord } from "../../types";
import { ambientAgents } from "../../lib/registry";
import { claudeCogsPaths } from "./cogsLauncher";
import { REPO_ROOT } from "../../lib/personaTemplates";

export function cogsTmuxAgent(id: string): AgentRecord | undefined {
  return ambientAgents().find(a => a.id === id && a.runtime === "claude_channel" && a.cogs_inbox?.transport === "tmux");
}
export function cogsTmuxAlive(session: string): boolean {
  return spawnSync("tmux", ["has-session", "-t", `=${session}`], {stdio:"ignore", timeout:5000}).status === 0;
}
const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

/** A persistent interactive CLI; the server's cogs poller owns getUpdates. */
export function cogsTmuxCommand(agent: AgentRecord, resume = false): string {
  if (!agent.workspace_path || !agent.tmux_session) throw new Error("cogs_tmux_workspace_missing");
  let model = "sonnet";
  try { model = /^model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(claudeCogsPaths(agent.id).codexHome,"config.toml"),"utf8"))?.[1] ?? model; } catch { /* newly provisioned member */ }
  const persona=["SOUL.md","CLAUDE.md"].map(name=>{try{return readFileSync(join(agent.workspace_path,name),"utf8");}catch{return "";}}).join("\n");
  const instruction = persona + "\n" + "cogs messages arrive through tmux. Reply by calling mcp__cogs_reply__reply with thread_id, message_id and text from the envelope. Never call Telegram tools or messaging shell scripts.";
  const policy = cogsToolPolicy(agent.workspace_path,readCogsToolScope(agent.id));
  const args = ["claude","--model",model,"--disable-slash-commands","--setting-sources","","--settings",JSON.stringify(policy.settings),
    "--strict-mcp-config","--mcp-config",JSON.stringify({mcpServers:{cogs_reply:{command:process.execPath,
      args:[join(REPO_ROOT,"src/server/runtimes/claude/cogsTmuxReply.ts")],env:{GD_AGENT_ID:agent.id, TEAM_COLLAB_ROOT:REPO_ROOT, TEAM_DB_PATH:process.env.TEAM_DB_PATH ?? join(REPO_ROOT,"team.db"), TEAM_AGENT_REGISTRY:process.env.TEAM_AGENT_REGISTRY ?? join(REPO_ROOT,"agents.json")}}}}),
    ...policy.flags,"--permission-mode","dontAsk","--tools",policy.tools,"--allowedTools",...policy.allowed,"mcp__cogs_reply__reply",
    "--append-system-prompt",instruction];
  return `unset CLAUDECODE; export GD_AGENT_ID=${q(agent.id)}; export PATH=${q(`${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:/opt/homebrew/bin`)}:"$PATH"; ${resume ? `${args.map(q).join(" ")} --continue || ` : ""}exec ${args.map(q).join(" ")}`;
}
const controlGeneration = new Map<string, number>();
export interface CogsTmuxControlDeps {
  allowDisabledStart?: boolean;
  run?: (command: string, args: string[]) => {status: number | null};
  alive?: (session: string) => boolean;
  bridgePids?: (agent: AgentRecord) => number[];
  waitBridgeExit?: (pids: number[]) => Promise<boolean>;
}
export async function controlCogsTmux(agent: AgentRecord, enabled: boolean, resume = false, deps: CogsTmuxControlDeps = {}): Promise<{ok:boolean;detail:string}> {
  if (process.env.APPROVAL_EXECUTION_ENABLED !== "1") return {ok:false,detail:"execution_disabled"};
  const generation = (controlGeneration.get(agent.id) ?? 0) + 1;
  controlGeneration.set(agent.id,generation);
  const session = agent.tmux_session;
  if (!session) return {ok:false,detail:"cogs_tmux_session_missing"};
  const run = deps.run ?? ((cmd, args) => spawnSync(cmd,args,{stdio:"ignore",timeout:5000}));
  const alive = deps.alive ?? cogsTmuxAlive;
  // Retire the old bridge before the server starts polling the same bot token.
  const old = claudeCogsPaths(agent.id);
  const label = `gui/${process.getuid?.() ?? 0}/${old.label}`;
  const pids = deps.bridgePids ? deps.bridgePids(agent) : (() => { const pid = readBridgePid(old.pidFile,agent.id); return pid && pidAlive(pid) ? [pid,...descendantPids(pid)] : []; })();
  const bootout = run("launchctl", ["bootout", label]);
  if (bootout.status !== 0 && bootout.status !== 113 && bootout.status !== 3 && run("launchctl",["print",label]).status !== 113)
    return {ok:false,detail:"cogs_old_bridge_stop_unverified"};
  if (pids.length && !(await (deps.waitBridgeExit ?? ((ids) => waitForExit(ids,{timeoutMs:3000})))(pids)))
    return {ok:false,detail:"cogs_old_bridge_still_running"};
  if (!enabled) {
    if (!alive(session)) return {ok:true,detail:"cogs tmux already stopped"};
    const r = run("tmux",["kill-session","-t",`=${session}`]);
    return {ok:r.status===0,detail:"cogs tmux stopped"};
  }
  const current = cogsTmuxAgent(agent.id) ?? agent;
  if (controlGeneration.get(agent.id) !== generation ||
      (!deps.allowDisabledStart && (current.enabled === false || isAgentOff(agent.id)))) return {ok:false,detail:"cogs_tmux_start_cancelled"};
  if (!alive(session)) {
    const r = run("tmux",["new-session","-d","-s",session,"-c",agent.workspace_path,cogsTmuxCommand(agent,resume)]);
    if (r.status !== 0) return {ok:false,detail:"cogs_tmux_start_failed"};
  }
  return {ok:alive(session),detail:"cogs tmux session checked"};
}

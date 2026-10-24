import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import { cogsCall, cogsToken } from "../lib/cogsRelay";
import { readMemberChannel } from "../lib/memberChannel";
import { isAgentOff } from "../lib/agentControl";
import { cogsTmuxAlive } from "../runtimes/claude/cogsTmux";
import { claudeCogsPaths } from "../runtimes/claude/cogsLauncher";
import { codexBridgePaths } from "../runtimes/codex/launcher";
import { readBridgePid } from "../runtimes/codex/bridgeProcess";
import { pidAlive } from "../lib/codexBridgeClient";

export type CogsRuntimeStatus = "ok" | "offline" | "stalled";
export const COGS_POLL_STALE_MS = 90_000; // Includes the bridge's 30-second long poll.
export function cogsRuntimeStatus(enabled: boolean, alive: boolean, pollAt: number, now: number): CogsRuntimeStatus {
  if (!enabled || !alive) return "offline";
  return Number.isFinite(pollAt) && pollAt > 0 && now >= pollAt && now-pollAt <= COGS_POLL_STALE_MS ? "ok" : "stalled";
}

/** Status reporting never starts a runtime or consumes an update. */
export function createCogsStatusReporter(deps: {
  db: Database; agents: () => AgentRecord[];
  now?: () => number;
  observe?: (agent: AgentRecord) => {alive:boolean;pollAt:number};
  off?: (id:string) => boolean;
  report?: (agent: AgentRecord,status:CogsRuntimeStatus) => Promise<void>;
}) {
  const sent = new Map<string,{status:CogsRuntimeStatus;at:number}>();
  let busy = false;
  const observe = deps.observe ?? ((agent:AgentRecord) => {
    if (agent.cogs_inbox) {
      const row = deps.db.query("SELECT value FROM setting WHERE key=?").get(`cogs_poll_at:${agent.id}`) as {value:string}|null;
      return {alive:!!agent.tmux_session && cogsTmuxAlive(agent.tmux_session),pollAt:Number(row?.value ?? 0)};
    }
    const p = agent.runtime === "claude_channel" ? claudeCogsPaths(agent.id) : codexBridgePaths(agent.id);
    const pid = readBridgePid(p.pidFile,agent.id);
    let pollAt=0;
    try {
      const health = JSON.parse(readFileSync(`${p.pidFile}.poll`,"utf8"));
      if (health.agentId === agent.id && health.pid === pid) pollAt=Date.parse(health.readyAt);
    } catch { /* No successful poll observed. */ }
    return {alive:pid !== null && pidAlive(pid),pollAt};
  });
  const report = deps.report ?? (async(agent:AgentRecord,status:CogsRuntimeStatus) => {
    const channel=readMemberChannel(agent.id);
    const paths=agent.runtime === "claude_channel" ? claudeCogsPaths(agent.id) : codexBridgePaths(agent.id);
    const config=agent.cogs_inbox ?? {api_base:channel.apiBase,token_file:paths.tokenFile};
    await cogsCall(config,cogsToken(config),"setBotStatus",{status});
  });
  return async () => {
    if (busy) return;
    busy=true;
    try {
      for (const agent of deps.agents()) {
        if (agent.runtime !== "claude_channel" && agent.runtime !== "codex") continue;
        if (!agent.cogs_inbox && readMemberChannel(agent.id).kind !== "b3chat") continue;
        const now=(deps.now ?? Date.now)();
        const observed=observe(agent);
        const status=cogsRuntimeStatus(agent.enabled !== false && !(deps.off ?? isAgentOff)(agent.id),observed.alive,observed.pollAt,now);
        const prev=sent.get(agent.id);
        if (prev?.status === status && now-prev.at < 30_000) continue;
        try { await report(agent,status); sent.set(agent.id,{status,at:now}); } catch { /* Retry next interval; never expose a bot URL or token. */ }
      }
    } finally {busy=false;}
  };
}
export function startCogsStatus(deps: Parameters<typeof createCogsStatusReporter>[0]): () => void {
  const poll=createCogsStatusReporter(deps);
  const timer=setInterval(()=>void poll(),5000);
  void poll();
  return ()=>clearInterval(timer);
}

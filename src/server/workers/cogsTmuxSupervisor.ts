import type { AgentRecord } from "../types";
import { cogsTmuxAlive, controlCogsTmux } from "../runtimes/claude/cogsTmux";
import { isAgentOff } from "../lib/agentControl";

/** Called before polling; never consume a bot's update until its session is available. */
export function createCogsTmuxSupervisor(deps: {
  alive?: typeof cogsTmuxAlive;
  control?: typeof controlCogsTmux;
  now?: () => number;
  onRecovery?: (agent: AgentRecord, ok: boolean) => void;
} = {}) {
  const retired = new Set<string>();
  const attempts = new Map<string, number>();
  return async (agent: AgentRecord): Promise<boolean> => {
    if (agent.cogs_inbox?.transport !== "tmux") return true;
    if (agent.enabled === false || isAgentOff(agent.id) || !agent.tmux_session) return false;
    const alive = (deps.alive ?? cogsTmuxAlive)(agent.tmux_session);
    if (alive && retired.has(agent.id)) return true;
    const now = (deps.now ?? Date.now)();
    if (now - (attempts.get(agent.id) ?? -Infinity) < 30_000) return false;
    if (process.env.APPROVAL_EXECUTION_ENABLED !== "1" || (!alive && process.env.HEALTH_AUTOFIX_ENABLED !== "1")) return false;
    attempts.set(agent.id, now);
    const result = await (deps.control ?? controlCogsTmux)(agent, true, true);
    if (result.ok) retired.add(agent.id);
    deps.onRecovery?.(agent, result.ok);
    return result.ok;
  };
}

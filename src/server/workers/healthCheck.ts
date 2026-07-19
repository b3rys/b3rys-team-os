// health-check Phase 1 (observe-only): agent_status 를 주기적으로 분류해 위험 전이 시 알림.
// 자동 조치(Phase 2: compact 유도/세션 재시작 등)는 별도 — 여기선 감지+알림만(0 리스크).
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import { listStatuses, appendAudit } from "../db/queries";
import { classifyAll, type HealthLevel } from "../lib/health";
import { checkEssentialSettings } from "../lib/runtimeEssentials";

const INTERVAL_MS = Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 30_000);

interface HealthDeps {
  db: Database;
  agents: () => AgentRecord[];
}

/**
 * 주기적으로 전체 에이전트 health 를 분류.
 * - ok→danger 전이: audit "agent_danger" 알림 (대시보드 알림에 노출).
 * - danger→회복: "agent_recovered" 기록.
 * 같은 레벨 지속은 매 tick 알림 안 함(스팸 방지). Phase 2 에서 이 위에 자동조치.
 */
export function startHealthCheck(deps: HealthDeps): () => void {
  const lastLevel = new Map<string, HealthLevel>();
  const lastEssentialsKey = new Map<string, string>();
  let stopped = false;
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const agents = deps.agents();
      const verdicts = classifyAll(listStatuses(deps.db), agents);
      for (const v of verdicts) {
        const prev = lastLevel.get(v.agentId) ?? "ok";
        if (v.level === "danger" && prev !== "danger") {
          appendAudit(deps.db, "health", "agent_danger", v.agentId, {
            reasons: v.reasons,
            ctx: v.ctxPercent,
            state: v.state,
          });
          console.log(`[health] ⚠ ${v.agentId} DANGER: ${v.reasons.join(", ")}`);
        } else if (v.level !== "danger" && prev === "danger") {
          appendAudit(deps.db, "health", "agent_recovered", v.agentId, {
            level: v.level,
            ctx: v.ctxPercent,
          });
          console.log(`[health] ✓ ${v.agentId} recovered → ${v.level}`);
        }
        lastLevel.set(v.agentId, v.level);
      }
      for (const agent of agents) {
        const essentials = await checkEssentialSettings(agent);
        const key = essentials.ok ? "ok" : JSON.stringify({ runtime: agent.runtime, missing: essentials.missing });
        const prevKey = lastEssentialsKey.get(agent.id);
        if (!essentials.ok && prevKey !== key) {
          appendAudit(deps.db, "health", "runtime_essentials_missing", agent.id, {
            runtime: agent.runtime,
            missing: essentials.missing,
            canAutoFix: essentials.canAutoFix,
          });
          console.log(`[health] ${agent.id} essentials missing: ${essentials.missing.join(", ")}`);
        } else if (essentials.ok && prevKey && prevKey !== "ok") {
          appendAudit(deps.db, "health", "runtime_essentials_recovered", agent.id, { runtime: agent.runtime });
        }
        lastEssentialsKey.set(agent.id, key);
      }
    } catch (e) {
      console.error("[health] tick error:", (e as Error).message);
    } finally {
      ticking = false;
    }
  }

  void tick();
  const iv = setInterval(() => {
    if (!stopped) void tick();
  }, INTERVAL_MS);
  console.log(`[health] started — interval=${INTERVAL_MS}ms (observe-only, Phase 1)`);
  return () => {
    stopped = true;
    clearInterval(iv);
  };
}

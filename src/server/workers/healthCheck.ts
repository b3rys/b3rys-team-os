// health-check: agent_status 를 주기적으로 분류해 위험 전이 시 알림.
//
// ★2026-07-30 수정 — "감지는 됐는데 아무도 못 들었다"★
//   이전엔 appendAudit 으로 audit_event 테이블에만 썼다. 08:03:37 에
//   `runtime_essentials_missing | lisa | poller:claude bot.pid, canAutoFix:true` 를 정확히 잡아놓고도
// message 테이블에 아무것도 안 넣어 팀장님·팀원 누구에게도 안 갔고, 리사는 28분 무응답이었다.
//   게다가 claude 봇 launchd 잡은 KeepAlive=false 라(스포너라서 true 로 켤 수도 없다) 시스템 안에
//   그 멤버를 되살릴 주체가 아예 없었다 → 사람이 손으로 --force 를 돌려야 끝났다.
//   그래서 이제 (1) op 알림을 실제로 발행하고, (2) 게이트가 열려 있으면 재시작까지 시도한다.
//   부팅 오탐 방지: 연속 N tick(기본 3 ≒ 90s) 유지될 때만 — 정상 멤버도 부팅 직후 잠깐 미충족이다
//   (실측: jane 도 같은 항목이 잡혔고 34초 뒤 스스로 회복).
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import { listStatuses, appendAudit } from "../db/queries";
import { classifyAll, type HealthLevel } from "../lib/health";
import { checkEssentialSettings } from "../lib/runtimeEssentials";
import { restartAgent } from "../lib/agentControl";
import {
  EssentialsOpNotifier,
  emitOpNotice,
  auditOpNotice,
  pickOpNoticeRecipient,
  buildEssentialsDownBody,
  buildEssentialsRecoveredBody,
  OP_NOTICE_AFTER_TICKS,
} from "../lib/opNotice";

const INTERVAL_MS = Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 30_000);

/** 자동 재시작(Phase 2) 게이트. ★기본 OFF★ — 켜려면 명시적으로 1.
 *  이중 게이트다: 이 플래그 + agentControl.restartAgent 안의 APPROVAL_EXECUTION_ENABLED.
 *  둘 다 열려야 자동 재시작이 일어난다(무인 재시작은 승인 게이트 대상 행위이므로). */
const AUTOFIX_ENABLED = process.env.HEALTH_AUTOFIX_ENABLED === "1";

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
  const notifier = new EssentialsOpNotifier();
  let stopped = false;
  let ticking = false;

  /** 확정된 미충족(연속 N tick) — 알림을 먼저 보내고, 게이트가 열려 있으면 재시작을 시도한다.
   *  ★순서가 중요하다★: 알림 먼저. 재시작이 실패하거나 이 워커가 죽어도 사람은 사실을 안다. */
  async function handleEssentialsDown(
    agent: AgentRecord,
    missing: string[],
    agents: AgentRecord[],
  ): Promise<void> {
    // 실측 경과를 쓴다 — afterTicks × interval 은 항상 90 이 나오고, 스킵된 tick 만큼 실제로는 더 길다.
    const elapsedSec = notifier.elapsedSecOf(agent.id);
    const to = pickOpNoticeRecipient(agents, agent.id);
    if (to) {
      const id = emitOpNotice(deps.db, {
        to,
        body: buildEssentialsDownBody({ agentId: agent.id, runtime: agent.runtime, missing, elapsedSec }),
        threadKey: `op-health-${agent.id}`,
        priority: "high",
      });
      auditOpNotice(deps.db, "op_notice_sent", agent.id, { kind: "down", to, missing, message_id: id });
      console.log(`[health] ⚠ ${agent.id} essentials 미충족 ${elapsedSec}s 지속 — op 알림 → ${to}`);
    } else {
      // 받을 사람이 아무도 없다(1인 팀에서 그 1인이 고장). 최소한 흔적은 남긴다.
      auditOpNotice(deps.db, "op_notice_no_recipient", agent.id, { missing });
      console.log(`[health] ⚠ ${agent.id} essentials 미충족 — op 알림 수신자 없음(단독 멤버)`);
    }

    if (!AUTOFIX_ENABLED) return;
    try {
      // fresh=false → --resume(컨텍스트 유지). 스포너에 --force 가 함께 실려 no-op 함정을 피한다.
      const r = await restartAgent(agent.id, agent.runtime, false);
      appendAudit(deps.db, "health", r.ok ? "autofix_restarted" : "autofix_failed", agent.id, {
        runtime: agent.runtime,
        missing,
        detail: r.detail,
      });
      console.log(`[health] autofix ${agent.id}: ${r.ok ? "OK" : "FAIL"} — ${r.detail}`);
      if (to) {
        emitOpNotice(deps.db, {
          to,
          body: `[team op] ${agent.id} 자동 재시작 ${r.ok ? "성공" : "실패"} — ${r.detail}`,
          threadKey: `op-health-${agent.id}`,
          priority: r.ok ? "normal" : "high",
        });
      }
    } catch (e) {
      appendAudit(deps.db, "health", "autofix_failed", agent.id, { error: (e as Error).message });
      console.error(`[health] autofix ${agent.id} threw:`, (e as Error).message);
    }
  }

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
        // ★꺼둔 멤버는 고장이 아니다★ — 사람이 내린 결정이지 사고가 아니다.
        //   이 갈래가 없어서, 오래전에 안 쓰게 된 멤버가 ★2분마다 high 알림★ 을 냈다(2026-07-30 brief).
        //   설정이 아예 없는 멤버는 영원히 회복되지 않으므로 ★끝나지 않는 반복★ 이 된다.
        //   registry 는 disabled 멤버도 목록에 남긴다(ambientAgents: enabled = a.enabled !== false)
        //   → 여기서 명시적으로 건너뛰지 않으면 검사 대상에 그대로 들어온다.
        if (agent.enabled === false) continue;
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

        // ─── op 알림 + (게이트 열려 있으면) 자동 복구 ────────────────────────
        // ★pendingPairing 은 사고가 아니다★ — 첫 claude 멤버는 설계상 페어링 대기로 시작한다.
        //   여기서 알리면 영입 절차마다 오탐이 나므로 제외한다.
        const isRealFault = !essentials.ok && !(essentials as { pendingPairing?: boolean }).pendingPairing;
        const verdict = notifier.observe(agent.id, isRealFault ? essentials.missing : null);
        if (verdict === "down") {
          await handleEssentialsDown(agent, essentials.missing, agents);
        } else if (verdict === "recovered") {
          const to = pickOpNoticeRecipient(agents, agent.id);
          if (to) {
            const id = emitOpNotice(deps.db, {
              to,
              body: buildEssentialsRecoveredBody(agent.id),
              threadKey: `op-health-${agent.id}`,
              priority: "normal",
            });
            auditOpNotice(deps.db, "op_notice_sent", agent.id, { kind: "recovered", to, message_id: id });
          }
          console.log(`[health] ✓ ${agent.id} essentials 회복 — op 알림(회복) 발행`);
        }
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
  console.log(
    `[health] started — interval=${INTERVAL_MS}ms · op알림 after ${OP_NOTICE_AFTER_TICKS} tick` +
      ` · autofix=${AUTOFIX_ENABLED ? "ON" : "OFF(HEALTH_AUTOFIX_ENABLED≠1)"}`,
  );
  return () => {
    stopped = true;
    clearInterval(iv);
  };
}

import { Hono } from "hono";
import type { AgentRecord } from "../types";
import type { Database } from "bun:sqlite";
import { routeTeamMessageHybrid, isConfidentOwner, shouldSuppress } from "../lib/teamRouter";
import { getGroupOwner, getGroupOwners } from "../lib/groupOwner";
import { findRouteByTgMessageId } from "../db/inboxQueries";
import { appendAuditFile } from "../lib/auditFile";
import { isRouterEnabled } from "../lib/captureConfig";

interface RouterRouteDeps {
  agents: () => AgentRecord[];
  db: Database;
}

// injection(실제 봇 깨우기) 킬스위치 — 이제 *라이브 읽기* isRouterEnabled(deps.db). 기본 OFF — shadow(결정만).
// (P0) UI(Settings▸시스템OP) 토글로 즉시 on/off. store(setting router_enabled) 우선, 없으면 env(ROUTER_ENABLED) fallback.

/**
 * 라우터 서비스 라우트 — 라이브 통합 Stage 1.
 * POST /api/route { text, activeAssigneeId?, replyToAgentId? } → who-answers 결정 + audit 로깅.
 * 현재 shadow: 결정만 반환하고 봇을 깨우지 않는다(INJECTION_ENABLED=false).
 * 캡처 브리지(텔레그램 그룹→여기)와 injection 레이어는 OWNER 승인 후 단계 연결.
 */
export function createRouterRoutes(deps: RouterRouteDeps): Hono {
  const r = new Hono();

  r.post("/route", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const b = body as {
      text?: unknown;
      activeAssigneeId?: unknown;
      activeAssigneeIds?: unknown;
      replyToAgentId?: unknown;
      self?: unknown;
      tgMessageId?: unknown;
    };
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text) return c.json({ error: "missing_text" }, 400);
    // self = 묻는 봇의 id (owner-gate/react 훅이 자기 id를 보냄). suppress 판단에 사용.
    const self = typeof b.self === "string" ? b.self : "";
    // tgMessageId = 원본 telegram message_id. 주면 capture 가 적재한 결정(reply/sticky 반영)으로 재판단(reply-blindness 보완).
    const tgMessageId = typeof b.tgMessageId === "string" ? b.tgMessageId : "";

    // activeAssigneeId 미지정 시 그룹 sticky(직전 담당자)를 적용 — owner-gate 훅이 text만 보내도
    // 무-@멘션 메시지에 sticky 기준 owner 판정이 되게 한다(sticky=codex면 reason=active_assignee_followup).
    const context = {
      activeAssigneeId:
        typeof b.activeAssigneeId === "string" ? b.activeAssigneeId : (getGroupOwner() ?? undefined),
      activeAssigneeIds: Array.isArray(b.activeAssigneeIds)
        ? b.activeAssigneeIds.filter((id): id is string => typeof id === "string")
        : getGroupOwners(),
      replyToAgentId: typeof b.replyToAgentId === "string" ? b.replyToAgentId : undefined,
    };

    const decision = await routeTeamMessageHybrid(text, deps.agents(), context);

    // 결정 audit — self-learning 감사추적 (나중에 OWNER 교정과 함께 튜닝 소스).
    appendAuditFile("router", "route_decision", text.slice(0, 200), {
      outcome: decision.outcome,
      targets: decision.targetAgentIds,
      reason: decision.reason,
      intent: decision.intent,
      domain: decision.domain,
      suggested: decision.suggested,
      needsOwnerConfirm: decision.needsOwnerConfirm,
      via: decision.via,
      activeAssigneeId: context.activeAssigneeId ?? null,
      activeAssigneeIds: context.activeAssigneeIds,
      replyToAgentId: context.replyToAgentId ?? null,
      injection_enabled: isRouterEnabled(deps.db),
    });

    // owner-gate 단일 출처: self 봇이 응답·👀를 억제해야 하는지 서버가 판단(훅은 obey만).
    // reply-blindness 보완: tgMessageId 가 오면 capture 적재 결정(reply/sticky 반영)으로 재판단.
    // capture race 대비 짧은 재조회(최대 ~0.5s). 못 찾으면 위 text/sticky 판단으로 폴백.
    let effReason: string = decision.reason;
    let effTargets: string[] = decision.targetAgentIds;
    // authoritySource = suppress 판단에 실제 쓰인 권위 출처(capture 저장 결정 vs 즉석 text 판단).
    //   shadow audit 3자비교(team-comm 3a, Codex F2)에서 authority_reason/targets 로 기록됨.
    let authoritySource: "capture_meta" | "computed" = "computed";
    if (self && tgMessageId) {
      let route = findRouteByTgMessageId(deps.db, tgMessageId);
      for (let i = 0; i < 2 && !route; i++) {
        await new Promise((r) => setTimeout(r, 250));
        route = findRouteByTgMessageId(deps.db, tgMessageId);
      }
      if (route) {
        effReason = route.reason;
        effTargets = route.targets;
        authoritySource = "capture_meta";
      }
    }
    const confidentOwner = isConfidentOwner(effReason);
    const suppress = self ? shouldSuppress(effReason, effTargets, self) : false;

    // injection 은 킬스위치 ON 일 때만. 현재 OFF → 결정만 반환(shadow).
    // (ON 단계: outcome=route 면 targets 를 tmuxInject/openclawBridge 로 깨움 — OWNER 입회 후.)
    return c.json({
      ...decision,
      confidentOwner,
      suppress,
      // team-comm 3a (Codex F2): suppress 판단에 실제 쓰인 effective 값 — bridge audit 이 authority_* 로 기록.
      effectiveReason: effReason,
      effectiveTargets: effTargets,
      authoritySource,
      injection_enabled: isRouterEnabled(deps.db),
      note: isRouterEnabled(deps.db) ? "injection ON" : "shadow only — 결정만, 봇 안 깨움 (injection OFF)",
    });
  });

  r.get("/route/health", (c) => c.json({ ok: true, injection_enabled: isRouterEnabled(deps.db) }));

  return r;
}

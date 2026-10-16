import type { AgentRecord } from "../../types";
import {
  type RouterContext,
  type RouteDecision,
  type RouteIntent,
  type LlmRouteDecision,
  OLLAMA_URL,
  ROUTER_MODEL,
  buildRosterText,
  classifyIntent,
} from "./_shared";
import { coordinatorId } from "../capabilities";
import { broadcastRecipientIds } from "../agentMembership";
import { detectExplicitTargets, stripQuotedForRouting } from "./mention";
import { routeDefaultIntakeLLM } from "./defaultIntake";

// @all/@b3rys/@group — broadcast-all marker. Checked before explicit_mention.
const BROADCAST_MARKER_RE = /@(all|b3rys|group)\b/i;

// 라우팅 수신행과 wake가 갈리지 않도록 전체 호출 마커 판정을 공유한다.
export function hasBroadcastAllMarker(text: string): boolean {
  return BROADCAST_MARKER_RE.test(stripQuotedForRouting(text));
}

// 수동 allowlist는 정식 명부와 갈릴 수 있어 broadcastRecipientIds 하나로 대상을 계산한다. wake allowlist와는 별개다.
function broadcastTargets(agents: AgentRecord[]): string[] {
  return broadcastRecipientIds(agents);
}

// 방 게시와 팀원 wake는 별개다. 멘션 대상을 공통 detectExplicitTargets로 계산해야 대상 판정이 갈리지 않는다.
export function broadcastAudience(text: string, source?: string): { kind: "all_hands" | "none" } {
  // 팀원의 @all 언급이 전원 wake로 확대되지 않도록 전체 호출 마커는 팀장 발언에서만 인정한다.
  if (source !== "user") return { kind: "none" };
  return { kind: hasBroadcastAllMarker(text) ? "all_hands" : "none" };
}

export function routeTeamMessage(
  text: string,
  agents: AgentRecord[],
  context: RouterContext = {},
): RouteDecision {
  const activeAssigneeIds = validActiveAssignees(context, agents);
  // 인용/예시(코드펜스·"—-" 구분선 아래)의 멘션은 트리거 대상에서 제외.
  // 라이브 멘션 판정에만 적용 — 원문 text 는 다른 용도 위해 보존.
  const liveText = stripQuotedForRouting(text);
  // 0) @all/@b3rys/@group → broadcast all enabled agents. Checked BEFORE explicit_mention.
  if (hasBroadcastAllMarker(text)) {
    return {
      targetAgentIds: broadcastTargets(agents),
      reason: "broadcast_marker",
      shouldResetThread: false,
    };
  }

  const explicit = detectExplicitTargets(liveText, agents);
  if (explicit.length > 0) {
    return {
      targetAgentIds: explicit,
      reason: "explicit_mention",
      shouldResetThread: false,
    };
  }

  // @멘션 없음 + 답장이면 → 원문 작성자가 owner (sticky 보다 우선). GD 커뮤니케이션 룰.
  if (context.replyToAgentId && agents.some((a) => a.id === context.replyToAgentId)) {
    return {
      targetAgentIds: [context.replyToAgentId],
      reason: "reply_author",
      shouldResetThread: false,
    };
  }

  // 주제전환을 추측해 담당을 버리지 않도록 명시 멘션·답장 전까지 직전 owner를 유지한다.
  if (activeAssigneeIds.length > 0) {
    return {
      targetAgentIds: activeAssigneeIds,
      reason: "active_assignee_followup",
      shouldResetThread: false,
    };
  }

  const coordinator = coordinatorId(agents);
  return {
    targetAgentIds: coordinator ? [coordinator] : [],
    reason: "default_step",
    shouldResetThread: false,
  };
}

function validActiveAssignees(context: RouterContext, agents: AgentRecord[]): string[] {
  const validIds = new Set(agents.map((a) => a.id));
  const ids = context.activeAssigneeIds?.length
    ? context.activeAssigneeIds
    : context.activeAssigneeId
      ? [context.activeAssigneeId]
      : [];
  return [...new Set(ids)].filter((id) => validIds.has(id));
}


// 이 모델은 프롬프트 문구·순서·예시에 민감하므로 데이터화나 재배열 시 라우팅 회귀 검증이 필요하다.
function routerSystemPrompt(agents: AgentRecord[]): string {
  const coord = coordinatorId(agents) ?? "코디네이터"; // 조율 담당은 특정 ID가 아니라 capability에서 찾는다.
  return `너는 팀 채팅방 메시지 라우터다. 사용자(팀장)의 새 메시지를 보고 누가 응답할지 정한다.

팀원과 담당 영역:
${buildRosterText(agents)}

규칙(우선순위 순):
1. @멘션으로 특정인을 부르면 → 그 사람(들). 최우선. Codex는 예외적으로 정확히 @코덱스, @codex, @Codex, @example_openclaw_bot 일 때만 호출로 본다. 문장 중간의 "코덱스" 언급은 호출이 아니다.
2. @멘션이 없고 reply_to_agent 가 있으면 → 답장 원문 작성자(reply_to_agent). sticky/current_responder 보다 우선.
3. @멘션도 답장 원문 작성자도 없고, 이름 없이 직전 대화를 잇는 후속이면 → current_responder 유지(continuation=true). 예: current_responder=steve, "버블버블 게임이야" → responders=["steve"], continuation=true.
4. "의견/생각/어때?/검토/논의" 같이 **의견을 구하는 논의**면 → intent=discussion, 관련자 여럿(보통 codex+bill, 또는 도메인 전문가 포함).
5. "만들어/고쳐/구현/배포/세팅" 같이 **실행·구현**이면 → intent=execution, 도메인 담당 **1명**만.
6. **주제 전환·종료 신호가 있으면 current_responder 를 반드시 버리고 reset=true.** 신호: "이건 됐고/그건 됐고/오케이 됐고/다음/넘어가자/이제 다른/다른 거 하자". 이 경우 새 주제의 도메인 담당으로 보내라(불명확하면 ${coord}). 예: current_responder=steve, "오케이 이건 됐고 팀 대시보드 리뷰하자" → reset=true, responders=["bill"](대시보드=infra). steve 유지 금지.
7. 그 외 일반/잡담 → ${coord}(기본 조율 담당).

주의: 명확한 커뮤니케이션 owner 판정(@멘션 → 답장 원문 작성자 → sticky/current_responder)이 작업/도메인 판단보다 먼저다. 규칙 6(주제전환)는 sticky보다 우선한다. current_responder 가 있어도 전환 신호가 있으면 그 담당을 버린다.

도메인 매핑 (이름 없이 도메인으로 보낼 때, 반드시 이 매핑을 우선 적용):
- 투자/사업성/수익/재무/비용/예산/돈 → dbak. 예: "이 사업 투자할 만해?" → ["dbak"]. "비용 얼마나 들까?" → ["dbak"].
- 뉴스/트렌드/시장동향/업계소식 → brief. 예: "오늘 AI 뉴스 뭐 있어?" → ["brief"].
- 서비스전략/제품전략/우선순위/CSO/서비스 방향 → hermes. 예: "이 기능 서비스 전략상 맞아?" → ["hermes"].
- 서버/배포/봇/터널/인프라/보안/team-collab → bill. 예: "텔레그램 봇이 또 죽었어" → ["bill"].
- 앱/화면/프론트/UI 구현 → steve.
- 모델/아키텍처/AI 리서치 → demis.
- 런타임 조율/팀취합/그 외 불명확 → ${coord}(기본 조율 담당).

JSON 만 출력:
{"responders":["<id>",...],"intent":"discussion|execution|other","continuation":true|false,"reset":true|false,"domain":"infra|impl|research|finance|news|orchestration|none","reason":"<짧게>"}
responders 는 위 id 중에서만.`;
}

interface RawLlm {
  responders?: string[];
  intent?: string;
  continuation?: boolean;
  reset?: boolean;
  domain?: string;
  reason?: string;
}

/**
 * LLM 라우팅 (EXAONE/Ollama). Ollama 실패 시 regex routeTeamMessage 로 폴백.
 * standalone — 아직 라이브 메시지 흐름에 연결 안 됨.
 */
export async function routeTeamMessageLLM(
  text: string,
  agents: AgentRecord[],
  context: RouterContext = {},
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<LlmRouteDecision> {
  const validIds = new Set(agents.map((a) => a.id));
  try {
    const user = JSON.stringify({
      current_responder: context.activeAssigneeId ?? context.activeAssigneeIds?.[0] ?? null,
      current_responders: context.activeAssigneeIds ?? (context.activeAssigneeId ? [context.activeAssigneeId] : []),
      reply_to_agent: context.replyToAgentId ?? null,
      new_message: text,
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: opts.model ?? ROUTER_MODEL,
        messages: [
          { role: "system", content: routerSystemPrompt(agents) },
          { role: "user", content: user },
        ],
        stream: false,
        format: "json",
        options: { temperature: 0 },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const body = (await res.json()) as { message?: { content?: string } };
    const parsed = JSON.parse(body.message?.content ?? "{}") as RawLlm;

    const coordinator = coordinatorId(agents);
    let responders = (parsed.responders ?? []).filter((id) => validIds.has(id));
    if (responders.length === 0) responders = coordinator ? [coordinator] : [];

    const intent: RouteIntent =
      parsed.intent === "discussion" || parsed.intent === "execution" ? parsed.intent : "other";
    const reset = Boolean(parsed.reset);
    const continuation = Boolean(parsed.continuation);
    const reason: RouteDecision["reason"] = continuation
      ? "active_assignee_followup"
      : reset
        ? "topic_shift_default"
        : responders.some((r) => r !== coordinator)
          ? "explicit_mention"
          : "default_step";

    return {
      targetAgentIds: responders,
      reason,
      shouldResetThread: reset,
      intent,
      domain: parsed.domain ?? "none",
      via: "llm",
    };
  } catch {
    // Ollama 불가 → 결정론적 regex 폴백 (Codex 라우터).
    const d = routeTeamMessage(text, agents, context);
    return { ...d, intent: "other", domain: "none", via: "regex_fallback" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HYBRID 라우터 (권장) — 결정론 신호는 regex 로 100% 확실하게, 모호한 도메인만 LLM.
// 이유: 순수 small-LLM(EXAONE 2.4b) 단독은 ~77% + run-to-run 변동(명시멘션·주제전환을
// 가끔 놓침). 명시 @멘션/이름/주제전환 마커는 regex 가 확실하므로 그건 regex 로 고정하고,
// "이름·도메인 불명확" 인 경우에만 LLM 으로 도메인 분류. → 신뢰도↑ + LLM 호출↓(빠름).
//
// ─────────────────────────────────────────────────────────────────────────────

export async function routeTeamMessageHybrid(
  text: string,
  agents: AgentRecord[],
  context: RouterContext = {},
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<LlmRouteDecision> {
  const intent = classifyIntent(text);
  const activeAssigneeIds = validActiveAssignees(context, agents);
  // 인용/예시(코드펜스·"—-" 구분선 아래)의 멘션은 트리거 제외. 라이브 멘션 판정에만 적용.
  const liveText = stripQuotedForRouting(text);


  // 0.5) @all/@b3rys/@group → broadcast all enabled agents. Checked BEFORE explicit_mention.
  if (hasBroadcastAllMarker(text)) {
    return {
      targetAgentIds: broadcastTargets(agents),
      reason: "broadcast_marker",
      shouldResetThread: false,
      intent,
      domain: "broadcast",
      via: "llm",
      outcome: "route",
    };
  }

  // 명시 멘션은 요청 마커·과거참조 필터와 무관하게 우선한다. 필터를 적용하면 실제 직접 호출을 놓칠 수 있다.
  const wakeTargets = detectExplicitTargets(liveText, agents);
  if (wakeTargets.length > 0) {
    // 라우터는 owner만 정한다. 멘션된 전원에게 전달하고 위임·작업 판단은 수신자에게 맡긴다.
    return {
      targetAgentIds: wakeTargets,
      reason: "explicit_mention",
      shouldResetThread: false,
      intent,
      domain: "none",
      via: "llm",
      outcome: "route",
    };
  }

  // 1.5) @멘션 없음 + 답장(reply)이면 → 원문 작성자가 owner. GD 커뮤니케이션 룰:
  //   "@멘션 우선, 답장은 원문자가 응답, 멘션 없으면 sticky" → 답장은 sticky 보다 우선.
  if (context.replyToAgentId && agents.some((a) => a.id === context.replyToAgentId)) {
    return {
      targetAgentIds: [context.replyToAgentId],
      reason: "reply_author",
      shouldResetThread: false,
      intent,
      domain: "none",
      via: "llm",
      outcome: "route",
    };
  }

  // 2) 명시 없음 + 답장 아님 + sticky 유효 → 현재 담당 유지 (결정론). 주제전환 무관, 항상 유지.
  if (activeAssigneeIds.length > 0) {
    return {
      targetAgentIds: activeAssigneeIds,
      reason: "active_assignee_followup",
      shouldResetThread: false,
      intent,
      domain: "none",
      via: "llm",
      outcome: "route",
    };
  }

  // 3) 명시 없음 + sticky 없음 → b3rys 전용 owner inference.
  //    해석되지 않은 @텍스트도 여기서는 일반 텍스트로 취급한다.
  //    담당 범주를 코드 regex 로 고정하지 않고, agents.json 의 role 을 로컬 LLM 프롬프트에 넣어 판단한다.
  //    애매하거나 LLM 실패 시 coordinator capability 보유자가 default owner 로 받는다.
  const intake = await routeDefaultIntakeLLM(text, agents, opts).catch(() => null);
  if (intake?.outcome === "route") return { ...intake, shouldResetThread: false };

  // 명시 멘션·답장·직전 owner가 없으면 담당을 추측하지 않고 팀장에게 묻는다.
  return {
    targetAgentIds: [],
    reason: "ask_gd",
    shouldResetThread: false,
    intent,
    domain: intake?.domain ?? "none",
    via: "llm",
    outcome: "ask_gd",
    suggested: intake?.suggested ?? [],
  };
}

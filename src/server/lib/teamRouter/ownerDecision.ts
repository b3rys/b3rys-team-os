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
import { detectExplicitTargets, stripQuotedForRouting } from "./mention";
import { routeDefaultIntakeLLM } from "./defaultIntake";

// @all/@b3rys/@group — broadcast-all marker. Checked before explicit_mention.
const BROADCAST_MARKER_RE = /@(all|b3rys|group)\b/i;

// Enabled agents for broadcast: reads BUS_DISPATCH_AGENTS env (comma-sep ids).
// Falls back to all agents in roster if unset.
function broadcastTargets(agents: AgentRecord[]): string[] {
  const env = process.env.BUS_DISPATCH_AGENTS;
  if (env) {
    const allowed = new Set(env.split(",").map((s) => s.trim()).filter(Boolean));
    return agents.filter((a) => allowed.has(a.id)).map((a) => a.id);
  }
  return agents.map((a) => a.id);
}

export function routeTeamMessage(
  text: string,
  agents: AgentRecord[],
  context: RouterContext = {},
): RouteDecision {
  const activeAssigneeIds = validActiveAssignees(context, agents);
  // 인용/예시(코드펜스·"—-" 구분선 아래)의 멘션은 트리거 대상에서 제외 (GD 2026-06-25).
  // 라이브 멘션 판정에만 적용 — 원문 text 는 다른 용도 위해 보존.
  const liveText = stripQuotedForRouting(text);
  // 0) @all/@b3rys/@group → broadcast all enabled agents. Checked BEFORE explicit_mention.
  if (BROADCAST_MARKER_RE.test(liveText)) {
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

  // 2026-06-05: topic_shift/closure 자동감지 제거(GD). sticky 는 명시적 @멘션/답장으로
  // owner 가 바뀌기 전엔 항상 유지된다 — 자동 주제전환 추정으로 owner 를 버리지 않는다.
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

// ─────────────────────────────────────────────────────────────────────────────
// LLM router (EXAONE via Ollama) — PRIMARY engine per GD's "all-LLM, no regex"
// decision (2026-05-23). The regex routeTeamMessage above is kept as a fast,
// deterministic FALLBACK (used when Ollama is unavailable) + its tests document
// the expected behavior. The LLM engine additionally classifies discussion vs
// execution intent (논의=multi / 구현=single owner) — GD pattern.
// ─────────────────────────────────────────────────────────────────────────────

// NOTE (2026-06-20): routerSystemPrompt 는 데이터화(routing_domains) 시도했으나 EXAONE(2.4b, temp=0)이
// 프롬프트 텍스트/순서/예시에 민감해 기존 green 테스트 3개(explicit name·finance·sticky)를 깨뜨려 behavior
// 보존 실패 → 원문 유지. routeTeamMessageLLM 는 라이브 미연결(standalone) 함수라 영향 범위도 작다. 이 프롬프트
// 속 실명은 public export pipeline 의 ownerDecision 치환 + SKIN 단계가 처리. (LIVE 경로인 defaultIntakePrompt 는
// coordinator 기반으로 데이터화 완료 — 동작 보존 확인.)
function routerSystemPrompt(agents: AgentRecord[]): string {
  const coord = coordinatorId(agents) ?? "코디네이터"; // 기본 조율 담당 = capability 기반(agents.json), 특정 이름 하드코딩 금지(GD 2026-07-02)
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
 * standalone — 아직 라이브 메시지 흐름에 연결 안 됨 (GD 리뷰 후 통합).
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
// (GD 의 "all-LLM" 결정과의 트레이드오프: 신뢰도 위해 명확신호는 결정론. GD 리뷰 후 택1.)
// ─────────────────────────────────────────────────────────────────────────────

export async function routeTeamMessageHybrid(
  text: string,
  agents: AgentRecord[],
  context: RouterContext = {},
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<LlmRouteDecision> {
  const intent = classifyIntent(text);
  const activeAssigneeIds = validActiveAssignees(context, agents);
  // 인용/예시(코드펜스·"—-" 구분선 아래)의 멘션은 트리거 제외 (GD 2026-06-25). 라이브 멘션 판정에만 적용.
  const liveText = stripQuotedForRouting(text);

  // 2026-06-05: topic_shift/closure 자동감지 제거(GD). owner 는 @멘션 > 답장 > sticky > 기본
  // 으로만 결정한다. 종료·주제전환을 자동 추정해 owner 를 비우거나 codex 로 넘기지 않는다.

  // 0.5) @all/@b3rys/@group → broadcast all enabled agents. Checked BEFORE explicit_mention.
  if (BROADCAST_MARKER_RE.test(liveText)) {
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

  // 1) 명시 @멘션 — @멘션은 어떤 상황에서도 우선 (GD 2026-05-25). detectExplicitTargets 는
  // 순수 @멘션/@별칭만 잡고(과거참조 tail drop·REQUEST_MARKER 필터 없음) 무조건 깨운다.
  // 직접 호출 "@데미스 @스티브 이거 보여. 어제 모했어" 가 tail 의 '어제'(과거참조)+요청마커 부재로
  // detectAddressedNamesLoose/filterLiveWakeTargets 에서 둘 다 누락되던 버그 fix.
  // (bare 이름(@ 없음)은 detectExplicitTargets 가 안 잡으므로 over-summon 은 여전히 방지됨.)
  const wakeTargets = detectExplicitTargets(liveText, agents);
  if (wakeTargets.length > 0) {
    // 2026-06-05 (GD): @멘션은 컴 룰의 최상위. 잡힌 전원에게 라우팅하고 끝낸다.
    // 위임/중계/보고/작업 판단은 멘션 받은 에이전트(LLM)가 내용을 읽고 한다 — 라우터는 'owner 가 누구냐'만.
    // (이전 analyzeDelegation 좁히기는 "@빌 @코덱스 각자 일"을 위임으로 오판하는 등 버그만 양산해 제거.)
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

  // 4) (GD 룰 2026-06-05) 오너가 애매하면(멘션·답장·sticky 모두 없음) codex 로 자동 배정하지 않는다.
  //    룰 = @멘션 > 답장 > sticky > **오너 애매하면 GD 문의**. → ask_gd(아무도 안 깨움 + GD 에게 누가 볼지 질문).
  //    이전엔 하드코딩 default_step 으로 보내, 재시작으로 sticky 가 비면 특정 agent 가 엉뚱한 메시지를 잡던 문제 fix.
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

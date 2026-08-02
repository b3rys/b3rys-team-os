import type { AgentRecord } from "../../types";

export interface RouterContext {
  activeAssigneeId?: string | null;
  activeAssigneeIds?: string[] | null;
  activeThreadId?: string | null;
  /** 답장(reply) 원문 작성자의 agent id. @멘션 없을 때 이 사람이 owner (sticky 보다 우선). */
  replyToAgentId?: string | null;
}

export interface RouteDecision {
  targetAgentIds: string[];
  reason:
    | "explicit_mention"
    | "reply_author"
    | "active_assignee_followup"
    | "topic_shift_default"
    | "default_intake"
    | "default_step"
    | "ask_gd"
    | "broadcast_marker";
  shouldResetThread: boolean;
}

// (removed) DEFAULT_STEP_AGENT_ID = "codex" — default_step owner 는 이제 coordinator capability 로
// 결정한다. lib/capabilities.ts 의 coordinatorId(agents) 사용. 정본 = agents.json.

/**
 * 라우터 판정용 LLM 엔드포인트 — ★OpenAI 호환 /v1/chat/completions★.
 *
 * 예전엔 Ollama 네이티브 `/api/chat` 이었다(`TEAM_ROUTER_OLLAMA_URL`). 로컬 LLM 을 vLLM 으로 옮기면서
 * 바꿨다 — vLLM 은 OpenAI 호환 API 만 제공하고 `/api/chat` 이 없다. Ollama 도 OpenAI 호환 경로
 * (`/v1/chat/completions`)를 제공하므로 이 클라이언트 하나로 양쪽을 다 붙일 수 있다.
 *
 * ★env 키 이름도 바꿨다★ — 값(경로)이 어차피 달라져야 해서, 옛 키를 그대로 두면 "설정은 있는데
 * 경로가 틀린" 상태로 조용히 폴백만 계속된다. 키를 바꾸면 미설정으로 잡혀 기본값이 쓰인다.
 */
export const ROUTER_LLM_URL =
  process.env.TEAM_ROUTER_LLM_URL ?? "http://127.0.0.1:8000/v1/chat/completions";
export const ROUTER_MODEL = process.env.TEAM_ROUTER_MODEL ?? "Qwen3-Next-80B-A3B";

/**
 * 라우터 LLM 에 JSON 응답을 요청하고 파싱해 돌려준다.
 *
 * ★와이어 포맷을 아는 곳은 여기 하나다.★ 예전엔 defaultIntake 와 ownerDecision 이 같은 요청을 각자
 * 만들어 두 벌이었다 — 한쪽만 고치면 같은 질문에 답이 둘이 된다.
 *
 * 실패(네트워크·비 2xx·JSON 파싱 실패·타임아웃)는 전부 throw 한다. 폴백 판단은 호출부의 몫이다.
 */
export async function callRouterLlmJson(
  systemPrompt: string,
  userContent: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetch(ROUTER_LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: opts.model ?? ROUTER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        stream: false,
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`router llm ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export type RouteIntent = "discussion" | "execution" | "other";

export interface LlmRouteDecision extends RouteDecision {
  intent: RouteIntent;
  domain: string;
  via: "llm" | "regex_fallback";
  /**
   * 여러 단계(fan-out + 보고 회수) 위임이면 true. GD 지침(2026-05-24): 자동 실행하지 말고
   * 수신 에이전트가 GD 에게 계획을 재확인(컨펌)한 뒤 진행. 라우터는 신호만 올린다.
   */
  needsGdConfirm?: boolean;
  /**
   * 결정 종류 (GD 설계 2026-05-24):
   * - route: 정상 라우팅 (targetAgentIds 로 보냄)
   * - closure: 종료/그만 신호 → 아무도 안 깸 + sticky 해제 (targetAgentIds=[])
   * - ask_gd: 담당 애매 → GD 에게 "누가 볼까요?" 질문. suggested 는 LLM/키워드 추천 후보(결정 아님).
   * (routeTeamMessageLLM 순수 경로는 항상 route 의미라 생략 가능 — hybrid 는 항상 명시.)
   */
  outcome?: "route" | "closure" | "ask_gd";
  /** ask_gd 일 때 LLM/키워드가 제안하는 후보 (GD 가 확정/변경). 결정이 아니라 추천. */
  suggested?: string[];
}

export function buildRosterText(agents: AgentRecord[]): string {
  return agents
    .map((a) => {
      const aliases = a.nicknames?.length ? `; aliases=${a.nicknames.join(",")}` : "";
      const response = a.response_mode ? `; response_mode=${a.response_mode}` : "";
      return `- ${a.id} (${a.display_name}): ${a.role}${response}${aliases}`;
    })
    .join("\n");
}

// intent classification — shared by ownerDecision(hybrid), defaultIntake, legacy(isClosure).
const DISCUSSION_MARKERS = /(어때|어떻게 생각|생각은|의견|논의|괜찮을까|맞을까|좋을까|\?\s*$)/;
const EXECUTION_MARKERS = /(만들|고쳐|구현|배포|세팅|설정해|추가해|수정해|만들어)/;

export function classifyIntent(text: string): RouteIntent {
  if (EXECUTION_MARKERS.test(text)) return "execution";
  if (DISCUSSION_MARKERS.test(text)) return "discussion";
  return "other";
}

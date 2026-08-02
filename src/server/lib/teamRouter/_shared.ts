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
 * ★env 키 이름도 둘 다 바꿨다★ — 값(경로·모델명)이 어차피 달라져야 해서, 옛 키를 그대로 두면
 * "설정은 있는데 값이 틀린" 상태로 조용히 폴백만 계속된다. 키를 바꾸면 미설정으로 잡혀 기본값이 쓰인다.
 * ★URL 만 바꾸고 MODEL 을 두면 최악이다★ — 새 엔드포인트에 옛 Ollama 태그(`name:tag`)를 보내
 * 404 가 나고, 그게 조용한 폴백으로 묻힌다. 둘은 같이 움직여야 한다.
 */
export const ROUTER_LLM_URL =
  process.env.TEAM_ROUTER_LLM_URL ?? "http://127.0.0.1:8000/v1/chat/completions";
export const ROUTER_MODEL = process.env.TEAM_ROUTER_LLM_MODEL ?? "Qwen3-Next-80B-A3B";
/** 있으면 Bearer 로 붙인다(OpenAI·`--api-key` 로 띄운 vLLM). 로컬 키-불요 서버면 미설정. */
const ROUTER_LLM_API_KEY = process.env.TEAM_ROUTER_LLM_API_KEY ?? "";

/**
 * owner-inference 호출 상한(ms).
 *
 * ★owner-gate 훅의 예산보다 반드시 작아야 한다.★ `hooks/telegram-owner-gate.py` 는 서버 응답을
 * 3초까지만 기다리고, 넘으면 fail-open 해서 아무도 억제하지 않는다(= 전원이 답한다). 서버가 훅보다
 * 오래 기다리면 훅은 답을 못 받고, 우리가 어떤 판정을 냈든 무의미해진다.
 * 2.5초면 훅이 포기하기 전에 반드시 답을 받는다 — 늦으면 폴백 판정이라도 제때 준다.
 * 실측(DGX vLLM, Qwen3-Next-80B): 1.5~2.2초. 이 값을 올리려면 훅 쪽 timeout 도 같이 올려야 한다.
 */
const ROUTER_LLM_TIMEOUT_MS = 2_500;

/**
 * 라우터 LLM 에 JSON 응답을 요청하고 파싱해 돌려준다.
 *
 * ★와이어 포맷을 아는 곳은 여기 하나다.★ 예전엔 defaultIntake 와 ownerDecision 이 같은 요청을 각자
 * 만들어 두 벌이었다 — 한쪽만 고치면 같은 질문에 답이 둘이 된다.
 *
 * 실패(네트워크·비 2xx·빈 응답·JSON 파싱 실패·타임아웃)는 전부 throw 한다. 폴백 판단은 호출부의 몫이다.
 *
 * ★빈 응답을 {} 로 삼키지 않는다.★ 삼키면 아무것도 못 받았는데 via:"llm" 으로 기록돼 "LLM 이 판정했다"
 * 는 거짓 신호가 남는다. 특히 reasoning 계열 모델은 `content:null` + `reasoning_content` 를 낸다 —
 * 그게 성공으로 보이면 안 된다. (runtimes/b3osNative/runner.ts 의 openai_compat_empty_response 와 같은 규칙.)
 */
export async function callRouterLlmJson(
  systemPrompt: string,
  userContent: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? ROUTER_LLM_TIMEOUT_MS);
  try {
    const res = await fetch(ROUTER_LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ROUTER_LLM_API_KEY ? { Authorization: `Bearer ${ROUTER_LLM_API_KEY}` } : {}),
      },
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
    if (!res.ok) {
      // ★본문을 버리지 않는다★ — vLLM 은 "model does not exist" 같은 진단을 본문에 담는다.
      //   모델명 오설정이 가장 흔한 실패인데, 상태코드만 남기면 그걸 영영 못 본다.
      const detail = await res.text().catch(() => "");
      throw new Error(`router llm ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("router llm empty response");
    }
    return JSON.parse(content) as Record<string, unknown>;
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

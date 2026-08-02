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
    /** 멘션·답장·sticky 가 모두 없어 coordinator 가 기본으로 받음 (결정론, LLM 안 거침). */
    | "default_coordinator"
    | "ask_gd"
    | "broadcast_marker";
  shouldResetThread: boolean;
}

// (removed) DEFAULT_STEP_AGENT_ID = "codex" — default_step owner 는 이제 coordinator capability 로
// 결정한다. lib/capabilities.ts 의 coordinatorId(agents) 사용. 정본 = agents.json.

/**
 * GD 확인이 필요한 위험 신호 — 토큰·삭제·배포·재시작·비용·외부발신 등.
 * 이 플래그(needsGdConfirm)는 받는 agent 가 "바로 실행하지 말고 GD 께 먼저 확인" 하라는 신호다.
 * owner-inference 안에만 있었는데, 결정론 라우팅(default_coordinator)에서도 똑같이 필요해서 여기로 옮겼다.
 */
export const GD_CONFIRM_RE =
  /(삭제|지워|제거|revoke|폐기|토큰|token|credential|시크릿|secret|보안|security|권한|permission|결제|비용|paid|외부\s*(공개|발신|전송)|public|배포|deploy|재시작|restart|launchctl|마이그레이션|migration|DB|데이터베이스|database)/i;

export const OLLAMA_URL = process.env.TEAM_ROUTER_OLLAMA_URL ?? "http://127.0.0.1:11434/api/chat";
export const ROUTER_MODEL = process.env.TEAM_ROUTER_MODEL ?? "exaone3.5:2.4b";

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

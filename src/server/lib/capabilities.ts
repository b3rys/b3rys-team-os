import type { AgentRecord } from "../types";

/**
 * Capability registry helpers (b3os 퍼블릭화 — behavior-preserving capability model).
 *
 * 코드에서 하드코딩된 agent-id 비교(`agent.id === "codex"`/`"bill"`)를 없애고,
 * agents.json 의 `capabilities: string[]` 플래그 조회로 대체한다.
 * public 코드 == live 코드(데이터만 다름) → 자유 양방향 머지.
 *
 * 정의된 capability (의미 = 코드 동작):
 * - coordinator        : default_step owner(미배정/모호 메시지 기본 담당 — sync fallback·PM 조율)
 * - ambiguous_owner    : 오너가 애매/무-확신일 때 owner-inference(defaultIntake)가 보내는 담당.
 *                        = "누가 볼지 애매하면 이 사람이 받아서 GD 께 문의한다"(GD 2026-07-10 결정: 코덱스가 아니라 빌).
 *                        미설정 시 coordinator 로 폴백(기존 동작 보존). coordinator(PM/조율)와 분리 가능.
 * - restricted_mention : bare alias 무시, 명시 @멘션에만 응답
 * - native_routing     : openclaw 네이티브 self-poll 경로
 * - full_context       : 팀 전체 컨텍스트 수신
 * - recovery           : stop_all 제외 + 맨 마지막 재시작(복구 코디)
 * - non_interactive    : cron 비대화(persona 재생성 등 스킵)
 * - learning_loop_pm   : 주간 learning-loop PM 및 금요일 10:00 보고 주체
 */
export function hasCapability(agent: AgentRecord, cap: string): boolean {
  return Array.isArray(agent.capabilities) && agent.capabilities.includes(cap);
}

export function agentsWith(agents: AgentRecord[], cap: string): AgentRecord[] {
  return agents.filter((a) => hasCapability(a, cap));
}

// warn 스팸 방지(coordinatorId 는 메시지마다 호출됨) — 같은 경고 메시지는 프로세스당 1회만.
const _warned = new Set<string>();
function warnOnce(msg: string): void {
  if (_warned.has(msg)) return;
  _warned.add(msg);
  console.warn(msg);
}

/**
 * coordinator capability 를 가진 agent 의 id (= default_step owner. 이전 DEFAULT_STEP_AGENT_ID="codex").
 *
 * 안전망(스티브+하네스 리뷰 2026-06-20): coordinator 가 0개면 라우팅 fallback 들이 [] 를 반환해 메시지가
 * 어디에도 안 가고 silent-drop 되던 구멍이 있었다(하드코딩 "codex" 시절엔 없던 구멍 — 공개 사용자가
 * agents.json 편집 중 coordinator 누락/오타 시 라우팅 death). 그래서:
 *  - 정확히 1개  → 그 id (happy-path, 기존과 100% 동일).
 *  - 2개 이상    → 첫 매치 + warnOnce(구성 경고).
 *  - 0개         → 첫 에이전트로 fallback + warnOnce(절대 drop 하지 않음). 에이전트도 없으면 undefined.
 */
export function coordinatorId(agents: AgentRecord[]): string | undefined {
  const [first, ...rest] = agentsWith(agents, "coordinator");
  if (first && rest.length === 0) return first.id; // 정확히 1개 — 기존 동작 보존
  if (first) {
    warnOnce(
      `[capabilities] 여러 agent 가 'coordinator' capability 를 가짐(${[first, ...rest]
        .map((a) => a.id)
        .join(", ")}) — 첫 매치 사용: ${first.id}. agents.json 에서 coordinator 는 1명만 두세요.`,
    );
    return first.id;
  }
  // 0개 — silent-drop 방지용 안전 fallback.
  const fallback = agents[0]?.id;
  warnOnce(
    `[capabilities] 'coordinator' capability 를 가진 agent 가 없음 — 라우팅 fallback=${
      fallback ?? "(none)"
    }. agents.json 의 한 agent 에 "coordinator" 를 추가하세요(미설정 시 메시지가 첫 에이전트로 감).`,
  );
  return fallback;
}

/**
 * ambiguous_owner capability 를 가진 agent 의 id (= 오너가 애매/무-확신일 때 owner-inference 가 보내는 담당).
 *
 * GD 2026-07-10 결정: "오너 애매한 메시지는 코덱스(coordinator)가 받지 말고 빌이 받아서 GD 께 문의(ask gd)한다."
 * → 애매 라우팅 대상을 coordinator(PM/조율)와 분리한다. defaultIntake(라이브 owner-inference LLM 경로)의
 *    default/fallback 담당자로 쓰인다.
 *
 * 폴백 규칙(behavior-preserving): ambiguous_owner 를 가진 agent 가 없으면 coordinatorId 로 폴백한다
 *  — 공개 seed 등 이 capability 미지정 레지스트리는 기존(coordinator 로 감) 동작 그대로.
 *  - 정확히 1개  → 그 id.
 *  - 2개 이상    → 첫 매치 + warnOnce.
 *  - 0개         → coordinatorId(agents) 폴백.
 */
export function ambiguousOwnerId(agents: AgentRecord[]): string | undefined {
  const [first, ...rest] = agentsWith(agents, "ambiguous_owner");
  if (first && rest.length === 0) return first.id;
  if (first) {
    warnOnce(
      `[capabilities] 여러 agent 가 'ambiguous_owner' capability 를 가짐(${[first, ...rest]
        .map((a) => a.id)
        .join(", ")}) — 첫 매치 사용: ${first.id}. agents.json 에서 ambiguous_owner 는 1명만 두세요.`,
    );
    return first.id;
  }
  // 미설정 — coordinator 로 폴백(기존 동작 보존).
  return coordinatorId(agents);
}

/**
 * learning-loop PM capability 를 가진 agent 의 id.
 *
 * public/default seed 처럼 별도 PM 라벨이 없으면 coordinator 로 fallback 한다.
 * live registry 는 특정 팀원이 이 capability 를 가질 수 있고, 코드·스킬은 이름이 아니라 이 helper 를 기준으로 삼는다.
 */
export function learningLoopPmId(agents: AgentRecord[]): string | undefined {
  const [first, ...rest] = agentsWith(agents, "learning_loop_pm");
  if (first && rest.length === 0) return first.id;
  if (first) {
    warnOnce(
      `[capabilities] 여러 agent 가 'learning_loop_pm' capability 를 가짐(${[first, ...rest]
        .map((a) => a.id)
        .join(", ")}) — 첫 매치 사용: ${first.id}. agents.json 에서 learning_loop_pm 은 1명만 두세요.`,
    );
    return first.id;
  }
  return coordinatorId(agents);
}

/**
 * load-time 검증(registry sync 시 호출). coordinator capability 가 정확히 1개인지 확인하고
 * 결과를 반환한다(순수 — side-effect 없음). registry 가 이 결과로 warn + audit 한다.
 */
export interface CoordinatorCheck {
  ok: boolean;
  count: number;
  coordinatorIds: string[];
  /** ok=false 일 때의 사람용 메시지(0개=fallback_no_coordinator / 2+=multiple). */
  issue?: "none" | "multiple";
}
export function validateCoordinators(agents: AgentRecord[]): CoordinatorCheck {
  const ids = agentsWith(agents, "coordinator").map((a) => a.id);
  if (ids.length === 1) return { ok: true, count: 1, coordinatorIds: ids };
  return { ok: false, count: ids.length, coordinatorIds: ids, issue: ids.length === 0 ? "none" : "multiple" };
}

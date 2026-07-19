import { hasCapability } from "./capabilities";
import { ambientAgents } from "./registry";

/**
 * full_context capability 를 가진 팀원만 팀 전체 컨텍스트를 받는다.
 * (이전 하드코딩 Set(["bill","codex"]) 대체 — 정본 = agents.json capabilities.)
 * 공개 시그니처(string id)는 보존: 호출부(telegramCapture·wakeDispatcher)와 기존 테스트가 id 로 호출한다.
 */
export function canReceiveFullTeamContext(agentId: string): boolean {
  const agent = ambientAgents().find((a) => a.id === agentId);
  return agent ? hasCapability(agent, "full_context") : false;
}

export function teamContextForAgent(agentId: string, teamContext: string): string {
  return canReceiveFullTeamContext(agentId) ? teamContext : "";
}

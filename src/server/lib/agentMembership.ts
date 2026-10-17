import type { AgentRecord } from "../types";

export function isTeamOfficialMember(agent: Pick<AgentRecord, "team_official_member" | "lead_eligible"> | undefined): boolean {
  if (!agent) return true;
  if (agent.team_official_member === false) return false;
  return agent.lead_eligible !== false;
}

export const MAX_OFFICIAL_TEAM_MEMBERS = 15;

// 전체 호출과 팀원 broadcast가 같은 명부를 따라야 대상이 갈리지 않는다. 플래그가 없으면 포함하고 excludeId로 발신자만 제외한다.
export function broadcastRecipientIds(
  agents: Array<Pick<AgentRecord, "id" | "enabled" | "team_official_member" | "lead_eligible">>,
  excludeId?: string,
): string[] {
  return agents
    .filter((agent) => agent.enabled !== false && isTeamOfficialMember(agent))
    .map((agent) => agent.id)
    .filter((id) => id !== excludeId);
}

export function activeOfficialMemberCount(
  agents: Array<Pick<AgentRecord, "id" | "team_official_member" | "lead_eligible">>,
  isOff: (id: string) => boolean,
): number {
  return agents.filter((agent) => isTeamOfficialMember(agent) && !isOff(agent.id)).length;
}

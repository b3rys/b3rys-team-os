import type { AgentRecord } from "../types";

export function isTeamOfficialMember(agent: Pick<AgentRecord, "team_official_member" | "lead_eligible"> | undefined): boolean {
  if (!agent) return true;
  if (agent.team_official_member === false) return false;
  return agent.lead_eligible !== false;
}

export const MAX_OFFICIAL_TEAM_MEMBERS = 15;

export function activeOfficialMemberCount(
  agents: Array<Pick<AgentRecord, "id" | "team_official_member" | "lead_eligible">>,
  isOff: (id: string) => boolean,
): number {
  return agents.filter((agent) => isTeamOfficialMember(agent) && !isOff(agent.id)).length;
}

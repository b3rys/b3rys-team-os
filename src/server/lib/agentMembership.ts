import type { AgentRecord } from "../types";

export function isTeamOfficialMember(agent: Pick<AgentRecord, "team_official_member" | "lead_eligible"> | undefined): boolean {
  if (!agent) return true;
  if (agent.team_official_member === false) return false;
  return agent.lead_eligible !== false;
}

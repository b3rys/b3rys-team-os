import type { AgentRecord } from "../types";

export function isTeamOfficialMember(agent: Pick<AgentRecord, "team_official_member" | "lead_eligible"> | undefined): boolean {
  if (!agent) return true;
  if (agent.team_official_member === false) return false;
  return agent.lead_eligible !== false;
}

export const MAX_OFFICIAL_TEAM_MEMBERS = 15;

/**
 * ★broadcast(@all·팀원 방 발언)를 받는 사람 — 규칙은 여기 하나뿐이다.★
 *
 * 같은 질문("누가 받나")을 두 곳이 따로 계산하면 값이 갈린다. 실측: @all 은 9명인데
 * 팀원 broadcast 는 11명이었다 — 한쪽만 고쳐서 생긴 차이다.
 *
 * 판정은 `isTeamOfficialMember` 하나에 맡긴다. 그 함수는 플래그가 **없으면 포함**으로 보므로
 * 아무도 플래그를 안 쓰는 명부(공개 설치)에서 자연히 전원이 된다 — 빈 배열이 되어
 * broadcast 가 아무에게도 안 가는 고장을 따로 막을 필요가 없다.
 *
 * `excludeId` 는 발신자를 뺄 때 쓴다(자기 글은 자기 inbox 에 넣지 않는다).
 *
 * ★"어떤 종류의 발송인가" 는 부르는 쪽이 판단한다★ — 이 함수는 "그 발송을 받을 자격이 있는
 * 팀원" 만 답한다. 팀원 종류가 늘어나면 여기 조건을 늘린다.
 */
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

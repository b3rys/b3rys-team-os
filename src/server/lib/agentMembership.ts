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
 * `kind` 는 ★발송 종류★ 다. 지금은 `all_hands`(=@all) 하나가 명부 전체를 부르고, 나머지는
 * 멘션된 사람만 받는다. 팀원 종류가 늘어나도 ★이 함수 하나만 고치면 되도록★ 자리를 둔다
 * (GD 2026-08-01: "팀원의 종류도 늘어날 수 있어").
 */
export type BroadcastKind = "all_hands" | "mentioned";

export function broadcastRecipientIds(
  agents: Array<Pick<AgentRecord, "id" | "enabled" | "team_official_member" | "lead_eligible">>,
  excludeId?: string,
  kind: BroadcastKind = "all_hands",
  mentioned: readonly string[] = [],
): string[] {
  const active = agents.filter((agent) => agent.enabled !== false && isTeamOfficialMember(agent));
  const pool = kind === "all_hands" ? active : active.filter((agent) => mentioned.includes(agent.id));
  return pool.map((agent) => agent.id).filter((id) => id !== excludeId);
}

export function activeOfficialMemberCount(
  agents: Array<Pick<AgentRecord, "id" | "team_official_member" | "lead_eligible">>,
  isOff: (id: string) => boolean,
): number {
  return agents.filter((agent) => isTeamOfficialMember(agent) && !isOff(agent.id)).length;
}

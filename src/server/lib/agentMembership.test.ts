import { describe, expect, test } from "bun:test";
import { activeOfficialMemberCount, broadcastRecipientIds, MAX_OFFICIAL_TEAM_MEMBERS } from "./agentMembership";

describe("official team member limit", () => {
  test("비공식·lead 비대상·정지 팀원은 활성 공식 팀원 수에서 제외한다", () => {
    const agents = [
      { id: "active", team_official_member: true, lead_eligible: true },
      { id: "off", team_official_member: true, lead_eligible: true },
      { id: "observer", team_official_member: false, lead_eligible: false },
      { id: "legacy-nonlead", team_official_member: true, lead_eligible: false },
    ];
    expect(activeOfficialMemberCount(agents, (id) => id === "off")).toBe(1);
    expect(MAX_OFFICIAL_TEAM_MEMBERS).toBe(15);
  });
});

describe("broadcast 수신자 규칙", () => {
  // 기대값을 손으로 적지 않는다. 명부의 플래그에서 다시 계산해 두 집합을 비교한다.
  // 이름·숫자를 박으면 팀원이 늘거나 플래그가 바뀔 때 시험이 조용히 낡는다.
  const expected = (agents: Array<{ id: string; enabled?: boolean; team_official_member?: boolean; lead_eligible?: boolean }>, from?: string) =>
    agents
      .filter((a) => a.enabled !== false && a.team_official_member !== false && a.lead_eligible !== false)
      .map((a) => a.id)
      .filter((id) => id !== from);

  test("정지·비정식 팀원은 빠지고 나머지는 그대로 받는다", () => {
    const agents = [
      { id: "a", team_official_member: true },
      { id: "b", team_official_member: true },
      { id: "observer", team_official_member: false },
      { id: "paused", team_official_member: true, enabled: false },
      { id: "nonlead", team_official_member: true, lead_eligible: false },
    ];
    expect(broadcastRecipientIds(agents).sort()).toEqual(expected(agents).sort());
  });

  test("발신자는 자기 글을 안 받는다", () => {
    const agents = [
      { id: "sender", team_official_member: true },
      { id: "other", team_official_member: true },
    ];
    expect(broadcastRecipientIds(agents, "sender")).toEqual(expected(agents, "sender"));
    expect(broadcastRecipientIds(agents, "sender")).not.toContain("sender");
  });

  test("★플래그를 아무도 안 쓰는 명부(공개 설치)에서 수신자가 0명이 되지 않는다★", () => {
    // 이게 깨지면 공개 설치에서 broadcast 가 아무에게도 안 간다 — 원래 결함보다 나쁘다.
    const flagless = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(broadcastRecipientIds(flagless)).toEqual(["a", "b", "c"]);
    expect(broadcastRecipientIds(flagless, "a")).toEqual(["b", "c"]);
  });

  test("빈 명부는 빈 결과 — 던지지 않는다", () => {
    expect(broadcastRecipientIds([])).toEqual([]);
  });
});

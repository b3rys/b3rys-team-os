import { describe, expect, test } from "bun:test";
import { activeOfficialMemberCount, MAX_OFFICIAL_TEAM_MEMBERS } from "./agentMembership";

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

import { describe, expect, test } from "bun:test";
import { canReceiveFullTeamContext, teamContextForAgent } from "./teamContextPolicy";
import { ambientAgents } from "./registry";

describe("teamContextPolicy", () => {
  // full_context 는 ★agents.json 의 capabilities 가 정본★ (GD 2026-07-12: "full context 는
  //   agents.json 설정을 따라야 함. bill, codex 로 박혀있으면 고쳐야 됨").
  //   코드(canReceiveFullTeamContext)는 이미 capabilities 를 읽는데 이 테스트만 멤버 이름을
  //   하드코딩해서, 운영이 agents.json 에서 멤버를 추가/제거하면 ★코드가 아니라 테스트가★ 깨졌다
  //   (실제로 steve 에 full_context 부여 시 실패). → 이름 고정 대신 agents.json 을 정본으로 검증.
  test("full_context 는 agents.json capabilities 를 따른다 (멤버 이름 하드코딩 금지)", () => {
    const agents = ambientAgents();
    expect(agents.length).toBeGreaterThan(0); // 로딩 실패 시 전원 false 라 헛통과하는 것 방지

    for (const a of agents) {
      const expected = (a.capabilities ?? []).includes("full_context");
      expect(canReceiveFullTeamContext(a.id)).toBe(expected);
    }

    // capability 없는(=미등록) id 는 항상 false
    expect(canReceiveFullTeamContext("__no_such_agent__")).toBe(false);
    expect(canReceiveFullTeamContext("")).toBe(false);
  });

  test("redacts team context for specialist agents", () => {
    const context = "[bill] internal coordination\n[codex] implementation notes";
    expect(teamContextForAgent("codex", context)).toBe(context);
    expect(teamContextForAgent("bill", context)).toBe(context);
    expect(teamContextForAgent("hermes", context)).toBe("");
  });
});

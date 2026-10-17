// 실 명부는 머신마다 다르고 clone에 없을 수 있어 픽스처를 주입한다. full_context는 ID가 아니라 capabilities를 따라야 한다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ambientAgents } from "./registry";
import { canReceiveFullTeamContext, teamContextForAgent } from "./teamContextPolicy";

// 픽스처 로스터 — 실제 팀원 이름을 쓰지 않는다(이름 하드코딩 금지 규칙을 이 파일 스스로 지킨다).
const FIXTURE = [
  { id: "fixture-full-a", display_name: "Fixture Full A", role: "coordinator", capabilities: ["full_context", "coordinator"] },
  { id: "fixture-full-b", display_name: "Fixture Full B", role: "developer", capabilities: ["full_context"] },
  { id: "fixture-specialist", display_name: "Fixture Specialist", role: "specialist", capabilities: ["research"] },
  { id: "fixture-nocaps", display_name: "Fixture NoCaps", role: "specialist", capabilities: [] },
];

let dir: string;
const prevRegistry = process.env.TEAM_AGENT_REGISTRY;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "b3os-ctxpolicy-"));
  const path = join(dir, "agents.json");
  writeFileSync(path, JSON.stringify(FIXTURE), "utf-8");
  process.env.TEAM_AGENT_REGISTRY = path;
});

afterAll(() => {
  if (prevRegistry === undefined) delete process.env.TEAM_AGENT_REGISTRY;
  else process.env.TEAM_AGENT_REGISTRY = prevRegistry;
  rmSync(dir, { recursive: true, force: true });
});

describe("teamContextPolicy", () => {
  test("주입한 로스터가 실제로 읽힌다 (로딩 실패 시 전원 false 라 헛통과하는 것 방지)", () => {
    const agents = ambientAgents();
    expect(agents.length).toBe(FIXTURE.length);
    expect(agents.map((a) => a.id).sort()).toEqual(FIXTURE.map((a) => a.id).sort());
  });

  test("full_context 는 로스터의 capabilities 를 따른다 (멤버 이름 하드코딩 금지)", () => {
    for (const a of ambientAgents()) {
      const expected = (a.capabilities ?? []).includes("full_context");
      expect(canReceiveFullTeamContext(a.id)).toBe(expected);
    }
    // 픽스처가 양쪽 경우를 모두 담아야 위 루프가 의미를 갖는다(전원 false 헛통과 방지).
    expect(FIXTURE.some((a) => a.capabilities.includes("full_context"))).toBe(true);
    expect(FIXTURE.some((a) => !a.capabilities.includes("full_context"))).toBe(true);

    // capability 없는(=미등록) id 는 항상 false
    expect(canReceiveFullTeamContext("__no_such_agent__")).toBe(false);
    expect(canReceiveFullTeamContext("")).toBe(false);
  });

  test("full_context 없는 팀원에게는 팀 컨텍스트를 가린다", () => {
    const context = "[fixture-full-a] internal coordination\n[fixture-specialist] implementation notes";
    // 가진 쪽 = 그대로
    expect(teamContextForAgent("fixture-full-a", context)).toBe(context);
    expect(teamContextForAgent("fixture-full-b", context)).toBe(context);
    // 없는 쪽 = 빈 문자열
    expect(teamContextForAgent("fixture-specialist", context)).toBe("");
    expect(teamContextForAgent("fixture-nocaps", context)).toBe("");
    // 미등록 id 도 가린다
    expect(teamContextForAgent("__no_such_agent__", context)).toBe("");
  });
});

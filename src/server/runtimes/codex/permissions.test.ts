import { test, expect, describe } from "bun:test";
import { codexRuntimePreflight, codexConfiguredGrants } from "./permissions";

// 2026-07-05: GD 테스트에서 workspace-write Dex가 "덱스 있어?"조차 preflight tier-a "ask"로 매 턴 차단(dead-end)
// → 구조적 실행불가. fix = 관리자 설정(agents.json)을 grant로 seed(launch 경계). 이 라운드트립을 락인한다.
describe("codexConfiguredGrants ↔ codexRuntimePreflight round-trip", () => {
  const agent = { id: "dex", workspace_path: "/Users/x/Development/your-workspace" };

  test("seeded 설정-grant 가 workspace-write + network preflight 를 통과시킨다", () => {
    const grants = codexConfiguredGrants("dex", "workspace-write", true, agent.workspace_path);
    const r = codexRuntimePreflight(agent, "workspace-write", true, {
      workspaceRoot: agent.workspace_path,
      grants,
    });
    expect(r).toBeNull(); // null = 차단 없음(실행 허용)
  });

  test("grant 미주입 시 workspace-write 는 여전히 차단(preflight 원형 유지)", () => {
    const r = codexRuntimePreflight(agent, "workspace-write", true, {
      workspaceRoot: agent.workspace_path,
    });
    expect(r).not.toBeNull();
    expect(r?.tier).toBe("ask");
    expect(r?.rule).toBe("tier-a.workspace-write");
  });

  test("★Tier-D 불변★: danger-full-access 는 설정-grant 로도 통과 못 한다(hardDeny 우선)", () => {
    // codexConfiguredGrants 는 danger-full-access 에 grant 를 부여하지 않으며, 부여해도 hardDeny 가 먼저 deny.
    const grants = codexConfiguredGrants("dex", "danger-full-access", true, agent.workspace_path);
    const r = codexRuntimePreflight(agent, "danger-full-access", true, {
      workspaceRoot: agent.workspace_path,
      grants,
    });
    expect(r).not.toBeNull();
    expect(r?.tier).toBe("deny");
    expect(r?.rule).toBe("tier-d.danger-full-access");
  });

  test("read-only 는 grant 없이도 통과(ask 대상 아님)", () => {
    const r = codexRuntimePreflight(agent, "read-only", false, { workspaceRoot: agent.workspace_path });
    expect(r).toBeNull();
  });
});

import { test, expect, describe } from "bun:test";
import { codexRuntimePreflight, codexConfiguredGrants } from "./permissions";
import { checkPermission } from "../../lib/permissionGate";

// 사전 permission 검사에서는 턴을 막지 않고 Codex 자체 설정을 사용한다. grant 존재와 무관한 결과와 순수 판정 함수의 결과를 구분해 검증한다.
describe("codexRuntimePreflight — 턴 앞에 우리 판정 없음 (설정-grant 는 app-server 판정용으로 잔존)", () => {
  const agent = { id: "dex", workspace_path: "/Users/x/Development/your-workspace" };

  test("seeded 설정-grant 가 workspace-write + network preflight 를 통과시킨다", () => {
    const grants = codexConfiguredGrants("dex", "workspace-write", true, agent.workspace_path);
    const r = codexRuntimePreflight(agent, "workspace-write", true, {
      workspaceRoot: agent.workspace_path,
      grants,
    });
    expect(r).toBeNull(); // null = 차단 없음(실행 허용)
  });

  test("★grant 가 없어도 preflight 는 턴을 막지 않는다★ — 우리 판정을 뺐다", () => {
    const r = codexRuntimePreflight(agent, "workspace-write", true, {
      workspaceRoot: agent.workspace_path,
    });
    expect(r).toBeNull(); // 턴 사전 집행은 없더라도 순수 판정 함수는 같은 입력에 ask를 반환해야 판정 전체가 사라진 경우와 구분된다.

    expect(checkPermission(agent, { kind: "sandbox", sandbox: "workspace-write" }, { workspaceRoot: agent.workspace_path }))
      .toMatchObject({ tier: "ask", rule: "tier-a.workspace-write" });
  });

  // danger-full-access의 실행 경계도 런타임의 사전 검사 대신 Codex 설정이 정한다.
  test("★danger-full-access 도 preflight 는 통과시킨다★ — 이 경계는 codex 설정이 정한다", () => {
    const grants = codexConfiguredGrants("dex", "danger-full-access", true, agent.workspace_path);
    expect(codexRuntimePreflight(agent, "danger-full-access", true, { workspaceRoot: agent.workspace_path, grants })).toBeNull();
    // grant 를 안 줘도 결과가 같다 = 통과 여부가 grant 에 달려 있지 않다 (판정 자체를 안 한다)
    expect(codexRuntimePreflight(agent, "danger-full-access", true, { workspaceRoot: agent.workspace_path })).toBeNull();

    // 대조 — 위험 판정은 그대로 살아 있다. hardDeny 는 여전히 danger-full-access 를 deny 로 안다.
    //   preflight 가 그것을 보지 않기로 한 것 이지, 판정이 없어진 게 아니다.
    expect(checkPermission(agent, { kind: "sandbox", sandbox: "danger-full-access" }, { grants }))
      .toMatchObject({ tier: "deny", rule: "tier-d.danger-full-access" });
  });

  test("read-only 는 grant 없이도 통과(ask 대상 아님)", () => {
    const r = codexRuntimePreflight(agent, "read-only", false, { workspaceRoot: agent.workspace_path });
    expect(r).toBeNull();
  });
});

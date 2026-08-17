import { test, expect, describe } from "bun:test";
import { codexRuntimePreflight, codexConfiguredGrants } from "./permissions";
import { checkPermission } from "../../lib/permissionGate";

// 2026-07-05: GD 테스트에서 workspace-write Dex가 "덱스 있어?"조차 preflight tier-a "ask"로 매 턴 차단(dead-end)
// → 구조적 실행불가. fix = 관리자 설정(agents.json)을 grant로 seed(launch 경계). 이 라운드트립을 락인했었다.
//
// ★2026-08-13 계약 변경★: preflight 는 이제 ★아무것도 막지 않는다(항상 null)★.
//   우리 코드로 차단목록을 얹은 런타임은 codex 하나뿐이었다
//   (실측 — claude 0 · hermes 0 · openclaw 0 · b3osNative 0 · ★codex 6★). 다른 팀원은 그 도구 자체 설정을 쓴다.
//   경계는 ★codex 설정(config.toml 의 sandbox_mode·approval_policy·writable_roots)★ 이 정하고,
//   그 밖은 ★codex 승인창에서 사람이★ 정한다. codexConfiguredGrants 는 남는다 —
//   preflight 가 아니라 app-server 승인 판정(appServerApproval → checkPermission)에 실려 가기 때문이다.
//   그래서 아래 "grant 가 통과시킨다" 두 시험은 이제 ★통과 여부를 grant 가 정하지 않는다★ (전부 null).
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

  // ★계약 변경★ (다른 런타임과의 일관성).
  //   예전 이름: "grant 미주입 시 workspace-write 는 여전히 차단(preflight 원형 유지)".
  test("★grant 가 없어도 preflight 는 턴을 막지 않는다★ — 우리 판정을 뺐다", () => {
    const r = codexRuntimePreflight(agent, "workspace-write", true, {
      workspaceRoot: agent.workspace_path,
    });
    expect(r).toBeNull(); // 예전: tier "ask" / rule "tier-a.workspace-write" 로 매 턴 차단

    // ★대조 — 판정 자체가 사라진 게 아니다.★ 같은 입력에 순수 판정 함수는 여전히 ask 를 돌려준다
    //   (app-server 승인 판정·팝업 본문에서 쓴다). 없어진 것은 ★턴 앞에서 그것을 집행하던 자리★ 다.
    //   이 대조가 없으면 위 null 이 "판정이 통째로 죽어서" 인지 구분되지 않는다.
    expect(checkPermission(agent, { kind: "sandbox", sandbox: "workspace-write" }, { workspaceRoot: agent.workspace_path }))
      .toMatchObject({ tier: "ask", rule: "tier-a.workspace-write" });
  });

  // ★계약 변경★. 예전 이름: "★Tier-D 불변★: danger-full-access 는 설정-grant 로도 통과 못 한다".
  //   불변이 아니게 됐다 — 이 경계는 이제 우리가 아니라 ★codex 설정(config.toml sandbox_mode)★ 이 정한다.
  test("★danger-full-access 도 preflight 는 통과시킨다★ — 이 경계는 codex 설정이 정한다", () => {
    const grants = codexConfiguredGrants("dex", "danger-full-access", true, agent.workspace_path);
    expect(codexRuntimePreflight(agent, "danger-full-access", true, { workspaceRoot: agent.workspace_path, grants })).toBeNull();
    // grant 를 안 줘도 결과가 같다 = ★통과 여부가 grant 에 달려 있지 않다★ (판정 자체를 안 한다)
    expect(codexRuntimePreflight(agent, "danger-full-access", true, { workspaceRoot: agent.workspace_path })).toBeNull();

    // ★대조 — 위험 판정은 그대로 살아 있다.★ hardDeny 는 여전히 danger-full-access 를 deny 로 안다.
    //   preflight 가 그것을 ★보지 않기로 한 것★ 이지, 판정이 없어진 게 아니다.
    expect(checkPermission(agent, { kind: "sandbox", sandbox: "danger-full-access" }, { grants }))
      .toMatchObject({ tier: "deny", rule: "tier-d.danger-full-access" });
  });

  test("read-only 는 grant 없이도 통과(ask 대상 아님)", () => {
    const r = codexRuntimePreflight(agent, "read-only", false, { workspaceRoot: agent.workspace_path });
    expect(r).toBeNull();
  });
});

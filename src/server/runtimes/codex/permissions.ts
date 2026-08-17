import type { Database } from "bun:sqlite";
import type { CodexSandboxMode } from "../../types";
import {
  grantKey,
  requestPermission,
  safeCheckPermission,
  type PermissionAgent,
  type PermissionCheck,
  type PermissionContext,
  type PermissionOperation,
} from "../../lib/permissionGate";

/**
 * ★관리자 설정 = 명시적 grant★ — GD가 agents.json(codex_sandbox / codex_network_access)에서 이 에이전트에
 * 부여한 sandbox/network를 permissionGate 가 인식하는 grant 집합으로 변환한다. 런타임 launch(브릿지/어댑터)가
 * 이 grants 를 permissionContext 에 실어야 preflight 가 통과한다(미주입 시 tier-a "ask"로 매 턴 차단 → 구조적 실행불가).
 * grant scope 는 askRule 이 만드는 것과 ★정확히 동일★해야 매칭된다: sandbox=`workspace-write:${root}`, network=`net:*`.
 * (root 는 preflight 의 workspaceRoot 와 같은 값을 넘겨야 함 — 아래 codexRuntimePreflight 의 workspaceRoot 산출과 일치.)
 * Tier-D(danger-full-access 등)는 grant 로 부여 불가라 이 헬퍼로도 통과 못 한다(hardDeny 가 grant 이전에 deny).
 */
export function codexConfiguredGrants(
  agentId: string,
  sandbox: CodexSandboxMode | undefined,
  networkAccess: boolean | undefined,
  workspaceRoot?: string | null,
): Set<string> {
  const grants = new Set<string>();
  if (sandbox === "workspace-write") {
    grants.add(grantKey(agentId, `workspace-write:${workspaceRoot ?? ""}`));
  }
  if (networkAccess) grants.add(grantKey(agentId, "net:*"));
  return grants;
}

export function codexRuntimePreflight(
  db: Database,
  agent: PermissionAgent,
  sandbox?: CodexSandboxMode,
  networkAccess?: boolean,
  ctx?: PermissionContext,
): PermissionCheck | null;
export function codexRuntimePreflight(
  agent: PermissionAgent,
  sandbox?: CodexSandboxMode,
  networkAccess?: boolean,
  ctx?: PermissionContext,
): PermissionCheck | null;
export function codexRuntimePreflight(
  dbOrAgent: Database | PermissionAgent,
  agentOrSandbox?: PermissionAgent | CodexSandboxMode,
  sandboxOrNetworkAccess?: CodexSandboxMode | boolean,
  networkAccessOrCtx?: boolean | PermissionContext,
  maybeCtx?: PermissionContext,
): PermissionCheck | null {
  const hasDb = typeof (dbOrAgent as Database).prepare === "function";
  const db = hasDb ? dbOrAgent as Database : null;
  const agent = (hasDb ? agentOrSandbox : dbOrAgent) as PermissionAgent;
  const sandbox = (hasDb ? sandboxOrNetworkAccess ?? "read-only" : agentOrSandbox ?? "read-only") as CodexSandboxMode;
  const networkAccess = (hasDb ? networkAccessOrCtx : sandboxOrNetworkAccess) as boolean | undefined;
  void hasDb; void db; void agent; void sandbox; void networkAccess;
  void (hasDb ? maybeCtx : networkAccessOrCtx);
  // ★턴이 시작되기 전에 우리가 막지 않는다.★
  //
  //   전에는 여기서 샌드박스·네트워크를 우리 기준으로 미리 검사하고, 걸리면 ★턴을 아예 시작하지 않았다.★
  //   그 기준은 우리 코드(`permissionGate` Tier-D)에 하드코딩된 것이라 사람이 볼 수도 고칠 수도 없었다.
  //
  //   ★다른 팀원과 비교하면 codex 만 이랬다★ (2026-08-13 실측 — 우리 차단목록 참조 파일 수):
  //     claude 0 · hermes 0 · openclaw 0 · b3osNative 0 · ★codex 6★
  //   나머지는 그 도구 자체 설정(클로드 settings.json · 헤르메스 자체 기능)을 쓰거나 아예 없다.
  //
  //   이제 경계는 ★codex 설정(config.toml 의 sandbox_mode · approval_policy · writable_roots)★ 이 정하고,
  //   그 밖의 일은 ★codex 가 승인창으로 물어 사람이 정한다.★ 우리는 그 사이에 끼지 않는다.
  return null;
}

function persistCodexPermissionRequest(
  db: Database | null,
  check: PermissionCheck,
  op: PermissionOperation,
  skipDb: boolean,
): PermissionCheck {
  if (skipDb || !db) return check;
  const result = requestPermission(db, op);
  if (result.decision === "allow") return { tier: "allow", rule: `${check.rule}.grant`, reason: "permission grant matched", scope: check.scope };
  if (result.decision === "deny") return { tier: "deny", rule: check.rule, reason: `${check.reason}; ${result.reasons.join(",")}`, scope: check.scope };
  return {
    ...check,
    reason: `${check.reason}; approval request ${result.request?.id ?? "created"}`,
  };
}

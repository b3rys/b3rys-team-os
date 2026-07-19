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
  const ctx = (hasDb ? maybeCtx : networkAccessOrCtx) as PermissionContext | undefined;
  const workspaceRoot = ctx?.workspaceRoot ?? agent.workspace_path;
  const preflightCtx = { ...ctx, workspaceRoot };
  const sandboxCheck = safeCheckPermission(agent, { kind: "sandbox", sandbox }, preflightCtx);
  if (sandboxCheck.tier !== "allow") {
    return persistCodexPermissionRequest(db, sandboxCheck, {
      runtime: "codex",
      agent_id: agent.id,
      action: "sandbox",
      text: sandboxCheck.scope ?? sandbox,
      requested_by: "codex-adapter",
      provenance: { rule: sandboxCheck.rule, sandbox },
    }, !db || Boolean(ctx));
  }
  if (networkAccess) {
    const networkCheck = safeCheckPermission(agent, { kind: "network", target: "*" }, preflightCtx);
    if (networkCheck.tier !== "allow") {
      return persistCodexPermissionRequest(db, networkCheck, {
        runtime: "codex",
        agent_id: agent.id,
        action: "network",
        egress_url: networkCheck.scope?.replace(/^net:/, "") ?? "*",
        requested_by: "codex-adapter",
        provenance: { rule: networkCheck.rule, networkAccess },
      }, !db || Boolean(ctx));
    }
  }
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

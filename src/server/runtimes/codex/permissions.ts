import type { Database } from "bun:sqlite";
import type { CodexSandboxMode } from "../../types";
import {
  grantKey,
  requestPermission,
  type PermissionAgent,
  type PermissionCheck,
  type PermissionContext,
  type PermissionOperation,
} from "../../lib/permissionGate";

/** 관리자 sandbox·network 설정을 permissionGate 형식의 grant로 변환한다. scope는 workspace-write:<root>와 net:* 형식에 정확히 맞춘다.
 * 실행 root 산출과 일치시켜야 매칭되며 hardDeny를 grant로 우회할 수는 없다. 이 변환 자체가 턴 사전 집행을 활성화하지 않는다. */
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
  // 턴 사전 검사로 별도 차단하지 않고 Codex 설정·프로토콜이 경계를 정한다.
  // 현재 never는 승인창을 만들지 않아 사람 판단 단계가 없으며 사람 승인은 on-request로 복원한 경우에만 해당한다.
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

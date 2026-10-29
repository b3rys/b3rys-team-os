import { createHash, randomUUID } from "node:crypto";
import { checkCogsOperation, type CheckerRunner } from "./cogsChecker";
import { classifyCogsPath, type PathContext } from "./cogsPathGate";

export interface PermissionCandidate { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }
export type PermissionReply = { behavior: "deny"; message: string } | { behavior: "allow"; updatedInput: Record<string, unknown> };
export interface GateDeps {
  paths: PathContext;
  checker?: CheckerRunner;
  card: (input: PermissionCandidate, executionId: string, normalizedPath: string) => Promise<boolean>;
  audit: (row: Record<string, unknown>) => void;
}
const DENIAL_MESSAGES = {
  invalid_request: "올바르지 않은 작업 요청이에요",
  path_unresolved: "작업 경로를 확인할 수 없어요",
  protected_path: "보호된 경로에는 쓸 수 없어요",
  checker_denied: "보안 검사에서 거절됐어요",
  approval_denied: "작업 승인을 받지 못했어요",
  permission_gate_error: "권한 확인 중 오류가 발생했어요",
} as const;
function deny(code: keyof typeof DENIAL_MESSAGES): PermissionReply {
  return { behavior: "deny", message: `${code}: ${DENIAL_MESSAGES[code]}` };
}
export async function gateClaudePermission(candidate: PermissionCandidate, deps: GateDeps): Promise<PermissionReply> {
  const executionId = randomUUID();
  let reason: "invalid_request" | "path_unresolved" | "protected_path" | "checker_denied" | "owner_approved" | "approval_denied" | "permission_gate_error" = "invalid_request";
  let verdict = "deny", model: string | undefined, promptVersion: string | undefined;
  let checkerVerdict: string | undefined;
  let pathHash: string | undefined, inputHash: string | undefined;
  try {
    // Snapshot once. Neither mutable caller input nor approval response can change the operation.
    const raw = JSON.stringify(candidate.input);
    const input = JSON.parse(raw);
    inputHash = createHash("sha256").update(raw).digest("hex");
    if (candidate.tool_name !== "Write" || typeof input?.file_path !== "string" || typeof input.content !== "string")
      return deny(reason);
    const path = classifyCogsPath(input.file_path, deps.paths);
    if (!path.ok) { reason = path.reason; return deny(reason); }
    pathHash = createHash("sha256").update(path.path).digest("hex");
    if (path.kind === "protected") { reason = "protected_path"; return deny(reason); }
    const checked = await checkCogsOperation({ tool: candidate.tool_name, normalizedPath: path.path, input, secretPath: path.kind === "secret" }, deps.checker);
    ({ model, promptVersion } = checked); checkerVerdict = checked.verdict;
    if (checked.verdict !== "allow") { reason = "checker_denied"; return deny(reason); }
    // The card persists only metadata and a digest of the complete input.
    const allowed = await deps.card({ ...candidate, input }, executionId, path.path);
    reason = allowed ? "owner_approved" : "approval_denied";
    if (!allowed) return deny("approval_denied");
    verdict = "allow";
    return { behavior: "allow", updatedInput: JSON.parse(raw) };
  } catch { reason = "permission_gate_error"; return deny(reason); }
  finally {
    // Audit reasons are fixed codes; checker prose may quote candidate content or paths.
    // An audit write error propagates; the transport then denies, never returns allow.
    deps.audit({ executionId, tool: candidate?.tool_name === "Write" ? "Write" : "unsupported", inputHash, pathHash, verdict,
      reason, checkerVerdict, model, promptVersion, at: new Date().toISOString() });
  }
}

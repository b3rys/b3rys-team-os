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
      return { behavior: "deny", message: reason };
    const path = classifyCogsPath(input.file_path, deps.paths);
    if (!path.ok) { reason = path.reason; return { behavior: "deny", message: reason }; }
    pathHash = createHash("sha256").update(path.path).digest("hex");
    if (path.kind === "protected") { reason = "protected_path"; return { behavior: "deny", message: reason }; }
    const checked = await checkCogsOperation({ tool: candidate.tool_name, normalizedPath: path.path, input, secretPath: path.kind === "secret" }, deps.checker);
    ({ model, promptVersion } = checked); checkerVerdict = checked.verdict;
    if (checked.verdict !== "allow") { reason = "checker_denied"; return { behavior: "deny", message: checked.reason }; }
    // The card binds the original full tool input and the normalized target separately.
    const allowed = await deps.card({ ...candidate, input }, executionId, path.path);
    reason = allowed ? "owner_approved" : "approval_denied";
    if (!allowed) return { behavior: "deny", message: reason };
    verdict = "allow";
    return { behavior: "allow", updatedInput: JSON.parse(raw) };
  } catch { reason = "permission_gate_error"; return { behavior: "deny", message: reason }; }
  finally {
    // Audit reasons are fixed codes; checker prose may quote candidate content or paths.
    // An audit write error propagates; the transport then denies, never returns allow.
    deps.audit({ executionId, tool: candidate?.tool_name === "Write" ? "Write" : "unsupported", inputHash, pathHash, verdict,
      reason, checkerVerdict, model, promptVersion, at: new Date().toISOString() });
  }
}

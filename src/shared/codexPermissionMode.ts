export type CodexPermissionMode = "full" | "folder";
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = "full";

/** Missing settings preserve the existing installation's full-access behavior. */
export function codexPermissionMode(value: unknown): CodexPermissionMode {
  if (value === undefined || value === null) return DEFAULT_CODEX_PERMISSION_MODE;
  if (value === "full" || value === "folder") return value;
  throw new Error("invalid_codex_permission_mode");
}

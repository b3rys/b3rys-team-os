import { readFileSync, realpathSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { readCogsToolRules } from "./cogsToolRules";
import { REPO_ROOT } from "../../lib/personaTemplates";

export function cogsRegistryPath(): string {
  return resolve(process.env.TEAM_AGENT_REGISTRY || join(REPO_ROOT, "agents.json"));
}

// Resolve aliases even before a registry/config file exists.
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonicalPath(parent), basename(absolute));
}
function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
export function assertCogsWorkspace(workspace: string, registryPath = cogsRegistryPath(), repoRoots = [REPO_ROOT, resolve(import.meta.dir, "../../../..")]): string {
  const root = realpathSync(workspace);
  if (/[\[\]*?{}()\n\r]/.test(root) || root === "/") throw new Error("invalid_cogs_workspace");
  if ([registryPath, ...repoRoots].some(path => containsPath(root, join(canonicalPath(dirname(resolve(path))), basename(path))) || containsPath(root, canonicalPath(path)))) {
    throw new Error("cogs_workspace_contains_control_files");
  }
  return root;
}

export type CogsToolScope = "folder" | "full";
export function readCogsToolScope(agentId: string, registryPath = cogsRegistryPath()): CogsToolScope {
  try {
    const records: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    if (!Array.isArray(records)) return "folder";
    const matches = records.filter(record => record?.id === agentId);
    return matches.length === 1 && matches[0].cogs_tool_scope === "full" ? "full" : "folder";
  } catch { return "folder"; }
}

// Bash remains unavailable in PR1; its approval adapter is a separate change.
export function cogsToolPolicy(workspace: string, scope: CogsToolScope) {
  const root = assertCogsWorkspace(workspace);
  const common = {disableAllHooks: true, enabledPlugins: {}, autoMemoryEnabled: false};
  if (scope === "full") return {
    tools: "default", allowed: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "WebSearch"],
    settings: common, flags: [] as string[],
  };
  const rules = readCogsToolRules();
  const protectedPaths = rules.workspaceControls.map(name => join(root, name));
  const protectedWrites = protectedPaths.flatMap(path => [path, canonicalPath(path), `${path}/**`, `${canonicalPath(path)}/**`])
    .flatMap(path => [`Write(/${path})`, `Edit(/${path})`]);
  // Ask takes precedence over folder-wide allow. Without an approval adapter,
  // the runner remains dontAsk and cannot silently execute these operations.
  const credentialRequests = rules.askPaths.flatMap(path =>
    ["Read", "Write", "Edit"].map(tool => `${tool}(${path})`));
  return {
    tools: "Read,Glob,Grep,WebFetch,Write,Edit,WebSearch",
    allowed: ["WebFetch", "WebSearch", `Read(/${root}/**)`, `Glob(/${root}/**)`, `Grep(/${root}/**)`, `Write(/${root}/**)`, `Edit(/${root}/**)`],
    flags: ["--restricted"],
    settings: {...common, permissions: {
      blockReadsOutsideWorkingDirectories: true,
      additionalDirectories: [],
      deny: [...protectedWrites, ...rules.unavailableTools],
      ask: credentialRequests,
    }},
  };
}

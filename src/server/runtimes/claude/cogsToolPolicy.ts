import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../lib/personaTemplates";

export type CogsToolScope = "folder" | "full";
export function readCogsToolScope(agentId: string, registryPath = process.env.TEAM_AGENT_REGISTRY || join(REPO_ROOT, "agents.json")): CogsToolScope {
  try {
    const records: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    if (!Array.isArray(records)) return "folder";
    const matches = records.filter(record => record?.id === agentId);
    return matches.length === 1 && matches[0].cogs_tool_scope === "full" ? "full" : "folder";
  } catch { return "folder"; }
}

// Folder Bash stays disabled until the OS boundary passes the acceptance probe.
export function cogsToolPolicy(workspace: string, scope: CogsToolScope) {
  const root = realpathSync(workspace);
  if (/[\[\]*?{}()\n\r]/.test(root) || root === "/") throw new Error("invalid_cogs_workspace");
  const common = {disableAllHooks: true, enabledPlugins: {}, autoMemoryEnabled: false};
  if (scope === "full") return {
    tools: "default", allowed: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "WebSearch"],
    settings: common, flags: [] as string[],
  };
  return {
    tools: "Read,Glob,Grep,WebFetch,Write,Edit,WebSearch",
    allowed: ["WebFetch", "WebSearch", `Read(/${root}/**)`, `Glob(/${root}/**)`, `Grep(/${root}/**)`, `Write(/${root}/**)`, `Edit(/${root}/**)`],
    flags: ["--restricted"],
    settings: {...common, permissions: {
      blockReadsOutsideWorkingDirectories: true,
      additionalDirectories: [],
      deny: ["Bash", "Read(~/.claude/**)", "Read(~/.secrets/**)", "Read(**/.env)", "Read(**/.env.*)", "Edit(**/.env)", "Edit(**/.env.*)", "Write(**/.env)", "Write(**/.env.*)"],
    }},
  };
}

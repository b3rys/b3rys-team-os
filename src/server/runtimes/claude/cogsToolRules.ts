import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CogsToolRules {
  version: 1;
  workspaceControls: string[];
  askPaths: string[];
  unavailableTools: string[];
}

// This file is product policy, not the operator's Claude settings.
export function readCogsToolRules(path = join(import.meta.dir, "cogsToolRules.json")): CogsToolRules {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const fields = ["version", "workspaceControls", "askPaths", "unavailableTools"];
    if (!value || Array.isArray(value) || value.version !== 1
      || Object.keys(value).length !== fields.length
      || Object.keys(value).some(key => !fields.includes(key))) throw new Error();
    for (const key of fields.slice(1)) {
      const list = value[key];
      if (!Array.isArray(list) || list.length === 0 || list.length > 100
        || list.some(item => typeof item !== "string" || !item || item.length > 400 || /[\u0000-\u001f()]/.test(item))
        || new Set(list).size !== list.length) throw new Error();
    }
    if (value.workspaceControls.some((item: string) => !/^[A-Za-z0-9_.-]+$/.test(item) || item === "." || item === "..")
      || value.askPaths.some((item: string) => !item.startsWith("//") || item.includes(".."))
      || value.unavailableTools.some((item: string) => !/^[A-Za-z]+$/.test(item))) throw new Error();
    return value;
  } catch {
    // Do not include source text or filesystem errors in a user-facing failure.
    throw new Error("invalid_cogs_tool_rules");
  }
}

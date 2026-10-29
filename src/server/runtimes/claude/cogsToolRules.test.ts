import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCogsToolRules } from "./cogsToolRules";

test("product rules fail closed on absent, malformed, missing and unknown fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "cogs-rules-"));
  const path = join(dir, "rules.json");
  try {
    expect(() => readCogsToolRules(path)).toThrow("invalid_cogs_tool_rules");
    const valid = readCogsToolRules();
    const bad: unknown[] = [null, [], {}, {...valid, version: 2}, {...valid, allow: ["Write"]},
      {...valid, workspaceControls: []}, {...valid, workspaceControls: ["../settings"]},
      {...valid, askPaths: ["//**/.env) Write"]}, {...valid, askPaths: ["relative"]},
      {...valid, unavailableTools: ["Bash", "Bash"]}];
    for (const key of Object.keys(valid)) {
      const missing = {...valid} as Record<string, unknown>;
      delete missing[key]; bad.push(missing);
    }
    for (const value of bad) {
      writeFileSync(path, JSON.stringify(value));
      expect(() => readCogsToolRules(path)).toThrow("invalid_cogs_tool_rules");
    }
    writeFileSync(path, "not json");
    expect(() => readCogsToolRules(path)).toThrow("invalid_cogs_tool_rules");
    writeFileSync(path, JSON.stringify(valid));
    expect(readCogsToolRules(path)).toEqual(valid);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

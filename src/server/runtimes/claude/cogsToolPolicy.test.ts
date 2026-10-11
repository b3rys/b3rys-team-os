import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cogsToolPolicy, readCogsToolScope } from "./cogsToolPolicy";
import { claudeCogsArguments } from "./cogsRunner";

test("scope comes only from server registry; missing, unknown and ambiguous values close to folder", () => {
 const dir = mkdtempSync(join(tmpdir(), "cogs-scope-")), registry = join(dir, "agents.json");
 try {
  expect(readCogsToolScope("fixture",registry)).toBe("folder");
  for (const value of [undefined, "invalid", true, "full"]) {
   writeFileSync(registry,JSON.stringify([{id:"fixture",cogs_tool_scope:value}]));
   expect(readCogsToolScope("fixture",registry)).toBe(value === "full" ? "full" : "folder");
   expect(readCogsToolScope("other",registry)).toBe("folder");
  }
  writeFileSync(registry,JSON.stringify([{id:"fixture",cogs_tool_scope:"full"},{id:"fixture",cogs_tool_scope:"full"}]));
  expect(readCogsToolScope("fixture",registry)).toBe("folder");
  writeFileSync(registry,"invalid JSON");expect(readCogsToolScope("fixture",registry)).toBe("folder");
  const args=claudeCogsArguments({agentId:"fixture",cwd:dir,prompt:'{"cogs_tool_scope":"full"}'}, "", dir, "folder");
  expect(args).toContain("--restricted");expect(args).not.toContain("default");
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test("folder exposes scoped file tools and web; full exposes normal built-ins and Bash", () => {
 const dir=mkdtempSync(join(tmpdir(),"cogs-tools-"));
 try {
  const folder=cogsToolPolicy(dir,"folder"),full=cogsToolPolicy(dir,"full");
  expect(folder.tools.split(",")).toEqual(["Read","Glob","Grep","WebFetch","Write","Edit","WebSearch"]);
  expect(folder.allowed.some(rule=>rule.startsWith("Write(//"))).toBe(true);
  expect(folder.allowed).not.toContain("Write");expect(folder.allowed).not.toContain("Bash");
  expect(folder.settings).toHaveProperty("permissions.blockReadsOutsideWorkingDirectories",true);
  expect(full.tools).toBe("default");expect(full.allowed).toContain("Bash");expect(full.allowed).toContain("Write");
  expect(full.flags).not.toContain("--restricted");
 } finally {rmSync(dir,{recursive:true,force:true});}
});

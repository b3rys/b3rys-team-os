import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCogsWorkspace, cogsToolPolicy, readCogsToolScope } from "./cogsToolPolicy";
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

test("workspace containing server registry or repository is rejected, including aliases and missing registry",()=>{
 const dir=mkdtempSync(join(tmpdir(),"cogs-controls-"));
 const repo=join(dir,"repo"),member=join(dir,"member"),registry=join(repo,"agents.json");
 mkdirSync(repo);mkdirSync(member);writeFileSync(registry,"[]");symlinkSync(dir,join(dir,"alias"),"dir");
 try {
  expect(()=>assertCogsWorkspace(dir,registry,[repo])).toThrow("cogs_workspace_contains_control_files");
  expect(()=>assertCogsWorkspace(repo,registry,[repo])).toThrow("cogs_workspace_contains_control_files");
  expect(()=>assertCogsWorkspace(join(dir,"alias"),registry,[repo])).toThrow("cogs_workspace_contains_control_files");
  expect(()=>assertCogsWorkspace(dir,join(repo,"missing.json"),[])).toThrow("cogs_workspace_contains_control_files");
  expect(()=>assertCogsWorkspace(member,registry,[repo])).not.toThrow();
  symlinkSync(registry,join(member,"registry-link.json"));
  expect(()=>assertCogsWorkspace(member,join(member,"registry-link.json"),[])).toThrow("cogs_workspace_contains_control_files");
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test("folder Write/Edit deny persona, configuration, and resolved persona aliases",()=>{
 const dir=mkdtempSync(join(tmpdir(),"cogs-persona-"));
 writeFileSync(join(dir,"backing.md"),"synthetic");symlinkSync(join(dir,"backing.md"),join(dir,"SOUL.md"));
 try {
  const policy=cogsToolPolicy(dir,"folder");
  const deny=(policy.settings as any).permissions.deny as string[];
  for(const name of ["SOUL.md","CLAUDE.md",".claude","backing.md"]) {
   for(const tool of ["Write","Edit"]) expect(deny.some(rule=>rule.endsWith(`/${name})`)&&rule.startsWith(tool))).toBe(true);
  }
  expect(deny.some(rule=>rule.endsWith("/.claude/**)")&&rule.startsWith("Write"))).toBe(true);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

 test("folder runner requests credential approval while keeping Bash unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "cogs-protected-writes-"));
  try {
   const args = claudeCogsArguments({ agentId: "fixture", cwd: dir, prompt: "" }, "", dir, "folder");
   const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
   for (const path of ["//**/.env", "//**/.env.*", "//**/*.key", "//**/.ssh/**"]) {
    for (const tool of ["Read", "Write", "Edit"]) {
     expect(settings.permissions.ask).toContain(`${tool}(${path})`);
     expect(settings.permissions.deny).not.toContain(`${tool}(${path})`);
    }
   }
   expect(args[args.indexOf("--tools") + 1]!.split(",")).not.toContain("Bash");
   expect(settings.permissions.deny).toContain("Bash");
   expect(settings.permissions.deny.some((rule: string) => /env|secret|credential|ssh|key/.test(rule))).toBe(false);
   expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
   expect(cogsToolPolicy(dir, "full").settings).not.toHaveProperty("permissions");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 });

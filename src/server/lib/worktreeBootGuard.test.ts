import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertMemberWriteBootAllowed, WORKTREE_BOOT_ERROR, WORKTREE_WRITE_OVERRIDE } from "./worktreeBootGuard";
import { buildSkillsCopy, syncSkillsCopies } from "./skillsRender";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worktree-boot-"));
  const main = join(root, "main"); mkdirSync(main);
  const git = (...args: string[]) => execFileSync("git", args, {cwd: main, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
  git("init", "-q");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  const linked = join(root, "linked"); git("worktree", "add", "--detach", linked);
  return {root, main, linked};
}

test("main Git directory passes, linked worktree refuses, only exact env=1 overrides", () => {
  const f = fixture();
  try {
    expect(() => assertMemberWriteBootAllowed(f.main, {})).not.toThrow();
    expect(() => assertMemberWriteBootAllowed(f.linked, {})).toThrow(WORKTREE_BOOT_ERROR);
    for (const value of ["", "0", "true", "yes"]) expect(() => assertMemberWriteBootAllowed(f.linked, {[WORKTREE_WRITE_OVERRIDE]: value})).toThrow(WORKTREE_BOOT_ERROR);
    expect(() => assertMemberWriteBootAllowed(f.linked, {[WORKTREE_WRITE_OVERRIDE]: "1"})).not.toThrow();
    expect(() => assertMemberWriteBootAllowed(join(f.root, "missing"), {})).toThrow(WORKTREE_BOOT_ERROR);
    expect(() => assertMemberWriteBootAllowed(join(f.root, "missing"), {[WORKTREE_WRITE_OVERRIDE]: "1"})).not.toThrow();
    const alias = join(f.root, "alias"); symlinkSync(f.main, alias);
    expect(() => assertMemberWriteBootAllowed(alias, {})).not.toThrow();
  } finally { rmSync(f.root, {recursive: true, force: true}); }
});

test("historical boot skills writer cannot overwrite member files from a linked worktree", () => {
  // 7592ed1: index.ts refreshSkillsMd -> syncSkillsCopies writes each member workspace.
  const f = fixture();
  try {
    const member = join(f.root, "member"); mkdirSync(member);
    const source = join(f.root, "SKILLS.md"); writeFileSync(source, "new source\n");
    const dest = join(member, "SKILLS.md"); const before = buildSkillsCopy("old source\n"); writeFileSync(dest, before);
    const boot = () => { assertMemberWriteBootAllowed(f.linked, {}); syncSkillsCopies([member], source); };
    expect(boot).toThrow(WORKTREE_BOOT_ERROR);
    expect(readFileSync(dest, "utf8")).toBe(before);
    // Control mutant: removing the guard reaches the actual production writer.
    expect(syncSkillsCopies([member], source)[member]).toBe("written");
    expect(readFileSync(dest, "utf8")).toBe(buildSkillsCopy("new source\n"));
  } finally { rmSync(f.root, {recursive: true, force: true}); }
});

test("actual server entry refuses linked startup before opening DB or touching member data", () => {
  const f = fixture();
  try {
    cpSync(resolve("src"), join(f.linked, "src"), {recursive: true});
    cpSync(resolve("package.json"), join(f.linked, "package.json"));
    symlinkSync(resolve("node_modules"), join(f.linked, "node_modules"));
    const home = join(f.root, "home"); mkdirSync(home);
    const member = join(f.root, "member"); mkdirSync(member);
    const sentinel = join(member, "SKILLS.md"); writeFileSync(sentinel, buildSkillsCopy("unchanged\n"));
    const registry = join(f.root, "agents.json"); writeFileSync(registry, "[]\n");
    const db = join(f.root, "team.db");
    const result = spawnSync(process.execPath, ["src/server/index.ts"], {
      cwd: f.linked, encoding: "utf8", timeout: 20000,
      env: {PATH: process.env.PATH!, HOME: home, TEAM_DB_PATH: db, TEAM_AGENT_REGISTRY: registry},
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(WORKTREE_BOOT_ERROR);
    expect(existsSync(db)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe(buildSkillsCopy("unchanged\n"));
  } finally { rmSync(f.root, {recursive: true, force: true}); }
});

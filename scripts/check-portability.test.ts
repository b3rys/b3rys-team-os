import { expect, test } from "bun:test";
import { scanPortability as scan } from "./check-portability";

test("documented snapshot incident and requested Bash 4 forms fail", () => {
  // eda8e9a (#190) records mapfile/declare -A failures before tracked scripts existed.
  // These reproduce the recorded syntax; they are not recovered historical source.
  for (const source of ['mapfile -t ALL < snapshots', 'declare -A KEEP', 'declare -gA KEEP', 'echo "${runtime^^}"', 'if mapfile -t ALL; then :; fi', 'echo "$(mapfile -t ALL)"']) {
    expect(scan("scripts/snapshot-team.sh", source).length).toBeGreaterThan(0);
  }
});

test("shell files in skills and install are checked; documentation and literals are allowed", () => {
  expect(scan("skills/example/scripts/run.sh", 'declare -A lookup')).toHaveLength(1);
  expect(scan("skills/example/SKILL.md", '```bash\ndeclare -A lookup\n```')).toHaveLength(0);
  expect(scan("install.sh", 'mapfile -t files')).toHaveLength(1);
  for (const source of [
    '# declare -A mapfile ${v^^}', 'echo do mapfile', 'echo then declare -A', "echo 'mapfile ${v^^}'", 'echo "declare -A mapfile"',
    "cat <<'EXAMPLE'\nmapfile -t files\n${v^^}\nEXAMPLE", 'while read -r line; do echo "$line"; done',
  ]) expect(scan("scripts/example.sh", source)).toHaveLength(0);
  expect(scan("scripts/example.sh", 'cat <<EXAMPLE\n${v^^}\nEXAMPLE')).toHaveLength(1);
  expect(scan("scripts/example.sh", 'cat <<EXAMPLE\nmapfile is a builtin\nEXAMPLE')).toHaveLength(0);
  for (const command of ["mapfile -t a", "declare -A a"]) expect(scan("scripts/example.sh", `cat <<EXAMPLE\n$(${command})\nEXAMPLE`)).toHaveLength(1);
});

test("production paths fail while portable paths, comments and synthetic fixtures pass", () => {
  for (const source of ['const root = "/Users/example/project";', 'const root = `/Users/${name}/project`;', 'const root = `${prefix}/Users/example`;']) {
    expect(scan("src/server/config.ts", source)).toHaveLength(1);
  }
  for (const [file, source] of [
    ['src/server/config.ts', '// "/Users/example"\nconst root = join(process.env.HOME, "project");'],
    ['src/server/config.test.ts', 'const root = "/Users/example";'],
    ['src/test/fixture.ts', 'const root = "/Users/example";'],
  ]) expect(scan(file!, source!)).toHaveLength(0);
});

test("CLI fails on incident syntax injected into an isolated snapshot source", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const cwd = mkdtempSync(join(tmpdir(), "portability-"));
  const script = resolve("scripts/check-portability.ts");
  const original = readFileSync("scripts/snapshot-team.sh", "utf8");
  try {
    execFileSync("git", ["init", "-q"], {cwd}); mkdirSync(join(cwd, "scripts"));
    const target = join(cwd, "scripts/snapshot-team.sh");
    writeFileSync(target, original); execFileSync("git", ["add", "."], {cwd});
    expect(spawnSync(process.execPath, [script], {cwd, encoding: "utf8"}).status).toBe(0);
    writeFileSync(target, "mapfile -t ALL < snapshots\ndeclare -A KEEP\n" + original);
    const mutant = spawnSync(process.execPath, [script], {cwd, encoding: "utf8"});
    expect(mutant.status).toBe(1); expect(mutant.stderr).toContain("bash-mapfile"); expect(mutant.stderr).toContain("bash-associative-array");
    writeFileSync(target, original);
    expect(spawnSync(process.execPath, [script], {cwd, encoding: "utf8"}).status).toBe(0);
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});

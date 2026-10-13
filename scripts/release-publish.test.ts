import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("publish uses the reviewed plan, noreply commit/tag and atomic push in an isolated remote", async () => {
  const temp = mkdtempSync(join(tmpdir(), "release-publish-fixture-"));
  const root = join(temp, "repo"), remote = join(temp, "remote.git"), bin = join(temp, "bin");
  mkdirSync(root); mkdirSync(bin);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", root, ...args]);
    if (r.exitCode) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const email = "fixture@users.noreply.github.com";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    return Response.json(path.endsWith("agents") ? { agents: [{ display_name: "PrivateMember" }] }
      : path.endsWith("projects") ? { projects: [] } : { owner_name: "PrivateOwner", github_team_commit_email: email });
  } });
  try {
    for (const file of ["scripts/release-cut.sh", "scripts/release-cut.ts", "scripts/release-plan.ts", "skills/b3os-release-ops/scripts/public-content-lint.ts", "skills/b3os-release-ops/public-lint-allow.txt"]) {
      const dest = join(root, file);
      mkdirSync(resolve(dest, ".."), { recursive: true });
      copyFileSync(resolve(file), dest);
    }
    // Isolate the preflight boundary; no live settings, repository or GitHub writes.
    writeFileSync(join(root, "skills/b3os-release-ops/scripts/release-preflight.sh"), '#!/bin/bash\nset -eu\ntest -z "$(git status --porcelain)"\nprintf "preflight\\n" >> "$FIXTURE_LOG"\n');
    writeFileSync(join(root, "package.json"), '{"version":"0.6.1"}\n');
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture"); git("config", "user.email", email);
    git("config", "commit.gpgsign", "false"); git("config", "tag.gpgsign", "false");
    git("add", "."); git("commit", "-qm", "initial"); git("tag", "v0.6.1");
    writeFileSync(join(root, "feature.txt"), "feature\n");
    git("add", "feature.txt"); git("commit", "-qm", "feat: view");
    const oid = git("rev-parse", "HEAD");
    git("init", "--bare", "-q", remote); git("remote", "add", "origin", remote); git("push", "-q", "--tags", "origin", "main");
    const prs = join(temp, "prs.json"), log = join(temp, "operations.log");
    writeFileSync(prs, JSON.stringify([{ number: 1, title: "feat: dashboard view", labels: [], mergeCommit: { oid } }]));
    writeFileSync(join(bin, "gh"), '#!/bin/bash\nset -eu\ncase "$1 $2" in\n  "pr list") cat "$FIXTURE_PRS";;\n  "release create") printf "release:%s\\n" "$3" >> "$FIXTURE_LOG";;\n  *) exit 2;;\nesac\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, B3OS_SETTINGS_URL: `http://127.0.0.1:${server.port}/team/api/settings`, FIXTURE_PRS: prs, FIXTURE_LOG: log };
    const cli = async (...args: string[]) => {
      const child = Bun.spawn(["bash", "scripts/release-cut.sh", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code) throw new Error(stderr);
      return stdout;
    };
    const out = join(temp, "draft");
    await cli("--dry-run", "--out", out);
    expect(git("rev-parse", "HEAD")).toBe(oid);
    await cli("--publish", "--approved", "--plan", join(out, "plan.json"));
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("0.7.0");
    expect(git("log", "-1", "--format=%ae%n%ce")).toBe(`${email}\n${email}`);
    expect(git("cat-file", "-t", "v0.7.0")).toBe("tag");
    expect(git("for-each-ref", "--format=%(taggeremail)", "refs/tags/v0.7.0")).toBe(`<${email}>`);
    expect(git("ls-remote", "origin", "refs/heads/main")).toStartWith(git("rev-parse", "HEAD"));
    expect(git("ls-remote", "origin", "refs/tags/v0.7.0")).toStartWith(git("rev-parse", "v0.7.0"));
    expect(readFileSync(log, "utf8")).toBe("preflight\nrelease:v0.7.0\n");
  } finally { server.stop(true); rmSync(temp, { recursive: true, force: true }); }
}, 15000);

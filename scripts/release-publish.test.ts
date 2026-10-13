import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("publish uses the reviewed plan, release PR, noreply commit/tag and tag-only push with protected main in an isolated remote", async () => {
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
    return Response.json(path.endsWith("agents") ? { agents: [{ id: "tester", display_name: "PrivateMember" }] }
      : path.endsWith("projects") ? { projects: [] } : { owner_name: "PrivateOwner", github_team_commit_email: email, github_team_account: "fixture-team", github_approver_account: "fixture-approver" });
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
    writeFileSync(join(remote, "hooks/update"), '#!/bin/bash\ntest "$1" != refs/heads/main\n', { mode: 0o755 });
    const prs = join(temp, "prs.json"), log = join(temp, "operations.log");
    writeFileSync(prs, JSON.stringify([{ number: 1, title: "feat: dashboard view", labels: [], mergeCommit: { oid } }]));
    writeFileSync(join(bin, "gh"), '#!/bin/bash\nset -eu\ncase "$1 $2" in\n  "pr list") cat "$FIXTURE_PRS";;\n  "auth token") printf "fixture-token";;\n  "pr create") printf "release-pr\\n" >> "$FIXTURE_LOG"; printf "https://example.invalid/pull/1";;\n  "pr view") printf "fixture-team";;\n  "release create") printf "release:%s\\n" "$3" >> "$FIXTURE_LOG";;\n  *) exit 2;;\nesac\n', { mode: 0o755 });
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
    await expect(cli("--publish", "--approved", "--plan", join(out, "plan.json"))).rejects.toThrow("release PR first");
    expect(git("ls-remote", "origin", "refs/heads/main")).toStartWith(oid);
    await cli("--prepare", "--submitted-by", "tester", "--plan", join(out, "plan.json"));
    expect(git("log", "-1", "--format=%an%n%cn")).toBe("tester\ntester");
    expect(git("ls-remote", "origin", "refs/heads/main")).toStartWith(oid);
    expect(git("ls-remote", "origin", "refs/tags/v0.7.0")).toBe("");
    const prepared = git("rev-parse", "HEAD");
    // Simulate an approved PR merge without weakening the remote update hook.
    git("switch", "main"); git("merge", "--ff-only", "release/v0.7.0");
    git("--git-dir=" + remote, "update-ref", "refs/heads/main", prepared, oid);
    writeFileSync(prs, JSON.stringify([{ number: 1, title: "feat: dashboard view", labels: [], mergeCommit: { oid } }, { number: 2, title: "chore(release): v0.7.0", labels: [], mergeCommit: { oid: prepared } }]));
    await expect(cli("--publish", "--approved", "--plan", join(out, "plan.json"))).rejects.toThrow("Plan is stale");
    const final = join(temp, "reviewed-after-merge");
    await cli("--dry-run", "--out", final);
    await cli("--publish", "--approved", "--plan", join(final, "plan.json"));
    expect(git("rev-parse", "HEAD")).toBe(prepared);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("0.7.0");
    expect(git("log", "-1", "--format=%ae%n%ce")).toBe(`${email}\n${email}`);
    expect(git("cat-file", "-t", "v0.7.0")).toBe("tag");
    expect(git("for-each-ref", "--format=%(taggeremail)", "refs/tags/v0.7.0")).toBe(`<${email}>`);
    expect(git("ls-remote", "origin", "refs/heads/main")).toStartWith(git("rev-parse", "HEAD"));
    expect(git("ls-remote", "origin", "refs/tags/v0.7.0")).toStartWith(git("rev-parse", "v0.7.0"));
    expect(readFileSync(log, "utf8")).toBe("preflight\npreflight\nrelease-pr\npreflight\nrelease:v0.7.0\n");
  } finally { server.stop(true); rmSync(temp, { recursive: true, force: true }); }
}, 15000);

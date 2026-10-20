import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVersionRoutes, readRunningVersion } from "./version";

test("version API captures package and Git SHA at creation, not on request", async () => {
  const root = mkdtempSync(join(tmpdir(), "running-version-"));
  try {
    writeFileSync(join(root, "package.json"), '{"version":"0.6.1"}');
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", root, ...args]);
      expect(r.exitCode).toBe(0);
      return r.stdout.toString().trim();
    };
    git("init", "-q"); git("add", "package.json");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    const sha = git("rev-parse", "--short=8", "HEAD");
    const api = createVersionRoutes(root);
    writeFileSync(join(root, "package.json"), '{"version":"0.7.0"}');
    const response = await api.request("/version");
    expect(await response.json()).toEqual({ version: "0.6.1", commitsSinceTag: null, commit: sha });
    expect(await (await createVersionRoutes(root).request("/version")).json()).toEqual({ version: "0.7.0", commitsSinceTag: null, commit: sha });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("archive without metadata reports unknown values", async () => {
  const root = mkdtempSync(join(tmpdir(), "running-archive-"));
  try { expect(await (await createVersionRoutes(root).request("/version")).json()).toEqual({ version: null, commitsSinceTag: null, commit: null }); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test("tag version wins over stale package and counts commits since release", async () => {
  const root = mkdtempSync(join(tmpdir(), "tagged-running-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", root, ...args]);
    if (r.exitCode) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  try {
    writeFileSync(join(root, "package.json"), '{"version":"0.6.1"}');
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    git("tag", "v0.7.0");
    expect(readRunningVersion(root)).toEqual({ version: "0.7.0", commitsSinceTag: 0, commit: git("rev-parse", "--short=8", "HEAD") });
    const api = createVersionRoutes(root);
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "after release");
    expect(readRunningVersion(root)).toEqual({ version: "0.7.0", commitsSinceTag: 1, commit: git("rev-parse", "--short=8", "HEAD") });
    expect((await (await api.request("/version")).json()).commitsSinceTag).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

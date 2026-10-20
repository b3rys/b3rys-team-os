import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function readRunningVersion(root: string): { version: string | null; commitsSinceTag: number | null; commit: string | null } {
  let version: string | null = null;
  let commitsSinceTag: number | null = null;
  let commit: string | null = null;
  try {
    const git = spawnSync("git", ["describe", "--tags", "--match", "v[0-9]*", "--long", "--abbrev=8"], { cwd: root, encoding: "utf8", timeout: 2000 });
    const match = /^v(\d+\.\d+\.\d+)-(\d+)-g([a-f0-9]{7,40})$/.exec(git.stdout?.trim() ?? "");
    if (git.status === 0 && match) {
      version = match[1]!; commitsSinceTag = Number(match[2]); commit = match[3]!;
    }
  } catch { /* Fall back when Git/tag metadata is unavailable. */ }
  if (version === null) {
    try {
      const candidate = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
      if (typeof candidate === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(candidate)) version = candidate;
    } catch { /* Source archives may have no package metadata. */ }
  }
  try {
    const git = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: root, encoding: "utf8", timeout: 2000 });
    const candidate = git.stdout?.trim();
    if (git.status === 0 && /^[a-f0-9]{7,40}$/.test(candidate)) commit = candidate;
  } catch { /* Source archives may have no Git metadata. */ }
  return { version, commitsSinceTag, commit };
}

export function createVersionRoutes(root: string): Hono {
  // Capture once at startup: later file changes do not describe the running process.
  const running = readRunningVersion(root);
  const routes = new Hono();
  routes.get("/version", c => c.json(running));
  return routes;
}

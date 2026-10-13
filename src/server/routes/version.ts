import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function readRunningVersion(root: string): { version: string | null; commit: string | null } {
  let version: string | null = null;
  let commit: string | null = null;
  try {
    const candidate = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    if (typeof candidate === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(candidate)) version = candidate;
  } catch { /* Source archives may have no package metadata. */ }
  try {
    const git = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: root, encoding: "utf8", timeout: 2000 });
    const candidate = git.stdout?.trim();
    if (git.status === 0 && /^[a-f0-9]{7,40}$/.test(candidate)) commit = candidate;
  } catch { /* Source archives may have no Git metadata. */ }
  return { version, commit };
}

export function createVersionRoutes(root: string): Hono {
  // Capture once at startup: later file changes do not describe the running process.
  const running = readRunningVersion(root);
  const routes = new Hono();
  routes.get("/version", c => c.json(running));
  return routes;
}

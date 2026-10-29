import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, dirname, parse, resolve } from "node:path";
import { readCogsToolRules } from "./cogsToolRules";

export type PathClass = "inside" | "outside" | "protected" | "secret";
export type PathDecision = { ok: true; kind: PathClass; path: string } | { ok: false; reason: "path_unresolved" };
export interface PathContext {
  workspace: string;
  // Caller supplies server policy, checker, approval/audit storage and configuration roots.
  protectedPaths: string[];
}

// Resolve component by component: lexical resolve() before realpath would incorrectly
// erase a symlink followed by /.. . Dangling links and non-directory parents deny.
export function canonicalWritePath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("invalid_path");
  let current = parse(path).root;
  let missing = false;
  const parts = path.slice(current.length).split("/").filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      try { realpathSync(current); missing = false; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing = true;
      }
      continue;
    }
    const next = join(current, part);
    if (!missing) {
      try {
        lstatSync(next); // Existing dangling symlink must not look like a new filename.
        current = realpathSync(next);
        if (index < parts.length - 1 && !statSync(current).isDirectory()) throw new Error("not_directory");
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Distinguish missing entry from realpath failure on an existing symlink.
        try { lstatSync(next); } catch (entryError) {
          if ((entryError as NodeJS.ErrnoException).code === "ENOENT") { current = next; missing = true; continue; }
          throw entryError;
        }
        throw new Error("dangling_symlink");
      }
    }
    current = next;
  }
  return current;
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
export function classifyCogsPath(raw: string, context: PathContext): PathDecision {
  try {
    if (!raw || !Array.isArray(context.protectedPaths)) throw new Error("invalid_context");
    const root = realpathSync(context.workspace);
    if (!statSync(root).isDirectory()) throw new Error("invalid_workspace");
    const absolute = isAbsolute(raw) ? raw : `${root}/${raw}`;
    const path = canonicalWritePath(absolute);
    const rules = readCogsToolRules();
    const controls = [...context.protectedPaths, ...rules.workspaceControls.map(name => join(root, name))];
    // Check aliases and direct spellings. The control name itself remains protected
    // even when a workspace control is currently a symlink to a different location.
    if (controls.some(control => within(canonicalWritePath(control), path) || within(control, path) || within(control, resolve(absolute))))
      return { ok: true, kind: "protected", path };
    if (rules.askPaths.some(pattern => new Bun.Glob(pattern.slice(1)).match(path) || new Bun.Glob(pattern.slice(1)).match(resolve(absolute))))
      return { ok: true, kind: "secret", path };
    return { ok: true, kind: within(root, path) ? "inside" : "outside", path };
  } catch { return { ok: false, reason: "path_unresolved" }; }
}

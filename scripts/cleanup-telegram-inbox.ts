#!/usr/bin/env bun
import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const DAY = 86400_000;
async function plainDirectory(path: string) {
  try { const s = await lstat(path); return s.isDirectory() && !s.isSymbolicLink() && await realpath(path) === path; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

/** Only runtime-owned incoming caches. No arbitrary path or symlink traversal. */
export async function inboxRoots(home: string): Promise<string[]> {
  if (!home || !isAbsolute(home) || resolve(home) === sep) throw new Error("home");
  const base = await realpath(home), roots: string[] = [];
  if (base === sep) throw new Error("home");
  const add = async (path: string) => { if (await plainDirectory(path)) roots.push(path); };
  const channels = join(base, ".claude/channels");
  if (await plainDirectory(channels)) for (const entry of await readdir(channels, {withFileTypes: true})) {
    if (entry.isDirectory() && /^telegram-[a-zA-Z0-9_-]+$/.test(entry.name) && await plainDirectory(join(channels, entry.name))) await add(join(channels, entry.name, "inbox"));
  }
  // Hermes caches include generated/shared media; they are intentionally excluded.
  for (const name of await readdir(base, {withFileTypes: true})) {
    if (!name.isDirectory() || !/^\.openclaw(?:-[a-zA-Z0-9_-]+)?$/.test(name.name)) continue;
    const profile = join(base, name.name), media = join(profile, "media");
    if (await plainDirectory(profile) && await plainDirectory(media)) await add(join(media, "inbound"));
  }
  return roots;
}

export async function cleanupTelegramInbox(opts: {
  home?: string; days?: number; now?: number; apply?: boolean; root?: string;
} = {}) {
  const days = opts.days ?? 7;
  if (!Number.isFinite(days) || days <= 0 || days > 36500) throw new Error("days");
  const roots = await inboxRoots(opts.home ?? homedir());
  if (opts.root !== undefined && (!opts.root || !roots.includes(resolve(opts.root)))) throw new Error("root");
  const selected = opts.root === undefined ? roots : [resolve(opts.root)];
  const cutoff = (opts.now ?? Date.now()) - days * DAY;
  const results: {path: string; action: "would-delete" | "deleted"}[] = [];
  for (const root of selected) {
    async function walk(dir: string) {
      if (!await plainDirectory(dir)) return;
      for (const entry of await readdir(dir, {withFileTypes: true})) {
        const path = join(dir, entry.name), rel = relative(root, path);
        if (rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("outside");
        const info = await lstat(path);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { await walk(path); continue; }
        if (!info.isFile() || info.mtimeMs >= cutoff) continue;
        // Recheck the parent immediately before any unlink. Never remove directories.
        if (!await plainDirectory(dir) || await realpath(path) !== path) throw new Error("link");
        if (opts.apply) await unlink(path);
        results.push({path, action: opts.apply ? "deleted" : "would-delete"});
      }
    }
    await walk(root);
  }
  return {mode: opts.apply ? "apply" : "dry-run", days, roots: selected, files: results};
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2); let days = 7, root: string | undefined, apply = false;
    for (let i=0; i<args.length; i++) {
      if (args[i] === "--apply") apply = true;
      else if (args[i] === "--dry-run") apply = false;
      else if (args[i] === "--days" && args[i+1]) days = Number(args[++i]);
      else if (args[i] === "--root" && args[i+1] !== undefined) root = args[++i];
      else throw new Error();
    }
    console.log(JSON.stringify(await cleanupTelegramInbox({days, root, apply})));
  } catch { console.error("CLEANUP_FAILED"); process.exitCode = 1; }
}

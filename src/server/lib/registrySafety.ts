import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface RegistryWriteOptions {
  /** Explicit acknowledgement for replacing a non-empty registry with []. */
  forceEmpty?: boolean;
  /** Repository boundary used for symlink escape checks. */
  repoRoot?: string;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertSafeRegistryTarget(registryPath: string, repoRoot = resolve(import.meta.dir, "../../..")): void {
  const root = realpathSync(repoRoot);
  const lexicalRoot = resolve(repoRoot);
  const lexicalTarget = resolve(registryPath);
  // Resolve every path component. Checking only a final-component symlink
  // misses escapes such as repo/state -> /live with state/agents.json regular.
  const target = existsSync(registryPath)
    ? realpathSync(registryPath)
    : join(realpathSync(dirname(registryPath)), basename(registryPath));
  // Enforce the repository boundary for repository-relative targets. An
  // explicitly configured absolute target outside the repository (tests/BYO)
  // is its own trust boundary; it is not silently reached through a repo link.
  if (inside(lexicalRoot, lexicalTarget) && !inside(root, target)) {
    throw new Error(`registry_symlink_escape: ${registryPath} -> ${target}`);
  }
}

function currentRegistry(registryPath: string): unknown[] {
  if (!existsSync(registryPath)) return [];
  const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
  if (!Array.isArray(parsed)) throw new Error("agents.json must be an array");
  return parsed;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

interface ForcedEmptyApproval {
  content: string;
  expiresAt: number;
  fingerprint: string;
}

const forcedEmptyApprovals = new Map<string, ForcedEmptyApproval>();
const FORCED_EMPTY_TTL_MS = 5_000;

function fileFingerprint(path: string): string {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** One-shot process-local approval, bound to this exact write and not forgeable on disk. */
export function consumeForcedEmptyRegistry(registryPath: string): boolean {
  const key = resolve(registryPath);
  const approval = forcedEmptyApprovals.get(key);
  forcedEmptyApprovals.delete(key);
  if (!approval || Date.now() > approval.expiresAt) return false;
  try {
    return fileFingerprint(registryPath) === approval.fingerprint
      && readFileSync(registryPath, "utf-8") === approval.content;
  } catch {
    return false;
  }
}

/** Backup-first, atomic registry writer shared by Settings and activation flows. */
export function writeRegistrySafely(registryPath: string, list: unknown[], options: RegistryWriteOptions = {}): void {
  assertSafeRegistryTarget(registryPath, options.repoRoot);
  const current = currentRegistry(registryPath);
  const forcedEmptyTransition = current.length > 0 && list.length === 0 && options.forceEmpty === true;

  if (current.length > 0 && list.length === 0) {
    const emergencyBackup = `${registryPath}.bak-empty-${timestamp()}`;
    copyFileSync(registryPath, emergencyBackup);
    if (!options.forceEmpty) {
      throw new Error(`registry_empty_requires_force: backup=${emergencyBackup}`);
    }
  }

  if (existsSync(registryPath)) copyFileSync(registryPath, `${registryPath}.bak`);
  const tempPath = `${registryPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const content = JSON.stringify(list, null, 2) + "\n";
  try {
    writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    renameSync(tempPath, registryPath);
    try { chmodSync(registryPath, 0o600); } catch { /* best-effort */ }
    if (forcedEmptyTransition) {
      forcedEmptyApprovals.set(resolve(registryPath), {
        content,
        expiresAt: Date.now() + FORCED_EMPTY_TTL_MS,
        fingerprint: fileFingerprint(registryPath),
      });
    }
  } finally {
    try { rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
  }
}

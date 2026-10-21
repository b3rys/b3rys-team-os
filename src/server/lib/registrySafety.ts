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
import { withRegistryLock } from "./registryLock";

export interface RegistryWriteOptions {
  /** Explicit acknowledgement for replacing a non-empty registry with []. */
  forceEmpty?: boolean;
  /**
   * cogs 권한 정책 서비스만 true. 그 밖의 쓰기는 cogs_permissions 칸을 바꿀 수 없다 —
   * 잠금 안에서 원본을 다시 읽어 각 팀원의 그 칸을 지금 값으로 유지한다(오래된 목록이 축소를 되돌리지 못하게).
   */
  cogsPolicyWriter?: boolean;
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

/**
 * Backup-first, atomic registry writer shared by Settings and activation flows.
 * 모든 쓰기는 같은 파일 잠금(registryLock) 안에서 한다 — 서버와 브리지가 같은 파일을 쓴다.
 */
export function writeRegistrySafely(registryPath: string, list: unknown[], options: RegistryWriteOptions = {}): void {
  assertSafeRegistryTarget(registryPath, options.repoRoot);
  const r = withRegistryLock(registryPath, () => writeLocked(registryPath, list, options));
  if (r === "busy") throw new Error("registry_busy");
}

/** 정책 서비스가 아닌 쓰기: 원본에 있는 팀원의 cogs_permissions 는 원본 값을 쓴다. */
function keepCogsPolicies(current: unknown[], list: unknown[]): unknown[] {
  const live = new Map<string, unknown>();
  for (const a of current) {
    if (a && typeof a === "object" && "id" in a) live.set(String((a as { id: unknown }).id), (a as { cogs_permissions?: unknown }).cogs_permissions);
  }
  return list.map((a) => {
    if (!a || typeof a !== "object" || !("id" in a)) return a;
    const id = String((a as { id: unknown }).id);
    if (!live.has(id)) return a;
    const { cogs_permissions: _stale, ...rest } = a as Record<string, unknown>;
    const now = live.get(id);
    return now === undefined ? rest : { ...rest, cogs_permissions: now };
  });
}

function writeLocked(registryPath: string, inputList: unknown[], options: RegistryWriteOptions): void {
  const current = currentRegistry(registryPath);
  const list = options.cogsPolicyWriter ? inputList : keepCogsPolicies(current, inputList);
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

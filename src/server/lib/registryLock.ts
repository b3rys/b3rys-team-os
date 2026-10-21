/**
 * agents.json 읽고-고치고-쓰기 잠금 — 프로세스 사이(서버·브리지)에서 같은 파일을 쓰는 모든 경로가 거친다.
 *
 * O_EXCL 잠금 파일. 같은 프로세스 안에서는 다시 잡아도 된다(정책 서비스가 잠금 안에서 writeRegistrySafely 를 부른다).
 * 오래된 잠금(쓰던 프로세스가 죽음)은 STALE_MS 뒤 치운다. 동기 함수다 — 잠금 안에서 await 하지 않는다.
 */
import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const STALE_MS = 10_000;
const held = new Map<string, number>();

export function registryLockPath(registryPath: string): string {
  return `${resolve(registryPath)}.lock`;
}

/** 잠금을 못 잡으면 "busy". fn 이 던지면 잠금을 풀고 그대로 던진다. */
export function withRegistryLock<T>(registryPath: string, fn: () => T, timeoutMs = 2_000): T | "busy" {
  const lock = registryLockPath(registryPath);
  const depth = held.get(lock) ?? 0;
  if (depth > 0) {
    held.set(lock, depth + 1);
    try { return fn(); } finally { held.set(lock, depth); }
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_MS) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() >= deadline) return "busy";
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  held.set(lock, 1);
  try {
    return fn();
  } finally {
    held.delete(lock);
    try { unlinkSync(lock); } catch { /* 이미 없음 */ }
  }
}

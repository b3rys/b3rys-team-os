/**
 * b3chat 서버 ↔ b3os 서버 연결 인증 — 같은 맥의 두 서버끼리만 쓰는 길이다.
 *
 * 두 겹으로 막는다:
 *   ① 같은 기계에서 온 요청만 — 접속 주소가 loopback 이고, 프록시가 붙이는 헤더(Forwarded·X-Forwarded-*·CF)가
 *      하나도 없어야 한다. 터널(cloudflared)도 127.0.0.1 에서 접속하므로 ★주소만으로는 못 가른다 — 헤더로 가른다.★
 *      Host 헤더로는 판정하지 않는다(호출자가 꾸밀 수 있다).
 *   ② 공유 비밀 — b3os 가 var/secrets/b3chat-link.key(0600)를 만들고, b3chat 은 그 파일을 읽어 X-B3chat-Link 로 보낸다.
 *      상수시간 비교. 키 값은 응답·로그·감사 기록에 싣지 않는다.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LINK_HEADER = "x-b3chat-link";

/** 프록시·터널이 붙이는 헤더 — 하나라도 있으면 같은 기계에서 직접 온 요청이 아니다. */
const PROXY_HEADERS = [
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
  "cf-ray", "cf-connecting-ip", "cf-ipcountry", "cf-access-jwt-assertion", "cf-visitor",
] as const;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function linkKeyPath(registryPath: string): string {
  return join(dirname(registryPath), "var", "secrets", "b3chat-link.key");
}

/** 키 파일이 없으면 만든다(0600). 이미 있으면 그대로 둔다 — b3chat 이 읽고 있는 값을 바꾸지 않는다. */
export function ensureLinkKey(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, randomBytes(32).toString("base64url") + "\n", { mode: 0o600, flag: "wx" });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

export function readLinkKey(path: string): string | null {
  try {
    const v = readFileSync(path, "utf-8").trim();
    return v.length >= 32 ? v : null;
  } catch {
    return null;
  }
}

/** 같은 기계에서 직접 온 요청인가 — 접속 주소 loopback + 프록시 헤더 없음. */
export function isDirectLocal(remoteAddress: string | null | undefined, headers: Headers): boolean {
  if (!remoteAddress || !LOOPBACK.has(remoteAddress)) return false;
  return PROXY_HEADERS.every((h) => !headers.has(h));
}

/** 공유 비밀 상수시간 비교 — 길이가 달라도 시간이 새지 않게 해시끼리 비교한다. */
export function linkSecretMatches(given: string | null | undefined, key: string | null): boolean {
  if (!given || !key) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(key).digest();
  return timingSafeEqual(a, b);
}

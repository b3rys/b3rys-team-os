import { timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isPinSessionValid } from "./approvals";

export interface TrustedActor {
  actor: string;
  source: "pin_session" | "op_token" | "loopback_dashboard";
}

export interface AuthResult {
  ok: boolean;
  actor?: TrustedActor;
  error?: string;
  status?: number;
}

const ACTOR_RE = /^[a-z0-9_-]{1,40}$/i;
const LEAD_SETTING_RE = /^[a-z0-9_-]{1,40}$/;

let leadActorDb: Database | null = null;

export function configureLeadActorDb(db: Database): void {
  leadActorDb = db;
}

function leadActorSetting(db: Database | null): string | null {
  if (!db) return null;
  try {
    const row = db.prepare("SELECT value FROM setting WHERE key = 'lead_id'").get() as { value: string } | undefined;
    const value = row?.value?.trim() ?? "";
    return LEAD_SETTING_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function leadActorId(db?: Database): string {
  return leadActorSetting(db ?? leadActorDb) ?? process.env.LEAD_ACTOR_ID ?? "gd";
}

export function leadActorSource(db?: Database): "setting" | "env" | "default" {
  if (leadActorSetting(db ?? leadActorDb)) return "setting";
  if (process.env.LEAD_ACTOR_ID) return "env";
  return "default";
}

export function fallbackLeadActorId(): string {
  return process.env.LEAD_ACTOR_ID ?? "gd";
}

export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function trustedActorFromHeaders(headers: Headers): AuthResult {
  const pinSession = headers.get("x-pin-session") ?? undefined;
  if (isPinSessionValid(pinSession)) return { ok: true, actor: { actor: leadActorId(), source: "pin_session" } };

  const actor = String(headers.get("x-actor-id") ?? "").trim();
  if (!ACTOR_RE.test(actor)) return { ok: false, error: "x_actor_id_required", status: 403 };
  const provided = headers.get("x-op-token") ?? undefined;
  const expected = process.env.OP_MESSAGE_TOKEN ?? "";
  if (!expected) return { ok: false, error: "op_auth_disabled", status: 503 };
  if (!tokenMatches(provided, expected)) return { ok: false, error: "unauthorized", status: 401 };
  return { ok: true, actor: { actor, source: "op_token" } };
}

export function trustedActorFromRequest(
  request: Request,
  opts: { loopbackDashboardActor?: string } = {},
): AuthResult {
  const headers = request.headers;
  const hasExplicitAuth =
    headers.has("x-pin-session") ||
    headers.has("x-op-token") ||
    headers.has("x-actor-id");
  const fromHeaders = trustedActorFromHeaders(headers);
  if (fromHeaders.ok || hasExplicitAuth) return fromHeaders;
  const actor = opts.loopbackDashboardActor;
  if (actor && isLoopbackDashboardRequest(request) && ACTOR_RE.test(actor)) {
    return { ok: true, actor: { actor, source: "loopback_dashboard" } };
  }
  // 여기서 실패한 이유는 "헤더가 없다" 가 아니라 "이 주소를 못 믿는다" 다.
  //   앞서는 위에서 만들어둔 `fromHeaders`(= x_actor_id_required)를 그대로 돌려줬다. 그런데
  //   그 값을 만든 함수는 주소를 한 번도 안 본다 — 헤더만 본다. 그래서 화면에도 로그에도
  //   대시보드가 쓰지도 않는 헤더 이름 이 남았고, 원인을 찾는 사람을 엉뚱한 데로 보냈다.
  //   이름은 `not_local_dashboard` 가 아니라 `dashboard_host_not_trusted` 다(steve) —
  //   이 검사는 loopback 또는 등록된 주소 면 통과하므로, 로컬만 조건인 것처럼 읽히면 안 된다.
  return { ok: false, error: "dashboard_host_not_trusted", status: 403 };
}

// 신뢰 도메인은 앞단 로그인 관문을 전제로 lead 권한을 부여한다. 오리진 직접 노출을 막기 위해 loopback 바인딩을 요구하며 기본 신뢰 도메인은 없다.
function trustedDashboardHosts(): Set<string> {
  return new Set(
    (process.env.TEAM_TRUSTED_DASHBOARD_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

// 와일드카드는 점 경계의 하위 도메인만 신뢰한다. 맨 도메인은 별도 등록해야 하며 새 하위 주소도 자동 신뢰됨에 유의한다.
function isTrustedDashboardHost(value: string, trusted: Set<string>): boolean {
  const host = value.trim().toLowerCase();
  if (isLoopbackHost(host)) return true;
  if (trusted.has(host)) return true;
  for (const entry of trusted) {
    if (!entry.startsWith("*.")) continue;
    const suffix = entry.slice(1); // "*.b3rys.com" → ".b3rys.com"
    if (host.length > suffix.length && host.endsWith(suffix)) return true;
  }
  return false;
}

/** 아래 경고를 요청마다 찍지 않는다 — 한 번만 말하면 된다. */
let warnedBindNotLoopback = false;

/** 테스트 격리용 — '한 번만 경고' 상태를 비운다(앞 테스트가 소모하면 뒤 테스트가 못 본다). */
export function __resetAuthWarningsForTest(): void {
  warnedBindNotLoopback = false;
}

function isLoopbackDashboardRequest(request: Request): boolean {
  const bind = process.env.TEAM_BIND ?? "127.0.0.1";
  if (!isLoopbackHost(bind)) {
    // 설정이 무시된 원인을 알 수 있도록 loopback 바인딩 조건 불충족을 한 번 경고한다.
    if (!warnedBindNotLoopback && trustedDashboardHosts().size > 0) {
      warnedBindNotLoopback = true;
      console.warn(
        "[auth] TEAM_TRUSTED_DASHBOARD_HOSTS 가 설정돼 있지만 적용되지 않습니다 —" +
          ` TEAM_BIND(${bind}) 가 loopback 이 아닙니다. 오리진이 직접 노출된 상태에서는 이 예외를 켜지 않습니다.`,
      );
    }
    return false;
  }
  // Bun은 Host로 request.url의 authority를 만들므로 URL host와 Host를 독립 신호로 취급하지 않는다. 둘 다 해석할 수 없으면 거부한다.
  const trusted = trustedDashboardHosts();
  let host = request.headers.get("host") ?? "";
  if (!host) {
    try {
      host = new URL(request.url).host;
    } catch {
      return false;
    }
  }
  return !!host && isTrustedDashboardHost(hostHeaderName(host), trusted);
}

// 깨진 Host를 잘라서 신뢰 호스트로 복구하지 않는다. [::1]junk 같은 입력은 빈 값으로 반환한다.
function hostHeaderName(value: string): string {
  const v = value.trim();
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end < 0) return ""; // 닫는 괄호가 없다
    const after = v.slice(end + 1);
    if (after && !after.startsWith(":")) return ""; // `]` 뒤에 포트가 아닌 것이 붙어 있다
    return v.slice(1, end);
  }
  return v.split(":")[0] ?? "";
}

function isLoopbackHost(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return v === "localhost" || v === "::1" || /^127(?:\.\d{1,3}){3}$/.test(v);
}

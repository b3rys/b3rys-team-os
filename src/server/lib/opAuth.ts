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
  // ★여기서 실패한 이유는 "헤더가 없다" 가 아니라 "이 주소를 못 믿는다" 다.★ (팀장님 지적 2026-07-30)
  //   앞서는 위에서 만들어둔 `fromHeaders`(= x_actor_id_required)를 그대로 돌려줬다. 그런데
  //   그 값을 만든 함수는 ★주소를 한 번도 안 본다★ — 헤더만 본다. 그래서 화면에도 로그에도
  //   ★대시보드가 쓰지도 않는 헤더 이름★ 이 남았고, 원인을 찾는 사람을 엉뚱한 데로 보냈다.
  //   이름은 `not_local_dashboard` 가 아니라 `dashboard_host_not_trusted` 다(steve) —
  //   이 검사는 loopback ★또는 등록된 주소★ 면 통과하므로, 로컬만 조건인 것처럼 읽히면 안 된다.
  return { ok: false, error: "dashboard_host_not_trusted", status: 403 };
}

/**
 * 이 주소로 들어온 대시보드도 loopback 과 같게 믿는다 — ★기본값 없음(=현행 동작 그대로)★.
 *
 * 왜 필요했나 (2026-07-30 팀장님 실측): 대시보드는 신원을 얻는 경로가 loopback 예외 하나뿐이다
 * (PIN UI 는 2026-06-28 에 제거됐고, 프론트는 어떤 인증 헤더도 보내지 않는다). 그래서 같은 사람이
 * 같은 맥에서 같은 버튼을 눌러도 ★주소창이 127.0.0.1 이면 되고 도메인이면 403★ 이었다.
 * 터널이 요청을 127.0.0.1 로 넘겨주지만 Host 헤더에는 도메인 이름이 남아 서버가 구분할 근거가 없다.
 * 이 때문에 태그 3개가 아니라 ★쓰기 9군데★ 가 앱·도메인에서 전부 막혀 있었다.
 *
 * ★무엇을 믿는 것인지 분명히 한다★: 이건 '신원' 이 아니라 ★'어느 문으로 들어왔나' 를 믿는 것★ 이다.
 * 그 문 앞에 로그인 관문(예: Cloudflare Access)이 있다는 전제에서만 성립한다. 관문이 꺼지면 그 주소를
 * 아는 누구나 lead 권한을 얻고, 감사 로그의 actor 도 전원 같은 이름으로 뭉개진다.
 * 그래서 ①기본값을 비워 공개 설치본의 동작을 바꾸지 않고 ②TEAM_BIND 가 loopback 이어야 한다는
 * 기존 전제를 유지해 오리진이 직접 노출된 상태에서는 켜지지 않게 한다.
 * (근본 해결은 '앱만 붙일 수 있는 키' — 도메인이 아니라 앱을 믿는 방식. 팀장님 방향, 별건 설계.)
 */
function trustedDashboardHosts(): Set<string> {
  return new Set(
    (process.env.TEAM_TRUSTED_DASHBOARD_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * loopback 이거나, 운영자가 등록한 대시보드 주소인가.
 *
 * 등록 형식 두 가지 — 정확한 이름(`dev.b3rys.com`) 또는 ★하위 주소 전체(`*.b3rys.com`)★.
 * 와일드카드는 팀장님 지시(2026-07-30)다: 소유한 도메인의 하위 주소를 새로 열 때마다 설정을 고치지
 * 않아도 되게. 대가는 ★그 도메인 아래 새로 생기는 주소가 자동으로 신뢰된다★ 는 것이다.
 *
 * ★접미사 오매치를 막는다★ — `*.b3rys.com` 은 `evilb3rys.com` 이나 `b3rys.com.attacker.net` 에
 * 걸리면 안 된다. 그래서 단순 endsWith 가 아니라 ★점 경계★ 로 본다. 그리고 와일드카드는 ★하위 주소만★
 * 이므로 맨 도메인(`b3rys.com`)은 따로 적어야 통과한다(의도를 흐리지 않는다).
 */
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
    // ★등록했는데 안 켜지면 사람은 "설정이 안 먹네" 로 읽고 원인을 못 찾는다★ (bill 리뷰).
    //   조용히 거부하지 않고 왜 안 켜지는지 한 번 말한다. 오늘 우리가 반복해서 만난 실패 모양이다.
    if (!warnedBindNotLoopback && trustedDashboardHosts().size > 0) {
      warnedBindNotLoopback = true;
      console.warn(
        "[auth] TEAM_TRUSTED_DASHBOARD_HOSTS 가 설정돼 있지만 적용되지 않습니다 —" +
          ` TEAM_BIND(${bind}) 가 loopback 이 아닙니다. 오리진이 직접 노출된 상태에서는 이 예외를 켜지 않습니다.`,
      );
    }
    return false;
  }
  let urlHost = "";
  try {
    urlHost = new URL(request.url).hostname;
  } catch {
    return false;
  }
  const trusted = trustedDashboardHosts();
  const hostHeader = request.headers.get("host") ?? "";
  // urlHost 는 여전히 loopback 이어야 한다 — 요청이 실제로 이 서버 소켓에 닿았다는 뜻이다.
  //   등록된 주소는 ★Host 헤더★ 쪽에서만 허용한다(터널이 남기는 이름이 그것뿐이다).
  return isLoopbackHost(urlHost) && (!hostHeader || isTrustedDashboardHost(hostHeaderName(hostHeader), trusted));
}

function hostHeaderName(value: string): string {
  const v = value.trim();
  if (v.startsWith("[")) return v.slice(1, v.indexOf("]") >= 0 ? v.indexOf("]") : undefined);
  return v.split(":")[0] ?? "";
}

function isLoopbackHost(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return v === "localhost" || v === "::1" || /^127(?:\.\d{1,3}){3}$/.test(v);
}

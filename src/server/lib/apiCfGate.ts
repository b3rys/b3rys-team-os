/**
 * /api 원격 게이트 — Cloudflare Access 증명서(JWT)로 원격 호출을 검증한다.
 *
 * 왜 필요한가: /team/api 는 지금까지 CF 엣지 로그인(302)만이 방어였고, 서버는 Host=dev.b3rys.com 을
 * 신뢰 대시보드로 보고 lead 로 취급했다(opAuth). 원격 앱(Steno)이 서비스 토큰으로 붙으려면
 * ① CF 가 붙여준 증명서를 서버가 직접 검증하고 ② 그 서비스 토큰이 우리 매핑표에 있어야 한다 —
 * /team/mcp 가 이미 하는 방식(mcpAuth)을 /api 에도 그대로 적용한다.
 *
 * 로컬 호출은 검사하지 않는다: Host 가 loopback 이고 CF 프록시 헤더(cf-ray·cf-connecting-ip)가 없으면 로컬이다.
 * 터널을 지나온 요청은 TCP 로는 127.0.0.1 에서 오지만 Host 가 공개 도메인이고 CF 헤더가 붙는다 — 그래서
 * 소켓 주소가 아니라 이 둘로 가른다. (로컬 호출자가 Host 를 꾸며도 로컬은 원래 신뢰 범위다.)
 *
 * 설정(env):
 *   B3OS_API_CF_AUD          허용 Access 앱 AUD, 쉼표 구분. ★비어 있으면 게이트 off★(현행 유지 — 엣지만 방어).
 *   B3OS_MCP_CF_TEAM_DOMAIN  팀 도메인(mcpAuth 와 공유).
 *   B3OS_MCP_PRINCIPALS      서비스 토큰 subject → agent 매핑(mcpAuth 와 공유). 사람 로그인은 매핑 없이 통과.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { JWTPayload } from "jose";
import { CF_JWT_HEADER, parsePrincipalMap, subjectFromPayload, verifyCfAccessJwt } from "../mcp/mcpAuth";

export interface ApiCfGateConfig {
  teamDomain: string | undefined;
  audiences: string[];
  principals: Map<string, { agentId: string; scope: "read" | "write" }>;
}

export function loadApiCfGateConfig(env: Record<string, string | undefined> = process.env): ApiCfGateConfig {
  return {
    teamDomain: env.B3OS_MCP_CF_TEAM_DOMAIN?.trim() || undefined,
    audiences: (env.B3OS_API_CF_AUD ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    principals: parsePrincipalMap(env.B3OS_MCP_PRINCIPALS),
  };
}

/** Host 헤더에서 이름만(포트 제거). 형식이 깨지면 빈 값 — 이름을 지어내지 않는다. */
function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : "";
  }
  const i = h.indexOf(":");
  return i >= 0 ? h.slice(0, i) : h;
}

function isLoopbackName(name: string): boolean {
  return name === "localhost" || name === "::1" || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** CF 프록시를 지나온 요청에는 항상 붙는 헤더 — 클라이언트가 지울 수 없다. */
const CF_PROXY_HEADERS = ["cf-ray", "cf-connecting-ip"] as const;

/** 로컬 호출인가 — Host 가 loopback 이고 CF 프록시 헤더가 없다. */
export function isLocalApiRequest(req: Request): boolean {
  for (const h of CF_PROXY_HEADERS) if (req.headers.get(h)) return false;
  let host = req.headers.get("host") ?? "";
  if (!host) {
    try {
      host = new URL(req.url).host;
    } catch {
      return false;
    }
  }
  return isLoopbackName(hostName(host));
}

export interface ApiCfPrincipal {
  subject: string;
  kind: "service_token" | "user";
  /** 서비스 토큰이면 매핑된 agent. 사람 로그인은 없음. */
  agentId?: string;
  scope?: "read" | "write";
}

export type ApiCfGateResult =
  | { ok: true; local: true }
  | { ok: true; local: false; principal: ApiCfPrincipal }
  | { ok: false; status: 401 | 403 | 503; reason: string };

export interface ApiCfGateDeps {
  config?: () => ApiCfGateConfig;
  verify?: typeof verifyCfAccessJwt;
  onDeny?: (reason: string, detail: Record<string, unknown>) => void;
}

/** 요청 하나를 판정한다. 미들웨어와 시험이 같은 함수를 부른다. */
export async function evaluateApiCfGate(req: Request, cfg: ApiCfGateConfig, verify = verifyCfAccessJwt): Promise<ApiCfGateResult> {
  if (cfg.audiences.length === 0) return { ok: true, local: true }; // 게이트 off — 설정 전까지 현행 유지
  if (isLocalApiRequest(req)) return { ok: true, local: true };
  // 여기부터 원격. aud 는 있는데 팀 도메인이 없으면 검증할 수 없다 → 열지 않는다(fail-closed).
  if (!cfg.teamDomain) return { ok: false, status: 503, reason: "api_cf_gate_misconfigured" };
  const token = req.headers.get(CF_JWT_HEADER)?.trim();
  if (!token) return { ok: false, status: 401, reason: "missing_access_jwt" };
  const payload: JWTPayload | null = await verify(token, cfg.teamDomain, cfg.audiences);
  if (!payload) return { ok: false, status: 401, reason: "invalid_access_jwt" };
  const subj = subjectFromPayload(payload);
  if (!subj) return { ok: false, status: 403, reason: "no_subject_in_jwt" };
  if (subj.kind === "user") return { ok: true, local: false, principal: { subject: subj.subject, kind: "user" } };
  // 서비스 토큰은 매핑표에 있어야 한다 — CF 가 통과시킨 토큰이라도 우리가 모르는 것은 거부(이중 게이트, MCP 와 동일).
  const mapped = cfg.principals.get(subj.subject);
  if (!mapped) return { ok: false, status: 403, reason: "subject_not_mapped" };
  return { ok: true, local: false, principal: { subject: subj.subject, kind: "service_token", agentId: mapped.agentId, scope: mapped.scope } };
}

/** Hono 미들웨어. 통과한 원격 신원은 `c.get("apiCfPrincipal")` 로 뒤 핸들러가 읽을 수 있다. */
export function apiCfGate(deps: ApiCfGateDeps = {}): MiddlewareHandler {
  const loadConfig = deps.config ?? loadApiCfGateConfig;
  const verify = deps.verify ?? verifyCfAccessJwt;
  return async (c: Context, next) => {
    const r = await evaluateApiCfGate(c.req.raw, loadConfig(), verify);
    if (!r.ok) {
      deps.onDeny?.(r.reason, { status: r.status, path: new URL(c.req.url).pathname, host: c.req.header("host") ?? "" });
      return c.json({ error: r.reason }, r.status);
    }
    if (!r.local) c.set("apiCfPrincipal", r.principal);
    await next();
  };
}

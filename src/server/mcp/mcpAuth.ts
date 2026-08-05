/**
 * MCP HTTP 경로 인증 — Cloudflare Access 가 붙여준 신원 증명서(JWT)를 검증해 b3os 신원으로 바꾼다.
 *
 * ★왜 별도 파일인가★: 대시보드 인증(opAuth)은 "루프백이면 lead" 를 신뢰한다. 그건 같은 머신 전제라
 * 맞는 규칙이지만, MCP 는 ★밖에서 들어오는 경로★ 라 그대로 쓰면 서버에 닿은 모든 요청이 lead 가 된다.
 * → opAuth 재사용 금지. 이 파일이 MCP 전용 신원 판정의 단일 지점이다.
 *
 * ★검증 순서(fail-closed)★
 *  1. Cf-Access-Jwt-Assertion 헤더 존재
 *  2. 서명 검증 — Access 팀 도메인의 공개키(JWKS)로. ★헤더 존재만 믿으면 위조 가능★(CF 문서 명시)
 *  3. aud 가 우리 애플리케이션인지
 *  4. exp/nbf 유효
 *  5. 증명서의 주체(서비스토큰=common_name / 사람=email)를 매핑표로 b3os agent id 로 변환
 *  6. 그 agent 가 레지스트리에 있는지는 호출부(resolveActor)가 다시 확인 — 이중 게이트
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface McpPrincipal {
  /** b3os agent id (레지스트리 등록값). */
  agentId: string;
  /** 이 신원이 쓸 수 있는 범위. read = 조회만, write = 쓰기 도구까지. */
  scope: "read" | "write";
  /** 증명서상 주체 — 감사 로그용(서비스토큰 client id 또는 이메일). */
  subject: string;
  /** 사람 로그인인지 서비스 토큰인지. */
  kind: "service_token" | "user";
}

export type McpAuthResult =
  | { ok: true; principal: McpPrincipal }
  | { ok: false; status: 401 | 403; reason: string };

/** CF Access 가 원본 서버로 넘겨주는 증명서 헤더 이름. */
export const CF_JWT_HEADER = "cf-access-jwt-assertion";

/**
 * 매핑표 — 증명서 주체 → b3os 신원·권한.
 * 형식: `<subject>:<agentId>:<read|write>` 를 콤마로 이어서 env 로 준다.
 * 예) B3OS_MCP_PRINCIPALS="abc123.access:gd:write,ops@example.com:gd:read"
 *
 * ★비밀값이 아니다★ — 서비스 토큰의 client id 는 공개 식별자다. secret 은 CF 가 검증하고 우리에게 오지 않는다.
 */
export function parsePrincipalMap(raw: string | undefined): Map<string, { agentId: string; scope: "read" | "write" }> {
  const map = new Map<string, { agentId: string; scope: "read" | "write" }>();
  if (!raw?.trim()) return map;
  for (const entry of raw.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length !== 3) continue; // 형식 안 맞으면 조용히 버린다(fail-closed: 매핑 없으면 거부됨)
    const [subject, agentId, scope] = parts.map((s) => s.trim());
    if (!subject || !agentId) continue;
    if (scope !== "read" && scope !== "write") continue; // 오타로 write 가 열리지 않게 화이트리스트
    map.set(subject, { agentId, scope });
  }
  return map;
}

/**
 * 증명서 payload 에서 주체를 뽑는다.
 * 서비스 토큰 = common_name(=CF-Access-Client-Id), sub 는 빈 문자열.
 * 사람 로그인 = email.
 */
export function subjectFromPayload(payload: JWTPayload): { subject: string; kind: "service_token" | "user" } | null {
  const commonName = typeof payload.common_name === "string" ? payload.common_name.trim() : "";
  if (commonName) return { subject: commonName, kind: "service_token" };
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email) return { subject: email, kind: "user" };
  return null;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksTeamDomain = "";

/** 팀 도메인의 공개키 묶음. jose 가 캐시·갱신을 맡는다(요청마다 네트워크로 안 나감). */
function jwksFor(teamDomain: string) {
  if (!jwks || jwksTeamDomain !== teamDomain) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksTeamDomain = teamDomain;
  }
  return jwks;
}

export interface McpAuthConfig {
  /** 예: b3rys.cloudflareaccess.com */
  teamDomain: string | undefined;
  /** Access 애플리케이션의 AUD 태그. */
  audience: string | undefined;
  /** 주체 → 신원·권한 매핑. */
  principals: Map<string, { agentId: string; scope: "read" | "write" }>;
}

export function loadMcpAuthConfig(env: Record<string, string | undefined> = process.env): McpAuthConfig {
  return {
    teamDomain: env.B3OS_MCP_CF_TEAM_DOMAIN?.trim() || undefined,
    audience: env.B3OS_MCP_CF_AUD?.trim() || undefined,
    principals: parsePrincipalMap(env.B3OS_MCP_PRINCIPALS),
  };
}

/**
 * 요청 하나를 인증한다. ★설정이 비어 있으면 열지 않고 막는다★(fail-closed) —
 * 설정을 깜빡한 서버가 조용히 무인증으로 열리는 게 가장 위험하다.
 */
export async function authenticateMcpRequest(req: Request, cfg: McpAuthConfig): Promise<McpAuthResult> {
  if (!cfg.teamDomain || !cfg.audience) {
    return { ok: false, status: 403, reason: "mcp_auth_not_configured" };
  }
  const token = req.headers.get(CF_JWT_HEADER)?.trim();
  if (!token) return { ok: false, status: 401, reason: "missing_access_jwt" };

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, jwksFor(cfg.teamDomain), {
      audience: cfg.audience,
      issuer: `https://${cfg.teamDomain}`,
    });
    payload = verified.payload;
  } catch {
    // 서명·만료·aud·iss 중 하나라도 어긋나면 여기로 온다. 이유를 밖으로 자세히 알리지 않는다.
    return { ok: false, status: 401, reason: "invalid_access_jwt" };
  }

  const subj = subjectFromPayload(payload);
  if (!subj) return { ok: false, status: 403, reason: "no_subject_in_jwt" };

  const mapped = cfg.principals.get(subj.subject);
  if (!mapped) return { ok: false, status: 403, reason: "subject_not_mapped" };

  return {
    ok: true,
    principal: { agentId: mapped.agentId, scope: mapped.scope, subject: subj.subject, kind: subj.kind },
  };
}

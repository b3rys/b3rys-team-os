// MCP HTTP 인증 — 매핑 파싱·주체 추출·거부 경로. ★뚫어보는 시험★ 위주로 짠다.
import { test, expect } from "bun:test";
import { parsePrincipalMap, subjectFromPayload, authenticateMcpRequest, CF_JWT_HEADER, type McpAuthConfig } from "./mcpAuth";

const cfg = (over: Partial<McpAuthConfig> = {}): McpAuthConfig => ({
  teamDomain: "team.cloudflareaccess.com",
  audience: "aud-tag",
  principals: parsePrincipalMap("tok1.access:gd:write,ops@example.com:demis:read"),
  ...over,
});
const req = (headers: Record<string, string> = {}) => new Request("https://x/team/mcp", { method: "POST", headers });

// ── 매핑 파싱 ──

test("정상 매핑을 읽는다", () => {
  const m = parsePrincipalMap("tok1.access:gd:write,ops@example.com:demis:read");
  expect(m.get("tok1.access")).toEqual({ agentId: "gd", scope: "write" });
  expect(m.get("ops@example.com")).toEqual({ agentId: "demis", scope: "read" });
});

test("★오타난 권한은 통과시키지 않는다★ — write 가 실수로 열리면 안 된다", () => {
  const m = parsePrincipalMap("tok1.access:gd:WRITE,tok2.access:gd:wrtie,tok3.access:gd:admin");
  expect(m.size).toBe(0); // 셋 다 read/write 가 아니므로 전부 버림
});

test("형식이 깨진 항목은 버리고 나머지는 살린다", () => {
  const m = parsePrincipalMap("깨짐,tok1.access:gd:write,a:b,:x:read");
  expect(m.size).toBe(1);
  expect(m.get("tok1.access")?.agentId).toBe("gd");
});

test("설정이 비어 있으면 매핑도 비어 있다(아무도 통과 못 함)", () => {
  expect(parsePrincipalMap(undefined).size).toBe(0);
  expect(parsePrincipalMap("   ").size).toBe(0);
});

// ── 주체 추출 ──

test("서비스 토큰은 common_name 을 주체로 쓴다", () => {
  expect(subjectFromPayload({ common_name: "tok1.access", sub: "" })).toEqual({ subject: "tok1.access", kind: "service_token" });
});

test("사람 로그인은 email 을 주체로 쓰고 소문자로 맞춘다", () => {
  expect(subjectFromPayload({ email: "Ops@Example.COM" })).toEqual({ subject: "ops@example.com", kind: "user" });
});

test("★둘 다 없으면 주체 없음★ — 신원 미상은 통과시키지 않는다", () => {
  expect(subjectFromPayload({ sub: "abc" })).toBeNull();
  expect(subjectFromPayload({})).toBeNull();
});

test("common_name 이 있으면 email 보다 우선(서비스 토큰 판정)", () => {
  const r = subjectFromPayload({ common_name: "tok1.access", email: "x@y.z" });
  expect(r?.kind).toBe("service_token");
});

// ── 거부 경로 (fail-closed) ──

test("★설정이 없으면 열리지 않는다★ — 깜빡한 서버가 무인증으로 열리는 게 제일 위험하다", async () => {
  const r = await authenticateMcpRequest(req({ [CF_JWT_HEADER]: "x" }), cfg({ teamDomain: undefined }));
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.status).toBe(403); expect(r.reason).toBe("mcp_auth_not_configured"); }
});

test("aud 설정이 없어도 열리지 않는다", async () => {
  const r = await authenticateMcpRequest(req({ [CF_JWT_HEADER]: "x" }), cfg({ audience: undefined }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("mcp_auth_not_configured");
});

test("★증명서 헤더가 없으면 401★ — CF 를 우회해 원본에 직접 닿아도 막힌다", async () => {
  const r = await authenticateMcpRequest(req(), cfg());
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.status).toBe(401); expect(r.reason).toBe("missing_access_jwt"); }
});

test("★위조 증명서는 거부★ — 헤더가 있다는 것만으로 믿지 않는다(서명 검증)", async () => {
  // 서명이 맞지 않는 형태만 갖춘 토큰. 네트워크(JWKS)까지 가기 전에 형식·서명에서 걸린다.
  const fake = "eyJhbGciOiJSUzI1NiJ9.eyJjb21tb25fbmFtZSI6InRvazEuYWNjZXNzIn0.bm90LWEtc2lnbmF0dXJl";
  const r = await authenticateMcpRequest(req({ [CF_JWT_HEADER]: fake }), cfg());
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.status).toBe(401); expect(r.reason).toBe("invalid_access_jwt"); }
});

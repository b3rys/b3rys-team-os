/**
 * /api 원격 게이트 — 로컬은 그대로, 원격은 CF Access 증명서로만.
 * 진짜 JWKS 대신 verify 를 주입해 판정 로직만 잰다(서명 검증 자체는 mcpAuth 시험이 맡는다).
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { apiCfGate, evaluateApiCfGate, isLocalApiRequest, loadApiCfGateConfig, type ApiCfGateConfig } from "./apiCfGate";
import { CF_JWT_HEADER } from "../mcp/mcpAuth";

const cfg = (over: Partial<ApiCfGateConfig> = {}): ApiCfGateConfig => ({
  teamDomain: "team.cloudflareaccess.com",
  audiences: ["aud-team"],
  principals: new Map([["steno1.access", { agentId: "gd", scope: "write" as const }]]),
  ...over,
});
const req = (headers: Record<string, string>, url = "http://127.0.0.1:7878/team/api/members") => new Request(url, { headers });
const remote = (extra: Record<string, string> = {}) => req({ host: "dev.b3rys.com", "cf-ray": "abc-HKG", "cf-connecting-ip": "1.2.3.4", ...extra });
/** 가짜 검증기: 토큰 문자열이 곧 payload JSON 이다. "bad" 는 서명 실패. */
const fakeVerify = async (token: string, _domain: string, audience: string | string[]) => {
  if (token === "bad") return null;
  const p = JSON.parse(token) as Record<string, unknown>;
  const auds = Array.isArray(audience) ? audience : [audience];
  return auds.includes(String(p.aud)) ? p : null;
};
const svc = (aud = "aud-team", cn = "steno1.access") => JSON.stringify({ aud, common_name: cn });
const user = (aud = "aud-team") => JSON.stringify({ aud, email: "Lead@Example.com" });

describe("로컬 판정", () => {
  test("Host 가 loopback 이고 CF 헤더가 없으면 로컬", () => {
    expect(isLocalApiRequest(req({ host: "127.0.0.1:7878" }))).toBe(true);
    expect(isLocalApiRequest(req({ host: "localhost:7878" }))).toBe(true);
    expect(isLocalApiRequest(req({ host: "[::1]:7878" }))).toBe(true);
    expect(isLocalApiRequest(req({}))).toBe(true); // Host 없음 → url 의 host(127.0.0.1)
  });
  test("공개 도메인이면 원격", () => {
    expect(isLocalApiRequest(req({ host: "dev.b3rys.com" }))).toBe(false);
  });
  test("★Host 를 loopback 으로 꾸며도 CF 프록시 헤더가 있으면 원격★ — 터널을 지나온 요청은 항상 이 헤더를 단다", () => {
    expect(isLocalApiRequest(req({ host: "127.0.0.1:7878", "cf-ray": "x" }))).toBe(false);
    expect(isLocalApiRequest(req({ host: "127.0.0.1:7878", "cf-connecting-ip": "1.2.3.4" }))).toBe(false);
  });
  test("깨진 Host([::1 닫힘 없음)는 이름을 지어내지 않고 원격으로 본다", () => {
    expect(isLocalApiRequest(req({ host: "[::1junk" }))).toBe(false);
  });
});

describe("판정", () => {
  test("★aud 설정이 비어 있으면 게이트 off★ — 원격 무헤더도 통과(설정 전까지 현행 유지, 엣지가 방어)", async () => {
    const r = await evaluateApiCfGate(remote(), cfg({ audiences: [] }), fakeVerify);
    expect(r.ok).toBe(true);
  });
  test("로컬은 증명서 없이 통과", async () => {
    const r = await evaluateApiCfGate(req({ host: "127.0.0.1:7878" }), cfg(), fakeVerify);
    expect(r).toEqual({ ok: true, local: true });
  });
  test("원격 무증명서 → 401", async () => {
    const r = await evaluateApiCfGate(remote(), cfg(), fakeVerify);
    expect(r).toEqual({ ok: false, status: 401, reason: "missing_access_jwt" });
  });
  test("원격 위조 증명서 → 401", async () => {
    const r = await evaluateApiCfGate(remote({ [CF_JWT_HEADER]: "bad" }), cfg(), fakeVerify);
    expect(r).toEqual({ ok: false, status: 401, reason: "invalid_access_jwt" });
  });
  test("다른 앱의 증명서(aud 불일치) → 401", async () => {
    const r = await evaluateApiCfGate(remote({ [CF_JWT_HEADER]: svc("aud-other") }), cfg(), fakeVerify);
    expect(r).toEqual({ ok: false, status: 401, reason: "invalid_access_jwt" });
  });
  test("aud 여럿 허용 — 둘째 앱의 증명서도 통과", async () => {
    const r = await evaluateApiCfGate(remote({ [CF_JWT_HEADER]: svc("aud-mcp") }), cfg({ audiences: ["aud-team", "aud-mcp"] }), fakeVerify);
    expect(r.ok).toBe(true);
  });
  test("매핑된 서비스 토큰 → 통과 + agent·scope 가 붙는다", async () => {
    const r = await evaluateApiCfGate(remote({ [CF_JWT_HEADER]: svc() }), cfg(), fakeVerify);
    expect(r).toEqual({ ok: true, local: false, principal: { subject: "steno1.access", kind: "service_token", agentId: "gd", scope: "write" } });
  });
  test("★매핑 없는 서비스 토큰 → 403★ — CF 가 통과시켜도 우리가 모르는 토큰은 거부(이중 게이트)", async () => {
    const r = await evaluateApiCfGate(remote({ [CF_JWT_HEADER]: svc("aud-team", "stranger.access") }), cfg(), fakeVerify);
    expect(r).toEqual({ ok: false, status: 403, reason: "subject_not_mapped" });
  });
  test("사람 로그인(email)은 매핑 없이 통과 — 누가 로그인할 수 있는지는 CF 정책이 정한다", async () => {
    const r = await evaluateApiCfGate(remote({ [CF_JWT_HEADER]: user() }), cfg(), fakeVerify);
    expect(r).toEqual({ ok: true, local: false, principal: { subject: "lead@example.com", kind: "user" } });
  });
  test("주체 없는 증명서 → 403", async () => {
    const r = await evaluateApiCfGate(remote({ [CF_JWT_HEADER]: JSON.stringify({ aud: "aud-team" }) }), cfg(), fakeVerify);
    expect(r).toEqual({ ok: false, status: 403, reason: "no_subject_in_jwt" });
  });
  test("★aud 는 있는데 팀 도메인이 없으면 원격을 열지 않는다(503)★ — 검증 못 하는 상태로 열리지 않게", async () => {
    const r = await evaluateApiCfGate(remote({ [CF_JWT_HEADER]: svc() }), cfg({ teamDomain: undefined }), fakeVerify);
    expect(r).toEqual({ ok: false, status: 503, reason: "api_cf_gate_misconfigured" });
  });
});

describe("미들웨어 배선", () => {
  const build = (c: ApiCfGateConfig, denied: string[] = []) => {
    const app = new Hono();
    app.use("*", apiCfGate({ config: () => c, verify: fakeVerify, onDeny: (reason) => denied.push(reason) }));
    app.get("/api/members", (c2) => c2.json({ ok: true, principal: c2.get("apiCfPrincipal" as never) ?? null }));
    return app;
  };
  test("원격 무증명서는 핸들러에 닿지 않고 401 JSON + 거부 기록", async () => {
    const denied: string[] = [];
    const res = await build(cfg(), denied).request("http://127.0.0.1:7878/api/members", { headers: { host: "dev.b3rys.com", "cf-ray": "x" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_access_jwt" });
    expect(denied).toEqual(["missing_access_jwt"]);
  });
  test("로컬은 200, 신원 없음", async () => {
    const res = await build(cfg()).request("http://127.0.0.1:7878/api/members", { headers: { host: "127.0.0.1:7878" } });
    expect(res.status).toBe(200);
    expect((await res.json()).principal).toBeNull();
  });
  test("매핑된 서비스 토큰은 200, 뒤 핸들러가 신원을 읽는다", async () => {
    const res = await build(cfg()).request("http://127.0.0.1:7878/api/members", { headers: { host: "dev.b3rys.com", "cf-ray": "x", [CF_JWT_HEADER]: svc() } });
    expect(res.status).toBe(200);
    expect((await res.json()).principal.agentId).toBe("gd");
  });
});

describe("설정 읽기", () => {
  test("B3OS_API_CF_AUD 쉼표 목록 · 팀 도메인·매핑은 MCP 와 공유", () => {
    const c = loadApiCfGateConfig({ B3OS_API_CF_AUD: " a1 , a2 ,", B3OS_MCP_CF_TEAM_DOMAIN: "t.cloudflareaccess.com", B3OS_MCP_PRINCIPALS: "x.access:gd:write" });
    expect(c.audiences).toEqual(["a1", "a2"]);
    expect(c.teamDomain).toBe("t.cloudflareaccess.com");
    expect(c.principals.get("x.access")).toEqual({ agentId: "gd", scope: "write" });
  });
  test("비어 있으면 aud 0개(게이트 off)", () => {
    expect(loadApiCfGateConfig({}).audiences).toEqual([]);
  });
});

describe("배선 — 게이트는 라우트보다 먼저 등록돼야 한다", () => {
  test("★index.ts 에서 apiCfGate 등록이 첫 api.route/api.get 보다 앞이다★ — Hono 는 등록 순서대로 실행하므로 뒤에 두면 앞 라우트는 검사 없이 답한다", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");
    const gateAt = src.indexOf('api.use("*", apiCfGate(');
    const firstRoute = Math.min(...["api.route(", "api.get(", "api.post(", "api.patch(", "api.delete("].map((s) => src.indexOf(s)).filter((i) => i >= 0));
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(firstRoute);
  });
});

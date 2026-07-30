import { afterEach, describe, expect, test } from "bun:test";
import { trustedActorFromHeaders, trustedActorFromRequest } from "./opAuth";

afterEach(() => {
  delete process.env.OP_MESSAGE_TOKEN;
  delete process.env.TEAM_TRUSTED_DASHBOARD_HOSTS;
  delete process.env.TEAM_BIND;
});

describe("op auth shared token", () => {
  test("a valid shared token authenticates any valid actor id", () => {
    process.env.OP_MESSAGE_TOKEN = "shared-secret";
    expect(trustedActorFromHeaders(new Headers({ "x-op-token": "shared-secret", "x-actor-id": "bill" }))).toMatchObject({
      ok: true,
      actor: { actor: "bill", source: "op_token" },
    });
    expect(trustedActorFromHeaders(new Headers({ "x-op-token": "shared-secret", "x-actor-id": "devon" }))).toMatchObject({
      ok: true,
      actor: { actor: "devon", source: "op_token" },
    });
  });

  test("an invalid shared token is rejected", () => {
    process.env.OP_MESSAGE_TOKEN = "shared-secret";
    expect(trustedActorFromHeaders(new Headers({ "x-op-token": "wrong-secret", "x-actor-id": "devon" }))).toMatchObject({
      ok: false,
      status: 401,
      error: "unauthorized",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 대시보드 신원 — ★주소창만 달라도 결과가 갈렸다★ (2026-07-30 팀장님 실측)
//   대시보드는 인증 헤더를 하나도 안 보내므로 loopback 예외 하나에만 의존한다. 그래서 도메인·앱으로
//   들어오면 태그·보고서·제안 쓰기 9군데가 전부 403(x_actor_id_required) 이었다.
//   ★여기에 테스트가 없어서 코드 리뷰·CI 로 잡히지 않았다★ — 그래서 양방향을 못박는다.
// ─────────────────────────────────────────────────────────────────────────────
describe("대시보드 loopback 예외 + 등록한 주소", () => {
  const req = (host: string) =>
    new Request("http://127.0.0.1:7878/team/api/tags", { method: "POST", headers: { host } });

  test("loopback Host 는 통과한다 (기존 동작 — 이게 깨지면 로컬 대시보드가 죽는다)", () => {
    expect(trustedActorFromRequest(req("127.0.0.1:7878"), { loopbackDashboardActor: "gd" })).toMatchObject({
      ok: true,
      actor: { actor: "gd", source: "loopback_dashboard" },
    });
    expect(trustedActorFromRequest(req("localhost:7878"), { loopbackDashboardActor: "gd" })).toMatchObject({ ok: true });
  });

  test("★도메인 Host 는 등록 없이는 거절한다★ (신고된 그 증상)", () => {
    expect(trustedActorFromRequest(req("dev.b3rys.com"), { loopbackDashboardActor: "gd" })).toMatchObject({
      ok: false,
      status: 403,
      error: "x_actor_id_required",
    });
  });

  test("★등록한 주소는 통과한다★ — 등록은 env 로만, 기본값은 비어 있다", () => {
    process.env.TEAM_TRUSTED_DASHBOARD_HOSTS = "dev.b3rys.com, studio.b3rys.com";
    expect(trustedActorFromRequest(req("dev.b3rys.com"), { loopbackDashboardActor: "gd" })).toMatchObject({
      ok: true,
      actor: { actor: "gd", source: "loopback_dashboard" },
    });
    expect(trustedActorFromRequest(req("studio.b3rys.com"), { loopbackDashboardActor: "gd" })).toMatchObject({ ok: true });
    // 등록하지 않은 다른 도메인은 그대로 막힌다 — 목록이 아니라 와일드카드가 되면 안 된다.
    expect(trustedActorFromRequest(req("evil.example.com"), { loopbackDashboardActor: "gd" })).toMatchObject({ ok: false });
  });

  test("Host 대소문자·포트가 붙어도 등록 판정은 같다", () => {
    process.env.TEAM_TRUSTED_DASHBOARD_HOSTS = "dev.b3rys.com";
    expect(trustedActorFromRequest(req("DEV.B3RYS.COM:443"), { loopbackDashboardActor: "gd" })).toMatchObject({ ok: true });
  });

  test("★서버가 loopback 에 묶여 있지 않으면 등록해도 안 켜진다★ — 오리진 직접 노출 방어", () => {
    process.env.TEAM_TRUSTED_DASHBOARD_HOSTS = "dev.b3rys.com";
    process.env.TEAM_BIND = "0.0.0.0";
    expect(trustedActorFromRequest(req("dev.b3rys.com"), { loopbackDashboardActor: "gd" })).toMatchObject({ ok: false });
  });

  test("인증 헤더가 있으면 이 예외는 시도되지 않는다 (fail-fast 유지)", () => {
    process.env.TEAM_TRUSTED_DASHBOARD_HOSTS = "dev.b3rys.com";
    const r = new Request("http://127.0.0.1:7878/team/api/tags", {
      method: "POST",
      headers: { host: "dev.b3rys.com", "x-actor-id": "gd" },
    });
    // 토큰이 없으므로 op_auth_disabled/unauthorized 로 떨어진다 — loopback 예외로 새지 않는다.
    expect(trustedActorFromRequest(r, { loopbackDashboardActor: "gd" }).ok).toBe(false);
  });
});

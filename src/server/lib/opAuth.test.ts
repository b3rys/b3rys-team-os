import { afterEach, describe, expect, test } from "bun:test";
import { trustedActorFromHeaders, trustedActorFromRequest, __resetAuthWarningsForTest } from "./opAuth";

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
//   들어오면 태그·보고서·제안 쓰기가 전부 403 이었다(이름은 2026-07-30 에 dashboard_host_not_trusted 로 정정).
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
      // ★이름이 실패 이유를 가리켜야 한다★ — 앞서는 헤더 검사의 실패값(x_actor_id_required)이
      //   그대로 돌아왔다. 대시보드는 그 헤더를 아예 안 쓰는데도.
      error: "dashboard_host_not_trusted",
    });
  });

  test("★헤더를 보냈는데 형식이 틀린 경우는 여전히 x_actor_id_required★ — 두 실패를 섞지 않는다", () => {
    // 이름을 바꾼 건 "주소를 못 믿는다" 쪽뿐이다. 헤더 경로의 실패는 그대로여야 한다.
    const r = new Request("http://127.0.0.1:7878/team/api/x", {
      method: "PATCH",
      headers: { host: "127.0.0.1:7878", "x-actor-id": "!!not-a-valid-id!!" },
    });
    expect(trustedActorFromRequest(r, { loopbackDashboardActor: "gd" })).toMatchObject({
      ok: false,
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
    // 등록하지 않은 다른 도메인은 그대로 막힌다.
    expect(trustedActorFromRequest(req("evil.example.com"), { loopbackDashboardActor: "gd" })).toMatchObject({ ok: false });
  });

  test("★와일드카드는 하위 주소 전체를 받는다★ (팀장님 지시 — 소유 도메인)", () => {
    process.env.TEAM_TRUSTED_DASHBOARD_HOSTS = "*.b3rys.com";
    for (const h of ["dev.b3rys.com", "studio.b3rys.com", "a.b.b3rys.com", "DEV.B3RYS.COM:443"]) {
      expect(trustedActorFromRequest(req(h), { loopbackDashboardActor: "gd" }).ok, h).toBe(true);
    }
  });

  test("★와일드카드가 접미사만 같은 남의 도메인에 걸리지 않는다★ (단순 endsWith 금지)", () => {
    process.env.TEAM_TRUSTED_DASHBOARD_HOSTS = "*.b3rys.com";
    for (const h of ["evilb3rys.com", "b3rys.com.attacker.net", "b3rys.com", "notb3rys.com"]) {
      expect(trustedActorFromRequest(req(h), { loopbackDashboardActor: "gd" }).ok, h).toBe(false);
    }
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

  test("★안 켜질 때 조용히 끝내지 않고 이유를 말한다★ (bill 리뷰 — '설정이 안 먹네' 방지)", () => {
    process.env.TEAM_TRUSTED_DASHBOARD_HOSTS = "dev.b3rys.com";
    process.env.TEAM_BIND = "0.0.0.0";
    __resetAuthWarningsForTest();
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    try {
      trustedActorFromRequest(req("dev.b3rys.com"), { loopbackDashboardActor: "gd" });
    } finally {
      console.warn = original;
    }
    // 등록이 있는데 TEAM_BIND 때문에 못 켜는 상황을 한 줄로 알린다(경고 문구에 두 이름이 다 들어간다).
    expect(warned.join("\n")).toContain("TEAM_TRUSTED_DASHBOARD_HOSTS");
    expect(warned.join("\n")).toContain("TEAM_BIND");
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

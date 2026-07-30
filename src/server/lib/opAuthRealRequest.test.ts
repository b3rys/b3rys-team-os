/**
 * 신뢰 호스트 판정 — ★진짜 서버에 진짜 요청을 보내서★ 잰다. (2026-07-30)
 *
 * ■ 왜 이 파일이 따로 있나
 * `opAuth.test.ts` 는 `new Request(...)` 를 손으로 만들어 검사한다. 그게 이 기능을 ★한 번도
 * 동작한 적 없는 채로 통과시켰다.★ 그 테스트가 만든 요청은 이런 모양이었다:
 *
 *     new Request("http://127.0.0.1:7878/team/api/tags", { headers: { host: "dev.b3rys.com" } })
 *                  └─ url 은 루프백 ─┘                              └─ Host 는 도메인 ─┘
 *
 * ★실제 서버는 이런 요청을 만들지 않는다.★ Host 헤더가 곧 url 의 authority 가 되기 때문이다.
 * 그래서 `isLoopbackHost(urlHost) && isTrustedDashboardHost(hostHeader)` 라는 판정이
 * ★서로 배타적인 두 조건★ 이라는 걸 아무도 못 봤다 — 손으로 만든 요청에서는 둘이 독립이었으니까.
 * hermes 3회전 교차검증도 못 봤다. 셋 다 같은 가짜 모양을 봤다.
 *
 * ■ 그래서 여기서는 검사 대상을 우리가 만들지 않는다
 * `Bun.serve` 를 띄우고 `fetch` 로 진짜 요청을 보낸다. 우리가 정하는 건 Host 헤더 하나뿐이고,
 * 나머지(url·authority·정규화·파싱 실패)는 ★런타임이 정한다.★ 우리가 상상하지 못한 모양이 나오면
 * 그게 그대로 검사 대상이 된다 — 실제로 아래 malformed 케이스가 그렇게 나왔다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { trustedActorFromRequest } from "./opAuth";

afterEach(() => {
  delete process.env.TEAM_TRUSTED_DASHBOARD_HOSTS;
  delete process.env.TEAM_BIND;
});

/** 진짜 서버를 띄워 Host 헤더만 바꿔 보내고, 판정 결과를 그대로 돌려받는다. */
async function ask(host: string): Promise<{ ok: boolean; error?: string; actor?: { actor: string; source: string } }> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => Response.json(trustedActorFromRequest(req, { loopbackDashboardActor: "gd" })),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/team/api/tags`, { method: "POST", headers: { host } });
    return (await res.json()) as { ok: boolean; error?: string };
  } finally {
    server.stop(true);
  }
}

/** 서버가 실제로 만든 요청에서 url 과 Host 헤더가 어떻게 나오는지 그대로 본다. */
async function shapeOf(host: string): Promise<{ urlHost: string | null; hostHeader: string | null }> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      let urlHost: string | null = null;
      try { urlHost = new URL(req.url).host; } catch { urlHost = null; }
      return Response.json({ urlHost, hostHeader: req.headers.get("host") });
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/x`, { headers: { host } });
    return (await res.json()) as { urlHost: string | null; hostHeader: string | null };
  } finally {
    server.stop(true);
  }
}

describe("★요청의 실제 모양★ — 이 사실을 몰라서 기능이 죽어 있었다", () => {
  test("url 의 authority 는 ★Host 헤더에서 나온다★ — 둘은 독립된 두 신호가 아니다", async () => {
    // 이게 이 사고의 뿌리다. 둘을 AND 로 걸면 도메인 요청은 앞 조건에서 항상 떨어진다.
    expect(await shapeOf("dev.b3rys.com")).toEqual({ urlHost: "dev.b3rys.com", hostHeader: "dev.b3rys.com" });
    // 실제 포트와 달라도 Host 가 이긴다 — url 을 "서버에 닿았다는 증거" 로 쓸 수 없는 이유다.
    expect((await shapeOf("127.0.0.1:9999")).urlHost).toBe("127.0.0.1:9999");
  });

  test("★다만 '항상 글자까지 같다' 는 아니다★ — URL 은 소문자로 정규화한다", async () => {
    // 판정을 url 쪽에서 읽느냐 헤더 쪽에서 읽느냐로 결과가 갈릴 수 있다. 한 곳에서만 읽어야 한다.
    const s = await shapeOf("DEV.B3RYS.COM:443");
    expect(s.hostHeader).toBe("DEV.B3RYS.COM:443");
    expect(s.urlHost).toBe("dev.b3rys.com:443");
  });

  test("★형식이 깨진 Host 는 url 파싱 자체가 실패한다★ — 손으로 만든 Request 로는 만들 수 없는 상태", async () => {
    const s = await shapeOf("[::1]junk");
    expect(s.hostHeader).toBe("[::1]junk");
    expect(s.urlHost, "url 은 파싱되지 않는다 — 여기서 url 을 믿으면 던진다").toBeNull();
  });
});

describe("신뢰 호스트 판정 — 진짜 요청으로", () => {
  test("loopback 은 등록 없이도 통과한다 (로컬 대시보드가 죽으면 안 된다)", async () => {
    expect(await ask("127.0.0.1:7878")).toMatchObject({ ok: true, actor: { actor: "gd", source: "loopback_dashboard" } });
    expect(await ask("localhost:7878")).toMatchObject({ ok: true });
  });

  test("★도메인은 등록 없이는 거절★", async () => {
    expect(await ask("dev.b3rys.com")).toMatchObject({ ok: false, error: "dashboard_host_not_trusted" });
  });

  test("★등록하면 도메인이 통과한다★ — 이게 2026-07-30 까지 한 번도 안 되던 것이다", async () => {
    process.env.TEAM_BIND = "127.0.0.1";
    process.env.TEAM_TRUSTED_DASHBOARD_HOSTS = "dev.b3rys.com";
    expect(await ask("dev.b3rys.com")).toMatchObject({ ok: true, actor: { source: "loopback_dashboard" } });
  });

  test("★와일드카드는 하위 주소만★ — 접미사만 같은 남의 도메인은 못 들어온다", async () => {
    process.env.TEAM_BIND = "127.0.0.1";
    process.env.TEAM_TRUSTED_DASHBOARD_HOSTS = "*.b3rys.com";
    expect(await ask("dev.b3rys.com")).toMatchObject({ ok: true });
    expect(await ask("studio.b3rys.com")).toMatchObject({ ok: true });
    expect(await ask("evilb3rys.com"), "접미사 오매치").toMatchObject({ ok: false });
    expect(await ask("b3rys.com.attacker.net"), "뒤에 붙인 도메인").toMatchObject({ ok: false });
    expect(await ask("b3rys.com"), "맨 도메인은 따로 적어야 한다").toMatchObject({ ok: false });
  });

  test("등록해도 서버가 loopback 에 묶여 있지 않으면 안 켜진다 (오리진 직접 노출 방어)", async () => {
    process.env.TEAM_BIND = "0.0.0.0";
    process.env.TEAM_TRUSTED_DASHBOARD_HOSTS = "dev.b3rys.com";
    expect(await ask("dev.b3rys.com")).toMatchObject({ ok: false });
  });

  test("★형식이 깨진 Host 를 loopback 으로 봐주지 않는다★ (codex·hermes 지적)", async () => {
    // `[::1]junk` 는 닫는 괄호 뒤에 쓰레기가 붙어 있다. 괄호 안만 잘라 읽으면 `::1` 이 되어
    // ★등록 없이 통과★ 한다 — 신뢰를 주는 쪽으로 관대한 파서다. 실제 서버는 이 Host 를 그대로 넘긴다.
    expect(await ask("[::1]junk")).toMatchObject({ ok: false, error: "dashboard_host_not_trusted" });
    expect(await ask("[::1]"), "제대로 된 IPv6 loopback 은 통과해야 한다").toMatchObject({ ok: true });
  });
});

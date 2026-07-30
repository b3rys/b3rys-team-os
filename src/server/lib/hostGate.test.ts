/**
 * 관문은 ★전부 막고 예외를 뚫는★ 방향이라, 잘못 걸면 크게 막힌다.
 * 그래서 "막히나" 뿐 아니라 ★"막히면 안 되는 것이 안 막히나"★ 를 같은 무게로 단정한다.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createHostGate } from "./hostGate";

/** 신뢰 판정을 주입해 테스트가 환경(git·env·소켓)에 안 걸리게 한다. */
function appWith(trusted: boolean) {
  const app = new Hono();
  app.use("*", createHostGate({ isTrusted: () => trusted }));
  app.get("/team", (c) => c.text("dashboard"));
  app.get("/team/api/agents", (c) => c.json({ agents: [] }));
  app.post("/team/api/members", (c) => c.json({ ok: true }));
  app.patch("/team/api/tasks/:id", (c) => c.json({ ok: true }));
  app.delete("/team/api/members/:id", (c) => c.json({ ok: true }));
  app.post("/team/api/slack/events", (c) => c.json({ ok: true }));
  app.get("/team/health", (c) => c.json({ ok: true }));
  app.get("/team/ws", (c) => c.text("ws"));
  return app;
}

const req = (path: string, method = "GET") =>
  new Request(`http://studio.b3rys.com${path}`, { method, headers: { host: "studio.b3rys.com" } });

describe("신뢰하지 않는 주소 — 막는다", () => {
  test("★읽기도 막는다★ — 열어두면 주소를 아는 사람이 팀원 목록을 그대로 본다", async () => {
    const r = await appWith(false).fetch(req("/team/api/agents"));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "dashboard_host_not_trusted" });
  });

  test("★관문을 안 타던 쓰기가 이제 다 막힌다★ — 칸반·영입·퇴사 (2026-07-30 실측 구멍)", async () => {
    const app = appWith(false);
    for (const [path, method] of [
      ["/team/api/tasks/abc", "PATCH"],      // 칸반 — 전에는 404(통과)였다
      ["/team/api/members", "POST"],          // 영입
      ["/team/api/members/x", "DELETE"],      // 퇴사
    ] as const) {
      const r = await app.fetch(req(path, method));
      expect([path, r.status]).toEqual([path, 403]);
    }
  });

  test("★WebSocket 도 막는다★ — 실시간 채널로 읽기가 새면 관문이 무의미하다", async () => {
    const r = await appWith(false).fetch(req("/team/ws"));
    expect(r.status).toBe(403);
  });

  test("★사람이 보는 화면은 조각내지 않고 한 장으로 말한다★", async () => {
    const r = await appWith(false).fetch(req("/team"));
    expect(r.status).toBe(403);
    // ★text/plain 이면 브라우저가 소스를 그대로 보여준다 — 안내 페이지가 무의미해진다.★
    //   프레임워크 기본값에 기대면 환경에 따라 달라진다(실측: src/web 테스트와 같이 돌면 text/plain).
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("등록되지 않은 주소");
    // 자기 주소가 보여야 하고, 그대로 물어볼 문장이 있어야 한다
    expect(html).toContain("studio.b3rys.com");
    expect(html).toContain("팀원에게 이대로 물어보세요");
    expect(html).toContain("TEAM_TRUSTED_DASHBOARD_HOSTS");
  });

  test("★안내 페이지는 자체 포함이어야 한다★ — 이 상황에선 assets 도 막힌다", async () => {
    const html = await (await appWith(false).fetch(req("/team"))).text();
    expect(html).not.toContain("/assets/");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
  });

  test("★주소에 태그가 들어와도 그대로 그려지지 않는다★", async () => {
    const app = appWith(false);
    const r = await app.fetch(
      new Request("http://x/team", { headers: { host: '"><script>alert(1)</script>' } }),
    );
    const html = await r.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("막히면 안 되는 것 — 안 막힌다", () => {
  test("★신뢰하는 주소는 전부 통과★ — 로컬 대시보드가 이 변경으로 깨지면 안 된다", async () => {
    const app = appWith(true);
    for (const [path, method] of [
      ["/team", "GET"],
      ["/team/api/agents", "GET"],
      ["/team/api/members", "POST"],
      ["/team/api/tasks/abc", "PATCH"],
    ] as const) {
      const r = await app.fetch(req(path, method));
      expect([path, r.status]).toEqual([path, 200]);
    }
  });

  test("★예외는 없다★ — 앞서 뚫으려던 둘도 막힌다(전제가 거짓이었다)", async () => {
    const app = appWith(false);
    // /slack/events: "서명 자체검증" 이 전제였는데, 무서명 요청이 200 으로 통과한다(hermes 실측).
    expect((await app.fetch(req("/team/api/slack/events", "POST"))).status).toBe(403);
    // /team/health: "아무것도 안 알려준다" 가 전제였는데 port·base_path·agents 를 준다.
    expect((await app.fetch(req("/team/health"))).status).toBe(403);
  });
});

describe("포털(/reports) 은 API 가 아니다", () => {
  test("★JSON 이 아니라 안내 페이지를 준다★ — 공유 링크를 받은 사람은 사람이다", async () => {
    const app = new Hono();
    app.use("*", createHostGate({ isTrusted: () => false, isApiPath: () => false }));
    app.get("/reports", (c) => c.text("portal"));
    const r = await app.fetch(new Request("http://x/reports", { headers: { host: "studio.b3rys.com" } }));
    expect(r.status).toBe(403);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("등록되지 않은 주소");
  });
});

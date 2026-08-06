/**
 * MCP HTTP 창구 — `/team/mcp`. 클로드 코드/커서가 웹으로 b3os 도구를 부르는 경로.
 *
 * ★설계 원칙 3가지★
 *
 * 1. ★요청마다 새 서버 인스턴스★
 *    buildMcpServer 는 actor 를 인스턴스에 고정한다. 인스턴스를 재사용하면 A 의 신원으로 B 가 도구를
 *    부르게 된다. 그래서 요청마다 새로 만들고 끝나면 닫는다(stateless). 세션 재사용 최적화는 하지 않는다 —
 *    신원 격리가 성능보다 우선.
 *
 * 2. ★본체를 멈추지 않는다★ (팀 리드 지시 2026-08-05)
 *    b3os 서버는 프로세스 1개·주 스레드 1개다. 여기서 동기 블로킹을 하면 대시보드가 같이 멎는다.
 *    이 경로는 await 만 쓴다(대기는 무해 — 대기 중 다른 요청이 처리된다). 붙들고 안 놓는 호출 금지.
 *
 * 3. ★opAuth 재사용 금지★
 *    대시보드 인증은 "루프백이면 lead" 를 신뢰한다. 밖에서 오는 이 경로에 쓰면 전부 lead 가 된다.
 *    인증은 mcpAuth 로만 한다.
 */
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer, resolveActorStrict } from "./b3osMcpServer";
import { authenticateMcpRequest, loadMcpAuthConfig, type McpAuthConfig, type McpPrincipal } from "./mcpAuth";
import { appendAudit } from "../db/queries";

// ★쓰기 도구 목록은 여기 두지 않는다★ — 관문은 b3osMcpServer 의 WRITE_TOOL_NAMES 하나뿐이다.
// (리뷰 P1, bill) 목록이 두 곳이면 새 쓰기 도구를 추가할 때 한쪽만 고치고 '완료' 가 되는데,
// 그때 관문은 안 바뀌고 read 신원에게 그 도구가 노출된다 — 그리고 아무 에러도 안 난다.

/** 감사 기록. 실패해도 요청을 막지는 않는다(기록 실패가 서비스 중단이 되면 안 된다). */
function audit(db: Database, actor: string, action: string, target: string, detail: Record<string, unknown>): void {
  try {
    appendAudit(db, actor, action, target, detail);
  } catch {
    // 기록 실패는 삼킨다 — 단, 여기서 던지면 정상 요청까지 죽는다.
  }
}

export interface McpHttpDeps {
  /** 테스트에서 주입. 미지정 시 env 에서 읽는다. */
  authConfig?: McpAuthConfig;
  /** 테스트에서 인증을 대체할 때 사용. */
  authenticate?: typeof authenticateMcpRequest;
  /**
   * ★시험 전용 관측 지점★ — 정리(transport·server close)가 실제로 돌았는지 볼 방법이 없어서 둔다.
   * 클라이언트가 스트림을 끊는 경로는 ★밖에서 관측할 수 없다★(응답을 이미 버린 뒤다).
   * 운영에서는 지정하지 않는다.
   */
  onCleanup?: () => void;
  /** keepalive 간격(ms). 시험에서 짧게 줄여 확인한다. 기본 10초. */
  keepaliveMs?: number;
}

/**
 * `/mcp` 라우트를 담은 Hono 앱을 만든다. 상위에서 BASE_PATH 밑에 붙인다.
 * ★catch-all(SPA) 보다 먼저 등록해야 한다★ — 안 그러면 화면이 이 주소를 가로챈다.
 */
export function buildMcpHttpApp(db: Database, deps: McpHttpDeps = {}): Hono {
  const app = new Hono();
  const authenticate = deps.authenticate ?? authenticateMcpRequest;

  app.all("/mcp", async (c) => {
    // 설정은 요청 시점에 읽는다 — 재시작 없이 매핑을 갱신할 수 있게.
    const cfg = deps.authConfig ?? loadMcpAuthConfig();

    const auth = await authenticate(c.req.raw, cfg);
    if (!auth.ok) {
      audit(db, "unknown", "mcp.http.denied", auth.reason, { status: auth.status });
      return c.json({ error: auth.reason }, auth.status);
    }
    const principal: McpPrincipal = auth.principal;

    // ★이중 게이트★: CF 가 통과시킨 신원이라도 우리 레지스트리에 없으면 거부.
    // strict = env 폴백 없음. 신원이 비면 서버 자기 신원으로 떨어지지 않고 거부된다.
    const actor = resolveActorStrict(db, principal.agentId);
    if (!actor) {
      audit(db, principal.agentId, "mcp.http.denied", "actor_not_registered", { subject: principal.subject });
      return c.json({ error: "actor_not_registered" }, 403);
    }

    audit(db, actor, "mcp.http.request", principal.kind, { subject: principal.subject, scope: principal.scope });

    // ★요청마다 새 인스턴스★ — 신원이 섞이지 않게. 끝나면 닫는다.
    // scope 를 같이 넘겨야 read 신원에게 쓰기 도구가 노출되지 않는다.
    const server = buildMcpServer(db, actor, principal.scope);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — 세션 저장 없음
      // ★JSON 한 방 응답을 쓰지 않는다★ (2026-08-06 라이브): 그 모드는 답이 다 될 때까지
      //   ★한 바이트도 안 보낸다.★ 그동안 연결이 조용하니 ★Cloudflare 가 30초에 끊었다.★
      //   실측: 서버는 60초를 정상 완료했는데(waited_ms=60141) 클라이언트는 30.4초에 에러를 봤다.
      //   → SSE 로 두면 응답이 ★즉시 열리고★ 진행 알림이 흐른다. 조용한 연결이 아니게 된다.
      //   (MCP 규약이 원래 이 용도로 notifications/progress 를 갖고 있다.)
      enableJsonResponse: false,
    });
    // 인스턴스를 남기지 않는다(누수 시 다음 요청이 남의 신원을 쓸 위험).
    let finished = false;
    const cleanup = async () => {
      if (finished) return; // 두 번 돌지 않는다
      finished = true;
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
      deps.onCleanup?.();
    };
    let res: Response;
    try {
      await server.connect(transport);
      res = await transport.handleRequest(c.req.raw);
    } catch (e) {
      await cleanup();
      throw e;
    }
    // ★SSE 는 응답이 '살아 있는 스트림' 이다 — 여기서 바로 닫으면 한 바이트도 안 나간다.★
    //   (실측 2026-08-06: finally 로 즉시 닫았더니 content-type 은 text/event-stream 인데 본문이 빈 문자열.
    //    JSON 모드일 땐 응답이 이미 완성돼 있어서 같은 코드가 멀쩡했다 — 모드를 바꾸며 드러났다.)
    //   → ★스트림이 끝날 때 정리한다.★ 본문이 없으면(빈 응답) 지금 정리해도 된다.
    if (!res.body) {
      await cleanup();
      return res;
    }
    // ★TransformStream 의 cancel 훅은 쓰지 않는다★ (빌 실측 2026-08-06, bun 1.3.14):
    //   최신 스펙 추가분이라 ★Bun 이 안 부른다.★ 정상 종료(flush)만 돌고 ★클라이언트 끊김에는 안 돈다★ —
    //   그런데 끊기는 그 순간이 ★CF 가 30초에 자르는 바로 그 경로★ 다. 정리가 필요한 때만 정확히 안 돈다.
    //   (`as Transformer` 캐스팅이 필요했던 것 자체가 신호였다 — 타입에 없는 훅이었다.)
    //   → ReadableStream 으로 직접 감싼다. 이쪽 cancel 은 Bun 이 부른다.
    //
    // ★그리고 여기서 keepalive 를 흘린다★: SDK 에는 자체 keepalive 가 없다(writePrimingEvent 는
    //   eventStore + 프로토콜 2025-11-25 조건부라 우리 stateless 경로에는 안 온다).
    //   그게 없으면 이 기능은 ★"클라이언트가 progressToken 을 준다" 에 전적으로 걸린다.★ 안 주면
    //   90초 내내 조용해 CF 가 자르고 ★고치기 전과 똑같아진다.★ 주석 줄(`: …`)은 SSE 규약상
    //   클라이언트가 무시하지만 ★바이트는 흐른다★ — 연결이 조용하지 않다.
    const keepaliveMs = deps.keepaliveMs ?? 10_000;
    const upstream = res.body.getReader();
    let ka: ReturnType<typeof setInterval> | null = null;
    const wrapped = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ka = setInterval(() => {
          try {
            ctrl.enqueue(new TextEncoder().encode(": keepalive\n\n"));
          } catch {
            /* 이미 닫힌 뒤 — 무시 */
          }
        }, keepaliveMs);
      },
      async pull(ctrl) {
        const { done, value } = await upstream.read();
        if (done) {
          if (ka) clearInterval(ka);
          ctrl.close();
          await cleanup();
          return;
        }
        if (value) ctrl.enqueue(value);
      },
      async cancel(reason) {
        // ★클라이언트가 끊었다★ — #280 초판이 놓치던 자리.
        if (ka) clearInterval(ka);
        await upstream.cancel(reason).catch(() => {});
        await cleanup();
      },
    });
    return new Response(wrapped, { status: res.status, headers: res.headers });
  });

  return app;
}

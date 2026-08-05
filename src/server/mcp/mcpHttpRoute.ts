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
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      // 인스턴스를 남기지 않는다(누수 시 다음 요청이 남의 신원을 쓸 위험).
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  return app;
}

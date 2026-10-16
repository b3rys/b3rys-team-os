// 새 엔드포인트의 검사 누락을 막도록 공통 관문에서 읽기·쓰기를 모두 제한한다. 브라우저 요청에는 위젯 실패 대신 안내 페이지를 제공한다.
import type { Context, Next } from "hono";
import { untrustedHostPage } from "./untrustedHostPage";

// slack/events의 모든 분기가 서명을 검증하지 않고 team/health도 운영 정보를 반환하므로 예외를 두지 않는다. 외부 감시는 관문 밖 rootApp의 /health를 쓴다.

export interface HostGateDeps {
  /** 이 요청을 신뢰하는가. 실제로는 `trustedActorFromRequest(...).ok` 를 넘긴다. */
  isTrusted: (request: Request) => boolean;
}

/** 기계가 부르는 자리인가 — 그러면 JSON, 아니면 사람이 읽을 페이지. */
function isApiPath(path: string): boolean {
  return path.includes("/api/");
}

export function createHostGate(deps: HostGateDeps) {
  return async (c: Context, next: Next) => {
    const path = c.req.path;
    if (deps.isTrusted(c.req.raw)) return next();
    if (isApiPath(path)) {
      return c.json({ error: "dashboard_host_not_trusted" }, 403);
    }
    // content-type 을 명시한다. 브라우저는 text/plain 을 받으면 HTML 을 그리지 않고
    //   소스를 그대로 보여준다 — 안내 페이지가 통째로 무의미해진다. 값이 하나뿐인 자리라 못 박는다.
    return c.body(untrustedHostPage(c.req.header("host") ?? ""), 403, {
      "content-type": "text/html; charset=utf-8",
    });
  };
}

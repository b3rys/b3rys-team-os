/**
 * 신뢰하지 않는 주소를 ★한 곳에서★ 막는다.
 *
 * ■ 왜 한 곳인가
 * 앞서는 엔드포인트마다 각자 `trustedActorFromRequest` 를 불렀다. 그래서 쓰기 70곳 중
 * 관문을 타는 건 소수였다 — 칸반 수정·삭제, 인박스, 라우터, 그리고 `settings` 쓰기 31개 중
 * 30개(★영입 `POST /members`·퇴사 `DELETE /members/:id` 포함★)가 검사 없이 열려 있었다.
 * 도메인 Host 로 `PATCH /tasks/<없는id>` 를 보내면 403 이 아니라 404 가 왔다(실측).
 *
 * ★"게이트를 부르는 곳" 을 세는 방식으로는 "게이트가 있어야 하는데 없는 곳" 을 못 본다.★
 * 각 엔드포인트가 기억해서 부르는 대신, 지나갈 수밖에 없는 자리에 한 번 건다.
 * 새 엔드포인트가 추가돼도 자동으로 덮인다 — 빠뜨릴 수가 없는 게 이 방식의 요점이다.
 *
 * ■ 읽기도 막는다
 * 읽기를 열어두면 주소를 아는 사람이 팀원 목록·보고서를 그대로 본다(오늘 실제로 그랬다).
 * 보고서 공유 링크는 "받아서 전달하거나, 그 주소를 등록해서 열어준다" 로 간다.
 *
 * ■ 대신 화면을 조각조각 깨뜨리지 않는다
 * 읽기를 막으면 껍데기만 뜨고 위젯이 전부 실패한다 — "고장인지 아닌지 모르겠는" 상태가 되고,
 * 그게 오늘 원인 찾기를 어렵게 만든 바로 그 모양이다. 그래서 사람이 보는 요청에는 한 장짜리
 * 안내 페이지를 돌려준다.
 */
import type { Context, Next } from "hono";
import { untrustedHostPage } from "./untrustedHostPage";

/**
 * ★예외는 없다.★ (2026-07-30 · codex·hermes 교차검증에서 둘 다 같은 결론)
 *
 *  처음엔 두 개를 뒀는데 ★둘 다 전제가 거짓이었다.★
 *
 *  · `/slack/events` — "서명으로 자체 검증한다" 고 적었는데 아니었다.
 *    `url_verification` 은 ★서명 검사 전에★ challenge 를 그대로 돌려주고,
 *    `api_app_id` 가 등록된 앱이 아니면 검사 블록을 ★통째로 건너뛴다★ — signing_secret 이
 *    없어도 마찬가지다. hermes 가 무서명 요청으로 실측했다: 200 OK.
 *    ★내가 "자체 검증이 있다" 고 믿고 예외를 뚫었으면, 그게 유일한 공개 구멍이 됐을 것이다.★
 *    Event URL 방식을 쓰는 설치본은 ★그 도메인을 TEAM_TRUSTED_DASHBOARD_HOSTS 에 등록★ 하면 된다
 *    (대시보드를 그 주소로 여는 것과 같은 조건이다).
 *
 *  · `/health` — "아무것도 안 알려준다" 고 적었는데 `/team/health` 는
 *    `{ok, port, base_path, agents}` 를 준다. 게다가 접미사로 걸어서 `…/health` 로 끝나는
 *    어떤 경로도 앞으로 자동 면제됐다. ★바깥 감시는 `rootApp` 의 `/health`(= `{ok:true}`)를 쓰는데 그건 이 관문
 *    바깥이라 영향이 없다★ — 예외가 애초에 필요 없었다.
 *
 *  ★"예외에는 자체 방어가 있다" 는 말은 그 방어를 실제로 읽고 나서만 참이다.★
 *  둘 다 내가 안 읽고 적었고, 둘 다 틀렸다. 그래서 예외를 두지 않는다.
 */

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
    // ★content-type 을 명시한다.★ 브라우저는 text/plain 을 받으면 HTML 을 그리지 않고
    //   소스를 그대로 보여준다 — 안내 페이지가 통째로 무의미해진다. 값이 하나뿐인 자리라 못 박는다.
    return c.body(untrustedHostPage(c.req.header("host") ?? ""), 403, {
      "content-type": "text/html; charset=utf-8",
    });
  };
}

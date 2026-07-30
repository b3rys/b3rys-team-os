/**
 * 신뢰하지 않는 주소를 ★한 곳에서★ 막는다. (팀장님 지시 2026-07-30)
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
 * 보고서 공유 링크는 "받아서 전달하거나, 그 주소를 등록해서 열어준다" 로 간다(팀장님 판단).
 *
 * ■ 대신 화면을 조각조각 깨뜨리지 않는다
 * 읽기를 막으면 껍데기만 뜨고 위젯이 전부 실패한다 — "고장인지 아닌지 모르겠는" 상태가 되고,
 * 그게 오늘 원인 찾기를 어렵게 만든 바로 그 모양이다. 그래서 사람이 보는 요청에는 한 장짜리
 * 안내 페이지를 돌려준다.
 */
import type { Context, Next } from "hono";
import { untrustedHostPage } from "./untrustedHostPage";

/** 관문을 태우면 안 되는 인바운드. ★자체 검증이 있는 것만★ 넣는다. */
export const GATE_EXEMPT_SUFFIX = [
  // Slack 이 밖에서 보내는 이벤트. 서명(x-slack-signature)으로 자체 검증한다 — routes/slack.ts.
  //   여기서 막으면 Event URL 방식을 쓰는 설치본의 슬랙이 끊긴다.
  "/slack/events",
  // 감시용. 아무 내용도 안 알려주고, 막으면 바깥 모니터가 서버를 죽은 것으로 본다.
  "/health",
];

export function isGateExempt(path: string): boolean {
  return GATE_EXEMPT_SUFFIX.some((sfx) => path.endsWith(sfx));
}

export interface HostGateDeps {
  /** 이 요청을 신뢰하는가. 실제로는 `trustedActorFromRequest(...).ok` 를 넘긴다. */
  isTrusted: (request: Request) => boolean;
  /** true 면 API 로 보고 JSON 을 돌려준다. 기본은 경로에 `/api/` 가 있는지. */
  isApiPath?: (path: string) => boolean;
}

export function createHostGate(deps: HostGateDeps) {
  const isApiPath = deps.isApiPath ?? ((path: string) => path.includes("/api/"));
  return async (c: Context, next: Next) => {
    const path = c.req.path;
    if (isGateExempt(path)) return next();
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

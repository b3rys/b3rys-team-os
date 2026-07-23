// 표준 API 응답 헬퍼 — 성공 {ok:true,...} / 에러 {ok:false,error,...} 포맷 통일.
// 기존 라우트는 {error}·{ok:true,...} 혼재(점진 치환 대상). 신규 라우트는 이 헬퍼 강제.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function ok(c: Context, data: Record<string, unknown>, status: ContentfulStatusCode = 200) {
  return c.json({ ok: true, ...data }, status);
}

export function err(
  c: Context,
  code: string,
  status: ContentfulStatusCode = 400,
  extra?: Record<string, unknown>,
) {
  return c.json({ ok: false, error: code, ...(extra ?? {}) }, status);
}

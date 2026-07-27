/**
 * codex app-server 0.144.6 ServerRequest 분류 + 응답 codec (Phase1 ②).
 *
 * 배경: appServerClient가 ★모든★ server→client 요청에 `{decision}`을 보내던 것을 고친다.
 * generate-json-schema(0.144.6) 기준 ServerRequest는 11종이고, 그 중 승인성은 4종뿐,
 * 나머지 6종(+unknown)은 각기 다른 result 또는 JSON-RPC error가 필요하다.
 * 잘못된 result를 보내면 Codex 쪽 pending callback이 오류/폴백에 의존하거나 hang한다.
 *
 * 근거(Ames 교차검증·schema PASS 2026-07-24):
 *   research/codex-appserver-0.144.6-server-request-codec.md (ames repo). 각 payload는 0.144.6 Response schema로 검증됨.
 *
 * ★이 모듈은 순수 함수다 — I/O·상태 없음(테스트 용이). appServerClient가 이걸 써서 respond/respondError 한다.★
 */

/** 승인 콜백의 내부 공통 결정(런타임 무관). wire codec에서 신규/legacy로 분리 인코딩. */
export type InternalDecision = "once" | "session" | "decline" | "cancel";

/** 기존 onApproval 반환(legacy 스타일 ReviewDecision) → 내부 결정으로 정규화. */
export function toInternalDecision(d: string): InternalDecision {
  switch (d) {
    case "approved": return "once";
    case "approved_for_session": return "session";
    case "abort": return "cancel";
    // denied·timed_out·기타 = 보수적으로 decline
    default: return "decline";
  }
}

export type ServerRequestKind =
  | "approval_command"   // item/commandExecution/requestApproval (신규, availableDecisions 有)
  | "approval_file"      // item/fileChange/requestApproval (신규)
  | "approval_permissions" // item/permissions/requestApproval (별도 codec)
  | "approval_legacy"    // execCommandApproval | applyPatchApproval (legacy)
  | "user_input"         // item/tool/requestUserInput
  | "mcp_elicitation"    // mcpServer/elicitation/request
  | "dynamic_tool"       // item/tool/call
  | "auth_refresh"       // account/chatgptAuthTokens/refresh
  | "attestation"        // attestation/generate
  | "current_time"       // currentTime/read
  | "unknown";

const APPROVAL_KINDS: ReadonlySet<ServerRequestKind> = new Set<ServerRequestKind>([
  "approval_command", "approval_file", "approval_permissions", "approval_legacy",
]);

export function isApprovalKind(kind: ServerRequestKind): boolean {
  return APPROVAL_KINDS.has(kind);
}

/** method 정확 매칭으로 분류. */
export function classifyServerRequest(method: string): ServerRequestKind {
  switch (method) {
    case "item/commandExecution/requestApproval": return "approval_command";
    case "item/fileChange/requestApproval": return "approval_file";
    case "item/permissions/requestApproval": return "approval_permissions";
    case "execCommandApproval":
    case "applyPatchApproval": return "approval_legacy";
    case "item/tool/requestUserInput": return "user_input";
    case "mcpServer/elicitation/request": return "mcp_elicitation";
    case "item/tool/call": return "dynamic_tool";
    case "account/chatgptAuthTokens/refresh": return "auth_refresh";
    case "attestation/generate": return "attestation";
    case "currentTime/read": return "current_time";
    default: return "unknown";
  }
}

/** 신규(command/file) 결정값. */
function newDecisionValue(d: InternalDecision): string {
  switch (d) {
    case "once": return "accept";
    case "session": return "acceptForSession";
    case "cancel": return "cancel";
    case "decline": default: return "decline";
  }
}
/** legacy(exec/apply) 결정값. */
function legacyDecisionValue(d: InternalDecision): string {
  switch (d) {
    case "once": return "approved";
    case "session": return "approved_for_session";
    case "cancel": return "abort";
    case "decline": default: return "denied";
  }
}

/** 응답 인코딩 결과: result(성공) 또는 error(JSON-RPC error). */
export type CodecOutcome =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "error"; code: number; message: string };

/**
 * 승인성 요청 → 내부 결정을 method별 wire result로 인코딩.
 * command의 availableDecisions(non-null)면 최종 문자열 결정이 그 배열에 있는지 검증(deep-equal는 문자열 한정).
 * amendment 객체 결정은 이 경로에서 생성하지 않는다(팝업은 accept/decline/session/cancel만 노출).
 */
export function encodeApproval(
  kind: ServerRequestKind,
  decision: InternalDecision,
  params: Record<string, unknown>,
): CodecOutcome {
  if (kind === "approval_command") {
    let v = newDecisionValue(decision);
    const avail = params?.availableDecisions;
    if (Array.isArray(avail)) {
      const strs = avail.filter((x) => typeof x === "string") as string[];
      if (!strs.includes(v)) {
        // 선호값이 허용목록에 없으면: decline→cancel→fail-closed(error)
        if (strs.includes("decline")) v = "decline";
        else if (strs.includes("cancel")) v = "cancel";
        else return { kind: "error", code: -32001, message: "no acceptable decline/cancel in availableDecisions" };
      }
    }
    return { kind: "result", result: { decision: v } };
  }
  if (kind === "approval_file") {
    return { kind: "result", result: { decision: newDecisionValue(decision) } };
  }
  if (kind === "approval_legacy") {
    return { kind: "result", result: { decision: legacyDecisionValue(decision) } };
  }
  if (kind === "approval_permissions") {
    // permissions는 decision이 아니라 grant 프로필. 거절/타임아웃 = 빈 grant(turn).
    // 승인(once/session) = 요청 profile을 grant(subset 정교화는 후속 과제 — 현재는 요청분 grant).
    if (decision === "once" || decision === "session") {
      const requested = (params?.permissions ?? {}) as Record<string, unknown>;
      return {
        kind: "result",
        result: {
          permissions: requested,
          scope: decision === "session" ? "session" : "turn",
          strictAutoReview: false,
        },
      };
    }
    return { kind: "result", result: { permissions: {}, scope: "turn", strictAutoReview: false } };
  }
  return { kind: "error", code: -32601, message: `not an approval kind: ${kind}` };
}

/**
 * 비승인성 요청의 fail-safe 응답(핸들러 미제공/에러 시). 진짜 값이 필요한 것(auth/attestation)은 error.
 * currentTime은 nowUnixSec 주입(테스트 결정성 위해 인자로).
 */
export function failSafeNonApproval(kind: ServerRequestKind, nowUnixSec: number): CodecOutcome {
  switch (kind) {
    case "user_input": return { kind: "result", result: { answers: {} } };
    case "mcp_elicitation": return { kind: "result", result: { action: "decline" } };
    case "dynamic_tool":
      return { kind: "result", result: { contentItems: [{ type: "inputText", text: "client tool unavailable" }], success: false } };
    case "current_time":
      return { kind: "result", result: { currentTimeAt: Math.floor(nowUnixSec) } };
    case "auth_refresh":
      return { kind: "error", code: -32001, message: "no client-managed auth provider; cannot refresh" };
    case "attestation":
      return { kind: "error", code: -32001, message: "attestation not opted in (capabilities.requestAttestation=false)" };
    default:
      return { kind: "error", code: -32601, message: `unhandled non-approval kind: ${kind}` };
  }
}

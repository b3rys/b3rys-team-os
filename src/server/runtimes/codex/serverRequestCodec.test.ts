import { test, expect, describe } from "bun:test";
import {
  classifyServerRequest, isApprovalKind, toInternalDecision, encodeApproval, failSafeNonApproval,
} from "./serverRequestCodec";

// 근거: research/codex-appserver-0.144.6-server-request-codec.md (Ames, 0.144.6 schema PASS).

describe("classifyServerRequest — 11종 + unknown", () => {
  const cases: [string, string][] = [
    ["item/commandExecution/requestApproval", "approval_command"],
    ["item/fileChange/requestApproval", "approval_file"],
    ["item/permissions/requestApproval", "approval_permissions"],
    ["execCommandApproval", "approval_legacy"],
    ["applyPatchApproval", "approval_legacy"],
    ["item/tool/requestUserInput", "user_input"],
    ["mcpServer/elicitation/request", "mcp_elicitation"],
    ["item/tool/call", "dynamic_tool"],
    ["account/chatgptAuthTokens/refresh", "auth_refresh"],
    ["attestation/generate", "attestation"],
    ["currentTime/read", "current_time"],
    ["something/unheard", "unknown"],
  ];
  for (const [m, k] of cases) {
    test(`${m} → ${k}`, () => { expect(classifyServerRequest(m)).toBe(k as any); });
  }
  test("승인성은 정확히 4종", () => {
    const approval = cases.map(([m]) => classifyServerRequest(m)).filter(isApprovalKind);
    expect(approval.length).toBe(5); // command,file,permissions,legacy(exec),legacy(apply)
    expect(new Set(approval).size).toBe(4); // 종류는 4
  });
});

describe("toInternalDecision (legacy ReviewDecision → 내부)", () => {
  test.each([
    ["approved", "once"], ["approved_for_session", "session"], ["abort", "cancel"],
    ["denied", "decline"], ["timed_out", "decline"], ["whatever", "decline"],
  ])("%s → %s", (inp, out) => { expect(toInternalDecision(inp)).toBe(out as any); });
});

describe("encodeApproval — method별 결정값 codec", () => {
  test("신규 command: once→accept / session→acceptForSession / decline→decline / cancel→cancel", () => {
    const p = {};
    expect(encodeApproval("approval_command", "once", p)).toEqual({ kind: "result", result: { decision: "accept" } });
    expect(encodeApproval("approval_command", "session", p)).toEqual({ kind: "result", result: { decision: "acceptForSession" } });
    expect(encodeApproval("approval_command", "decline", p)).toEqual({ kind: "result", result: { decision: "decline" } });
    expect(encodeApproval("approval_command", "cancel", p)).toEqual({ kind: "result", result: { decision: "cancel" } });
  });
  test("command availableDecisions 제약: 선호값 없으면 decline→cancel→error 폴백", () => {
    // accept 불가, decline만 허용 → accept 요청이 decline로 강등
    expect(encodeApproval("approval_command", "once", { availableDecisions: ["decline"] }))
      .toEqual({ kind: "result", result: { decision: "decline" } });
    // decline도 없고 cancel만 → cancel
    expect(encodeApproval("approval_command", "decline", { availableDecisions: ["cancel"] }))
      .toEqual({ kind: "result", result: { decision: "cancel" } });
    // 둘 다 없음 → fail-closed error
    expect(encodeApproval("approval_command", "decline", { availableDecisions: ["accept"] }).kind).toBe("error");
  });
  test("신규 file: decision류(availableDecisions 무관)", () => {
    expect(encodeApproval("approval_file", "once", {})).toEqual({ kind: "result", result: { decision: "accept" } });
    expect(encodeApproval("approval_file", "decline", {})).toEqual({ kind: "result", result: { decision: "decline" } });
  });
  test("legacy exec/apply: approved/approved_for_session/denied/abort", () => {
    expect(encodeApproval("approval_legacy", "once", {})).toEqual({ kind: "result", result: { decision: "approved" } });
    expect(encodeApproval("approval_legacy", "session", {})).toEqual({ kind: "result", result: { decision: "approved_for_session" } });
    expect(encodeApproval("approval_legacy", "decline", {})).toEqual({ kind: "result", result: { decision: "denied" } });
    expect(encodeApproval("approval_legacy", "cancel", {})).toEqual({ kind: "result", result: { decision: "abort" } });
  });
  test("permissions: decision 아님 — 거절=빈 grant(turn), 승인=요청 profile grant", () => {
    expect(encodeApproval("approval_permissions", "decline", { permissions: { fs: true } }))
      .toEqual({ kind: "result", result: { permissions: {}, scope: "turn", strictAutoReview: false } });
    expect(encodeApproval("approval_permissions", "once", { permissions: { fs: true } }))
      .toEqual({ kind: "result", result: { permissions: { fs: true }, scope: "turn", strictAutoReview: false } });
    expect(encodeApproval("approval_permissions", "session", { permissions: { fs: true } }))
      .toEqual({ kind: "result", result: { permissions: { fs: true }, scope: "session", strictAutoReview: false } });
    // ★거절 시 요청 permissions echo 금지(= 승인돼버림) 회귀 가드★
    const declined = encodeApproval("approval_permissions", "decline", { permissions: { fs: true } });
    expect((declined as any).result.permissions).toEqual({});
  });
});

describe("failSafeNonApproval — 비승인 6종", () => {
  test("user_input → {answers:{}}", () => {
    expect(failSafeNonApproval("user_input", 100)).toEqual({ kind: "result", result: { answers: {} } });
  });
  test("mcp_elicitation → {action:'decline'}", () => {
    expect(failSafeNonApproval("mcp_elicitation", 100)).toEqual({ kind: "result", result: { action: "decline" } });
  });
  test("dynamic_tool → contentItems + success:false", () => {
    expect(failSafeNonApproval("dynamic_tool", 100)).toEqual({
      kind: "result", result: { contentItems: [{ type: "inputText", text: "client tool unavailable" }], success: false },
    });
  });
  test("current_time → {currentTimeAt: Unix초(정수)}", () => {
    const out = failSafeNonApproval("current_time", 1719999999.7);
    expect(out).toEqual({ kind: "result", result: { currentTimeAt: 1719999999 } }); // floor, 밀리초/소수 금지
  });
  test("auth_refresh → JSON-RPC error (가짜 토큰 합성 금지)", () => {
    expect(failSafeNonApproval("auth_refresh", 100).kind).toBe("error");
  });
  test("attestation → JSON-RPC error (opt-in 아님)", () => {
    expect(failSafeNonApproval("attestation", 100).kind).toBe("error");
  });
});

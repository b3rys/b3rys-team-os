import { test, expect, describe } from "bun:test";
import { buildOperationFromApproval, approvalOperationHash } from "./appServerPopup";
import { scopeKeyForOperation, targetForOperation } from "../../lib/permissionGate";
import type { ApprovalRequest } from "./appServerClient";

/**
 * ★S0(#106) — 해석하지 못한 승인 payload 가 넓은 권한 열쇠를 만들지 않는다★
 *
 * 배경: 승인 요청 payload 는 두 세대다(2026-07-28 벤더 스키마 실측, codex-cli 0.144.6).
 *   구세대 execCommandApproval   → command 가 ★배열★
 *   신세대 item/commandExecution/requestApproval → command 가 ★문자열★
 *   신세대 item/fileChange/requestApproval       → ★fileChanges 필드 자체가 없다★
 * buildOperationFromApproval 은 Array.isArray(p.command) / p.fileChanges 로만 분기하므로
 * ★신세대는 전부 마지막 분기로 떨어진다.★
 *
 * 예전 마지막 분기는 action=req.method, text=reason 이었다. reason 이 없으면 target 이 action 으로
 * 떨어져 ★target = method 이름★ 이 된다 → 그 method 로 오는 ★모든 요청이 같은 scope_key★.
 * 즉 한 번 allowed_always 를 주면 이후 내용이 전혀 다른 요청도 팝업 없이 통과한다.
 *
 * 팀 리드 원칙(2026-07-28): ★"애매하면 통과가 아니고 ask 로."★
 * 아래 테스트들이 그 원칙을 코드에 고정한다.
 */
describe("S0 — 해석 실패 payload 의 권한 열쇠", () => {
  const newGenCmd = (command: string): ApprovalRequest => ({
    method: "item/commandExecution/requestApproval",
    params: { command, cwd: "/tmp", itemId: "i1", turnId: "t1", threadId: "th1", startedAtMs: 1 },
  });

  test("★서로 다른 명령은 서로 다른 열쇠를 갖는다★ — 하나를 '항상 허용' 해도 다른 하나는 다시 묻는다", () => {
    const safe = buildOperationFromApproval(newGenCmd("rm -rf /tmp/x"), "dex");
    const evil = buildOperationFromApproval(newGenCmd("cat ~/.ssh/id_rsa"), "dex");

    // 이 단언이 S0 의 본체다. 수정 전에는 두 값이 ★같았다★.
    expect(scopeKeyForOperation(safe)).not.toBe(scopeKeyForOperation(evil));
  });

  test("target 이 더 이상 method 이름이 아니다", () => {
    const op = buildOperationFromApproval(newGenCmd("ls -la"), "dex");
    expect(targetForOperation(op)).not.toBe("item/commandExecution/requestApproval");
    expect(op.action).toBe("approval_unparsed"); // 해석 실패를 이름으로 밝힌다
  });

  test("payload 지문이 target 안에 살아남는다 (240자 절단 뒤에도)", () => {
    const op = buildOperationFromApproval(newGenCmd("echo hi"), "dex");
    // 지문이 절단에 잘려나가면 열쇠가 다시 뭉개진다. 그래서 method 바로 뒤에 둔다.
    expect(targetForOperation(op)).toMatch(/#[0-9a-f]{16}/);
  });

  test("같은 payload 는 같은 열쇠 — 결정적이다", () => {
    const a = buildOperationFromApproval(newGenCmd("git status"), "dex");
    const b = buildOperationFromApproval(newGenCmd("git status"), "dex");
    expect(scopeKeyForOperation(a)).toBe(scopeKeyForOperation(b));
  });

  test("★키 순서가 달라도 같은 열쇠★ — 같은 작업에 두 개의 열쇠가 생기면 안 된다", () => {
    const a: ApprovalRequest = { method: "item/tool/requestUserInput", params: { a: 1, b: { x: 1, y: 2 } } };
    const b: ApprovalRequest = { method: "item/tool/requestUserInput", params: { b: { y: 2, x: 1 }, a: 1 } };
    expect(scopeKeyForOperation(buildOperationFromApproval(a, "dex")))
      .toBe(scopeKeyForOperation(buildOperationFromApproval(b, "dex")));
  });

  test("★approvalOperationHash 로는 못 가른다★ — 왜 payload 전체 지문이 필요한지의 근거", () => {
    // 신세대는 command 가 문자열이라 basis 의 Array.isArray 가 false → command:null.
    // fileChanges 도 reason 도 없으니 basis 가 {method, null, null, null} 로 같아진다.
    // ★즉 기존 지문을 그대로 썼다면 위 첫 테스트가 통과하지 못한다.★ (실제로 처음에 그렇게 짰다가 잡혔다)
    expect(approvalOperationHash(newGenCmd("rm -rf /tmp/x")))
      .toBe(approvalOperationHash(newGenCmd("cat ~/.ssh/id_rsa")));
  });

  test("★reason 은 text 에 남는다★ — permissionGate 가 text 를 Tier-D 스캔에 쓰기 때문", () => {
    const req: ApprovalRequest = {
      method: "item/permissions/requestApproval",
      params: { reason: "needs network egress to example.com", itemId: "i9" },
    };
    const op = buildOperationFromApproval(req, "dex");
    expect(op.text).toContain("needs network egress to example.com");
  });

  test("해석되는 구세대 경로는 건드리지 않는다 — 회귀 가드", () => {
    const oldGen: ApprovalRequest = { method: "execCommandApproval", params: { command: ["rm", "-rf", "/tmp/x"], cwd: "/tmp" } };
    const op = buildOperationFromApproval(oldGen, "dex");
    expect(op.action).toBe("shell");
    expect(op.command).toBe("rm -rf /tmp/x");
    expect(targetForOperation(op)).toBe("rm -rf /tmp/x");
  });
});

import { test, expect, describe } from "bun:test";
import { buildOperationFromApproval, approvalOperationHash } from "./appServerPopup";
import { scopeKeyForOperation, targetForOperation } from "../../lib/permissionGate";
import type { ApprovalRequest } from "./appServerClient";

/** 해석할 수 없는 요청은 전체 payload 해시로 scope를 구분해 다른 작업에 지속 허용을 재사용하지 않는다.
 * 현재도 해석 실패인 method를 fixture로 써야 명령 해석 시험과 혼동하지 않는다. */
describe("S0 — 해석 실패 payload 의 권한 열쇠", () => {
  // 해석되지 않는 승인 요청 — 사람 입력을 요구하는 종류라 command/fileChanges 가 없다.
  //   (신세대 '명령' 승인은 S1 이 해석하므로 더 이상 이 경로를 타지 않는다 — 위 주석 참조)
  const unparsed = (note: string): ApprovalRequest => ({
    method: "item/tool/requestUserInput",
    params: { note, itemId: "i1", turnId: "t1", threadId: "th1", startedAtMs: 1 },
  });

  test("★내용이 다르면 다른 열쇠를 갖는다★ — 하나를 '항상 허용' 해도 다른 하나는 다시 묻는다", () => {
    const a = buildOperationFromApproval(unparsed("A"), "dex");
    const b = buildOperationFromApproval(unparsed("B"), "dex");

    // 같은 method라도 payload가 다른 작업은 같은 scope로 합쳐지지 않아야 한다.
    expect(scopeKeyForOperation(a)).not.toBe(scopeKeyForOperation(b));
  });

  test("target 이 더 이상 method 이름이 아니다", () => {
    const op = buildOperationFromApproval(unparsed("x"), "dex");
    expect(targetForOperation(op)).not.toBe("item/tool/requestUserInput");
    expect(op.action).toBe("approval_unparsed"); // 해석 실패를 이름으로 밝힌다
  });

  test("payload 지문이 target 안에 살아남는다 (240자 절단 뒤에도)", () => {
    const op = buildOperationFromApproval(unparsed("echo hi"), "dex");
    // operation hash 가 절단에 잘려나가면 열쇠가 다시 뭉개진다. 그래서 method 바로 뒤에 둔다.
    expect(targetForOperation(op)).toMatch(/#[0-9a-f]{16}/);
  });

  test("같은 payload 는 같은 열쇠 — 결정적이다", () => {
    const a = buildOperationFromApproval(unparsed("git status"), "dex");
    const b = buildOperationFromApproval(unparsed("git status"), "dex");
    expect(scopeKeyForOperation(a)).toBe(scopeKeyForOperation(b));
  });

  test("★키 순서가 달라도 같은 열쇠★ — 같은 작업에 두 개의 열쇠가 생기면 안 된다", () => {
    const a: ApprovalRequest = { method: "item/tool/requestUserInput", params: { a: 1, b: { x: 1, y: 2 } } };
    const b: ApprovalRequest = { method: "item/tool/requestUserInput", params: { b: { y: 2, x: 1 }, a: 1 } };
    expect(scopeKeyForOperation(buildOperationFromApproval(a, "dex")))
      .toBe(scopeKeyForOperation(buildOperationFromApproval(b, "dex")));
  });

  test("★'__proto__' 키만 다른 payload 도 갈린다★ — 해석 실패 경로의 우회 통로였다", () => {
    // __proto__를 일반 객체 대입으로 정렬하면 own property가 아니어서 JSON에서 사라지고 다른 payload가 충돌한다.
    // 실제 수신과 같은 JSON.parse 입력으로 이 키도 해시에 남는지 확인한다.
    const a = { method: "item/tool/requestUserInput", params: JSON.parse('{"x":1,"__proto__":{"a":1}}') } as ApprovalRequest;
    const b = { method: "item/tool/requestUserInput", params: JSON.parse('{"x":1,"__proto__":{"a":2}}') } as ApprovalRequest;
    expect(scopeKeyForOperation(buildOperationFromApproval(a, "dex")))
      .not.toBe(scopeKeyForOperation(buildOperationFromApproval(b, "dex")));
  });

  test("reason 은 500자까지 text 에 남는다 — Tier-D 스캔 범위를 줄이지 않는다", () => {
    const long = "x".repeat(600);
    const op = buildOperationFromApproval(
      { method: "item/permissions/requestApproval", params: { reason: long, itemId: "i1" } } as ApprovalRequest,
      "dex",
    );
    // 합친 문자열을 다시 자르면 reason 끝이 스캔에서 빠진다. 500자는 온전히 남아야 한다.
    expect(op.text).toContain("x".repeat(500));
  });

  test("★approvalOperationHash 로는 못 가른다★ — 왜 payload 전체 지문이 필요한지의 근거", () => {
    // 이 fixture(item/tool/requestUserInput)는 command 도 fileChanges 도 reason 도 없어
    // basis 가 {method, null, null, null} 로 내용과 무관하게 같아진다.
    // 즉 기존 operation hash 를 그대로 썼다면 위 첫 테스트가 통과하지 못한다.
    // ※ 신세대 '명령' 은 S1 에서 operation hash basis 에 포함되도록 고쳤다 — appServerPopup.s1.test.ts 참조.
    expect(approvalOperationHash(unparsed("rm -rf /tmp/x")))
      .toBe(approvalOperationHash(unparsed("cat ~/.ssh/id_rsa")));
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
    // S5: 본문은 그대로, 앞에 전체 operation hash. 해석 실패 경로(S0 operation hash 열쇠)로 새지 않는 것이 이 가드의 요지다.
    expect(op.command).toMatch(/^rm -rf \/tmp\/x #[0-9a-f]{64}$/);
    expect(targetForOperation(op)).toContain("rm -rf /tmp/x");
  });
});

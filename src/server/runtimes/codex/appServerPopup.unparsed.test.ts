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
 *
 * ★2026-07-29 S1 이후 — 이 파일의 fixture 를 바꿨다(보장은 그대로다).★
 *   S1 이 신세대 ★명령★ 승인(item/commandExecution/requestApproval)을 실제로 해석하게 되면서,
 *   그 payload 는 더 이상 '해석 실패' 가 아니다. 그래서 원래 쓰던 신세대 명령 fixture 로는
 *   ★이 파일이 주장하는 것(해석 실패 경로)을 더 이상 검사하지 못한다.★
 *   → fixture 를 ★지금도 해석되지 않는 method★(item/tool/requestUserInput)로 바꿨다.
 *   ★테스트를 약하게 만든 게 아니라, 검사 대상이 옮겨간 것을 따라간 것이다.★
 *   (신세대 명령이 제대로 해석되는지는 appServerPopup.s1.test.ts 가 따로 고정한다.)
 */
describe("S0 — 해석 실패 payload 의 권한 열쇠", () => {
  // ★해석되지 않는 승인 요청★ — 사람 입력을 요구하는 종류라 command/fileChanges 가 없다.
  //   (신세대 '명령' 승인은 S1 이 해석하므로 더 이상 이 경로를 타지 않는다 — 위 주석 참조)
  const unparsed = (note: string): ApprovalRequest => ({
    method: "item/tool/requestUserInput",
    params: { note, itemId: "i1", turnId: "t1", threadId: "th1", startedAtMs: 1 },
  });

  test("★내용이 다르면 다른 열쇠를 갖는다★ — 하나를 '항상 허용' 해도 다른 하나는 다시 묻는다", () => {
    const a = buildOperationFromApproval(unparsed("A"), "dex");
    const b = buildOperationFromApproval(unparsed("B"), "dex");

    // 이 단언이 S0 의 본체다. 수정 전에는 같은 method 면 내용과 무관하게 ★열쇠가 같았다★.
    expect(scopeKeyForOperation(a)).not.toBe(scopeKeyForOperation(b));
  });

  test("target 이 더 이상 method 이름이 아니다", () => {
    const op = buildOperationFromApproval(unparsed("x"), "dex");
    expect(targetForOperation(op)).not.toBe("item/tool/requestUserInput");
    expect(op.action).toBe("approval_unparsed"); // 해석 실패를 이름으로 밝힌다
  });

  test("payload 지문이 target 안에 살아남는다 (240자 절단 뒤에도)", () => {
    const op = buildOperationFromApproval(unparsed("echo hi"), "dex");
    // 지문이 절단에 잘려나가면 열쇠가 다시 뭉개진다. 그래서 method 바로 뒤에 둔다.
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
    // Codex 리뷰(2026-07-29)에서 잡힌 실제 충돌. 일반 객체에 acc["__proto__"]=... 로 대입하면
    // ★프로토타입이 바뀔 뿐 own property 가 되지 않아 JSON.stringify 에서 통째로 사라진다.★
    // → "__proto__" 값만 다른 두 payload 가 ★같은 지문·같은 열쇠★ 였다(재현: 둘 다 #5353b5b6…).
    // JSON-RPC payload 에 이 키가 오는 것은 유효하므로 ★해석 실패 경로에서 우회 통로★ 가 된다.
    // JSON.parse 로 만들어야 실제 수신 경로와 같다(리터럴로 쓰면 파서가 프로토타입으로 처리한다).
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
    // basis 가 {method, null, null, null} 로 ★내용과 무관하게 같아진다★.
    // ★즉 기존 지문을 그대로 썼다면 위 첫 테스트가 통과하지 못한다.★ (실제로 처음에 그렇게 짰다가 잡혔다)
    // ※ 신세대 '명령' 은 S1 에서 지문 basis 에 포함되도록 고쳤다 — appServerPopup.s1.test.ts 참조.
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
    // ★S5: 본문은 그대로, 앞에 전체 지문.★ 해석 실패 경로(S0 지문 열쇠)로 새지 않는 것이 이 가드의 요지다.
    expect(op.command).toMatch(/^#[0-9a-f]{64} rm -rf \/tmp\/x$/);
    expect(targetForOperation(op)).toContain("rm -rf /tmp/x");
  });
});

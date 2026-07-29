import { test, expect, describe } from "bun:test";
import { buildOperationFromApproval, approvalOperationHash } from "./appServerPopup";
import { scopeKeyForOperation, targetForOperation } from "../../lib/permissionGate";
import type { ApprovalRequest } from "./appServerClient";

/**
 * ★S1(#106) — 명령 승인을 세대 무관하게 해석한다★
 *
 * S0 는 해석 못 한 요청이 넓은 열쇠를 만들지 않게 했다(안전). 하지만 신세대 명령 승인은 여전히
 * 해석되지 않아 ★열쇠도 팝업도 payload 지문★ 이었다 — 안전하지만 ★사람이 무슨 명령인지 볼 수 없다.★
 *
 * S1 은 그 명령을 실제로 읽는다. 판정 기준은 payload 모양이 아니라 ★method★ 다.
 */
describe("S1 — 신세대 명령 승인 해석", () => {
  const newGen = (command: unknown): ApprovalRequest => ({
    method: "item/commandExecution/requestApproval",
    params: { command, cwd: "/tmp", itemId: "i1", turnId: "t1", threadId: "th1", startedAtMs: 1 },
  });
  const oldGen = (command: unknown): ApprovalRequest => ({
    method: "execCommandApproval",
    params: { command, cwd: "/tmp" },
  });

  test("★신세대 문자열 명령이 구세대 배열과 같은 모양으로 해석된다★", () => {
    const nw = buildOperationFromApproval(newGen("rm -rf /tmp/x"), "dex");
    const od = buildOperationFromApproval(oldGen(["rm", "-rf", "/tmp/x"]), "dex");
    expect(nw.action).toBe("shell");
    expect(nw.command).toBe("rm -rf /tmp/x");
    // 같은 명령이면 세대가 달라도 같은 작업으로 본다 — 사람이 보기에 같은 일이기 때문.
    expect(nw.command).toBe(od.command);
  });

  test("★사람이 읽을 수 있는 target 이 된다★ — 지문이 아니라 명령", () => {
    const op = buildOperationFromApproval(newGen("git status"), "dex");
    expect(targetForOperation(op)).toBe("git status");
    expect(targetForOperation(op)).not.toMatch(/#[0-9a-f]{16}/); // S0 지문 형식이 아니다
  });

  test("서로 다른 명령은 서로 다른 열쇠 · 같은 명령은 같은 열쇠", () => {
    const a = buildOperationFromApproval(newGen("rm -rf /tmp/x"), "dex");
    const b = buildOperationFromApproval(newGen("cat /etc/hosts"), "dex");
    const a2 = buildOperationFromApproval(newGen("rm -rf /tmp/x"), "dex");
    expect(scopeKeyForOperation(a)).not.toBe(scopeKeyForOperation(b));
    // ★S0 와 달라지는 지점★: 해석되면 열쇠가 '명령' 단위라 같은 명령은 같은 열쇠다.
    // 그래야 '항상 허용' 이 의미를 갖는다(S0 의 지문 열쇠는 요청마다 달라 매번 물었다).
    expect(scopeKeyForOperation(a)).toBe(scopeKeyForOperation(a2));
  });

  test("★method 는 명령 승인인데 command 가 비면 해석 실패로 보낸다★ — 넓게 통과가 아니라 좁게 묻는다", () => {
    for (const empty of [undefined, null, "", "   ", [], ["", "  "]]) {
      const op = buildOperationFromApproval(newGen(empty), "dex");
      expect(op.action).toBe("approval_unparsed"); // S0 경로로 떨어진다
      expect(targetForOperation(op)).toMatch(/#[0-9a-f]{16}/);
    }
  });

  test("명령 승인이 아닌 method 는 건드리지 않는다 — 회귀 가드", () => {
    const fileReq: ApprovalRequest = {
      method: "item/fileChange/requestApproval",
      params: { itemId: "i1", turnId: "t1", threadId: "th1", startedAtMs: 1 },
    };
    // 신세대 파일 변경은 아직 해석 대상이 아니다(S2). S0 의 보수적 처리를 그대로 받아야 한다.
    expect(buildOperationFromApproval(fileReq, "dex").action).toBe("approval_unparsed");
  });

  test("★혼합 payload — 명령 method + 빈 command + fileChanges 는 write 가 아니라 unparsed★", () => {
    // Codex 리뷰(2026-07-29)에서 잡힌 실제 구멍. '명령 method 아님' 과 '명령 method 인데 못 읽음' 을
    // 같은 null 로 합쳤더니, 호출부가 이어서 fileChanges 를 검사해 ★write 로 처리★ 됐다.
    // ★명령 승인이라고 밝힌 요청은 명령을 못 읽는 순간 거기서 멈춰야 한다★ — fail-closed 계약.
    const mixed: ApprovalRequest = {
      method: "item/commandExecution/requestApproval",
      params: { command: "", fileChanges: { "x.ts": {} }, itemId: "i", turnId: "t", threadId: "th", startedAtMs: 1 },
    };
    expect(buildOperationFromApproval(mixed, "dex").action).toBe("approval_unparsed");
  });

  test("★서로 다른 신세대 명령은 서로 다른 작업 지문을 갖는다★ — 상관키가 둘을 구분해야 한다", () => {
    // S1 이 문자열 command 를 실제 shell operation 으로 승격하는데, 지문 basis 가 Array.isArray 만 보면
    // ★신세대는 전부 command:null★ 이 되어 서로 다른 명령이 ★같은 지문★ 을 갖는다(Codex 리뷰에서 재현).
    // 상관키·audit 이 두 요청을 구분하지 못하면 결정이 엉뚱한 요청에 배달될 수 있다.
    expect(approvalOperationHash(newGen("rm -rf /tmp/x")))
      .not.toBe(approvalOperationHash(newGen("cat /etc/shadow")));
  });

  test("구세대 배열 지문은 값이 그대로다 — 변경 범위 최소화 확인", () => {
    // 배열은 배열 그대로 basis 에 넣어 구세대 지문 값을 바꾸지 않았다.
    const a = approvalOperationHash(oldGen(["ls", "-la"]));
    const b = approvalOperationHash(oldGen(["ls", "-la"]));
    expect(a).toBe(b);
    expect(a).not.toBe(approvalOperationHash(oldGen(["ls", "-l"])));
  });

  test("구세대 배열 경로 불변 — 회귀 가드", () => {
    const op = buildOperationFromApproval(oldGen(["echo", "hi"]), "dex");
    expect(op.action).toBe("shell");
    expect(op.command).toBe("echo hi");
  });

  test("구세대 파일 변경 경로 불변 — 회귀 가드", () => {
    const req: ApprovalRequest = {
      method: "applyPatchApproval",
      params: { fileChanges: { "b.ts": {}, "a.ts": {} }, callId: "c1" },
    };
    const op = buildOperationFromApproval(req, "dex");
    expect(op.action).toBe("write");
    expect(op.path).toBe("a.ts|b.ts"); // 정렬된 전체 파일집합
  });
});

import { test, expect, describe } from "bun:test";
import { approvalOperationHash } from "./appServerPopup";
import type { ApprovalRequest } from "./appServerClient";

const cmd = (arr: string[]): ApprovalRequest => ({ method: "item/commandExecution/requestApproval", params: { command: arr } });

describe("approvalOperationHash — TOCTOU/scope 하드닝(Phase1 ③)", () => {
  test("결정적: 같은 작업 → 같은 해시", () => {
    expect(approvalOperationHash(cmd(["ls", "-la"]))).toBe(approvalOperationHash(cmd(["ls", "-la"])));
  });

  test("★잘린 요약(2000자)이 같아도 전체가 다르면 해시가 다르다 — grant 재사용 차단★", () => {
    const prefix = "x".repeat(2100); // 팝업 command 표시(slice 2000)는 동일하게 잘림
    const a = cmd([prefix + "AAA"]);
    const b = cmd([prefix + "BBB"]);
    // 표시용 truncation은 같지만(앞 2000자 동일) 전체가 달라 해시는 달라야 한다.
    expect(a.params.command).not.toEqual(b.params.command);
    expect(approvalOperationHash(a)).not.toBe(approvalOperationHash(b));
  });

  test("command vs fileChanges vs method 구분", () => {
    const fileReq: ApprovalRequest = { method: "item/fileChange/requestApproval", params: { fileChanges: { "a.ts": {}, "b.ts": {} } } };
    expect(approvalOperationHash(cmd(["a.ts", "b.ts"]))).not.toBe(approvalOperationHash(fileReq));
    // 파일집합 정렬 무관 동일
    const f1: ApprovalRequest = { method: "item/fileChange/requestApproval", params: { fileChanges: { "a.ts": {}, "b.ts": {} } } };
    const f2: ApprovalRequest = { method: "item/fileChange/requestApproval", params: { fileChanges: { "b.ts": {}, "a.ts": {} } } };
    expect(approvalOperationHash(f1)).toBe(approvalOperationHash(f2));
  });

  test("16 hex 길이", () => {
    expect(approvalOperationHash(cmd(["echo", "hi"]))).toMatch(/^[0-9a-f]{16}$/);
  });
});

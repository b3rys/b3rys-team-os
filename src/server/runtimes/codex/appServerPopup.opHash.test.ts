import { test, expect, describe } from "bun:test";
import { approvalOperationHash, buildOperationFromApproval } from "./appServerPopup";
import { scopeKeyForOperation } from "../../lib/permissionGate";
import type { ApprovalRequest } from "./appServerClient";

const cmd = (arr: string[]): ApprovalRequest => ({ method: "item/commandExecution/requestApproval", params: { command: arr } });

describe("approvalOperationHash — 지문의 결정성·충돌저항(권한 결합은 미구현)", () => {
  test("결정적: 같은 작업 → 같은 해시", () => {
    expect(approvalOperationHash(cmd(["ls", "-la"]))).toBe(approvalOperationHash(cmd(["ls", "-la"])));
  });

  test("잘린 요약(2000자)이 같아도 전체 command가 다르면 해시가 다르다 (해시 수준 구분만 — grant 재사용 차단 아님)", () => {
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

/**
 * ★알려진 갭을 코드로 못 박는다 (2026-07-28 Codex·Bill 리뷰).★
 *
 * 아래 테스트들은 ★현재 동작(=갭이 존재함)을 단언한다★. 말로만 남긴 갭은 사라지므로,
 * 후속 작업(전체 canonical operation을 grant scope에 결합 + 실행 직전 재해시 + 파일 내용 해시)에서
 * 이 갭이 실제로 닫히면 ★이 테스트들이 실패한다★. 그 실패가 후속 작업의 ★완료 판정★이다.
 * 실패하면 테스트를 '갭이 닫혔다'는 단언으로 뒤집어 쓰면 된다.
 *
 * ★이 갭이 닫히기 전에는 B3OS_CODEX_APPSERVER를 켜지 않는다 — release blocker.★
 */
describe("알려진 갭 (후속 작업에서 닫히면 이 테스트가 실패해야 한다)", () => {
  test("갭1: 240자 prefix가 같으면 전체가 달라도 ★같은 grant scope★로 취급된다", () => {
    // permissionGate.targetForOperation이 target을 앞 240자만 쓴다 → 뒤가 갈라져도 scope가 같다.
    const prefix = "y".repeat(240);
    const safe = buildOperationFromApproval(cmd([prefix + "SAFE"]), "demis");
    const evil = buildOperationFromApproval(cmd([prefix + "EVIL"]), "demis");

    // 지문(해시)은 둘을 구분한다 —
    expect(safe.provenance!.operation_hash).not.toBe(evil.provenance!.operation_hash);
    // — 그런데 실제 권한 판단에 쓰이는 scope는 같다. ★이 한 줄이 갭의 본체다.★
    expect(scopeKeyForOperation(safe)).toBe(scopeKeyForOperation(evil));
  });

  test("갭2: 파일 이름이 같으면 ★내용이 달라도★ 지문이 같다", () => {
    // basis의 files가 Object.keys()라 이름만 담는다 → 승인과 실행 사이 내용 변경을 구분하지 못한다.
    const before: ApprovalRequest = {
      method: "item/fileChange/requestApproval",
      params: { fileChanges: { "a.ts": { diff: "export const x = 1;" } } },
    };
    const after: ApprovalRequest = {
      method: "item/fileChange/requestApproval",
      params: { fileChanges: { "a.ts": { diff: "process.exit(1);" } } },
    };
    expect(approvalOperationHash(before)).toBe(approvalOperationHash(after));
  });
});

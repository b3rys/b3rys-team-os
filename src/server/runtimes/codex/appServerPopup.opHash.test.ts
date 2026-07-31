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

});

/**
 * ★갭2 는 닫혔다 (S4, 2026-07-31).★ 지문 basis 에 ★내용 해시★ 를 넣었다.
 *
 * ■ ★옛 테스트가 틀린 모양을 쓰고 있었다★ — 이걸 먼저 적는다
 * 예전 갭2 테스트는 `fileChanges: { "a.ts": { diff: "..." } }` 로 갭을 보였다.
 * 그런데 ★벤더 스키마에 `diff` 라는 필드는 없다★ (0.144.6 실측:
 * AddFileChange{content} · DeleteFileChange{content} · UpdateFileChange{unified_diff, move_path}).
 * 즉 ★실제로는 올 수 없는 입력으로 갭을 증명하고 있었다.★ 그래서 S4 를 구현한 뒤에도
 * 그 테스트는 ★초록 그대로였다★ — "갭이 닫히면 빨강이 된다" 는 완료 신호가 작동하지 않았다.
 * ★모양을 지어내면 시험은 통과하고 실물에서 틀린다★ — 오늘 반복해서 만난 형태다.
 * → 실제 모양으로 다시 쓰고, 이제 ★갭이 닫혔다는 단언★ 으로 뒤집는다.
 */
describe("갭2 닫힘 — 같은 파일이라도 내용이 다르면 지문이 다르다 (S4)", () => {
  const oldGen = (fileChanges: unknown): ApprovalRequest => ({
    method: "applyPatchApproval",
    params: { fileChanges, callId: "c1" },
  });

  test("★구세대: 내용만 달라도 지문이 갈린다★ — 승인과 실행 사이 바꿔치기를 상관키가 구분한다", () => {
    const before = oldGen({ "a.ts": { type: "update", unified_diff: "export const x = 1;" } });
    const after = oldGen({ "a.ts": { type: "update", unified_diff: "process.exit(1);" } });
    expect(approvalOperationHash(before)).not.toBe(approvalOperationHash(after));
  });

  test("★신세대: 관측한 내용이 다르면 지문이 갈린다★ (payload 에는 내용이 없다 — 색인해 둔 것을 쓴다)", () => {
    const req = (diff: string): ApprovalRequest => ({
      method: "item/fileChange/requestApproval",
      params: { itemId: "i1", turnId: "t1" },
      observedItem: { itemId: "i1", turnId: "t1", threadId: "th", changes: [{ path: "a.ts", kind: "update", movePath: null, diff }] },
    });
    expect(approvalOperationHash(req("@@ -1 +1 @@\n-a\n+b\n")))
      .not.toBe(approvalOperationHash(req("@@ -1 +1 @@\n-a\n+DANGER\n")));
  });

  test("같은 내용이면 같은 지문이다 — 갈라지기만 하면 되는 게 아니다", () => {
    const one = oldGen({ "a.ts": { type: "add", content: "hello\n" } });
    const two = oldGen({ "a.ts": { type: "add", content: "hello\n" } });
    expect(approvalOperationHash(one)).toBe(approvalOperationHash(two));
  });

  test("★종류가 다르면 다른 작업이다★ — 같은 내용을 add 하는 것과 update 하는 것은 같지 않다", () => {
    const added = oldGen({ "a.ts": { type: "add", content: "x\n" } });
    const updated = oldGen({ "a.ts": { type: "update", unified_diff: "x\n" } });
    expect(approvalOperationHash(added)).not.toBe(approvalOperationHash(updated));
  });

  test("★신세대도 종류가 지문에 들어간다★ — 같은 파일·같은 내용이라도 add 와 update 는 다르다", () => {
    // ★뮤턴트가 살아남아 추가했다(M3).★ 앞 시험은 구세대만 봐서, 신세대 kind 를 상수로 바꿔도 초록이었다.
    const req = (kind: string): ApprovalRequest => ({
      method: "item/fileChange/requestApproval",
      params: { itemId: "i1", turnId: "t1" },
      observedItem: { itemId: "i1", turnId: "t1", threadId: "th", changes: [{ path: "a.ts", kind, movePath: null, diff: "x\n" }] },
    });
    expect(approvalOperationHash(req("add"))).not.toBe(approvalOperationHash(req("update")));
  });

  test("★종류와 필드가 어긋나면 내용을 안 읽는다★ — 엉뚱한 값을 지문에 넣지 않는다", () => {
    // ★뮤턴트가 살아남아 추가했다(M4).★ 앞 시험은 kind 가 달라서 통과했고, ★필드 선택 자체는 재지 않았다.★
    // update 인데 content 만 있는 payload 는 ★내용을 모르는 것★ 으로 본다(S3 에서 표시 쪽에 한 정정과 같다).
    // 그러므로 content 가 A 든 B 든 지문이 같아야 한다 — 다르면 없는 내용을 읽고 있다는 뜻이다.
    const a = oldGen({ "a.ts": { type: "update", content: "AAA" } });
    const b = oldGen({ "a.ts": { type: "update", content: "BBB" } });
    expect(approvalOperationHash(a)).toBe(approvalOperationHash(b));
  });

  test("★빈 파일도 '아는 내용' 이다★ — 빈 파일 생성과 빈 파일 삭제는 다른 작업이다", () => {
    // ★코덱스 리뷰 P1(재현 확인).★ 길이로 "내용을 얻었나" 를 재면 ★정상적인 빈 파일 작업이 '모름' 과 합쳐진다.★
    // basis.files 에는 kind 가 없어서 그 둘을 갈라줄 다른 재료도 없었다 → 같은 지문이 됐다.
    const addEmpty = oldGen({ "a.ts": { type: "add", content: "" } });
    const delEmpty = oldGen({ "a.ts": { type: "delete", content: "" } });
    expect(approvalOperationHash(addEmpty)).not.toBe(approvalOperationHash(delEmpty));
  });

  test("★'비어 있다' 와 '모른다' 는 다르다★ — 내용 필드가 아예 없는 것과 구분된다", () => {
    const known = oldGen({ "a.ts": { type: "add", content: "" } });   // 빈 파일을 만든다(아는 것)
    const unknown = oldGen({ "a.ts": { type: "add" } });               // 내용 필드가 없다(모르는 것)
    expect(approvalOperationHash(known)).not.toBe(approvalOperationHash(unknown));
  });

  test("모르는 종류에서 필드 우선순위를 고정한다 — 먼저 선언된 쪽을 믿는다", () => {
    // 비차단 지적(코덱스): type 없음 + unified_diff:"" + content:"X" 에서 ★빈 diff 가 X 를 가린다.★
    // 그게 의도인지 사고인지 코드만 봐선 모르므로 ★계약으로 못박는다★ — 종류를 모를 때는 unified_diff 를 먼저 본다.
    const a = oldGen({ "a.ts": { unified_diff: "", content: "X" } });
    const b = oldGen({ "a.ts": { unified_diff: "", content: "Y" } });
    expect(approvalOperationHash(a)).toBe(approvalOperationHash(b)); // content 는 안 본다
  });

  test("★내용을 모르면 지문을 바꾸지 않는다★ — 구세대 golden 이 그대로여야 한다", () => {
    // 내용 없는 payload 에 빈 문자열을 해시하면 "내용을 안다" 는 거짓 신호가 되고 골든도 깨진다.
    expect(approvalOperationHash(oldGen({ "b.ts": {}, "a.ts": {} }))).toBe("c7fa63459c642993");
  });
});

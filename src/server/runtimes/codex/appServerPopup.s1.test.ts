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
    // ★S5 이후: 사람이 읽는 본문은 그대로고, 앞에 전체 지문이 붙는다.★ (240자 절단선 안에 열쇠를 남기려고)
    expect(nw.command).toMatch(/^rm -rf \/tmp\/x #[0-9a-f]{64}$/);
    expect(od.command).toMatch(/^rm -rf \/tmp\/x #[0-9a-f]{64}$/);
  });

  test("★S5 에서 뒤집힌 결정★: 세대가 다르면 이제 따로 묻는다 — 합칠 수가 없다", () => {
    // S5 이전 계약은 '같은 명령이면 세대가 달라도 같은 작업' 이었다. 그것을 의도적으로 바꿨다.
    //
    // ★고칠 수 있는데 안 합친 게 아니라, 합칠 방법이 없다.★
    // 구세대는 argv 배열(['a b','c'])이고 신세대는 문자열("a b c")이다. 배열을 문자열로 이으면
    // ★['a b','c'] 와 ['a','b c'] 가 같은 문자열이 되어 실제로 다른 실행이 한 허용으로 묶인다★ (실측된 구멍).
    // 그래서 지문 재료로 구조를 보존해야 하는데, ★문자열에서 argv 경계는 복원할 수 없다.★
    // → 두 세대는 원리적으로 같은 열쇠를 가질 수 없다.
    //
    // 사용자에게 보이는 영향: codex CLI 세대가 바뀌면 저장된 '항상 허용' 을 ★한 번 다시 묻는다.★
    // 방향이 안전하다(몰래 통과가 아니라 다시 묻기)이므로 이 손해를 받아들인다.
    const nw = buildOperationFromApproval(newGen("rm -rf /tmp/x"), "dex");
    const od = buildOperationFromApproval(oldGen(["rm", "-rf", "/tmp/x"]), "dex");
    expect(scopeKeyForOperation(nw)).not.toBe(scopeKeyForOperation(od));
  });

  test("★구세대 argv 경계가 열쇠를 가른다★ — 이어붙인 문자열로 합치지 않는다", () => {
    // ['a b','c'] 는 인자가 'a b' 하나, ['a','b c'] 는 실행 파일이 'a' — ★실제로 다른 실행이다.★
    // 이어붙이면 둘 다 "a b c" 가 되어 하나를 허용하면 나머지가 팝업 없이 통과했다(실측).
    const x = buildOperationFromApproval(oldGen(["a b", "c"]), "dex");
    const y = buildOperationFromApproval(oldGen(["a", "b c"]), "dex");
    expect(scopeKeyForOperation(x)).not.toBe(scopeKeyForOperation(y));
  });

  test("★사람이 읽을 수 있는 target 이 된다★ — 지문이 아니라 명령", () => {
    const op = buildOperationFromApproval(newGen("git status"), "dex");
    // ★명령 본문이 사람 눈에 남는다★ — 지문만 보이는 S0 형식이 아니다. (지문은 앞에 붙는다)
    expect(targetForOperation(op)).toContain("git status");
    expect(targetForOperation(op)).toMatch(/^git status #[0-9a-f]{64}$/);
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
    // (2026-07-29) 리뷰에서 잡힌 실제 구멍. '명령 method 아님' 과 '명령 method 인데 못 읽음' 을
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
    // ★신세대는 전부 command:null★ 이 되어 서로 다른 명령이 ★같은 지문★ 을 갖는다(재현 확인).
    // 상관키·audit 이 두 요청을 구분하지 못하면 결정이 엉뚱한 요청에 배달될 수 있다.
    expect(approvalOperationHash(newGen("rm -rf /tmp/x")))
      .not.toBe(approvalOperationHash(newGen("cat /etc/shadow")));
  });

  test("★구세대 배열 지문 값이 S1 이전과 동일하다★ — golden 값으로 고정", () => {
    // ★재리뷰(2026-07-29) 지적 반영★: 앞선 판에서 이 테스트는 '결정성 + 다른 입력 구분' 만
    // 검사하면서 이름은 "값이 그대로다" 라고 주장했다. ★테스트 이름이 검사하는 것보다 많이 주장했다.★
    // ★그 주장을 실제로 고정한다.★
    //
    // golden 값은 ★S1 이전 정본(9903b3d)에서 같은 입력으로 실측★ 해 얻었다. 두 판이 같은 값을 냈다.
    // 이 값이 바뀌면 = 배열 경로를 건드린 것이고, 진행 중인 승인의 상관키가 어긋날 수 있다.
    expect(approvalOperationHash(oldGen(["ls", "-la"]))).toBe("b1a8a5879bc13205");
  });

  test("구세대 배열 경로 불변 — 회귀 가드", () => {
    const op = buildOperationFromApproval(oldGen(["echo", "hi"]), "dex");
    expect(op.action).toBe("shell");
    expect(op.command).toMatch(/^echo hi #[0-9a-f]{64}$/);
  });

  test("구세대 파일 변경 경로 불변 — 회귀 가드", () => {
    const req: ApprovalRequest = {
      method: "applyPatchApproval",
      params: { fileChanges: { "b.ts": {}, "a.ts": {} }, callId: "c1" },
    };
    const op = buildOperationFromApproval(req, "dex");
    expect(op.action).toBe("write");
    // ★S3 에서 표시 형식이 바뀌었다★ — 파일집합(정렬)은 그대로이고 사람이 읽을 말과 지문이 붙었다.
    expect(op.path).toMatch(/^파일 2개 · change a\.ts, change b\.ts #[0-9a-f]{12}$/);
  });
});

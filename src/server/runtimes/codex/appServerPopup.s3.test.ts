import { test, expect, describe } from "bun:test";
import { buildOperationFromApproval } from "./appServerPopup";
import { scopeKeyForOperation, targetForOperation } from "../../lib/permissionGate";
import type { ApprovalRequest } from "./appServerClient";
import type { ObservedItem } from "./appServerItemIndex";

/**
 * ★S3(#106) — 사람이 볼 수 있게.★
 *
 * ★이 단계가 왜 필요했는지 (실측으로 발견):★
 * S2 는 `update a.ts(+1/-2)` 같은 사람용 요약을 `op.text` 에 잘 만들어 뒀다. 그런데
 * ★팝업은 text 를 보여주지 않는다.★ telegramCapture 가 렌더하는 두 줄은
 *   `${runtime}/${agent_id} · ${action}` / `${target}`
 * 이고, `targetForOperation` 의 우선순위는 ★command > path > egress_url > text★ 다.
 * → write 승인에서는 ★path 가 화면이고 text 는 아무도 못 본다.★
 * 그래서 S2 의 완료 판정("파일명+규모가 포함된다")은 ★text 기준으로는 참, 화면 기준으로는 거짓★ 이었다.
 *
 * ★그래서 S3 의 대상은 path 다★ — 한 문자열이 ①열쇠 ②사람이 읽는 유일한 줄 두 일을 한다.
 * 규모(+n/-n)는 ★열쇠에 넣을 수 없다★(내용이 바뀔 때마다 열쇠가 달라져 '항상 허용' 이 영원히 안 붙는다).
 * 규모를 화면에 띄우려면 렌더러(codex 폴더 밖)를 고쳐야 한다 — ★팀 리드 판단 대기 항목.★
 */

const observed = (
  changes: Array<{ path: string; kind: string; movePath?: string | null; diff?: string }>,
): ObservedItem => ({
  itemId: "i1",
  turnId: "t1",
  threadId: "th1",
  changes: changes.map((c) => ({ path: c.path, kind: c.kind, movePath: c.movePath ?? null, diff: c.diff ?? "@@ -1 +1 @@\n-a\n+b\n" })),
});
const fileReq = (observedItem: ObservedItem, extra: Record<string, unknown> = {}): ApprovalRequest => ({
  method: "item/fileChange/requestApproval",
  params: { itemId: observedItem.itemId, turnId: "t1", threadId: "th1", ...extra },
  observedItem,
});
/** 팝업이 실제로 보여주는 두 번째 줄(telegramCapture.ts) — 화면을 시험한다. */
const screenLine = (op: ReturnType<typeof buildOperationFromApproval>) => targetForOperation(op);

describe("S3 — 화면이 곧 열쇠라는 계약", () => {
  test("★화면에 나오는 줄은 text 가 아니라 path 다★ — 이 우선순위가 바뀌면 S3 전체 전제가 무너진다", () => {
    const op = buildOperationFromApproval(fileReq(observed([{ path: "src/a.ts", kind: "update" }])), "dex");
    expect(op.text).toContain("(+1/-1)");        // 규모는 text 에 있다
    expect(screenLine(op)).toBe(op.path ?? "");  // ★그런데 화면은 path 다★
    expect(screenLine(op)).not.toContain("(+");  // → 규모는 화면에 안 나온다(렌더러 변경 대기)
  });

  test("사람이 읽는 순서로 시작한다 — 첫 글자가 지문이 아니다", () => {
    const op = buildOperationFromApproval(fileReq(observed([{ path: "src/a.ts", kind: "update" }])), "dex");
    expect(screenLine(op).startsWith("파일 ")).toBe(true);
    expect(screenLine(op)).toMatch(/#[0-9a-f]{12}$/); // 지문은 맨 뒤
  });
});

describe("S3 — 잘려도 열쇠가 갈린다 (지문을 뒤로 옮긴 근거)", () => {
  const many = (tail: string) =>
    observed(Array.from({ length: 20 }, (_, i) => ({ path: `src/very/long/directory/name/file${i}${i === 19 ? tail : ""}.ts`, kind: "update" })));

  test("★앞부분이 같고 뒤만 다른 두 요청은 열쇠가 달라야 한다★ — 240자 절단이 합치지 못한다", () => {
    const a = buildOperationFromApproval(fileReq(many("-alpha")), "dex");
    const b = buildOperationFromApproval(fileReq(many("-bravo")), "dex");
    // 화면에 보이는 부분은 같다 — 사람 눈으로는 구별이 안 된다.
    expect(screenLine(a).slice(0, 100)).toBe(screenLine(b).slice(0, 100));
    // ★그래도 열쇠는 갈린다★ — 파일집합 전체의 지문이 절단선 안에 남기 때문이다.
    expect(scopeKeyForOperation(a)).not.toBe(scopeKeyForOperation(b));
  });

  test("몇 개가 안 보이는지 말한다 — 단어 중간에서 끊지 않는다", () => {
    const op = buildOperationFromApproval(fileReq(many("")), "dex");
    expect(screenLine(op)).toContain("…외 ");
    expect(screenLine(op).length).toBeLessThanOrEqual(240);
    expect(screenLine(op)).toMatch(/#[0-9a-f]{12}$/); // 잘림 뒤에도 지문 생존
  });

  test("같은 파일을 다시 고치면 열쇠가 같다 — '항상 허용' 이 계속 유효하다", () => {
    const one = buildOperationFromApproval(fileReq(observed([{ path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" }])), "dex");
    const two = buildOperationFromApproval(fileReq(observed([{ path: "src/a.ts", kind: "update", diff: "@@ -1,9 +1,9 @@\n-x\n+y\n-z\n+w\n" }])), "dex");
    expect(one.text).not.toBe(two.text);                          // 규모는 다르다
    expect(scopeKeyForOperation(one)).toBe(scopeKeyForOperation(two)); // ★열쇠는 같다★
  });
});

describe("S3 — 구세대도 같은 것을 보여준다", () => {
  /** ★벤더 스키마 0.144.6 실측 모양★ — 짐작이 아니라 generate-json-schema 출력에서 읽었다.
   *    add    `{ type:"add",    content }`      delete `{ type:"delete", content }`
   *    update `{ type:"update", unified_diff, move_path? }` */
  const oldGen = (fileChanges: Record<string, unknown>): ApprovalRequest => ({
    method: "applyPatchApproval",
    params: { fileChanges, callId: "c1" },
  });

  test("★구세대 payload 에도 내용이 있었다★ — 지금까지 이름만 보여준 것은 재료가 없어서가 아니었다", () => {
    const op = buildOperationFromApproval(
      oldGen({
        "src/a.ts": { type: "update", unified_diff: "@@ -1,2 +1,3 @@\n a\n-b\n+B\n+C\n" },
        "src/new.ts": { type: "add", content: "HELLO\nWORLD\n" },
        "src/old.ts": { type: "delete", content: "X\n" },
      }),
      "dex",
    );
    expect(op.text).toContain("update src/a.ts(+2/-1)");
    expect(op.text).toContain("add src/new.ts(+2/-0)");
    expect(op.text).toContain("delete src/old.ts(+0/-1)");
    expect(screenLine(op)).toContain("파일 3개");
    expect(screenLine(op)).toContain("delete src/old.ts");
  });

  test("★내용을 모르면 규모를 지어내지 않는다★ — (+0/-0) 은 '아무것도 안 바뀐다' 는 거짓말이다", () => {
    const op = buildOperationFromApproval(oldGen({ "src/a.ts": {} }), "dex");
    expect(op.text).not.toContain("(+0/-0)");
    expect(op.text).toContain("change src/a.ts");
  });

  test("구세대 이동도 목적지가 화면에 보인다", () => {
    const op = buildOperationFromApproval(
      oldGen({ "a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n", move_path: "b/c.ts" } }),
      "dex",
    );
    expect(screenLine(op)).toContain("a.ts → b/c.ts");
  });
});

describe("S3 — 폴더 전체 요청은 경고가 먼저 보인다", () => {
  const root = (r: string) => buildOperationFromApproval(fileReq(observed([{ path: "src/a.ts", kind: "update" }]), { grantRoot: r }), "dex");

  test("★화면 첫 글자가 경고다★ — 이건 파일 1개가 아니라 폴더 하위 전체 승인이다", () => {
    const op = root("/Users/x/Development/proj");
    expect(screenLine(op).startsWith("⚠")).toBe(true);
    expect(screenLine(op)).toContain("/Users/x/Development/proj");
  });

  test("★긴 루트는 뒤를 남긴다★ — 뿌리는 앞이 아니라 뒤가 다르다", () => {
    const base = "/Users/x/" + "deep/".repeat(30);
    const a = root(`${base}alpha`);
    const b = root(`${base}bravo`);
    expect(screenLine(a)).toContain("alpha");   // 사람이 구별할 수 있다
    expect(screenLine(b)).toContain("bravo");
    expect(scopeKeyForOperation(a)).not.toBe(scopeKeyForOperation(b)); // 열쇠도 갈린다(P2)
  });

  test("★표시에 안 보이는 부분만 다른 두 루트도 열쇠가 갈린다★ — 지문이 루트 전문을 담는 이유", () => {
    // ★이 시험은 뮤턴트가 살아남아서 추가했다(2026-07-30).★ 앞 시험은 두 루트의 ★뒤★ 가 달라서
    //   표시 문자열만으로도 열쇠가 갈렸다 — 즉 지문을 지워도 초록이었다. ★기계가 아니라 입력이 문제였다.★
    //   여기서는 ★뒤 71자가 완전히 같고 앞만 다른★ 두 루트를 쓴다. 표시로는 구별이 불가능하므로
    //   지문이 grantRoot 전문을 담지 않으면 ★서로 다른 폴더 승인이 같은 열쇠★ 가 된다(P2 그 사고).
    const tail = "/" + "x".repeat(300);
    const a = root(`/alpha${tail}`);
    const b = root(`/bravo${tail}`);
    // ★사람이 읽는 부분(지문 앞까지)이 글자 하나까지 같다★ — 눈으로는 구별할 방법이 없다.
    const readable = (s: string) => s.replace(/ #[0-9a-f]{12}$/, "");
    expect(readable(screenLine(a))).toBe(readable(screenLine(b)));
    // → 즉 ★이 두 요청을 가르는 것은 지문뿐이다★. 그래서 지문이 루트 전문을 담아야 한다.
    expect(scopeKeyForOperation(a)).not.toBe(scopeKeyForOperation(b)); // ★그래도 열쇠는 갈려야 한다★
  });

  test("루트가 같으면 열쇠가 같다 — 세션 승인이 재사용된다", () => {
    expect(scopeKeyForOperation(root("/repo"))).toBe(scopeKeyForOperation(root("/repo")));
  });
});

/**
 * ★코덱스 리뷰(2026-07-30)가 잡은 반례 — 전부 내가 직접 재현한 뒤 고쳤다.★
 *
 * 앞의 시험 39건은 전부 초록이었는데 아래 여섯 가지가 다 깨져 있었다. ★내 시험이 내가 주장한 것을
 * 재고 있지 않았다★ — 오늘 M2 뮤턴트가 살아남은 것과 같은 형태다(입력이 메커니즘을 안 건드렸다).
 * 그리고 두 번째 시험은 내가 코덱스에게 ★"열쇠는 지문이 갈라준다" 고 단언한 자리★ 다.
 * 지문의 재료가 모호했으므로 그 단언이 틀렸다 — ★단언 전에 재료를 봐야 했다.★
 */
describe("S3 — 코덱스 리뷰 반례 (회귀 가드)", () => {
  const one = (path: string, kind = "update", movePath: string | null = null, diff?: string) =>
    buildOperationFromApproval(fileReq(observed([{ path, kind, movePath, diff }])), "dex");
  const oldGen = (fileChanges: unknown): ApprovalRequest => ({
    method: "applyPatchApproval",
    params: { fileChanges, callId: "c1" },
  });

  test("★첫 항목이 예산을 넘어도 지문이 살아남는다★ — 안 그러면 긴 경로들이 한 열쇠로 합쳐진다", () => {
    const a = one("src/" + "x".repeat(400) + ".ts");
    const b = one("src/" + "x".repeat(400) + "-DIFFERENT.ts");
    expect(targetForOperation(a).length).toBeLessThanOrEqual(240);
    expect(targetForOperation(a)).toMatch(/#[0-9a-f]{12}$/);           // 지문 생존
    expect(targetForOperation(a)).toContain("…");                      // 잘렸음을 말한다
    expect(scopeKeyForOperation(a)).not.toBe(scopeKeyForOperation(b)); // ★앞 240자가 같아도 갈린다★
  });

  test("★이름에 '>' 가 든 파일과 '이동' 이 같은 열쇠가 되지 않는다★ — 지문 재료가 구조화 tuple 이라서", () => {
    const plain = one("a>b.ts", "add", null, "X\n");
    const move = one("a", "update", "b.ts");
    expect(scopeKeyForOperation(plain)).not.toBe(scopeKeyForOperation(move));
    // 표시도 원본 필드에서 조립한다 — 평범한 파일이 '옮긴다' 로 거짓 표시되지 않는다.
    expect(screenLine(plain)).toContain("add a>b.ts");
    expect(screenLine(plain)).not.toContain("→");
  });

  test("★'a>b'→'c' 와 'a'→'b>c' 는 서로 다른 쓰기다★ — 이어붙인 문자열로 해시하면 같은 열쇠였다", () => {
    const x = one("a>b", "update", "c");
    const y = one("a", "update", "b>c");
    expect(scopeKeyForOperation(x)).not.toBe(scopeKeyForOperation(y));
  });

  test("★240 경계가 이모지를 반 토막 내지 않는다★ — 고아 서로게이트로 끝나면 안 된다", () => {
    for (const pad of [220, 222, 224, 226]) {
      const t = targetForOperation(one("a".repeat(pad) + "😀" + ".ts"));
      const last = t.charCodeAt(t.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  test("★새 파일 내용에 '@@' 줄이 있어도 (+0/-0) 이 안 된다★ — 모양이 아니라 종류로 판정한다", () => {
    expect(buildOperationFromApproval(oldGen({ "a.md": { type: "add", content: "@@ heading\nhello\n" } }), "dex").text)
      .toContain("add a.md(+2/-0)");
    expect(buildOperationFromApproval(oldGen({ "b.md": { type: "delete", content: "@@ x\ny\n" } }), "dex").text)
      .toContain("delete b.md(+0/-2)");
    expect(one("c.md", "add", null, "@@ heading\nhello\n").text).toContain("add c.md(+2/-0)"); // 신세대도
  });

  test("★빈 목록·배열은 '파일 0개 쓰기' 가 아니라 해석 실패다★ — 넓은 열쇠를 만들지 않는다", () => {
    expect(buildOperationFromApproval(oldGen({}), "dex").action).toBe("approval_unparsed");
    const arr = buildOperationFromApproval(oldGen(["src/z.ts"]), "dex");
    expect(arr.action).toBe("approval_unparsed");
    expect(screenLine(arr)).not.toContain("change 0"); // 인덱스를 경로로 표시하지 않는다
  });
});

describe("S3 — 해석 실패 화면", () => {
  test("★내부 용어만 두 줄 보여주지 않는다★ — 사람 말로 상황을 먼저 말한다", () => {
    const op = buildOperationFromApproval(
      { method: "item/fileChange/requestApproval", params: { itemId: "i9", turnId: "t9", reason: "패치를 적용해도 될까요" } },
      "dex",
    );
    expect(op.action).toBe("approval_unparsed"); // 앞줄은 공용 코드가 만든다 — 여기서 못 바꾼다
    expect(screenLine(op).startsWith("내용 해석 실패")).toBe(true); // ★뒷줄이 설명한다★
    expect(screenLine(op)).toContain("패치를 적용해도 될까요");
    expect(screenLine(op)).toMatch(/#[0-9a-f]{16}/); // payload 지문은 유지(요청마다 다른 열쇠)
  });

  test("사람 말 머리말이 열쇠 구분력을 줄이지 않는다 — 상수이므로", () => {
    const mk = (reason: string): ApprovalRequest => ({
      method: "item/fileChange/requestApproval",
      params: { itemId: "i9", turnId: "t9", reason },
    });
    const a = buildOperationFromApproval(mk("하나"), "dex");
    const b = buildOperationFromApproval(mk("둘"), "dex");
    expect(scopeKeyForOperation(a)).not.toBe(scopeKeyForOperation(b));
  });
});

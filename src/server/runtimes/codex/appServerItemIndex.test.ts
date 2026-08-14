import { test, expect, describe } from "bun:test";
import { CodexTurnItemIndex } from "./appServerItemIndex";

/**
 * ★S2a — turn 단위 알림 색인★
 *
 * 이 색인이 틀리면 ★사람이 승인한 것과 실제로 실행되는 것이 달라진다.★ 그래서 시험의 초점은
 * '잘 찾는다' 가 아니라 ★'엉뚱한 것을 찾아주지 않는다'★ 다.
 */
const patch = (itemId: string, turnId: string, changes: unknown) => ({
  method: "item/fileChange/patchUpdated",
  params: { itemId, turnId, threadId: "th1", changes },
});
const oneChange = (path: string, type = "update") => [{ path, kind: { type }, diff: `--- a\n+++ b\n+x\n` }];

describe("S2a — 알림 색인", () => {
  test("patchUpdated 로 기억해 두면 같은 turn 의 itemId 로 꺼낼 수 있다", () => {
    const idx = new CodexTurnItemIndex();
    const m = patch("i1", "t1", oneChange("src/a.ts"));
    idx.observe(m.method, m.params);
    const hit = idx.lookup("i1", "t1");
    expect(hit?.changes.map((c) => c.path)).toEqual(["src/a.ts"]);
    expect(hit?.changes[0]?.kind).toBe("update");
  });

  test("item/started 의 fileChange 항목도 기억한다", () => {
    const idx = new CodexTurnItemIndex();
    idx.observe("item/started", {
      turnId: "t1", threadId: "th1",
      item: { id: "i9", type: "fileChange", status: "inProgress", changes: oneChange("src/b.ts", "add") },
    });
    expect(idx.lookup("i9", "t1")?.changes[0]?.kind).toBe("add");
  });

  test("파일변경이 아닌 item/started 는 기억하지 않는다", () => {
    const idx = new CodexTurnItemIndex();
    idx.observe("item/started", { turnId: "t1", item: { id: "i1", type: "commandExecution", command: "ls" } });
    expect(idx.lookup("i1", "t1")).toBeNull();
    expect(idx.size).toBe(0);
  });

  test("★다른 turn 의 항목은 짝이 아니다★ — 승인한 것과 실행되는 것이 갈리는 경로", () => {
    const idx = new CodexTurnItemIndex();
    const m = patch("i1", "t1", oneChange("src/a.ts"));
    idx.observe(m.method, m.params);
    expect(idx.lookup("i1", "t2")).toBeNull(); // 같은 itemId 라도 turn 이 다르면 안 준다
    expect(idx.lookup("i1", "t1")).not.toBeNull();
  });

  test("★turnId 를 대조할 수 없으면 짝짓지 않는다★ — 통과가 아니라 ask", () => {
    const idx = new CodexTurnItemIndex();
    const m = patch("i1", "t1", oneChange("src/a.ts"));
    idx.observe(m.method, m.params);
    for (const bad of [undefined, null, "", 123, {}]) {
      expect(idx.lookup("i1", bad)).toBeNull();
    }
  });

  test("★관측에 turnId 가 없으면(알림이 malformed) 조회에 절대 안 걸린다★", () => {
    const idx = new CodexTurnItemIndex();
    idx.observe("item/fileChange/patchUpdated", { itemId: "i1", threadId: "th1", changes: oneChange("src/a.ts") });
    expect(idx.size).toBe(1);          // 기억은 한다(진단용)
    expect(idx.lookup("i1", "t1")).toBeNull(); // 그러나 짝은 안 된다 — null !== "t1"
  });

  test("turn 시작이면 이전 관측이 사라진다", () => {
    const idx = new CodexTurnItemIndex();
    const m = patch("i1", "t1", oneChange("src/a.ts"));
    idx.observe(m.method, m.params);
    idx.beginTurn();
    expect(idx.size).toBe(0);
    expect(idx.lookup("i1", "t1")).toBeNull();
  });

  test("같은 itemId 가 다시 오면 최신 내용으로 갈아끼운다", () => {
    const idx = new CodexTurnItemIndex();
    const a = patch("i1", "t1", oneChange("old.ts"));
    const b = patch("i1", "t1", oneChange("new.ts"));
    idx.observe(a.method, a.params);
    idx.observe(b.method, b.params);
    expect(idx.lookup("i1", "t1")?.changes.map((c) => c.path)).toEqual(["new.ts"]);
    expect(idx.size).toBe(1);
  });

  test("★빈 변경목록은 기억하지 않는다★ — '내용 없는 승인' 을 만들지 않기 위해", () => {
    const idx = new CodexTurnItemIndex();
    for (const empty of [[], undefined, null, "nope", [{ kind: { type: "add" } }]]) {
      idx.observe("item/fileChange/patchUpdated", { itemId: "i1", turnId: "t1", changes: empty });
    }
    expect(idx.size).toBe(0);
    expect(idx.lookup("i1", "t1")).toBeNull();
  });

  test("모양이 어긋난 원소는 버리고 성한 것만 남긴다 — 추측해서 채우지 않는다", () => {
    const idx = new CodexTurnItemIndex();
    idx.observe("item/fileChange/patchUpdated", {
      itemId: "i1", turnId: "t1",
      changes: [
        { path: "ok.ts", kind: { type: "update", move_path: "moved.ts" }, diff: "d" },
        { path: "", kind: { type: "add" }, diff: "d" },   // path 없음 → 버림
        { kind: { type: "add" } },                          // path 없음 → 버림
        { path: "nokind.ts", diff: "d" },                   // kind 모양 어긋남 → unknown 으로 남김
      ],
    });
    const hit = idx.lookup("i1", "t1")!;
    expect(hit.changes.map((c) => c.path)).toEqual(["ok.ts", "nokind.ts"]);
    expect(hit.changes[0]?.movePath).toBe("moved.ts");
    expect(hit.changes[1]?.kind).toBe("unknown");
  });

  test("상한을 넘으면 오래된 것부터 버린다 — 버려진 것은 ask 로 떨어진다", () => {
    const idx = new CodexTurnItemIndex();
    for (let i = 0; i < 300; i++) {
      idx.observe("item/fileChange/patchUpdated", { itemId: `i${i}`, turnId: "t1", changes: oneChange(`f${i}.ts`) });
    }
    expect(idx.size).toBe(256);
    expect(idx.lookup("i0", "t1")).toBeNull();     // 가장 오래된 것 = 버려짐
    expect(idx.lookup("i299", "t1")).not.toBeNull(); // 최신은 남음
  });

  test("diff 는 상한까지만 보관한다", () => {
    const idx = new CodexTurnItemIndex();
    idx.observe("item/fileChange/patchUpdated", {
      itemId: "i1", turnId: "t1",
      changes: [{ path: "big.ts", kind: { type: "update" }, diff: "x".repeat(50_000) }],
    });
    expect(idx.lookup("i1", "t1")!.changes[0]!.diff.length).toBe(20_000);
  });
});

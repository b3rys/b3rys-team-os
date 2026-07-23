import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { insertDmMessage, recallDmMessages } from "./dmCapture";

function freshDb(): Database {
  const d = new Database(":memory:");
  migrate(d);
  return d;
}
const T = (iso: string) => new Date(iso);

test("insert + recall 기본 (UTC 저장)", () => {
  const d = freshDb();
  const ok = insertDmMessage(d, {
    memberId: "steve", runtime: "claude_channel", direction: "in",
    body: "안녕", createdAt: T("2026-07-06T00:00:00Z"), dedupeKey: "telegram:1000000001:1",
  });
  expect(ok).toBe(true);
  const r = recallDmMessages(d, "steve");
  expect(r.length).toBe(1);
  expect(r[0]!.body).toBe("안녕");
  expect(r[0]!.created_at).toBe("2026-07-06 00:00:00"); // UTC 저장 (KST는 렌더 시 +9h)
});

test("dedupe — 같은 dedupe_key 재삽입 무시(행 1개)", () => {
  const d = freshDb();
  insertDmMessage(d, { memberId: "steve", direction: "in", body: "a", createdAt: T("2026-07-06T00:00:00Z"), dedupeKey: "k1" });
  const dup = insertDmMessage(d, { memberId: "steve", direction: "in", body: "a-dup", createdAt: T("2026-07-06T00:00:00Z"), dedupeKey: "k1" });
  expect(dup).toBe(false);
  expect(recallDmMessages(d, "steve").length).toBe(1);
});

test("★격리★ — 멤버는 자기 GD DM만 recall (프라이버시)", () => {
  const d = freshDb();
  insertDmMessage(d, { memberId: "steve", direction: "in", body: "steve것", createdAt: T("2026-07-06T00:00:00Z"), dedupeKey: "s1" });
  insertDmMessage(d, { memberId: "bill", direction: "in", body: "bill것", createdAt: T("2026-07-06T00:00:00Z"), dedupeKey: "b1" });
  const steve = recallDmMessages(d, "steve");
  expect(steve.length).toBe(1);
  expect(steve[0]!.body).toBe("steve것");
  expect(steve.some((r) => r.body === "bill것")).toBe(false); // 타 멤버 GD DM 절대 안 보임
});

test("direction in/out + 최신순", () => {
  const d = freshDb();
  insertDmMessage(d, { memberId: "steve", direction: "in", body: "1st", createdAt: T("2026-07-06T00:00:00Z"), dedupeKey: "a" });
  insertDmMessage(d, { memberId: "steve", direction: "out", body: "2nd", createdAt: T("2026-07-06T00:01:00Z"), dedupeKey: "b" });
  const r = recallDmMessages(d, "steve", 10);
  expect(r[0]!.body).toBe("2nd"); // 최신 먼저
  expect(r[0]!.direction).toBe("out");
  expect(r[1]!.body).toBe("1st");
});

test("CHECK 제약 — direction은 in/out만", () => {
  const d = freshDb();
  expect(() =>
    d.prepare("INSERT INTO dm_message (id,member_id,direction,body,created_at,dedupe_key) VALUES ('x','steve','sideways','b','2026-07-06 00:00:00','k')").run(),
  ).toThrow();
});

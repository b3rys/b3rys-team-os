// "누가 나한테 보냈나"(사적 DM 조회) 헬퍼 테스트 — direction 필터·member 격리·요약/문자열.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { insertDmMessage } from "./dmCapture";
import { recentInboundDms, summarizeInboundDms, describeInboundDms } from "./dmQuery";

function freshDb(): Database {
  const d = new Database(":memory:");
  migrate(d);
  return d;
}
const T = (iso: string) => new Date(iso);

test("inbound(in)만 조회 — out(봇→GD)은 '누가 보냈나'에 제외", () => {
  const d = freshDb();
  insertDmMessage(d, { memberId: "demis", direction: "in", body: "GD가 보낸 것", createdAt: T("2026-07-09T00:00:00Z"), dedupeKey: "i1" });
  insertDmMessage(d, { memberId: "demis", direction: "out", body: "봇이 보낸 것", createdAt: T("2026-07-09T00:01:00Z"), dedupeKey: "o1" });
  const rows = recentInboundDms(d, "demis");
  expect(rows.length).toBe(1);
  expect(rows[0]!.body).toBe("GD가 보낸 것");
  expect(rows.some((r) => r.direction === "out")).toBe(false);
});

test("★member 격리★ — 타 멤버의 GD DM은 조회 불가(프라이버시)", () => {
  const d = freshDb();
  insertDmMessage(d, { memberId: "demis", direction: "in", body: "demis것", createdAt: T("2026-07-09T00:00:00Z"), dedupeKey: "d1" });
  insertDmMessage(d, { memberId: "bill", direction: "in", body: "bill것", createdAt: T("2026-07-09T00:00:00Z"), dedupeKey: "b1" });
  const rows = recentInboundDms(d, "demis");
  expect(rows.length).toBe(1);
  expect(rows.some((r) => r.body === "bill것")).toBe(false);
});

test("최신순 + limit", () => {
  const d = freshDb();
  for (let i = 0; i < 5; i++)
    insertDmMessage(d, { memberId: "demis", direction: "in", body: `m${i}`, createdAt: T(`2026-07-09T00:0${i}:00Z`), dedupeKey: `k${i}` });
  const rows = recentInboundDms(d, "demis", { limit: 2 });
  expect(rows.length).toBe(2);
  expect(rows[0]!.body).toBe("m4"); // 최신 먼저
  expect(rows[1]!.body).toBe("m3");
});

test("sinceHours 창 — 오래된 것 제외", () => {
  const d = freshDb();
  const now = new Date();
  const recent = new Date(now.getTime() - 1 * 3600_000); // 1시간 전
  const old = new Date(now.getTime() - 48 * 3600_000); // 48시간 전
  insertDmMessage(d, { memberId: "demis", direction: "in", body: "최근", createdAt: recent, dedupeKey: "r1" });
  insertDmMessage(d, { memberId: "demis", direction: "in", body: "오래됨", createdAt: old, dedupeKey: "o1" });
  const rows = recentInboundDms(d, "demis", { sinceHours: 6 });
  expect(rows.length).toBe(1);
  expect(rows[0]!.body).toBe("최근");
});

test("summarize — count·latest·items(최신순)", () => {
  const d = freshDb();
  insertDmMessage(d, { memberId: "demis", direction: "in", body: "첫째", createdAt: T("2026-07-09T00:00:00Z"), dedupeKey: "1" });
  insertDmMessage(d, { memberId: "demis", direction: "in", body: "둘째 " + "x".repeat(200), createdAt: T("2026-07-09T01:00:00Z"), dedupeKey: "2" });
  const s = summarizeInboundDms(d, "demis");
  expect(s.count).toBe(2);
  expect(s.sender).toBe("GD");
  expect(s.latest!.preview.startsWith("둘째")).toBe(true);
  expect(s.latest!.preview.length).toBeLessThanOrEqual(81); // PREVIEW_LEN(80)+… 컷
  expect(s.latest!.atKst).toContain("KST");
});

test("describe — 0건은 명시적 '없음'(조용한 빈 답 방지)", () => {
  const d = freshDb();
  expect(describeInboundDms(d, "demis", { sinceHours: 24 })).toContain("없습니다");
});

test("describe — 다건은 최신+건수 포함", () => {
  const d = freshDb();
  insertDmMessage(d, { memberId: "demis", direction: "in", body: "회의 언제야", createdAt: T("2026-07-09T00:00:00Z"), dedupeKey: "1" });
  insertDmMessage(d, { memberId: "demis", direction: "in", body: "리포트 확인했어", createdAt: T("2026-07-09T02:00:00Z"), dedupeKey: "2" });
  const out = describeInboundDms(d, "demis");
  expect(out).toContain("2건");
  expect(out).toContain("리포트 확인했어"); // 최신
});

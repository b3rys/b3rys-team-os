/**
 * portal(리포트) 요청 플로우 integration test — 리포트 요청 접수회신(GD 2026-06-22 "요청 접수가 GD께 떠야").
 * 핀: POST /api/:id/request → {ok, assignee, thread_id} 반환(=대시보드 인라인 "✅ 전송됨" 근거) + 담당자 버스 dm + 추적 task.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { upsertReport } from "../db/reports";
import { createReportsApp } from "./portal";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(
    `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('bill','Bill','infra','claude_channel','claude_tmux','/tmp','P.md')`,
  ).run();
  upsertReport(db, { id: "rep1", title: "테스트 보고서", author: "bill", category: "보고서", summary: "s", forms: [] } as never);
  return { app: createReportsApp({ db, reportsDir: "/tmp" } as never), db };
}
const json = (b: unknown) => ({ method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });
const patchJson = (b: unknown) => ({ method: "PATCH", body: JSON.stringify(b), headers: { "content-type": "application/json" } });

describe("portal 리포트 요청 — 접수회신 플로우", () => {
  test("요청 제출 → {ok, assignee, thread_id} 반환 (대시보드 인라인 확인 근거)", async () => {
    const { app } = setup();
    const r = await app.request("/api/rep1/request", json({ text: "3장 수치 최신화 부탁" }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; assignee: string; thread_id: string };
    expect(j.ok).toBe(true);
    expect(j.assignee).toBe("bill"); // 보고서 author로 자동 배정
    expect(j.thread_id).toBeTruthy();
  });

  test("요청 → 담당자 버스 dm + 추적 task 생성 (안 묻힘)", async () => {
    const { app, db } = setup();
    await app.request("/api/rep1/request", json({ text: "수치 갱신" }));
    const dm = db.prepare("SELECT to_agent_id, body FROM message WHERE to_agent_id='bill' ORDER BY rowid DESC LIMIT 1").get() as { to_agent_id: string; body: string } | null;
    expect(dm?.to_agent_id).toBe("bill");
    expect(dm?.body).toContain("보고서 요청");
    const task = db.prepare("SELECT owner, lane FROM task WHERE owner='bill' AND title LIKE '요청:%' ORDER BY rowid DESC LIMIT 1").get() as { owner: string; lane: string } | null;
    expect(task?.owner).toBe("bill");
    expect(task?.lane).toBe("doing");
  });

  test("text 없으면 400 (빈 요청 거부)", async () => {
    const { app } = setup();
    const r = await app.request("/api/rep1/request", json({ text: "  " }));
    expect(r.status).toBe(400);
  });

  test("중요 표시 토글 → 목록 API에 반영", async () => {
    const { app } = setup();
    const on = await app.request("/api/rep1/important", patchJson({ important: true }));
    expect(on.status).toBe(200);
    const onJson = (await on.json()) as { report: { is_important: boolean } };
    expect(onJson.report.is_important).toBe(true);

    const listed = await app.request("/api/list");
    const listedJson = (await listed.json()) as { reports: { id: string; is_important: boolean }[] };
    expect(listedJson.reports.find((r) => r.id === "rep1")?.is_important).toBe(true);

    const off = await app.request("/api/rep1/important", patchJson({ important: false }));
    const offJson = (await off.json()) as { report: { is_important: boolean } };
    expect(offJson.report.is_important).toBe(false);
  });

  test("목록 pagination → cursor로 다음 페이지를 가져온다", async () => {
    const { app, db } = setup();
    for (let i = 2; i <= 5; i++) {
      upsertReport(db, {
        id: `rep${i}`,
        title: `페이지 보고서 ${i}`,
        author: "bill",
        category: i % 2 ? "교육자료" : "보고서",
        forms: [],
        date: `2026-07-0${i} 10:00:00`,
      } as never);
    }

    const first = await app.request("/api/list?limit=2");
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { reports: { id: string }[]; has_more: boolean; next_cursor: string | null; category_counts: Record<string, number> };
    expect(firstJson.reports).toHaveLength(2);
    expect(firstJson.has_more).toBe(true);
    expect(firstJson.next_cursor).toBeTruthy();
    expect(firstJson.category_counts["보고서"]).toBeGreaterThan(0);

    const second = await app.request(`/api/list?limit=2&cursor=${encodeURIComponent(firstJson.next_cursor!)}`);
    const secondJson = (await second.json()) as { reports: { id: string }[] };
    expect(secondJson.reports).toHaveLength(2);
    expect(new Set([...firstJson.reports, ...secondJson.reports].map((r) => r.id)).size).toBe(4);
  });

  test("목록 pagination → 중요 필터와 검색을 서버에서 적용한다", async () => {
    const { app, db } = setup();
    upsertReport(db, { id: "star1", title: "중요 릴리즈", author: "steve", category: "교육자료", forms: [], date: "2026-07-03 10:00:00" } as never);
    upsertReport(db, { id: "star2", title: "일반 릴리즈", author: "bill", category: "보고서", forms: [], date: "2026-07-04 10:00:00" } as never);
    await app.request("/api/star1/important", patchJson({ important: true }));

    const important = await app.request("/api/list?limit=10&important=1");
    const importantJson = (await important.json()) as { reports: { id: string; is_important: boolean }[]; important_count: number };
    expect(importantJson.reports.map((r) => r.id)).toEqual(["star1"]);
    expect(importantJson.reports.every((r) => r.is_important)).toBe(true);
    expect(importantJson.important_count).toBe(1);

    const searched = await app.request(`/api/list?limit=10&q=${encodeURIComponent("중요 릴리즈")}`);
    const searchedJson = (await searched.json()) as { reports: { id: string }[] };
    expect(searchedJson.reports.map((r) => r.id)).toEqual(["star1"]);
  });
});

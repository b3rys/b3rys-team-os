/**
 * portal(리포트) 요청 플로우 integration test — 리포트 요청 접수회신.
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
const putJson = (b: unknown) => ({ method: "PUT", body: JSON.stringify(b), headers: { "content-type": "application/json" } });

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

  test("요청 → 담당자 wake 가능한 user bus dm + 추적 task 생성", async () => {
    const { app, db } = setup();
    await app.request("/api/rep1/request", json({ text: "수치 갱신" }));
    const dm = db.prepare(
      `SELECT m.id, m.from_agent_id, m.to_agent_id, m.body, mr.delivery_state
       FROM message m
       JOIN message_recipient mr ON mr.message_id = m.id AND mr.agent_id = m.to_agent_id
       WHERE m.to_agent_id='bill'
       ORDER BY m.rowid DESC LIMIT 1`,
    ).get() as {
      id: string;
      from_agent_id: string;
      to_agent_id: string;
      body: string;
      delivery_state: string;
    } | null;
    expect(dm?.from_agent_id).toBe("user");
    expect(dm?.to_agent_id).toBe("bill");
    expect(dm?.body).toContain("[보고서 요청 · gd]");
    expect(dm?.delivery_state).toBe("pending");
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

  test("목록 필터와 무관한 전체 개수를 total_all로 반환한다", async () => {
    const { app, db } = setup();
    upsertReport(db, { id: "uncategorized", title: "무분류 보고서", category: null, forms: [] } as never);
    upsertReport(db, { id: "research", title: "리서치 보고서", category: "리서치", forms: [] } as never);

    const filtered = await app.request(`/api/list?limit=10&category=${encodeURIComponent("보고서")}`);
    const body = (await filtered.json()) as { total: number; total_all: number; reports: { id: string }[] };

    expect(body.total).toBe(1);
    expect(body.reports.map((report) => report.id)).toEqual(["rep1"]);
    expect(body.total_all).toBe(3);
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

  test("태그 CRUD, 복수 태깅, OR 필터와 삭제 연결 해제", async () => {
    const { app, db } = setup();
    upsertReport(db, { id: "rep2", title: "두 번째", forms: [] } as never);
    const a = await app.request("/api/tags", json({ name: "AI", color: "violet" }));
    const b = await app.request("/api/tags", json({ name: "전략" }));
    const tagA = ((await a.json()) as any).tag;
    const tagB = ((await b.json()) as any).tag;
    expect(a.status).toBe(201);

    const marked = await app.request("/api/rep1/tags", putJson({ tag_ids: [tagA.id, tagB.id] }));
    expect(marked.status).toBe(200);
    expect(((await marked.json()) as any).report.tags.map((t: any) => t.name)).toEqual(["AI", "전략"]);
    await app.request("/api/rep2/tags", putJson({ tag_ids: [tagB.id] }));

    const filtered = await app.request(`/api/list?limit=10&tags=${tagA.id},${tagB.id}`);
    expect(((await filtered.json()) as any).reports.map((r: any) => r.id).sort()).toEqual(["rep1", "rep2"]);

    const renamed = await app.request(`/api/tags/${tagA.id}`, patchJson({ name: "에이전트" }));
    expect(((await renamed.json()) as any).tag.name).toBe("에이전트");
    await app.request(`/api/tags/${tagA.id}`, { method: "DELETE" });
    const afterDelete = await app.request("/api/rep1");
    expect(((await afterDelete.json()) as any).tags.map((t: any) => t.name)).toEqual(["전략"]);
  });

  test("태그 필터·보고서 태깅은 20개를 상한으로 제한한다", async () => {
    const { app } = setup();
    const ids = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    const list = await app.request(`/api/list?limit=10&tags=${ids.join(",")}`);
    expect(list.status).toBe(400);
    const put = await app.request("/api/rep1/tags", putJson({ tag_ids: ids }));
    expect(put.status).toBe(400);
    const report = await app.request("/api/rep1");
    expect(((await report.json()) as any).tags).toEqual([]);
  });

  test("보고서를 분류로 이동하고 분류 이름을 바꾼다", async () => {
    const { app, db } = setup();
    upsertReport(db, { id: "rep2", title: "두 번째", category: "리서치", forms: [] } as never);

    const moved = await app.request("/api/rep1/category", putJson({ category: "0730 드라이브" }));
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as any).report.category).toBe("0730 드라이브");

    const renamed = await app.request(`/api/categories/${encodeURIComponent("0730 드라이브")}`, patchJson({ name: "완료" }));
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as any).changed).toBe(1);
    expect(((await (await app.request("/api/rep1")).json()) as any).category).toBe("완료");
  });

  test("분류 삭제는 안의 보고서를 무분류로 보존한다", async () => {
    const { app, db } = setup();
    upsertReport(db, { id: "rep2", title: "두 번째", category: "리서치", forms: [] } as never);
    await app.request("/api/rep1/category", putJson({ category: "보관함" }));
    await app.request("/api/rep2/category", putJson({ category: "보관함" }));

    const deleted = await app.request(`/api/categories/${encodeURIComponent("보관함")}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as any).changed).toBe(2);
    const list = await app.request("/api/list?limit=10");
    const reports = ((await list.json()) as any).reports;
    expect(reports.every((report: any) => report.category === null)).toBe(true);
  });

  test("빈 분류 이름은 거부하고 기존 분류도 자유롭게 변경한다", async () => {
    const { app } = setup();
    expect((await app.request("/api/rep1/category", putJson({ category: "  " }))).status).toBe(400);
    const renamed = await app.request(`/api/categories/${encodeURIComponent("보고서")}`, patchJson({ name: "옛날것" }));
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as any).changed).toBe(1);
    const deleted = await app.request(`/api/categories/${encodeURIComponent("옛날것")}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as any).changed).toBe(1);
    const report = (await (await app.request("/api/rep1")).json()) as any;
    expect(report.category).toBe(null);
    const list = (await (await app.request("/api/list?limit=10")).json()) as any;
    expect(list.category_counts).toEqual({});
  });

  test("빈 분류를 새로 만들어도 목록에 0건으로 남는다", async () => {
    const { app } = setup();
    const created = await app.request("/api/categories", json({ name: "새 폴더" }));
    expect(created.status).toBe(200);
    const list = await app.request("/api/list?limit=10");
    expect(((await list.json()) as any).category_counts["새 폴더"]).toBe(0);
  });

  test("게시 API의 분류 입력은 받지 않고 신규 보고서를 무분류로 등록한다", async () => {
    const { app } = setup();
    const registered = await app.request("/api/register", json({ id: "new-report", title: "신규", category: "리서치", forms: [] }));
    expect(registered.status).toBe(200);
    expect(((await registered.json()) as any).report.category).toBe(null);
  });

  test("재게시에서 분류를 생략하면 사용자가 이동한 분류를 유지한다", async () => {
    const { app, db } = setup();
    await app.request("/api/rep1/category", putJson({ category: "0828 드라이브" }));

    upsertReport(db, { id: "rep1", title: "갱신된 보고서", category: null, forms: [] });
    expect(((await (await app.request("/api/rep1")).json()) as any).category).toBe("0828 드라이브");

    upsertReport(db, { id: "rep1", title: "명시 분류 보고서", category: "리서치", forms: [] });
    expect(((await (await app.request("/api/rep1")).json()) as any).category).toBe("리서치");
  });
});

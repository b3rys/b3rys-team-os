// 측정 W1 emit 슬라이스 — tasks lane 전이 → loop_event emit → projection → recompute (end-to-end).
// ★로그 격리(팀 하드레슨): appendAuditFile이 라이브 logs/ 안 건드리게 temp dir로.★
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { createTaskRoutes } from "./tasks";
import { EVENT, LOOP_EVENT_SCHEMA, projectAuditRow, type AuditRow } from "../metrics/loopEvent";
import { verifiedClosure } from "../metrics/recompute";

/** 전역 격리(preload)가 세팅한 값 — afterAll 에서 ★지우지 말고 되돌린다.★ */
const PREV_AUDIT_DIR = process.env.B3OS_AUDIT_LOG_DIR;

let TMP: string;
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "w1-emit-audit-"));
  process.env.B3OS_AUDIT_LOG_DIR = TMP;
});
afterAll(() => {
  // ★지우면 안 된다 — 되돌려야 한다.★ (2026-07-14)
  //   전역 preload(src/test/audit-isolation.ts)가 B3OS_AUDIT_LOG_DIR 을 temp 로 세팅해 ★모든★ 테스트를
  //   라이브 logs/ 에서 격리한다. 여기서 delete 하면 ★그 격리가 통째로 풀리고★, 같은 프로세스에서
  //   ★뒤에 도는 모든 테스트가 라이브 감사로그에 쓴다.★
  //   실측: 라이브 로그에 테스트 이벤트 ★1619건★ (actor='nova', thread='t1' — 존재하지 않는 팀원/스레드).
  //   ★계기판이 첫날부터 가짜 데이터로 못 쓰게 됐다.★ (팀 하드레슨: bun test 는 라이브를 안 건드린다)
  if (PREV_AUDIT_DIR === undefined) delete process.env.B3OS_AUDIT_LOG_DIR;
  else process.env.B3OS_AUDIT_LOG_DIR = PREV_AUDIT_DIR;
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(`INSERT OR REPLACE INTO setting (key,value) VALUES ('metrics_emit_enabled','on')`).run();
  const app = createTaskRoutes({ db });
  return { app, db };
}
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

function loopEvents(db: Database) {
  const rows = db.prepare(`SELECT id, actor, action, target, detail_json, at FROM audit_event ORDER BY id`).all() as {
    id: number; actor: string; action: string; target: string | null; detail_json: string; at: string;
  }[];
  return rows
    .map((r): AuditRow => ({ id: r.id, actor: r.actor, action: r.action, target: r.target, detail: JSON.parse(r.detail_json), at: r.at }))
    .filter((r) => (r.detail as Record<string, unknown>)?.schema === LOOP_EVENT_SCHEMA)
    .map((r) => projectAuditRow(r))
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

describe("tasks lane emit (측정 W1 ④)", () => {
  test("metrics_emit_enabled default OFF면 lane 전이도 loop_event emit 안 함", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createTaskRoutes({ db });
    const created = (await (await app.request("/tasks", { method: "POST", body: JSON.stringify({ title: "off", column: "doing" }), headers: { "content-type": "application/json" } })).json()) as { task: { id: string } };
    const id = created.task.id;
    const r = await app.request(`/tasks/${id}`, patch({ column: "done" }));
    expect(r.status).toBe(200);
    expect(loopEvents(db).length).toBe(0);
  });

  test("plan→doing→done PATCH → task.closed loop_event emit → recompute가 집계", async () => {
    const { app, db } = setup();
    const created = (await (await app.request("/tasks", { method: "POST", body: JSON.stringify({ title: "리포트 작성", column: "plan" }), headers: { "content-type": "application/json" } })).json()) as { task: { id: string } };
    const id = created.task.id;

    await app.request(`/tasks/${id}`, patch({ column: "doing" })); // plan→doing = 미발행(최소 슬라이스)
    const r1 = await app.request(`/tasks/${id}`, patch({ column: "done" })); // →done = task.closed
    expect(r1.status).toBe(200);

    const events = loopEvents(db);
    const closed = events.filter((e) => e.event_name === EVENT.task_closed);
    expect(closed.length).toBe(1);
    expect(closed[0]!.task_id).toBe(id);
    expect(closed[0]!.event_id).toContain(`evt:task:${id}:${EVENT.task_closed}`);
    // plan→doing은 이벤트 안 남김(최소 슬라이스)
    expect(events.filter((e) => e.event_name === EVENT.task_opened).length).toBe(0);

    // 엔진 recompute가 emit된 event로 집계
    const vc = verifiedClosure(events);
    expect(vc.closed).toBe(1); // task.closed 1건 집계됨(verified는 closure.verified 없어 0 — 정상)
  });

  test("done→doing PATCH → closure.corrected(사후 재오픈) emit", async () => {
    const { app, db } = setup();
    const created = (await (await app.request("/tasks", { method: "POST", body: JSON.stringify({ title: "x", column: "done" }), headers: { "content-type": "application/json" } })).json()) as { task: { id: string } };
    const id = created.task.id;
    await app.request(`/tasks/${id}`, patch({ column: "doing" })); // done→doing
    const events = loopEvents(db);
    expect(events.filter((e) => e.event_name === EVENT.closure_corrected).length).toBe(1);
  });

  test("lane 불변 PATCH(title만)는 emit 안 함", async () => {
    const { app, db } = setup();
    const created = (await (await app.request("/tasks", { method: "POST", body: JSON.stringify({ title: "y", column: "doing" }), headers: { "content-type": "application/json" } })).json()) as { task: { id: string } };
    const id = created.task.id;
    const r = await app.request(`/tasks/${id}`, patch({ title: "y2" }));
    expect(r.status).toBe(200);
    expect(loopEvents(db).length).toBe(0);
  });

  test("★fault injection(Bill #1): emit이 throw해도 카드 PATCH는 200 + 커밋 유지 (best-effort 크럭스)", async () => {
    const { app, db } = setup();
    const created = (await (await app.request("/tasks", { method: "POST", body: JSON.stringify({ title: "z", column: "doing" }), headers: { "content-type": "application/json" } })).json()) as { task: { id: string } };
    const id = created.task.id;
    // ★emit 실제 실패 주입★: audit_event 테이블을 없애 emitLoopEvent(appendAudit INSERT)가 throw하게.
    //   updateTask(카드 커밋)은 task 테이블이라 영향 없음 → emitLoopEventSafe가 삼키고 PATCH는 정상.
    db.exec("DROP TABLE audit_event");
    const r = await app.request(`/tasks/${id}`, patch({ column: "done" }));
    expect(r.status).toBe(200); // ★계측 실패해도 라이브 기능 안 깨짐★
    const body = (await r.json()) as { ok: boolean; task: { column: string } };
    expect(body.ok).toBe(true);
    expect(body.task.column).toBe("done"); // 카드는 실제로 done 커밋됨
  });
});

/**
 * tasks 라우트 — DELETE/PATCH 계측 + 카드변경 담당자 알림 검증 (2026-06-14).
 * 핵심1(CCTV): 삭제/재배정 시 audit_event 에 actor·UA·referer·스냅샷이 남아 범인 추적+복구.
 * 핵심2(알림): 삭제·담당자 변경 시 영향받는 담당자를 버스로 깨운다(self-action 제외) →
 *             GD가 카드를 지워도 담당자가 자동 인지해 GD께 확인만 (dbak 케이스 근본 해결).
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createTaskRoutes } from "./tasks";

function seedAgent(db: Database, id: string) {
  db.prepare(
    `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'P.md')`,
  ).run(id, id);
}

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["dbak", "steve", "bill"]) seedAgent(db, a);
  const app = createTaskRoutes({ db });
  return { app, db };
}

// the bus message + its pending recipient row that wakes the owner
function lastNotice(db: Database, to: string) {
  return db
    .query(
      `SELECT m.body, m.from_agent_id, mr.delivery_state
         FROM message m JOIN message_recipient mr ON mr.message_id = m.id
        WHERE m.to_agent_id = ? ORDER BY m.rowid DESC LIMIT 1`,
    )
    .get(to) as { body: string; from_agent_id: string; delivery_state: string } | null;
}
const json = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

async function createCard(app: ReturnType<typeof setup>["app"], body: unknown) {
  const r = await app.request("/tasks", json(body));
  expect(r.status).toBe(201);
  return (await r.json()).task as { id: string };
}

describe("tasks DELETE — audit 계측", () => {
  test("삭제 시 audit_event 에 스냅샷+actor 가 기록된다", async () => {
    const { app, db } = setup();
    const card = await createCard(app, {
      title: "천만원 실전투자 + 카뱅 진단",
      column: "plan",
      owner: "dbak",
      description: "GD 입력 대기",
    });

    const r = await app.request(`/tasks/${card.id}?actor=dbak`, {
      method: "DELETE",
      headers: { "user-agent": "test-agent/1.0", referer: "http://x/team" },
    });
    expect(r.status).toBe(200);
    expect((await r.json()).deleted).toBe(card.id);

    const ev = db
      .query(`SELECT actor, action, target, detail_json FROM audit_event WHERE action='task_deleted' AND target=?`)
      .get(card.id) as { actor: string; target: string; detail_json: string } | null;

    expect(ev).not.toBeNull();
    expect(ev!.actor).toBe("dbak");
    expect(ev!.target).toBe(card.id);
    const detail = JSON.parse(ev!.detail_json);
    expect(detail.lane).toBe("plan");
    expect(detail.owner).toBe("dbak");
    expect(detail.user_agent).toBe("test-agent/1.0");
    expect(detail.referer).toBe("http://x/team");
    // 스냅샷으로 복구 가능 — 제목·description 보존
    expect(detail.snapshot.title).toBe("천만원 실전투자 + 카뱅 진단");
    expect(detail.snapshot.description).toBe("GD 입력 대기");
  });

  test("actor 미지정 시 'unknown' 으로 기록 (대시보드 ✕ 등 무인증 경로 식별)", async () => {
    const { app, db } = setup();
    const card = await createCard(app, { title: "무인증 삭제", column: "plan", owner: "dbak" });

    const r = await app.request(`/tasks/${card.id}`, { method: "DELETE" });
    expect(r.status).toBe(200);

    const ev = db
      .query(`SELECT actor FROM audit_event WHERE action='task_deleted' AND target=?`)
      .get(card.id) as { actor: string } | null;
    expect(ev?.actor).toBe("unknown");
  });

  test("존재하지 않는 카드 삭제는 404, audit 안 남김", async () => {
    const { app, db } = setup();
    const r = await app.request(`/tasks/nope`, { method: "DELETE" });
    expect(r.status).toBe(404);
    const n = db.query(`SELECT count(*) c FROM audit_event WHERE action='task_deleted'`).get() as { c: number };
    expect(n.c).toBe(0);
  });
});

describe("tasks — 카드변경 담당자 알림", () => {
  test("삭제 시 담당자에게 버스 알림이 가고 깨움 대기(pending)다", async () => {
    const { app, db } = setup();
    const card = await createCard(app, { title: "카뱅 투자", column: "plan", owner: "dbak", description: "GD 대기" });

    // actor=bill(담당자 아님) → dbak에게 알림
    const r = await app.request(`/tasks/${card.id}?actor=bill`, { method: "DELETE" });
    expect(r.status).toBe(200);

    const notice = lastNotice(db, "dbak");
    expect(notice).not.toBeNull();
    expect(notice!.from_agent_id).toBe("system");
    expect(notice!.delivery_state).toBe("pending"); // 디스패처가 깨울 수 있는 상태
    expect(notice!.body).toContain("삭제");
    expect(notice!.body).toContain("카뱅 투자");

    const notified = db
      .query(`SELECT count(*) c FROM audit_event WHERE action='card_change_notified'`)
      .get() as { c: number };
    expect(notified.c).toBe(1);
  });

  test("담당자가 자기 카드를 지우면 알림 안 간다(self-action)", async () => {
    const { app, db } = setup();
    const card = await createCard(app, { title: "내 카드", column: "plan", owner: "dbak" });

    await app.request(`/tasks/${card.id}?actor=dbak`, { method: "DELETE" });
    expect(lastNotice(db, "dbak")).toBeNull();
  });

  test("무인증(대시보드) 삭제도 담당자에게 알림 — '대시보드/GD' 라벨", async () => {
    const { app, db } = setup();
    const card = await createCard(app, { title: "라벨 테스트", column: "plan", owner: "dbak" });

    await app.request(`/tasks/${card.id}`, { method: "DELETE" }); // actor 없음
    const notice = lastNotice(db, "dbak");
    expect(notice).not.toBeNull();
    expect(notice!.body).toContain("대시보드");
  });

  test("담당자 변경 시 옛 담당자+새 담당자 둘 다 알림 + task_reassigned audit", async () => {
    const { app, db } = setup();
    const card = await createCard(app, { title: "이관 카드", column: "doing", owner: "dbak" });

    const r = await app.request(`/tasks/${card.id}?actor=bill`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: "steve" }),
    });
    expect(r.status).toBe(200);

    const toOld = lastNotice(db, "dbak");
    const toNew = lastNotice(db, "steve");
    expect(toOld?.body).toContain("재배정");
    expect(toNew?.body).toContain("배정");
    expect(toNew?.delivery_state).toBe("pending");

    const ev = db
      .query(`SELECT detail_json FROM audit_event WHERE action='task_reassigned'`)
      .get() as { detail_json: string } | null;
    expect(ev).not.toBeNull();
    const d = JSON.parse(ev!.detail_json);
    expect(d.from).toBe("dbak");
    expect(d.to).toBe("steve");
  });

  test("담당자 외 필드(제목)만 수정하면 알림/재배정 audit 없음 (필수만 스코프)", async () => {
    const { app, db } = setup();
    const card = await createCard(app, { title: "원제목", column: "plan", owner: "dbak" });

    await app.request(`/tasks/${card.id}?actor=bill`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "새제목" }),
    });
    const n = db.query(`SELECT count(*) c FROM audit_event WHERE action='task_reassigned'`).get() as { c: number };
    expect(n.c).toBe(0);
    expect(lastNotice(db, "dbak")).toBeNull();
  });
});

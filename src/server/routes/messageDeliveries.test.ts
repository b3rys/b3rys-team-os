// GET /api/inbox/messages/:id 가 ★버스 밖★ 으로 나간 결과(deliveries)도 준다.
//
// 왜 필요한가: recipients 는 ★버스 안★ 수신자만 다룬다. 목적지가 버스 밖인 메시지
//   (`--direct-to-gd` → 팀장 텔레그램 DM)는 그 구간이 recipients 에 나타나지 않는다.
//   그래서 보낸 쪽에서 보면 ★기록이 아예 없는 것처럼 보이고★, 멀쩡히 도착한 메시지를
//   '도달 확인 불가' 로 판단하게 된다. 기록 자체는 recordReportDelivery 가 audit_event 에
//   남겨두고 있다 — 없던 것은 기록이 아니라 ★조회 경로★ 다.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createInboxRoutes } from "./inbox";

function setup(): { db: Database; app: ReturnType<typeof createInboxRoutes> } {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["jane", "lisa"]) {
    db.prepare(
      `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'r', 'claude_channel', 'claude_tmux', '/tmp', 'P.md')`,
    ).run(a, a);
  }
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','[]','jane')`,
  ).run();
  const app = createInboxRoutes({
    db,
    broadcast: () => {},
    registeredAgentIds: () => new Set(["jane", "lisa"]),
  } as unknown as Parameters<typeof createInboxRoutes>[0]);
  return { db, app };
}

function seedMessage(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source)
     VALUES (?, 't1', 'lisa', 'jane', 'dm', 'b', 'agent')`,
  ).run(id);
}

/** recordReportDelivery 가 남기는 것과 같은 모양의 audit_event 행을 심는다. */
function seedDelivery(
  db: Database,
  msgId: string,
  d: { channel: string; to: string; ok?: boolean; error?: string; at?: string },
): void {
  db.prepare(
    `INSERT INTO audit_event (actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "lisa",
    d.ok === false ? "report_delivery_failed" : "report_delivered",
    msgId,
    JSON.stringify({ to: d.to, channel: d.channel, ...(d.error ? { error: d.error } : {}) }),
    d.at ?? "2026-08-19 01:05:28",
  );
}

const get = async (app: ReturnType<typeof createInboxRoutes>, id: string) =>
  await (await app.request(`/messages/${id}`)).json();

describe("GET /api/inbox/messages/:id — deliveries", () => {
  test("★--direct-to-gd: 팀장 DM 구간이 보인다★ — recipients 에는 없는 구간이다", async () => {
    const { db, app } = setup();
    seedMessage(db, "m1");
    seedDelivery(db, "m1", { channel: "bus", to: "jane", at: "2026-08-19 01:05:27" });
    seedDelivery(db, "m1", { channel: "telegram_dm", to: "gd", at: "2026-08-19 01:05:28" });
    const body = (await get(app, "m1")) as { deliveries: Array<Record<string, unknown>>; recipients: unknown[] };
    expect(body.deliveries).toHaveLength(2);
    // 시간순이어야 한다 — 버스 접수가 먼저, 외부 채널 발송이 나중이다.
    expect(body.deliveries[0]!.channel).toBe("bus");
    expect(body.deliveries[1]!.channel).toBe("telegram_dm");
    expect(body.deliveries[1]!.to).toBe("gd");
    expect(body.deliveries[1]!.ok).toBe(true);
    // ★이게 이 변경의 핵심★ — recipients 만 보면 팀장 DM 구간을 알 수 없다.
    expect(body.recipients).toHaveLength(0);
  });

  test("broadcast: 팀방 발송 구간이 보인다", async () => {
    const { db, app } = setup();
    seedMessage(db, "m2");
    seedDelivery(db, "m2", { channel: "bus", to: "broadcast", at: "2026-08-20 21:01:45" });
    seedDelivery(db, "m2", { channel: "telegram_group", to: "-100", at: "2026-08-20 21:01:46" });
    const body = (await get(app, "m2")) as { deliveries: Array<Record<string, unknown>> };
    expect(body.deliveries.map((d) => d.channel)).toEqual(["bus", "telegram_group"]);
  });

  test("★실패도 사유와 함께 남는다★ — 조용히 흘리면 보낸 쪽이 성공으로 믿는다", async () => {
    const { db, app } = setup();
    seedMessage(db, "m3");
    seedDelivery(db, "m3", { channel: "telegram_dm", to: "gd", ok: false, error: "telegram_send_failed" });
    const body = (await get(app, "m3")) as { deliveries: Array<Record<string, unknown>> };
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0]!.ok).toBe(false);
    expect(body.deliveries[0]!.error).toBe("telegram_send_failed");
  });

  test("★기록이 없으면 빈 배열★ — '모름' 이 아니라 '아직 안 나갔다' 는 사실이다", async () => {
    const { db, app } = setup();
    seedMessage(db, "m4");
    const body = (await get(app, "m4")) as { deliveries: unknown[] };
    expect(Array.isArray(body.deliveries)).toBe(true);
    expect(body.deliveries).toHaveLength(0);
  });

  test("다른 메시지의 기록이 섞이지 않는다", async () => {
    const { db, app } = setup();
    seedMessage(db, "m5");
    seedMessage(db, "m6");
    seedDelivery(db, "m5", { channel: "telegram_dm", to: "gd" });
    seedDelivery(db, "m6", { channel: "telegram_group", to: "-100" });
    const body = (await get(app, "m5")) as { deliveries: Array<Record<string, unknown>> };
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0]!.channel).toBe("telegram_dm");
  });

  test("detail_json 이 깨져도 나머지 필드는 준다", async () => {
    const { db, app } = setup();
    seedMessage(db, "m7");
    db.prepare(
      `INSERT INTO audit_event (actor, action, target, detail_json) VALUES ('lisa','report_delivered','m7','{not json')`,
    ).run();
    const body = (await get(app, "m7")) as { deliveries: Array<Record<string, unknown>> };
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0]!.ok).toBe(true);
    expect(body.deliveries[0]!.channel).toBeNull();
  });

  test("배달과 무관한 audit_event 는 섞이지 않는다", async () => {
    const { db, app } = setup();
    seedMessage(db, "m8");
    db.prepare(
      `INSERT INTO audit_event (actor, action, target, detail_json) VALUES ('lisa','some_other_action','m8','{}')`,
    ).run();
    const body = (await get(app, "m8")) as { deliveries: unknown[] };
    expect(body.deliveries).toHaveLength(0);
  });
});

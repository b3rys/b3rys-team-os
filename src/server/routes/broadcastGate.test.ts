/** 전체공지에는 정식·활성 발신 자격과 all_hands 사유가 필요하다.
 * 팀원 broadcast에 broadcast로 답하는 경로는 연쇄 깨움을 막기 위해 거절한다. */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createInboxRoutes } from "./inbox";
import { migrate } from "../db/migrate";
import type { AgentRecord } from "../types";

const ROSTER: AgentRecord[] = [
  { id: "bill", display_name: "Bill", role: "infra", capabilities: ["coordinator"] },
  { id: "steve", display_name: "Steve", role: "dev", capabilities: ["full_context"] },
  { id: "lui", display_name: "Lui", role: "dev" },
] as never;

function app(roster: AgentRecord[] = ROSTER, routeRoster: AgentRecord[] = roster) {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of roster) {
    db.prepare(
      `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?,?,?,'claude_channel','claude_tmux','/tmp','p.md')`,
    ).run(a.id, a.display_name, a.role);
  }
  db.prepare(
    `INSERT OR IGNORE INTO thread (id, title, kind, participants_json, opened_by)
     VALUES ('thread-broadcast-gate','gate','broadcast','["bill","steve","lui"]','bill')`,
  ).run();
  const h = createInboxRoutes({
    db,
    broadcast: () => {},
    registeredAgentIds: () => new Set(roster.map((a) => a.id)),
    agents: () => routeRoster,
  } as never);
  return { h, db };
}

const send = (h: ReturnType<typeof createInboxRoutes>, body: Record<string, unknown>) =>
  h.request("/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from_agent_id: "steve", to_agent_id: "broadcast", type: "broadcast",
      body: "…", source: "agent", thread_id: "thread-broadcast-gate", ...body,
    }),
  });


describe("★broadcast 에 대한 답은 broadcast 로 못 한다★ — 연쇄의 직접 고리", () => {
  it("부모가 broadcast 면 coordinator 라도 거부한다 (연쇄는 발신자를 안 가린다)", async () => {
    const { h, db } = app();
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
       VALUES ('PARENT-BCAST','thread-broadcast-gate','lui','broadcast','broadcast','공지','agent',datetime('now'))`,
    ).run();
    const res = await send(h, { from_agent_id: "bill", all_hands: "이유 있음", in_reply_to: "PARENT-BCAST" });
    expect(res.status, "★broadcast 답장이 broadcast 로 나갔다 — 오늘 47건 중 18건이 이 형태★").toBe(403);
    expect((await res.json()).error).toBe("broadcast_reply_to_broadcast");
  });

  it("부모가 1:1 이면 (coordinator+이유 조건은 그대로) 통과한다", async () => {
    const { h, db } = app();
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
       VALUES ('PARENT-DM','thread-broadcast-gate','lui','bill','dm','질문','agent',datetime('now'))`,
    ).run();
    const res = await send(h, { from_agent_id: "bill", all_hands: "전원 공지", in_reply_to: "PARENT-DM" });
    expect(res.status, "★1:1 답장을 broadcast 로 올리는 것은 이 게이트가 막지 않는다★").not.toBe(403);
  });
});

describe("★팀장님 경로는 이 게이트를 타지 않는다★", () => {
  it("source=user 의 broadcast(@all)는 라우터가 판정하므로 여기서 막지 않는다", async () => {
    const { h } = app();
    const res = await send(h, { from_agent_id: "user", source: "user" });
    expect(res.status, "★팀장님 @all 을 막으면 안 된다★").not.toBe(403);
  });
});

describe("★all_hands 전체공지는 사유·발신자격·감사를 강제한다★", () => {
  it("정식·활성 팀원은 보내고 사유·수신자 수를 DB 감사에 남긴다", async () => {
    const { h, db } = app();
    const res = await send(h, { from_agent_id: "steve", all_hands: "운영 점검" });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
    const row = db.prepare(
      `SELECT detail_json FROM audit_event WHERE actor='steve' AND action='agent_broadcast_all_hands' ORDER BY id DESC LIMIT 1`,
    ).get() as { detail_json: string };
    expect(JSON.parse(row.detail_json)).toMatchObject({
      reason: "운영 점검",
      recipient_count: 2,
      eligible_recipient_count: 2,
      zero_reason: null,
    });
  });

  it("비정식 팀원은 전체공지를 보내지 못한다", async () => {
    const roster = [
      { ...ROSTER[0]! },
      { ...ROSTER[1]!, team_official_member: false, lead_eligible: false },
    ] as AgentRecord[];
    const { h } = app(roster);
    const res = await send(h, { from_agent_id: "steve", all_hands: "운영 점검" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("all_hands_sender_ineligible");
  });

  it("source를 user로 속여도 all_hands 판정·감사를 우회하지 못한다", async () => {
    const roster = [
      { ...ROSTER[0]! },
      { ...ROSTER[1]!, team_official_member: false, lead_eligible: false },
    ] as AgentRecord[];
    const { h, db } = app(roster);
    const res = await send(h, { from_agent_id: "steve", source: "user", all_hands: "우회 시도" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("all_hands_sender_ineligible");
    const audit = db.prepare(
      `SELECT detail_json FROM audit_event WHERE action='agent_all_hands_blocked' ORDER BY id DESC LIMIT 1`,
    ).get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      reason: "우회 시도",
      identity_basis: "claimed_from_agent_id",
    });
  });

  it("인증 신원이 없는 현재 API에서는 정식 팀원 from_agent_id 사칭을 구분하지 못함을 고정한다", async () => {
    const { h, db } = app();
    const res = await send(h, { from_agent_id: "steve", source: "user", all_hands: "사칭 한계 기록" });
    expect(res.status).not.toBe(403);
    const audit = db.prepare(
      `SELECT detail_json FROM audit_event WHERE action='agent_broadcast_all_hands' ORDER BY id DESC LIMIT 1`,
    ).get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      reason: "사칭 한계 기록",
      identity_basis: "claimed_from_agent_id",
    });
  });

  it("꺼진 팀원은 전체공지를 보내지 못한다", async () => {
    const roster = [
      { ...ROSTER[0]! },
      { ...ROSTER[1]!, enabled: false },
    ] as AgentRecord[];
    const { h } = app(roster);
    const res = await send(h, { from_agent_id: "steve", all_hands: "운영 점검" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("all_hands_sender_ineligible");
  });

  it("명부에서 발신자를 확인하지 못하면 성공시키지 않는다", async () => {
    const { h, db } = app(ROSTER, []);
    const res = await send(h, { from_agent_id: "steve", all_hands: "운영 점검" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("all_hands_roster_unavailable");
    const audit = db.prepare(
      `SELECT detail_json FROM audit_event WHERE action='agent_all_hands_blocked' ORDER BY id DESC LIMIT 1`,
    ).get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json).error).toBe("sender_missing_from_registry");
  });

  it("발신자만 있는 명부의 수신행 0은 sender_only로 기록한다", async () => {
    const roster = [{ ...ROSTER[0]! }] as AgentRecord[];
    const { h, db } = app(roster);
    const res = await send(h, { from_agent_id: "bill", all_hands: "개인 설치 확인" });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
    const row = db.prepare(
      `SELECT detail_json FROM audit_event WHERE action='agent_broadcast_all_hands' ORDER BY id DESC LIMIT 1`,
    ).get() as { detail_json: string };
    expect(JSON.parse(row.detail_json)).toMatchObject({ recipient_count: 0, zero_reason: "sender_only" });
  });

  it("명부 수신자가 DB에 없어 수신행 0이면 registry_db_out_of_sync로 기록한다", async () => {
    const dbRoster = [{ ...ROSTER[1]! }] as AgentRecord[];
    const routeRoster = [{ ...ROSTER[1]! }, { ...ROSTER[0]! }] as AgentRecord[];
    const { h, db } = app(dbRoster, routeRoster);
    const res = await send(h, { from_agent_id: "steve", all_hands: "명부 동기화 확인" });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
    const row = db.prepare(
      `SELECT detail_json FROM audit_event WHERE action='agent_broadcast_all_hands' ORDER BY id DESC LIMIT 1`,
    ).get() as { detail_json: string };
    expect(JSON.parse(row.detail_json)).toMatchObject({
      recipient_count: 0,
      eligible_recipient_count: 1,
      zero_reason: "registry_db_out_of_sync",
    });
  });
});

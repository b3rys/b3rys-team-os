/**
 * ★팀원 broadcast 게이트★ (GD 2026-08-01)
 *
 * ═══ 왜 생겼나 — 실측 ═══
 * `--to broadcast` 는 누구나 아무 때나 칠 수 있었고 검사도 기록도 없었다.
 * 70분간 팀원 broadcast ★47건 → wake 517회★. 1건이 11명을 깨우고, 깨어난 사람이 또 쏜다.
 * ★팀장님 @all 은 7명인데 팀원 혼잣말이 11명을 깨웠다★ — 구조가 뒤집혀 있었다.
 * 룰에는 "결과는 TERMINAL, 확인 답장 금지" 가 이미 있었지만 지켜지지 않았다(47건 중 5건이 내 것).
 *
 * ★그래서 룰이 아니라 게이트로 막는다.★ 판단을 9명에게 맡기지 않고 coordinator 한 곳으로 모은다.
 *
 * 계약 두 개:
 *  ① 팀원 broadcast = coordinator 능력 + `--all-hands "<이유>"` 둘 다 있어야 한다
 *  ② broadcast 에 대한 답은 broadcast 로 못 한다 (coordinator 라도) — 연쇄의 직접 고리
 */
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

function app() {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ROSTER) {
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
    registeredAgentIds: () => new Set(ROSTER.map((a) => a.id)),
    agents: () => ROSTER,
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

// ★coordinator 요구는 뺐다 (2026-08-01)★ — 넣었더니 방이 통째로 조용해졌다.
//   팀장님 "@all 다들 인지했어?" 에 아무도 방에 답하지 못했다. 과녁은 ★연쇄★ 였지 발언 자체가 아니었다.
//   그래서 그 계약을 검사하던 시험도 같이 지운다. 남는 계약은 아래 하나뿐이다.

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

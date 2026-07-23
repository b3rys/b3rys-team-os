/**
 * [Steve 독립 sim 재검증] proposal PM 라우팅 capability 도출 — 공개 팀 유령배정 0 실증.
 * Bill 기능수정(하드코딩 codex/bill 제거) 교차검증용. 적대적 엣지케이스 중심.
 * 핵심 단언: 어떤 follow-up owner 도 codex/bill(유령) 이 아니고, 전부 실제 주입 팀원이다.
 * 임시 파일 — 검증 후 삭제.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createProposalRoutes } from "./proposals";
import type { AgentRecord } from "../types";

const OP_TOKEN = "proposal-routing-sim-op-token";

beforeEach(() => {
  process.env.OP_MESSAGE_TOKEN = OP_TOKEN;
  process.env.OP_MESSAGE_TOKEN_BINDINGS = JSON.stringify(Object.fromEntries(["alice", "bob", "carol", "dex", "codex", "bill", "gd"].map((id) => [id, OP_TOKEN])));
  delete process.env.LEAD_ACTOR_ID;
});

function seedAgent(db: Database, id: string) {
  db.prepare(
    `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'P.md')`,
  ).run(id, id);
}
function agentRec(id: string, capabilities: string[] = [], teamOfficialMember = true): AgentRecord {
  return { id, display_name: id, role: "role", runtime: "claude_channel", capabilities, team_official_member: teamOfficialMember } as AgentRecord;
}
// members: [id, caps?, teamOfficialMember?] — caps 예: ["coordinator"], ["non_interactive"]
function setupTeam(members: Array<[string, string[]?, boolean?]>) {
  const db = new Database(":memory:");
  migrate(db);
  for (const [id] of members) seedAgent(db, id);
  const records = members.map(([id, caps, leadEligible]) => agentRec(id, caps ?? [], leadEligible ?? true));
  return { app: createProposalRoutes({ db, agents: () => records }), db };
}
const json = (body: unknown, actor?: string) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    ...(actor ? { "x-op-token": OP_TOKEN, "x-actor-id": actor } : {}),
  },
});
const VALID = {
  title: "[skill] sim — 라우팅 검증", summary: "공개 팀 라우팅 sim", source: "skill",
  body: "approval scope test body sufficiently long for the gate.",
  evidence_refs: "demo_artifact: out.png; skill_draft_path: skills/x/SKILL.md",
  expected_value: "라우팅 유령배정 0 실증",
};
async function createBy(app: any, proposer: string): Promise<string> {
  const r = await app.request("/proposals", json({ ...VALID, proposer_agent: proposer, author_agent: proposer }, proposer));
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
const transition = (app: any, id: string, to: string, actor: string, extra: Record<string, unknown> = {}) =>
  app.request(`/proposals/${id}/transition`, json({ to, actor, reason: "t", comment: "t", ...extra }, actor));
const review = (app: any, id: string, reviewer: string, stage: string, verdict = "approve", extra: Record<string, unknown> = {}) =>
  app.request(`/proposals/${id}/reviews`, json({ reviewer_agent: reviewer, stage, verdict, ...extra }, reviewer));
const statusOf = (db: Database, id: string) => (db.prepare("SELECT status FROM proposal WHERE id = ?").get(id) as { status: string }).status;
// 이 proposal 에 배정된 모든 follow-up owner 집합 (유령배정 감사용).
function allOwners(db: Database, id: string): string[] {
  return (db.prepare("SELECT DISTINCT owner FROM proposal_followup_task WHERE proposal_id = ?").all(id) as { owner: string }[]).map((r) => r.owner);
}
const GHOSTS = ["codex", "bill", "gd", "brief", "forin"]; // 하드코딩 잔재 있으면 여기로 샘

describe("[Steve sim] 공개 팀 proposal 라우팅 — 유령배정 0 (적대적)", () => {
  test("S1: 3인 공개팀 전체 라이프사이클 — 모든 owner 가 실제 팀원, codex/bill 유령 0", async () => {
    const team = ["alice", "bob", "carol"];
    const { app, db } = setupTeam([["alice"], ["bob", ["coordinator"]], ["carol"]]);
    const id = await createBy(app, "alice");
    // 생성=peer 직행 → review 1건=자동 gd_report → 팀장 accepted
    expect(statusOf(db, id)).toBe("peer_review");
    expect((await review(app, id, "carol", "peer", "concern", { is_adversarial: true })).status).toBe(201);
    expect(statusOf(db, id)).toBe("gd_report");
    expect((await transition(app, id, "accepted", "gd")).status).toBe(200);
    expect(statusOf(db, id)).toBe("accepted");
    // ★유령배정 전수감사: 모든 follow-up owner ∈ 팀, 유령 0
    const owners = allOwners(db, id);
    expect(owners.length).toBeGreaterThan(0);
    for (const o of owners) {
      expect(team).toContain(o); // 실제 주입 팀원만 (codex/bill 유령 아님)
      expect(GHOSTS).not.toContain(o);
    }
    // review-stage(peer/pm) owner 는 제안자(alice) 제외 — 결정 알림 follow-up 은 제안자 소유 가능(정상)
    const reviewOwners = (db.prepare(
      "SELECT DISTINCT owner FROM proposal_followup_task WHERE proposal_id = ? AND status LIKE 'peer_review:%'",
    ).all(id) as { owner: string }[]).map((r) => r.owner);
    expect(reviewOwners.length).toBeGreaterThan(0);
    expect(reviewOwners).not.toContain("alice"); // 리뷰 owner 는 제안자 제외
    for (const o of reviewOwners) expect(team).toContain(o);
  });

  test("S4: coordinator 부재 공개팀 — 크래시/유령 없이 graceful", async () => {
    const { app, db } = setupTeam([["alice"], ["bob"]]); // 아무도 coordinator 없음
    const id = await createBy(app, "alice");
    expect(statusOf(db, id)).toBe("peer_review"); // 2인 → 단일 review
    const owners = allOwners(db, id);
    for (const o of owners) { expect(["alice", "bob"]).toContain(o); expect(GHOSTS).not.toContain(o); }
    // peer 리뷰 등록 = 자동 gd_report(coordinator 없어도 reviewer=bob)
    expect((await review(app, id, "bob", "peer", "approve")).status).toBe(201);
    expect(statusOf(db, id)).toBe("gd_report");
  });

  test("S5: proposer 가 유일 coordinator(2인) — review owner 는 제안자 아닌 다른 팀원", async () => {
    const { app, db } = setupTeam([["alice", ["coordinator"]], ["bob"]]);
    const id = await createBy(app, "alice"); // proposer=coordinator
    expect(statusOf(db, id)).toBe("peer_review"); // 2인 → 단일 review
    const owners = allOwners(db, id);
    expect(owners).toContain("bob"); // 제안자(alice=coord) 제외 → bob
    expect(owners).not.toContain("alice");
    for (const o of owners) expect(GHOSTS).not.toContain(o);
  });

  test("S6: non_interactive 팀원은 리뷰어 후보에서 배제", async () => {
    // alice(proposer)/bob/carol(non_interactive)/dave(coordinator) — peer·pm owner 에 carol 안 나와야
    const { app, db } = setupTeam([["alice"], ["bob"], ["carol", ["non_interactive"]], ["dave", ["coordinator"]]]);
    const id = await createBy(app, "alice");
    expect(statusOf(db, id)).toBe("peer_review"); // peer 직행(carol non_interactive 제외)
    await review(app, id, "bob", "peer", "concern", { is_adversarial: true }); // 반대 → 자동 pm
    const owners = allOwners(db, id);
    expect(owners).not.toContain("carol"); // non_interactive 배제
    expect(owners).not.toContain("alice"); // 제안자 배제
    for (const o of owners) { expect(["bob", "dave"]).toContain(o); expect(GHOSTS).not.toContain(o); }
  });

  test("S6b: team_official_member:false 비정식 팀원은 리뷰어 후보에서 배제", async () => {
    // Forin 같은 coach/콘텐츠 멤버는 team op wake allowlist 밖일 수 있어 proposal 리뷰 후보가 되면 stuck된다.
    const { app, db } = setupTeam([["alice"], ["bob"], ["coach", [], false], ["dave", ["coordinator"]]]);
    const id = await createBy(app, "alice");
    expect(statusOf(db, id)).toBe("peer_review"); // peer 직행(coach team_official_member:false 제외)
    await review(app, id, "bob", "peer", "concern", { is_adversarial: true }); // 반대 → 자동 pm
    const owners = allOwners(db, id);
    expect(owners).not.toContain("coach");
    expect(owners).not.toContain("alice");
    for (const o of owners) { expect(["bob", "dave"]).toContain(o); expect(GHOSTS).not.toContain(o); }
  });

  test("S7: 1인 공개팀 — gd_report 직행 도달(공개판 최소팀 작동)", async () => {
    const { app, db } = setupTeam([["alice", ["coordinator"]]]);
    const id = await createBy(app, "alice");
    expect(statusOf(db, id)).toBe("gd_report"); // 1인 = gd_report 직행
    const owners = allOwners(db, id);
    for (const o of owners) expect(GHOSTS).not.toContain(o);
  });
});

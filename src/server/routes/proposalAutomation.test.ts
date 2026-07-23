/**
 * proposal 자동화 — 생성=즉시 진입 / 리뷰=자동 전이 / 원자·멱등 코어 테스트.
 * GD 2026-07-04 "담당자 자율성 배제 → 시스템 자동 승격". codex/gemini 교차검토 반영.
 * 핀: (B)생성 즉시 첫 리뷰단계 진입 · 리뷰 등록 시 자동 전이 · advanceProposalIfCurrent 멱등/원자 race 차단.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createProposalRoutes, sweepStaleProposals } from "./proposals";
import { advanceProposalIfCurrent, createProposal, SYSTEM_ACTOR } from "../db/proposal";
import { ambientAgents } from "../lib/registry";

const OP_TOKEN = "proposal-auto-test-op-token";

beforeEach(() => {
  process.env.OP_MESSAGE_TOKEN = OP_TOKEN;
  process.env.OP_MESSAGE_TOKEN_BINDINGS = JSON.stringify(Object.fromEntries(["bill", "codex", "steve", "demis", "devon", "gd"].map((id) => [id, OP_TOKEN])));
  delete process.env.LEAD_ACTOR_ID;
});

function seedAgent(db: Database, id: string) {
  db.prepare(
    `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'P.md')`,
  ).run(id, id);
}
function setup() {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["bill", "codex", "steve", "demis", "devon", "gd"]) seedAgent(db, a);
  return { app: createProposalRoutes({ db }), db };
}
const json = (body: unknown, actor?: string) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    ...(actor ? { "x-op-token": OP_TOKEN, "x-actor-id": actor } : {}),
  },
});
const VALID_NEW = {
  title: "[skill] 자동화 파이프라인 테스트 제안",
  summary: "생성=즉시진입 검증용",
  body: "본문",
  proposer_agent: "codex",
  author_agent: "codex",
  source: "skill",
  evidence_refs: "ref: x",
  expected_value: "자동 진행 검증",
};
const create = (app: ReturnType<typeof setup>["app"], over: Record<string, unknown> = {}) =>
  app.request("/proposals", json({ ...VALID_NEW, ...over }, String(over.proposer_agent ?? VALID_NEW.proposer_agent)));
const review = (app: ReturnType<typeof setup>["app"], id: string, over: Record<string, unknown>) => {
  const reviewer = String(over.reviewer_agent ?? "steve");
  return app.request(`/proposals/${id}/reviews`, json({ reviewer_agent: reviewer, stage: "peer", ...over }, reviewer));
};
const statusOf = (db: Database, id: string) =>
  (db.prepare("SELECT status FROM proposal WHERE id = ?").get(id) as { status: string }).status;

describe("자동화 — 생성 = 즉시 진입 (B)", () => {
  test("생성 성공 시 draft에 안 멈추고 첫 리뷰단계로 자동 진입 + system actor 로그", async () => {
    const { app, db } = setup();
    const r = await create(app);
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string; stage: string; auto_advanced: boolean };
    expect(body.auto_advanced).toBe(true);
    expect(body.stage).not.toBe("draft");
    expect(statusOf(db, body.id)).toBe(body.stage);
    const logs = db.prepare(
      "SELECT actor, to_status FROM proposal_decision_log WHERE proposal_id = ? ORDER BY id",
    ).all(body.id) as { actor: string; to_status: string }[];
    // create→draft 후, system 이 draft→(첫 단계) 자동 전이
    expect(logs[0]?.to_status).toBe("draft");
    expect(logs.some((l) => l.actor === SYSTEM_ACTOR && l.to_status === body.stage)).toBe(true);
  });
});

describe("자동화 — 리뷰 등록 = 자동 전이", () => {
  test("peer review 등록 시 gd_report 자동전이", async () => {
    const { app, db } = setup();
    const { id } = (await (await create(app)).json()) as { id: string };
    const rr = await review(app, id, { reviewer_agent: "steve", verdict: "concern", is_adversarial: true });
    expect(rr.status).toBe(201);
    expect((await rr.json()).auto_advanced).toBe(true);
    expect(statusOf(db, id)).toBe("gd_report");
  });

  test("approve peer 리뷰도 단일 review로 인정되어 gd_report로 전이", async () => {
    const { app, db } = setup();
    const { id } = (await (await create(app)).json()) as { id: string };
    const rr = await review(app, id, { reviewer_agent: "steve", verdict: "approve", is_adversarial: false });
    expect(rr.status).toBe(201);
    expect((await rr.json()).auto_advanced).toBe(true);
    expect(statusOf(db, id)).toBe("gd_report");
  });

  test("단일 peer 리뷰로 전체 흐름이 gd_report까지 간다", async () => {
    const { app, db } = setup();
    const { id } = (await (await create(app)).json()) as { id: string };
    const rr = await review(app, id, { reviewer_agent: "steve", verdict: "approve" });
    expect(rr.status).toBe(201);
    expect((await rr.json()).auto_advanced).toBe(true);
    expect(statusOf(db, id)).toBe("gd_report");
  });
});

describe("자동화 — 원자·멱등 코어 (race 차단)", () => {
  test("같은 action_key 2번 = 1회만 전이(멱등)", () => {
    const { db } = setup();
    const id = createProposal(db, VALID_NEW).id!;
    const a1 = advanceProposalIfCurrent(db, { proposalId: id, expectedFrom: "draft", to: "peer_review", actionKey: "k1", kind: "t" });
    const a2 = advanceProposalIfCurrent(db, { proposalId: id, expectedFrom: "draft", to: "peer_review", actionKey: "k1", kind: "t" });
    expect(a1.advanced).toBe(true);
    expect(a2.advanced).toBe(false);
    expect(a2.deduped).toBe(true);
    expect(statusOf(db, id)).toBe("peer_review");
  });

  test("stale expected_from = 전이 거부 (동시 전이 후발 차단)", () => {
    const { db } = setup();
    const id = createProposal(db, VALID_NEW).id!;
    advanceProposalIfCurrent(db, { proposalId: id, expectedFrom: "draft", to: "peer_review", actionKey: "k1", kind: "t" });
    // 이미 peer_review 인데 draft 기준으로 다시 전이 시도 → stale, 부수효과 없음
    const stale = advanceProposalIfCurrent(db, { proposalId: id, expectedFrom: "draft", to: "pm_review", actionKey: "k2", kind: "t" });
    expect(stale.advanced).toBe(false);
    expect(statusOf(db, id)).toBe("peer_review");
  });
});

describe("자동화 — sweeper 정체 안전망", () => {
  const ageProposal = (db: Database, id: string, minutes: number) =>
    db.prepare("UPDATE proposal SET updated_at = datetime('now', ?) WHERE id = ?").run(`-${minutes} minutes`, id);

  test("draft 정체 30분+ → 첫 리뷰단계로 자동 제출(이미 멈춘 제안 구제)", () => {
    const { db } = setup();
    const id = createProposal(db, VALID_NEW).id!; // route 안 거침 → draft 로 남음
    expect(statusOf(db, id)).toBe("draft");
    ageProposal(db, id, 40);
    const r = sweepStaleProposals(db, ambientAgents());
    expect(r.advanced).toContain(id);
    expect(statusOf(db, id)).toBe("peer_review"); // 3+팀 → peer 자동 제출
  });

  test("peer 무응답 → 1차 재배정 → 2차 리뷰 skip degraded 진행", async () => {
    const { app, db } = setup();
    const { id } = (await (await create(app)).json()) as { id: string };
    expect(statusOf(db, id)).toBe("peer_review");
    ageProposal(db, id, 40);
    const r1 = sweepStaleProposals(db, ambientAgents());
    expect(r1.reassigned).toContain(id);
    expect(statusOf(db, id)).toBe("peer_review"); // 재배정만, 아직 peer
    const r2 = sweepStaleProposals(db, ambientAgents()); // 여전히 stale → degraded
    expect(r2.degraded).toContain(id);
    expect(statusOf(db, id)).toBe("gd_report"); // 리뷰 없이 자동 진행(degraded)
  });

  test("정체 아닌(최근) 제안은 sweeper가 건드리지 않는다", async () => {
    const { app, db } = setup();
    const { id } = (await (await create(app)).json()) as { id: string };
    const r = sweepStaleProposals(db, ambientAgents());
    expect(r.advanced).not.toContain(id);
    expect(r.reassigned).not.toContain(id);
    expect(r.degraded).not.toContain(id);
    expect(statusOf(db, id)).toBe("peer_review");
  });
});

describe("자동화 — 승인 후 실행 (지시 필수 + 유형)", () => {
  async function toGdReport(app: ReturnType<typeof setup>["app"], db: Database): Promise<string> {
    const { id } = (await (await create(app)).json()) as { id: string };
    await review(app, id, { reviewer_agent: "steve", verdict: "approve" }); // → gd_report
    expect(statusOf(db, id)).toBe("gd_report");
    return id;
  }

  test("팀장 결정에 지시 코멘트 없으면 거부(빈 승인 차단)", async () => {
    const { app, db } = setup();
    const id = await toGdReport(app, db);
    const empty = await app.request(`/proposals/${id}/transition`, json({ to: "accepted", actor: "gd", reason: "" }, "gd"));
    expect(empty.status).toBe(409); // 지시 없으면 넘어가지 않는다
    const withDirective = await app.request(`/proposals/${id}/transition`, json({ to: "accepted", actor: "gd", comment: "이건 팀스킬에 등록해" }, "gd"));
    expect(withDirective.status).toBe(200);
    expect(statusOf(db, id)).toBe("accepted");
  });

  test("승인 시 제안자에게 컨펌 트리거 카드가 열린 채(doing) 전달된다", async () => {
    const { app, db } = setup();
    const id = await toGdReport(app, db);
    await app.request(`/proposals/${id}/transition`, json({ to: "accepted", actor: "gd", comment: "팀 규칙에 반영 검토" }, "gd"));
    const proposerCard = db.prepare(
      "SELECT t.lane, t.description FROM task t JOIN proposal_followup_task pft ON pft.task_id = t.id WHERE pft.proposal_id = ? AND pft.status = ?",
    ).get(id, "gd_decision:accepted:codex") as { lane: string; description: string };
    expect(proposerCard.lane).toBe("doing"); // 실행 전 컨펌 트리거로 열려 있다
    expect(proposerCard.description).toContain("팀 규칙에 반영 검토"); // 팀장 지시 전달
  });

  test("peer reject verdict → 자동 최종 반려(rejected)", async () => {
    const { app, db } = setup();
    const { id } = (await (await create(app)).json()) as { id: string };
    expect(statusOf(db, id)).toBe("peer_review");
    const r = await review(app, id, { reviewer_agent: "steve", verdict: "reject", is_adversarial: true, comments: "폐기 사유" });
    expect(r.status).toBe(201);
    expect(statusOf(db, id)).toBe("rejected"); // peer reject = 그 자리서 최종 반려
    // 반려 노티(제안자 카드) 생성 확인
    const notice = db.prepare("SELECT COUNT(*) AS c FROM proposal_followup_task WHERE proposal_id=? AND status LIKE 'gd_decision:rejected:%'").get(id) as { c: number };
    expect(notice.c).toBeGreaterThan(0);
  });

  test("peer concern/approve 는 반려 아님(진행/대기, 노티 X)", async () => {
    const { app, db } = setup();
    const { id } = (await (await create(app)).json()) as { id: string };
    await review(app, id, { reviewer_agent: "steve", verdict: "concern", is_adversarial: true });
    expect(statusOf(db, id)).toBe("gd_report"); // concern = 진행(반려 아님)
    const notice = db.prepare("SELECT COUNT(*) AS c FROM proposal_followup_task WHERE proposal_id=? AND status LIKE 'gd_decision:%'").get(id) as { c: number };
    expect(notice.c).toBe(0); // 중간 진행은 노티 없음
  });

  test("생성 시 유형(type)이 제목 태그에서 파생된다", async () => {
    const { app, db } = setup();
    const { id } = (await (await create(app, { title: "[skill] 무언가 스킬" })).json()) as { id: string };
    const row = db.prepare("SELECT type FROM proposal WHERE id = ?").get(id) as { type: string };
    expect(row.type).toBe("skill");
  });
});

describe("자동화 — 교차검토 결함 회귀 방어", () => {
  const ageProposal = (db: Database, id: string, minutes: number) =>
    db.prepare("UPDATE proposal SET updated_at = datetime('now', ?) WHERE id = ?").run(`-${minutes} minutes`, id);

  test("결함1: approve review만으로 gd_report 자동전이(단일 review)", async () => {
    const { app, db } = setup();
    const { id } = (await (await create(app)).json()) as { id: string };
    const r = await review(app, id, { reviewer_agent: "steve", verdict: "approve", is_adversarial: false });
    expect(r.status).toBe(201);
    expect(statusOf(db, id)).toBe("gd_report");
  });

  test("결함2: x-actor-id: system 은 HTTP 전이에서 403 거부(권한 탈취 차단)", async () => {
    const { db } = setup();
    const app = createProposalRoutes({ db });
    const id = createProposal(db, VALID_NEW).id!; // draft (route 안 거침)
    const r = await app.request(`/proposals/${id}/transition`, json({ to: "peer_review" }, "system"));
    expect(r.status).toBe(403);
    expect(statusOf(db, id)).toBe("draft"); // 가로채기 실패
  });

  test("P1: sweeper degraded는 risk_level=high 제안을 자동 진행하지 않는다", () => {
    const { db } = setup();
    const id = createProposal(db, { ...VALID_NEW, risk_level: "high" }).id!;
    advanceProposalIfCurrent(db, { proposalId: id, expectedFrom: "draft", to: "peer_review", actionKey: "k", kind: "t" });
    ageProposal(db, id, 40);
    sweepStaleProposals(db, ambientAgents()); // 1차 재배정
    const r2 = sweepStaleProposals(db, ambientAgents()); // 2차: high-risk → skip
    expect(r2.degraded).not.toContain(id);
    expect(statusOf(db, id)).toBe("peer_review"); // 사람 리뷰 대기(무검토 승격 안 함)
  });
});

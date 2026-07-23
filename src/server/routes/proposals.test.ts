/**
 * proposals 라우트 — 거버넌스 상태기계 integration test (GD 2026-06-22 "필수기능 integration 테스트").
 * 표면: dashboard Proposal 탭의 정본 게이트(팀 정책 + 팀스킬 후보 공통). createProposalRoutes + in-memory DB + app.request.
 * 핀: 품질 하한선(evidence·expected_value) / 상태기계 / Guard A(반대리뷰 의무) / Guard B(최종승인 GD 전용).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createProposal as createProposalRow } from "../db/proposal";
import { createProposalRoutes, sweepStaleProposals } from "./proposals";
import type { AgentRecord } from "../types";

const OP_TOKEN = "proposal-route-test-op-token";

beforeEach(() => {
  process.env.OP_MESSAGE_TOKEN = OP_TOKEN;
  process.env.OP_MESSAGE_TOKEN_BINDINGS = JSON.stringify(Object.fromEntries(["bill", "codex", "steve", "demis", "devon", "gd", "lead", "alice", "bob", "carol", "lui", "hermes"].map((id) => [id, OP_TOKEN])));
  delete process.env.LEAD_ACTOR_ID;
  delete process.env.CAPTURE_BOT_TOKEN;
  delete process.env.CAPTURE_GROUP_ID;
  process.env.CAPTURE_TOKEN_FILE = "/tmp/b3os-proposals-test-no-token";
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
  const records = ["bill", "codex", "steve", "demis", "devon", "gd"].map((id) => agentRec(id, id === "bill" ? ["coordinator"] : []));
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
const patchJson = (body: unknown, actor?: string) => ({
  method: "PATCH",
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    ...(actor ? { "x-op-token": OP_TOKEN, "x-actor-id": actor } : {}),
  },
});

const VALID_NEW = {
  title: "[skill] create-webtoon — 웹툰 생성 팀스킬",
  summary: "웹툰 생성 자동화 스킬 후보",
  body: "approval scope: scoped approval requests stay on the matching agent account; unscoped requests do not fan out.",
  proposer_agent: "codex",
  author_agent: "codex",
  source: "skill",
  evidence_refs: "demo_artifact: out.png; skill_draft_path: skills/x/SKILL.md",
  expected_value: "팀 웹툰 콘텐츠 생성 자동화",
};

async function create(app: ReturnType<typeof setup>["app"], over: Record<string, unknown> = {}) {
  const body = { ...VALID_NEW, ...over };
  const r = await app.request("/proposals", json(body, String(body.proposer_agent ?? "codex")));
  return r;
}
const transition = (app: ReturnType<typeof setup>["app"], id: string, to: string, actor: string, extra: Record<string, unknown> = {}) =>
  // comment:"t" 기본 포함 — 팀장 결정(accepted 등)엔 지시 코멘트 필수(빈 결정 차단). 빈-승인 테스트는 직접 app.request로.
  app.request(`/proposals/${id}/transition`, json({ to, actor, reason: "t", comment: "t", ...extra }, actor));
const review = (app: ReturnType<typeof setup>["app"], id: string, over: Record<string, unknown>) => {
  const reviewer = String(over.reviewer_agent ?? "steve");
  return app.request(`/proposals/${id}/reviews`, json({ reviewer_agent: reviewer, stage: "peer", ...over }, reviewer));
};
async function onePeerReview(app: ReturnType<typeof setup>["app"], id: string) {
  expect((await review(app, id, { reviewer_agent: "steve", verdict: "concern", is_adversarial: true })).status).toBe(201);
}
function createProposalForLegacyPm(db: Database): string {
  const id = createProposalRow(db, VALID_NEW).id!;
  db.prepare("UPDATE proposal SET status = 'pm_review' WHERE id = ?").run(id);
  return id;
}

describe("proposals — 품질 하한선 (생성 게이트)", () => {
  test("evidence_refs·expected_value 없으면 400 (노이즈 폐기)", async () => {
    const { app } = setup();
    const r = await create(app, { evidence_refs: undefined, expected_value: undefined });
    expect(r.status).toBe(400);
  });
  test("non-string 필드(숫자/객체)는 .trim TypeError(500) 없이 안전 처리 (실라이브 가드)", async () => {
    const { app } = setup();
    // 옛 코드: p.x?.trim()가 숫자/객체에서 .trim is not a function → 500(서버 크래시).
    // 가드(String(x??"").trim()) 후엔 코어션돼 크래시 없음 — 비어있지 않으면 정상 생성(201).
    expect((await create(app, { evidence_refs: 123 })).status).toBe(201);
    expect((await create(app, { title: 123 })).status).toBe(201);
    // null/빈값으로 코어션되면 품질 하한선 400. 어느 경우든 500(TypeError)은 없다.
    expect((await create(app, { evidence_refs: null })).status).toBe(400);
  });
  test("proposer_agent가 실제 팀원이 아니면 400", async () => {
    const { app } = setup();
    const r = await app.request("/proposals", json({ ...VALID_NEW, proposer_agent: "ghost" }, "gd"));
    expect(r.status).toBe(400);
  });
  test("author_agent가 실제 팀원이 아니면 400, 생략하면 proposer로 backfill", async () => {
    const { app } = setup();
    expect((await create(app, { author_agent: "ghost" })).status).toBe(400);
    const r = await create(app, { author_agent: undefined });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const got = await (await app.request(`/proposals/${id}`)).json() as { proposal: { author_agent: string; body: string } };
    expect(got.proposal.author_agent).toBe("codex");
    expect(got.proposal.body).toContain("approval scope");
  });
  test("필수 충족 시 201 + (B) 생성=즉시 첫 리뷰단계 자동 진입", async () => {
    const { app } = setup();
    const r = await create(app);
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const got = await (await app.request(`/proposals/${id}`)).json();
    expect(got.proposal.status).toBe("peer_review"); // draft에 안 멈추고 자동 진입(생성=제출)
    expect(got.proposal.source).toBe("skill");
  });
});

describe("proposals — 상태기계 + Guard", () => {
  async function fresh() {
    const s = setup();
    // (B) 생성=즉시 첫 리뷰단계(peer) 진입. 그 시점 followup(배정+wake)이 create 응답에 실린다.
    const { id, followup } = (await (await create(s.app)).json()) as {
      id: string; followup?: { owner?: string; taskId?: string; messageId?: string };
    };
    return { ...s, id, followup };
  }
  // 지정 proposer로 revise_requested 상태까지 끌고 간다(escape/alert 테스트용).
  // 팀장 결정 단계(gd_report)는 승인/반려 2택이므로(GD 2026-07-10), revise 는 리뷰어 단계에서만 진입한다.
  async function reviseRequested(proposer: string) {
    const s = setup();
    // 생성=peer_review 진입 → 리뷰어가 곧바로 revise 요청(gd_report 로 넘기지 않는다).
    const { id } = (await (await create(s.app, { proposer_agent: proposer, author_agent: proposer })).json()) as { id: string };
    const reviewer = proposer === "steve" ? "demis" : "steve";
    expect((await transition(s.app, id, "revise_requested", reviewer)).status).toBe(200);
    return { ...s, id };
  }

  test("happy path: 생성=peer_review → 리뷰 자동전이 → gd_report → (GD)accepted", async () => {
    const { app, db, id } = await fresh();
    expect(statusOf(db, id)).toBe("peer_review"); // 생성=즉시 진입
    await onePeerReview(app, id); // review 등록 = gd_report 자동전이
    expect(statusOf(db, id)).toBe("gd_report");
    // Guard B: 최종 accepted는 GD만(수동 결정)
    expect((await transition(app, id, "accepted", "gd")).status).toBe(200);
    const got = await (await app.request(`/proposals/${id}`)).json();
    expect(got.proposal.status).toBe("accepted");
  });

  test("authz: transition actor는 body가 아니라 인증 헤더에서 온다", async () => {
    const { app, id } = await fresh();
    const r = await app.request(`/proposals/${id}/transition`, json({ to: "peer_review", actor: "codex", reason: "spoofed body" }, "bill"));
    expect(r.status).toBe(409); // header actor=bill 이므로 proposer(codex) 제출 가드에 걸린다.
    const noAuth = await app.request(new Request(`http://example.com/proposals/${id}/transition`, json({ to: "peer_review", actor: "codex", reason: "no auth" })));
    expect(noAuth.status).toBe(403);
  });

  test("authz: loopback dashboard 요청은 기존 ProposalsView POST를 actor=gd로 보정한다", async () => {
    const { app, id } = await fresh();
    await transition(app, id, "peer_review", "codex");
    await onePeerReview(app, id);

    const dashboard = await app.request(`/proposals/${id}/transition`, json({ to: "accepted", actor: "gd", reason: "dashboard button", comment: "팀스킬로 등록해" }));
    expect(dashboard.status).toBe(200);
  });

  test("authz: LEAD_ACTOR_ID 설정 시 최종 결정 actor가 env 팀장으로 바뀐다", async () => {
    process.env.LEAD_ACTOR_ID = "lead";
    const { app, id } = await fresh();
    await transition(app, id, "peer_review", "codex");
    await onePeerReview(app, id);

    expect((await transition(app, id, "accepted", "gd")).status).toBe(409);
    expect((await transition(app, id, "accepted", "lead")).status).toBe(200);
  });

  test("authz: review actor mismatch와 emergency_override reason 누락을 거부한다", async () => {
    const { app, id } = await fresh();
    expect((await app.request(`/proposals/${id}/reviews`, json({ reviewer_agent: "steve", stage: "peer", verdict: "concern" }, "bill"))).status).toBe(403);
    await transition(app, id, "peer_review", "codex");
    const r = await app.request(`/proposals/${id}/transition`, json({ to: "pm_review", actor: "bill", emergency_override: true, reason: "" }, "bill"));
    expect(r.status).toBe(409);
  });

  test("PATCH /proposals/:id updates draft text fields through standard API", async () => {
    const { app, db } = setup();
    const id = createProposalRow(db, {
      ...VALID_NEW,
      proposer_agent: "devon",
      author_agent: "devon",
      source: "proposal-update-api-test",
    }).id!;

    const r = await app.request(`/proposals/${id}`, patchJson({
      actor: "bill", // body spoof ignored; header actor=devon is authoritative.
      summary: "revised summary",
      body: "revised body with raw HTTP response evidence",
      evidence_refs: "request-id req_123; response body saved; audit log checked",
      reason: "apply peer required_changes",
    }, "devon"));
    expect(r.status).toBe(200);
    const out = await r.json() as { ok: boolean; updated: string[]; proposal: { summary: string; body: string; evidence_refs: string; status: string } };
    expect(out.ok).toBe(true);
    expect(out.updated.sort()).toEqual(["body", "evidence_refs", "summary"]);
    expect(out.proposal.status).toBe("draft");
    expect(out.proposal.summary).toBe("revised summary");
    expect(out.proposal.body).toContain("raw HTTP response");
    expect(out.proposal.evidence_refs).toContain("request-id");
    const log = db.prepare("SELECT actor, action, from_status, to_status, reason FROM proposal_decision_log WHERE proposal_id = ? ORDER BY id DESC LIMIT 1").get(id) as {
      actor: string; action: string; from_status: string; to_status: string; reason: string;
    };
    expect(log).toEqual({
      actor: "devon",
      action: "update",
      from_status: "draft",
      to_status: "draft",
      reason: "apply peer required_changes",
    });
  });

  test("PATCH /proposals/:id enforces actor, status, and field guards", async () => {
    const { app, db } = setup();
    const id = createProposalRow(db, {
      ...VALID_NEW,
      proposer_agent: "devon",
      author_agent: "devon",
      source: "proposal-update-api-test",
    }).id!;

    expect((await app.request(`/proposals/${id}`, patchJson({ summary: "x" }, "bill"))).status).toBe(409);
    expect((await app.request(`/proposals/${id}`, patchJson({ title: "not allowed" }, "devon"))).status).toBe(400);
    expect((await app.request(`/proposals/${id}`, patchJson({ summary: 123 }, "devon"))).status).toBe(400);

    db.prepare("UPDATE proposal SET status = 'peer_review' WHERE id = ?").run(id);
    const wrongStatus = await app.request(`/proposals/${id}`, patchJson({ summary: "x" }, "devon"));
    expect(wrongStatus.status).toBe(409);
    expect(await wrongStatus.json()).toEqual({ error: "proposal update는 draft/revise_requested 상태에서만 가능(현재 peer_review)" });
  });

  test("생성 시 첫 리뷰단계 follow-up task와 directed wake가 생성된다", async () => {
    const { db, id, followup } = await fresh();
    // (B) 생성=즉시 peer 진입 시점에 배정+wake 가 followup 으로 실린다.
    const peer = followup?.owner ?? "";
    expect(["bill", "steve", "demis", "devon", "gd"]).toContain(peer);
    expect(peer).not.toBe("codex");
    expect(followup?.taskId).toBeTruthy();
    expect(followup?.messageId).toBeTruthy();
    const task = db.prepare("SELECT title, lane, owner, description FROM task WHERE id = ?").get(followup!.taskId!) as {
      title: string; lane: string; owner: string; description: string;
    };
    expect(task.lane).toBe("doing");
    expect(task.owner).toBe(peer);
    expect(task.description).toContain(`proposal:${id} status:peer_review`);
    expect(task.description).toContain("팀장보고 전에 단일 review");
    const msg = db.prepare("SELECT from_agent_id, to_agent_id, body FROM message WHERE to_agent_id = ? ORDER BY created_at DESC LIMIT 1").get(peer) as {
      from_agent_id: string; to_agent_id: string; body: string;
    };
    expect(msg.from_agent_id).toBe("codex");
    expect(msg.body).toContain(id);
    const recipient = db.prepare("SELECT delivery_state FROM message_recipient WHERE message_id = ? AND agent_id = ?").get(followup!.messageId!, peer) as {
      delivery_state: string;
    };
    expect(recipient.delivery_state).toBe("pending");
    const link = db.prepare("SELECT proposal_id, status, closed_at FROM proposal_followup_task WHERE task_id = ?").get(followup!.taskId!) as {
      proposal_id: string; status: string; closed_at: string | null;
    };
    expect(link.proposal_id).toBe(id);
    expect(link.status).toBe(`peer_review:${peer}`);
    expect(link.closed_at).toBeNull();
    const openPeerTasks = db.prepare("SELECT COUNT(*) AS c FROM proposal_followup_task WHERE proposal_id = ? AND status LIKE 'peer_review:%' AND closed_at IS NULL").get(id) as { c: number };
    expect(openPeerTasks.c).toBe(1);
  });

  test("단일 review 등록 후 gd_report follow-up을 시스템 선정 owner에게 보낸다", async () => {
    const { app, db } = setup();
    const { id } = (await (await create(app, {
      title: "[skill] approval scope proposal flow",
      source: "skill",
      proposer_agent: "devon",
    })).json()) as { id: string };

    // 생성=peer_review. review 등록 = gd_report 자동전이 + 팀장 report owner 배정(review 응답에 followup).
    const r = await review(app, id, { reviewer_agent: "steve", verdict: "concern", is_adversarial: true });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { followup?: { owner?: string } };
    expect(body.followup?.owner).toBeTruthy();
    expect(["bill", "codex"]).toContain(body.followup!.owner!);
    const reportTasks = db.prepare(
      "SELECT owner, status FROM proposal_followup_task WHERE proposal_id = ? AND status = 'gd_report' ORDER BY owner",
    ).all(id) as { owner: string; status: string }[];
    expect(reportTasks).toHaveLength(1);
    expect(["bill", "codex"]).toContain(reportTasks[0]!.owner);
  });

  test("[test] proposal은 모든 status follow-up과 팀장 결정 요청 알림을 만들지 않고 감사 로그만 남긴다", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ body: { chat_id?: string; text?: string } }> = [];
    process.env.CAPTURE_BOT_TOKEN = "123456:test-token";
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const { app, db } = setup();
      db.prepare("INSERT INTO setting (key, value) VALUES ('owner_chat_id', '1000000001')").run();
      const created = await create(app, {
        title: "[test] approval scope proposal flow",
        source: "p0_approval_scope_smoke",
        proposer_agent: "devon",
      });
      const createdBody = (await created.json()) as { id: string; followup?: { skipped?: boolean; owner?: string } };
      const { id } = createdBody;
      expect(createdBody.followup?.skipped).toBe(true);
      expect(createdBody.followup?.owner).toBe("system");
      expect(db.prepare(
        "SELECT COUNT(*) AS c FROM proposal_followup_task WHERE proposal_id = ?",
      ).get(id) as { c: number }).toEqual({ c: 0 });

      const r = await review(app, id, { reviewer_agent: "steve", verdict: "concern", is_adversarial: true });
      expect(r.status).toBe(201);
      const body = (await r.json()) as { followup?: { skipped?: boolean; owner?: string } };
      expect(body.followup?.skipped).toBe(true);
      expect(body.followup?.owner).toBe("system");
      await Bun.sleep(0);

      expect(calls).toHaveLength(0);
      const reportTasks = db.prepare(
        "SELECT owner, status FROM proposal_followup_task WHERE proposal_id = ? AND status = 'gd_report'",
      ).all(id) as { owner: string; status: string }[];
      expect(reportTasks).toHaveLength(0);
      const audits = db.prepare(
        "SELECT action FROM audit_event WHERE target = ? ORDER BY id",
      ).all(id) as { action: string }[];
      expect(audits.map((a) => a.action).filter((a) => a === "proposal_followup_skipped_test")).toHaveLength(2);
      expect(audits.map((a) => a.action)).toContain("gd_report_notice_skipped_test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("source가 smoke/e2e/fixture이면 title이 [test]가 아니어도 follow-up을 만들지 않는다", async () => {
    const { app, db } = setup();
    const created = await create(app, {
      title: "[skill] source-only smoke proposal",
      source: "p0_approval_scope_smoke",
      proposer_agent: "devon",
    });
    expect(created.status).toBe(201);
    const { id, followup } = (await created.json()) as { id: string; followup?: { skipped?: boolean; owner?: string } };
    expect(followup?.skipped).toBe(true);
    expect(followup?.owner).toBe("system");
    const openTasks = db.prepare(
      "SELECT COUNT(*) AS c FROM proposal_followup_task WHERE proposal_id = ? AND closed_at IS NULL",
    ).get(id) as { c: number };
    expect(openTasks.c).toBe(0);
  });

  test("peer review는 제안자를 제외하고 나머지 팀원 중 랜덤 1명에게 보낸다", async () => {
    const { app, db } = setup();
    seedAgent(db, "lui");
    seedAgent(db, "hermes");
    const { id } = (await (await create(app, {
      title: "[skill] distinct proposer smoke",
      source: "skill",
      proposer_agent: "lui",
      author_agent: "lui",
    })).json()) as { id: string };

    // 생성=peer 진입 시점에 peer 1명(랜덤) 배정.
    const peerTasks = db.prepare(
      "SELECT owner, status FROM proposal_followup_task WHERE proposal_id = ? AND status LIKE 'peer_review:%' ORDER BY owner",
    ).all(id) as { owner: string; status: string }[];
    expect(peerTasks).toHaveLength(1); // 새 모델: peer 1명(랜덤)
    expect(peerTasks[0]!.owner).not.toBe("lui"); // 제안자 제외
    expect(peerTasks[0]!.owner).toBeTruthy();
  });

  test("peer reviewer 는 제안자만 배제하고 나머지 팀원(gd/bill/codex 포함)은 가능하다", async () => {
    const { app, db } = setup();
    seedAgent(db, "lui");
    for (const id of ["demis", "devon"]) {
      db.prepare("INSERT INTO agent_status (agent_id, state) VALUES (?, 'blocked')").run(id);
    }
    const { id } = (await (await create(app, {
      proposer_agent: "lui",
      author_agent: "lui",
      title: "[skill] eligible peer reviewer",
    })).json()) as { id: string };

    // 생성=peer 진입. demis/devon blocked · lui 제안자 → 후보 = bill/codex/steve/gd 중 랜덤 1
    const peerTasks = db.prepare(
      "SELECT owner FROM proposal_followup_task WHERE proposal_id = ? AND status LIKE 'peer_review:%' ORDER BY owner",
    ).all(id) as { owner: string }[];
    expect(peerTasks).toHaveLength(1);
    expect(["bill", "codex", "steve", "gd"]).toContain(peerTasks[0]!.owner);
    // 제안자 lui 는 리뷰 불가, gd는 팀원이라면 리뷰 가능
    expect((await review(app, id, { reviewer_agent: "lui", verdict: "concern", is_adversarial: true })).status).toBe(400);
    expect((await review(app, id, { reviewer_agent: "gd", verdict: "concern", is_adversarial: true })).status).toBe(201);
    expect(statusOf(db, id)).toBe("gd_report");
  });

  test("gd_report 결정 요청 알림은 팀그룹이 아니라 owner_chat_id 팀장 DM으로 보낸다", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: { chat_id?: string; text?: string } }> = [];
    process.env.CAPTURE_BOT_TOKEN = "123456:test-token";
    process.env.CAPTURE_GROUP_ID = "-1009999999999";
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const { app, db } = setup();
      db.prepare("INSERT INTO setting (key, value) VALUES ('owner_chat_id', '1000000001')").run();
      const { id } = (await (await create(app)).json()) as { id: string };
      expect((await review(app, id, { reviewer_agent: "steve", verdict: "approve", is_adversarial: true })).status).toBe(201);
      await Bun.sleep(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/bot123456:test-token/sendMessage");
      expect(calls[0]!.body.chat_id).toBe("1000000001");
      expect(calls[0]!.body.chat_id).not.toBe("-1009999999999");
      expect(calls[0]!.body.text).toContain("[Proposal 팀장 결정 요청]");
      expect(calls[0]!.body.text).toContain("제안자: codex");
      expect(calls[0]!.body.text).toContain("한줄 요약: 웹툰 생성 자동화 스킬 후보");
      expect(calls[0]!.body.text).toContain(id);
      expect(calls[0]!.body.text).toContain("steve(approve)[의무 반대리뷰]");
      expect(calls[0]!.body.text).not.toContain("steve(approve)⚠반대");
      const audit = db.prepare(
        "SELECT detail_json FROM audit_event WHERE target = ? AND action = 'gd_report_notice_sent'",
      ).get(id) as { detail_json: string } | undefined;
      expect(audit).toBeTruthy();
      expect(JSON.parse(audit!.detail_json).message_id).toBe(42);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("gd_report 결정 요청의 한줄 요약은 공백을 정리하고 160자로 제한한다", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ body: { text?: string } }> = [];
    process.env.CAPTURE_BOT_TOKEN = "123456:test-token";
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 43 } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const { app, db } = setup();
      db.prepare("INSERT INTO setting (key, value) VALUES ('owner_chat_id', '1000000001')").run();
      const summary = `첫 줄\n  ${"긴 요약 ".repeat(40)}`;
      const { id } = (await (await create(app, { summary })).json()) as { id: string };
      expect((await review(app, id, { reviewer_agent: "steve", verdict: "approve", is_adversarial: true })).status).toBe(201);
      await Bun.sleep(0);
      const summaryLine = calls[0]!.body.text!.split("\n").find((line) => line.startsWith("한줄 요약: "))!;
      expect(summaryLine).not.toContain("  ");
      expect(summaryLine.slice("한줄 요약: ".length)).toHaveLength(160);
      expect(summaryLine).toEndWith("...");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("gd_report 결정 요청 알림 전송 실패 시 notice claim을 해제해 재시도 가능하게 한다", async () => {
    const originalFetch = globalThis.fetch;
    process.env.CAPTURE_BOT_TOKEN = "123456:test-token";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: "telegram down" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const { app, db } = setup();
      db.prepare("INSERT INTO setting (key, value) VALUES ('owner_chat_id', '1000000001')").run();
      const { id } = (await (await create(app)).json()) as { id: string };
      expect((await review(app, id, { reviewer_agent: "steve", verdict: "approve" })).status).toBe(201);
      await Bun.sleep(0);
      const row = db.prepare(
        "SELECT 1 FROM proposal_automation_action WHERE proposal_id = ? AND kind = 'gd_report_notice'",
      ).get(id);
      expect(row).toBeFalsy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("gd_report 결정 요청 알림 성공 후 audit 실패는 notice claim을 유지해 중복 발송을 막는다", async () => {
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const calls: Array<{ body: { chat_id?: string; text?: string } }> = [];
    process.env.CAPTURE_BOT_TOKEN = "123456:test-token";
    try {
      const { app, db } = setup();
      console.error = (() => {}) as typeof console.error;
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body ?? "{}")) });
        return {
          status: 200,
          json: async () => {
            db.prepare("DROP TABLE audit_event").run();
            return { ok: true, result: { message_id: 42 } };
          },
        } as Response;
      }) as typeof fetch;
      db.prepare("INSERT INTO setting (key, value) VALUES ('owner_chat_id', '1000000001')").run();
      const { id } = (await (await create(app)).json()) as { id: string };
      expect((await review(app, id, { reviewer_agent: "steve", verdict: "approve" })).status).toBe(201);
      await Bun.sleep(0);
      expect(calls).toHaveLength(1);
      const row = db.prepare(
        "SELECT 1 FROM proposal_automation_action WHERE proposal_id = ? AND kind = 'gd_report_notice'",
      ).get(id);
      expect(row).toBeTruthy();
    } finally {
      console.error = originalConsoleError;
      globalThis.fetch = originalFetch;
    }
  });

  // GD 2026-07-10: 팀장 결정 단계는 승인/반려 2택. gd_report→revise_requested 경로 자체를 없앴다.
  //   따라서 "팀장이 수정요청으로 gd_report를 떠난다"는 시나리오는 더 이상 존재하지 않는다.
  //   이 테스트는 그 자리를 지키되, 검증 대상을 새 불변식으로 바꾼다: 거부되고, 알림 claim 은 유지된다.
  test("팀장 결정 단계에서 수정요청은 거부되고(409), 팀장보고 알림 claim 은 리셋되지 않는다", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ body: { chat_id?: string; text?: string } }> = [];
    process.env.CAPTURE_BOT_TOKEN = "123456:test-token";
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + calls.length } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const { app, db } = setup();
      db.prepare("INSERT INTO setting (key, value) VALUES ('owner_chat_id', '1000000001')").run();
      const { id } = (await (await create(app)).json()) as { id: string };
      expect((await review(app, id, { reviewer_agent: "steve", verdict: "approve" })).status).toBe(201);
      await Bun.sleep(0);
      expect(calls).toHaveLength(1);
      expect(db.prepare(
        "SELECT COUNT(*) AS c FROM proposal_automation_action WHERE proposal_id = ? AND kind = 'gd_report_notice'",
      ).get(id) as { c: number }).toEqual({ c: 1 });

      // 팀장이 수정요청을 시도해도 상태기계가 막는다(승인/반려 2택).
      const revise = await transition(app, id, "revise_requested", "gd", { comment: "수정 후 재상정" });
      expect(revise.status).toBe(409);
      expect(db.prepare("SELECT status FROM proposal WHERE id = ?").get(id) as { status: string }).toEqual({ status: "gd_report" });

      // 거부됐으니 알림 claim 은 그대로 1건 — 리셋도, 중복 발송도 없다.
      const afterReject = db.prepare(
        "SELECT COUNT(*) AS c FROM proposal_automation_action WHERE proposal_id = ? AND kind = 'gd_report_notice'",
      ).get(id) as { c: number };
      expect(afterReject.c).toBe(1);
      expect(calls).toHaveLength(1);

      const audits = db.prepare(
        "SELECT action FROM audit_event WHERE target = ? AND action IN ('gd_report_notice_reset_for_revision','gd_report_notice_sent') ORDER BY id",
      ).all(id) as { action: string }[];
      expect(audits.map((r) => r.action)).not.toContain("gd_report_notice_reset_for_revision");
      expect(audits.filter((r) => r.action === "gd_report_notice_sent")).toHaveLength(1);

      // 팀장 결정은 승인/반려만 가능하다.
      expect((await transition(app, id, "accepted", "gd")).status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("follow-up task는 같은 상태에서 중복 생성하지 않는다", async () => {
    const { app, db, id } = await fresh();
    await transition(app, id, "peer_review", "codex");
    const before = db.prepare("SELECT COUNT(*) AS c FROM task WHERE description LIKE ?").get(`%proposal:${id} status:peer_review%`) as { c: number };
    const r = await transition(app, id, "gd_report", "bill", { emergency_override: true });
    expect(r.status).toBe(200);
    // 같은 상태 재호출이 아니라 다음 상태 task는 새로 생기되, peer_review task는 팀 규모 기준 2개만 유지된다.
    const after = db.prepare("SELECT COUNT(*) AS c FROM task WHERE description LIKE ?").get(`%proposal:${id} status:peer_review%`) as { c: number };
    expect(before.c).toBe(1); // 새 모델: peer 1명
    expect(after.c).toBe(1);
  });

  test("생성 시 follow-up wake 실패하면 create+자동전이 전체 rollback (proposal 미생성)", async () => {
    const s = setup();
    // wake 메시지 수신자 삽입을 실패시키는 트리거를 create 전에 설치.
    s.db.exec(`
      CREATE TRIGGER fail_proposal_followup_recipient
      BEFORE INSERT ON message_recipient
      BEGIN
        SELECT RAISE(ABORT, 'forced recipient failure');
      END;
    `);
    const r = await create(s.app);
    expect(r.status).toBe(500); // 트랜잭션 안에서 wake 실패 → 500
    // 트랜잭션 롤백: proposal·task 자체가 남지 않는다.
    const cnt = s.db.prepare("SELECT COUNT(*) AS c FROM proposal").get() as { c: number };
    expect(cnt.c).toBe(0);
    const cards = s.db.prepare("SELECT COUNT(*) AS c FROM task").get() as { c: number };
    expect(cards.c).toBe(0);
  });

  test("revise_requested는 제안자에게 돌아가고 재상정 시 이전 follow-up을 닫은 뒤 새 리뷰 루프를 만든다", async () => {
    const { app, db, id } = await fresh();
    await transition(app, id, "peer_review", "codex");
    // 수정요청은 리뷰어 단계에서만 발생한다(팀장 단계는 승인/반려 2택 — GD 2026-07-10).
    const revise = await transition(app, id, "revise_requested", "steve");
    expect(revise.status).toBe(200);
    const reviseBody = (await revise.json()) as { followup?: { owner?: string; taskId?: string } };
    expect(reviseBody.followup?.owner).toBe("codex");

    const peerTasksAfterRevise = db.prepare(
      `SELECT COUNT(*) AS c
         FROM task t
         JOIN proposal_followup_task pft ON pft.task_id = t.id
        WHERE pft.proposal_id = ? AND pft.status LIKE 'peer_review:%' AND t.lane = 'done'`,
    ).get(id) as { c: number };
    expect(peerTasksAfterRevise.c).toBe(1); // 새 모델: peer 1명

    const draft = await transition(app, id, "draft", "codex");
    expect(draft.status).toBe(200);
    const draftBody = (await draft.json()) as { followup?: { owner?: string; taskId?: string } };
    expect(draftBody.followup?.owner).toBe("codex");
    const reviseTaskDone = db.prepare("SELECT COUNT(*) AS c FROM task WHERE lane = 'done' AND description LIKE ?").get(`%proposal:${id} status:revise_requested%`) as { c: number };
    expect(reviseTaskDone.c).toBe(2); // proposer(codex) + coordinator watch(bill) 둘 다 닫힘
    const openDraftTasks = db.prepare("SELECT COUNT(*) AS c FROM task WHERE lane != 'done' AND description LIKE ?").get(`%proposal:${id} status:draft%`) as { c: number };
    expect(openDraftTasks.c).toBe(1);

    const rerun = await transition(app, id, "peer_review", "codex");
    expect(rerun.status).toBe(200);
    const rerunBody = (await rerun.json()) as { followup?: { owner?: string; taskId?: string; skipped?: boolean } };
    expect(rerunBody.followup?.skipped).toBeUndefined();
    expect(rerunBody.followup?.taskId).toBeTruthy();
    const openPeerTasks = db.prepare(
      `SELECT COUNT(*) AS c
         FROM task t
         JOIN proposal_followup_task pft ON pft.task_id = t.id
        WHERE pft.proposal_id = ? AND pft.status LIKE 'peer_review:%' AND t.lane != 'done'`,
    ).get(id) as { c: number };
    expect(openPeerTasks.c).toBe(1); // 새 모델: peer 1명
    const draftTasksDone = db.prepare("SELECT COUNT(*) AS c FROM task WHERE lane = 'done' AND description LIKE ?").get(`%proposal:${id} status:draft%`) as { c: number };
    expect(draftTasksDone.c).toBe(1);
  });

  test("revise_requested→draft escape: proposer 무응답 시 coordinator가 emergency_override로 대리 전이", async () => {
    // (a) 대리 actor + emergency_override → 200 & decision_log action="transition(emergency_override)"
    const a = await reviseRequested("devon");
    expect((await transition(a.app, a.id, "draft", "bill", { emergency_override: true })).status).toBe(200);
    const log = a.db.prepare(
      "SELECT action FROM proposal_decision_log WHERE proposal_id = ? AND to_status = 'draft' ORDER BY id DESC LIMIT 1",
    ).get(a.id) as { action: string };
    expect(log.action).toBe("transition(emergency_override)");

    // (b) override 없이 비-proposer → 409 (proposer 아님)
    const b = await reviseRequested("devon");
    expect((await transition(b.app, b.id, "draft", "codex")).status).toBe(409);

    // (c) emergency_override는 coordinator/GD만 가능. 일반 팀원은 거부.
    const c = await reviseRequested("devon");
    expect((await transition(c.app, c.id, "draft", "steve", { emergency_override: true })).status).toBe(409);

    // (d) proposer 본인(devon)은 override 없이도 200 (정상 경로 유지)
    const d = await reviseRequested("devon");
    expect((await transition(d.app, d.id, "draft", "devon")).status).toBe(200);
  });

  test("revise_requested 진입 시 proposer + coordinator 둘 다 알림(comma-join 금지), proposer===coordinator면 1건", async () => {
    // coordinator = capability 보유자(실 레지스트리 = bill). proposer=devon → 2건(devon + bill:coordinator)
    const x = await reviseRequested("devon");
    const xTasks = x.db.prepare(
      "SELECT owner, status FROM proposal_followup_task WHERE proposal_id = ? AND status LIKE 'revise_requested%' AND closed_at IS NULL ORDER BY owner",
    ).all(x.id) as { owner: string; status: string }[];
    expect(xTasks.length).toBe(2);
    expect(xTasks.map((t) => t.owner)).toEqual(["bill", "devon"]);
    expect(xTasks.some((t) => t.status === "revise_requested:coordinator" && t.owner === "bill")).toBe(true);

    // proposer=bill(=coordinator) → 1건(dedup, 회귀 보호)
    const y = await reviseRequested("bill");
    const yTasks = y.db.prepare(
      "SELECT owner, status FROM proposal_followup_task WHERE proposal_id = ? AND status LIKE 'revise_requested%' AND closed_at IS NULL",
    ).all(y.id) as { owner: string; status: string }[];
    expect(yTasks.length).toBe(1);
    expect(yTasks[0]!.owner).toBe("bill");
  });

  test("peer review 등록 = gd_report 자동전이 + report owner 배정 + 이전 peer 카드 닫힘", async () => {
    const { app, db, id, followup } = await fresh();
    const peerTaskId = followup!.taskId!;
    const r = await review(app, id, {
      stage: "peer",
      verdict: "concern",
      is_adversarial: true,
      required_changes: "v5 evidence 확인 후 팀장 판단 필요",
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { auto_advanced?: boolean; followup?: { owner?: string; taskId?: string; messageId?: string } };
    expect(body.auto_advanced).toBe(true);
    expect(statusOf(db, id)).toBe("gd_report"); // review 1건 = 자동 gd_report 전이
    // report owner 자동 배정(coordinator 우선 = bill)
    expect(["bill", "codex"]).toContain(body.followup?.owner ?? "");
    expect(body.followup?.taskId).toBeTruthy();
    expect(body.followup?.messageId).toBeTruthy();
    const reportTask = db.prepare("SELECT lane, owner, description FROM task WHERE id = ?").get(body.followup!.taskId!) as {
      lane: string; owner: string; description: string;
    };
    expect(reportTask.lane).toBe("doing");
    expect(reportTask.description).toContain(`proposal:${id} status:gd_report`);
    // 이전 peer 카드는 자동으로 닫힌다
    const peerClosed = db.prepare("SELECT lane FROM task WHERE id = ?").get(peerTaskId) as { lane: string };
    const peerLink = db.prepare("SELECT closed_at FROM proposal_followup_task WHERE task_id = ?").get(peerTaskId) as { closed_at: string | null };
    expect(peerClosed.lane).toBe("done");
    expect(peerLink.closed_at).toBeTruthy();
  });

  test("follow-up 종료는 task.description marker 손상과 복사에 영향받지 않는다", async () => {
    const { app, db, id, followup } = await fresh();
    const taskId = followup!.taskId!;
    db.prepare("UPDATE task SET description = ? WHERE id = ?").run("owner-edited description without marker", taskId);
    db.prepare(
      `INSERT INTO task (id, title, lane, owner, description, sort_order)
       VALUES ('copied-marker', 'copied marker', 'doing', 'bill', ?, 99)`,
    ).run(`proposal:${id} status:peer_review`);

    await onePeerReview(app, id); // review → 자동 gd_report 전이 → 이전 peer 카드 닫힘
    const original = db.prepare("SELECT lane FROM task WHERE id = ?").get(taskId) as { lane: string };
    const copied = db.prepare("SELECT lane FROM task WHERE id = 'copied-marker'").get() as { lane: string };
    const link = db.prepare("SELECT closed_at FROM proposal_followup_task WHERE task_id = ?").get(taskId) as { closed_at: string | null };
    expect(original.lane).toBe("done");
    expect(copied.lane).toBe("doing");
    expect(link.closed_at).toBeTruthy();
  });

  test("terminal transition은 이전 gd_report follow-up을 닫는다", async () => {
    const { app, db, id } = await fresh();
    await transition(app, id, "peer_review", "codex");
    await onePeerReview(app, id);
    const openBefore = db.prepare(
      "SELECT COUNT(*) AS c FROM proposal_followup_task WHERE proposal_id = ? AND status = 'gd_report' AND closed_at IS NULL",
    ).get(id) as { c: number };
    expect(openBefore.c).toBe(1);

    const done = await transition(app, id, "accepted", "gd");
    expect(done.status).toBe(200);
    const openAfter = db.prepare(
      "SELECT COUNT(*) AS c FROM proposal_followup_task WHERE proposal_id = ? AND status = 'gd_report' AND closed_at IS NULL",
    ).get(id) as { c: number };
    const doneTasks = db.prepare(
      `SELECT COUNT(*) AS c
         FROM task t
         JOIN proposal_followup_task pft ON pft.task_id = t.id
        WHERE pft.proposal_id = ? AND pft.status = 'gd_report' AND t.lane = 'done'`,
    ).get(id) as { c: number };
    expect(openAfter.c).toBe(0);
    expect(doneTasks.c).toBe(1);
  });

  test("GD 최종 결정 코멘트는 Codex와 제안자 칸반/알림으로 전달된다", async () => {
    // 운영처럼 CAPTURE_GROUP_ID가 설정돼도 후속 알림은 direct_to_gd 보고가 아니라
    // 각 owner를 깨우는 directed 메시지여야 한다.
    process.env.CAPTURE_GROUP_ID = "-1009999999999";
    const s = setup();
    const { app, db } = s;
    const { id } = (await (await create(app, { proposer_agent: "devon" })).json()) as { id: string };
    await transition(app, id, "peer_review", "devon");
    await onePeerReview(app, id);

    const comment = "승인. 적용 전 Claude 런타임 경로만 최신화할 것.";
    const done = await transition(app, id, "accepted", "gd", { comment });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { notices?: { owner: string; taskId?: string; messageId?: string }[] };
    expect(body.notices?.map((n) => n.owner).sort()).toEqual(["codex", "devon"]);
    for (const owner of ["codex", "devon"]) {
      const task = db.prepare(
        `SELECT title, lane, owner, description
           FROM task
          WHERE owner = ? AND description LIKE ? AND description LIKE ?
          ORDER BY created_at DESC
          LIMIT 1`,
      ).get(owner, `%proposal:${id} status:gd_decision:accepted%`, `%${comment}%`) as {
        title: string; lane: string; owner: string; description: string;
      };
      expect(task.owner).toBe(owner);
      expect(task.lane).toBe("doing"); // accepted: codex(closure) + 제안자(실행 전 컨펌 트리거) 둘 다 doing
      expect(task.title).toContain("팀장 승인");
      expect(task.description).toContain(comment);
      expect(task.description).toContain("Skill Workshop live 적용 지시가 아닙니다");
      expect(task.description).toContain("skill_workshop apply/reject/quarantine 호출 금지");
      if (owner === "codex") {
        expect(task.description).toContain("팀장-visible closure report");
      }
      const msg = db.prepare(
        `SELECT m.body, m.meta_json, mr.delivery_state
           FROM message m
           JOIN message_recipient mr ON mr.message_id = m.id AND mr.agent_id = m.to_agent_id
          WHERE to_agent_id = ? AND body LIKE ?
          ORDER BY created_at DESC
          LIMIT 1`,
      ).get(owner, `%${comment}%`) as { body: string; meta_json: string | null; delivery_state: string };
      expect(msg.body).toContain("Proposal 팀장 결정 알림");
      expect(msg.body).toContain(comment);
      expect(msg.body).toContain("Skill Workshop live 적용 지시가 아닙니다");
      expect(msg.body).toContain("skill_workshop apply/reject/quarantine 호출 금지");
      expect(msg.meta_json).toBeNull();
      expect(msg.delivery_state).toBe("pending");
      if (owner === "codex") {
        expect(msg.body).toContain("팀장에게 짧게 최종 처리 결과를 보고");
      }
    }
    const proposerFollowup = db.prepare(
      `SELECT closed_at
         FROM proposal_followup_task
        WHERE proposal_id = ? AND status = ?`,
    ).get(id, "gd_decision:accepted:devon") as { closed_at: string | null };
    expect(proposerFollowup.closed_at).toBeNull(); // 제안자 카드는 컨펌 트리거로 열려 있다(doing)
    const openDecisionTasks = db.prepare(
      `SELECT COUNT(*) AS c
         FROM task
        WHERE lane != 'done'
          AND description LIKE ?`,
    ).get(`%proposal:${id} status:gd_decision:%`) as { c: number };
    expect(openDecisionTasks.c).toBe(2); // codex(closure) + 제안자(실행 전 컨펌) 둘 다 열림
  });

  test("DELETE /proposals/:id는 실제 삭제 대신 보관하고 기본 목록에서 숨기며 열린 follow-up을 닫는다", async () => {
    const { app, db, id } = await fresh();
    await transition(app, id, "peer_review", "codex");
    const openBefore = db.prepare(
      "SELECT COUNT(*) AS c FROM proposal_followup_task WHERE proposal_id = ? AND closed_at IS NULL",
    ).get(id) as { c: number };
    expect(openBefore.c).toBe(1); // 새 모델: peer 1명

    const del = await app.request(`/proposals/${id}`, {
      method: "DELETE",
      body: JSON.stringify({
        actor: "gd",
        reason: "테스트 proposal 목록 정리",
      }),
      headers: { "content-type": "application/json", "x-op-token": OP_TOKEN, "x-actor-id": "gd" },
    });

    expect(del.status).toBe(200);
    const proposal = db.prepare("SELECT status FROM proposal WHERE id = ?").get(id) as { status: string };
    expect(proposal.status).toBe("archived_duplicate");
    const list = (await (await app.request("/proposals")).json()) as { proposals: { id: string }[] };
    expect(list.proposals.map((p) => p.id)).not.toContain(id);
    const archived = (await (await app.request("/proposals?status=archived_duplicate")).json()) as { proposals: { id: string }[] };
    expect(archived.proposals.map((p) => p.id)).toContain(id);
    const openAfter = db.prepare(
      "SELECT COUNT(*) AS c FROM proposal_followup_task WHERE proposal_id = ? AND closed_at IS NULL",
    ).get(id) as { c: number };
    const doneTasks = db.prepare(
      `SELECT COUNT(*) AS c
         FROM task t
         JOIN proposal_followup_task pft ON pft.task_id = t.id
        WHERE pft.proposal_id = ? AND t.lane = 'done'`,
    ).get(id) as { c: number };
    expect(openAfter.c).toBe(0);
    expect(doneTasks.c).toBe(1); // 새 모델: peer 1명
    const log = db.prepare(
      "SELECT action, from_status, to_status, reason FROM proposal_decision_log WHERE proposal_id = ? ORDER BY id DESC LIMIT 1",
    ).get(id) as { action: string; from_status: string; to_status: string; reason: string };
    expect(log.action).toBe("archive");
    expect(log.from_status).toBe("peer_review");
    expect(log.to_status).toBe("archived_duplicate");
    expect(log.reason).toContain("테스트 proposal 목록 정리");
  });

  test("Guard P: draft→review 전이는 proposer_agent(또는 system)만 가능", async () => {
    const { app, id } = await fresh(); // 생성=peer_review
    // revise→draft 로 draft 상태를 만든 뒤 Guard P 검증(사람이 남의 draft 가로채기 방지).
    expect((await transition(app, id, "revise_requested", "codex")).status).toBe(200);
    expect((await transition(app, id, "draft", "bill")).status).toBe(409); // proposer 아님
    expect((await transition(app, id, "draft", "codex")).status).toBe(200); // proposer OK
    expect((await transition(app, id, "peer_review", "bill")).status).toBe(409); // proposer 아님
    expect((await transition(app, id, "peer_review", "codex")).status).toBe(200); // proposer OK
  });

  test("Guard A: review 없이 peer_review→gd_report = 409 (팀장보고 전 review 필수)", async () => {
    const { app, id } = await fresh();
    await transition(app, id, "peer_review", "codex");
    const r = await transition(app, id, "gd_report", "bill"); // review 0
    expect(r.status).toBe(409);
  });

  test("Guard A2: peer review 1건이면 gd_report 자동전이", async () => {
    const { app, db, id } = await fresh(); // 생성=peer_review
    const r = await review(app, id, { reviewer_agent: "steve", verdict: "concern", is_adversarial: true });
    expect(r.status).toBe(201);
    expect(statusOf(db, id)).toBe("gd_report"); // review 1건 = 자동 전이
  });

  test("Guard A 우회: emergency_override=true면 통과", async () => {
    const { app, id } = await fresh();
    await transition(app, id, "peer_review", "codex");
    const r = await transition(app, id, "gd_report", "bill", { emergency_override: true });
    expect(r.status).toBe(200);
  });

  test("Guard C: legacy pm_review row는 PM review 1건 없으면 gd_report 금지", async () => {
    const { app, db } = setup();
    const id = createProposalForLegacyPm(db);
    const r = await transition(app, id, "gd_report", "codex");
    expect(r.status).toBe(409);
  });

  test("Guard B: 최종 accepted를 비-GD actor가 하면 409", async () => {
    const { app, id } = await fresh();
    await transition(app, id, "peer_review", "codex");
    await onePeerReview(app, id);
    const r = await transition(app, id, "accepted", "codex"); // GD 아님
    expect(r.status).toBe(409);
  });

  test("invalid transition: draft→accepted 직행 = 409", async () => {
    const { app, id } = await fresh();
    const r = await transition(app, id, "accepted", "gd");
    expect(r.status).toBe(409);
  });
});

// ── GD 심플 모델: 팀 크기별 라우팅 (2026-07-01) ──────────────────────────
// 하드코딩 codex/bill 제거 검증 — 팀 크기 + capability 도출, 공개 팀(임의 멤버)에서도 유령배정 없이 동작.
// GD 지시 시나리오: 1/2/3+명 흐름 · 중간 드랍 · 최종 승인/리젝/수정요청 재인입.
function agentRec(id: string, capabilities: string[] = []): AgentRecord {
  return { id, display_name: id, role: "role", runtime: "claude_channel", capabilities } as AgentRecord;
}
function setupTeam(ids: string[], opts: { coordinator?: string } = {}) {
  const db = new Database(":memory:");
  migrate(db);
  for (const id of ids) seedAgent(db, id);
  const records = ids.map((id) => agentRec(id, opts.coordinator === id ? ["coordinator"] : []));
  return { app: createProposalRoutes({ db, agents: () => records }), db };
}
async function createBy(app: ReturnType<typeof setup>["app"], proposer: string): Promise<string> {
  const r = await create(app, { proposer_agent: proposer, author_agent: proposer });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
function statusOf(db: Database, id: string): string {
  return (db.prepare("SELECT status FROM proposal WHERE id = ?").get(id) as { status: string }).status;
}
const pmReview = (app: ReturnType<typeof setup>["app"], id: string, reviewer: string, verdict = "approve") =>
  app.request(`/proposals/${id}/reviews`, json({ reviewer_agent: reviewer, stage: "pm", verdict }, reviewer));
const peerReview = (app: ReturnType<typeof setup>["app"], id: string, reviewer: string) =>
  app.request(`/proposals/${id}/reviews`, json({ reviewer_agent: reviewer, stage: "peer", verdict: "concern", is_adversarial: true }, reviewer));

describe("proposals — test fixture gate", () => {
  test("sweeper는 title/source test fixture proposal을 진행·재배정하지 않는다", async () => {
    const { app, db } = setupTeam(["codex", "bill", "steve"], { coordinator: "bill" });
    const r = await create(app, {
      title: "[skill] stale smoke proposal",
      source: "smoke:e2e:distinct-proposers",
      proposer_agent: "codex",
      author_agent: "codex",
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    db.prepare("UPDATE proposal SET updated_at = datetime('now', '-2 hours') WHERE id = ?").run(id);

    const out = sweepStaleProposals(db, [agentRec("codex"), agentRec("bill", ["coordinator"]), agentRec("steve")], {
      staleMinutes: 30,
      limit: 10,
    });
    expect(out).toEqual({ advanced: [], reassigned: [], degraded: [] });
    expect(statusOf(db, id)).toBe("peer_review");
    const openTasks = db.prepare(
      "SELECT COUNT(*) AS c FROM proposal_followup_task WHERE proposal_id = ? AND closed_at IS NULL",
    ).get(id) as { c: number };
    expect(openTasks.c).toBe(0);
  });
});

describe("proposals — GD 심플 모델 (팀 크기별 라우팅)", () => {
  test("1인 팀: draft → gd_report 직행 → 팀장(gd) accepted", async () => {
    const { app, db } = setupTeam(["alice"], { coordinator: "alice" });
    const id = await createBy(app, "alice");
    expect(statusOf(db, id)).toBe("gd_report"); // 1인 팀 = 생성 즉시 gd_report 직행
    expect((await transition(app, id, "accepted", "alice")).status).toBe(409); // 비-팀장 불가
    expect((await transition(app, id, "accepted", "gd")).status).toBe(200);
    expect(statusOf(db, id)).toBe("accepted");
  });

  test("LEAD_ACTOR_ID 설정은 리뷰 후보 계산에 관여하지 않는다", async () => {
    process.env.LEAD_ACTOR_ID = "lead";
    const { app, db } = setupTeam(["lead", "alice", "bob"], { coordinator: "bob" });
    const id = await createBy(app, "alice");
    expect(statusOf(db, id)).toBe("peer_review"); // 제안자 제외 → lead/bob 둘 다 후보

    const owners = db.prepare(
      "SELECT DISTINCT owner FROM proposal_followup_task WHERE proposal_id = ?",
    ).all(id) as { owner: string }[];
    expect(owners.map((r) => r.owner)).toHaveLength(1);
    expect(["lead", "bob"]).toContain(owners[0]!.owner);
    expect((await peerReview(app, id, "lead")).status).toBe(201);
  });

  // 1인 팀은 peer_review 단계가 없어(others=0 → 바로 gd_report) revise_requested 에 도달할 경로가 없다.
  //   팀장은 승인/반려만 한다. 고칠 게 있으면 반려 후 새 proposal 로 올린다. (GD 2026-07-10)
  test("1인 팀: 팀장 결정은 승인/반려 2택 — 수정요청 경로가 없다", async () => {
    const { app, db } = setupTeam(["alice"], { coordinator: "alice" });
    const id = await createBy(app, "alice");
    await transition(app, id, "gd_report", "alice");
    expect((await transition(app, id, "revise_requested", "gd")).status).toBe(409);
    expect(statusOf(db, id)).toBe("gd_report");
    expect((await transition(app, id, "rejected", "gd")).status).toBe(200);
    expect(statusOf(db, id)).toBe("rejected");
  });

  test("2인 팀: draft → peer_review(다른 1명) → gd_report → accepted", async () => {
    const { app, db } = setupTeam(["alice", "bob"], { coordinator: "bob" });
    const id = await createBy(app, "alice");
    expect(statusOf(db, id)).toBe("peer_review"); // 2인 팀 = 단일 review
    expect((await peerReview(app, id, "bob")).status).toBe(201); // review = 자동 gd_report 전이
    expect(statusOf(db, id)).toBe("gd_report");
    expect((await transition(app, id, "accepted", "gd")).status).toBe(200);
    expect(statusOf(db, id)).toBe("accepted");
  });

  // 2인 팀은 리뷰어(bob)가 peer_review 단계에서 수정요청을 낸다. 팀장 단계에서는 못 낸다.
  test("2인 팀: 리뷰어 수정요청 → 다시 peer_review 재인입 (팀장 단계에선 수정요청 불가)", async () => {
    const { app, db } = setupTeam(["alice", "bob"], { coordinator: "bob" });
    const id = await createBy(app, "alice");
    expect(statusOf(db, id)).toBe("peer_review");
    expect((await transition(app, id, "revise_requested", "bob")).status).toBe(200);
    expect((await transition(app, id, "peer_review", "alice")).status).toBe(200); // others=1 → peer_review
    expect(statusOf(db, id)).toBe("peer_review");

    // 리뷰 등록 → 자동 gd_report. 여기서는 수정요청이 막힌다.
    expect((await peerReview(app, id, "bob")).status).toBe(201);
    expect(statusOf(db, id)).toBe("gd_report");
    expect((await transition(app, id, "revise_requested", "gd")).status).toBe(409);
  });

  test("3인 팀: draft → peer(랜덤 1) → gd_report → accepted", async () => {
    const { app, db } = setupTeam(["alice", "bob", "carol"], { coordinator: "bob" });
    const id = await createBy(app, "alice");
    expect(statusOf(db, id)).toBe("peer_review"); // 3인 팀 = peer 직행
    expect((await peerReview(app, id, "carol")).status).toBe(201); // review → 자동 gd_report
    expect(statusOf(db, id)).toBe("gd_report");
    expect((await transition(app, id, "accepted", "gd")).status).toBe(200);
    expect(statusOf(db, id)).toBe("accepted");
  });

  test("3인 팀: 수정요청 → 다시 peer_review 재인입", async () => {
    const { app, db } = setupTeam(["alice", "bob", "carol"], { coordinator: "bob" });
    const id = await createBy(app, "alice");
    await transition(app, id, "peer_review", "alice");
    expect((await transition(app, id, "revise_requested", "bob")).status).toBe(200);
    expect((await transition(app, id, "peer_review", "alice")).status).toBe(200); // others=2 → peer_review
    expect(statusOf(db, id)).toBe("peer_review");
  });

  test("중간 드랍: 리뷰 중 rejected 는 terminal(재오픈 불가)", async () => {
    const { app, db } = setupTeam(["alice", "bob", "carol"], { coordinator: "bob" });
    const id = await createBy(app, "alice");
    await transition(app, id, "peer_review", "alice");
    expect((await transition(app, id, "rejected", "bob")).status).toBe(200);
    expect(statusOf(db, id)).toBe("rejected");
    expect((await transition(app, id, "peer_review", "alice")).status).toBe(409); // terminal
  });

  test("최종 리젝: gd_report → rejected 는 팀장(gd)만", async () => {
    const { app, db } = setupTeam(["alice", "bob"], { coordinator: "bob" });
    const id = await createBy(app, "alice");
    // peer approve → 자동 gd_report.
    await peerReview(app, id, "bob");
    expect(statusOf(db, id)).toBe("gd_report");
    expect((await transition(app, id, "rejected", "bob")).status).toBe(409); // 비-팀장 불가
    expect((await transition(app, id, "rejected", "gd")).status).toBe(200); // 팀장(gd) 최종 반려
    expect(statusOf(db, id)).toBe("rejected");
  });
});

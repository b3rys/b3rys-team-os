// Team Self-Loop Governance — Proposal 시스템 db 로직 (Bill+Codex 설계 + 5명 얼라인, 2026-06-12).
//   루프=제안 생성 엔진(실행X). 가드를 데이터/로직에 강제:
//   - 품질 하한선: evidence_refs(근거)+expected_value(예상효과) 없으면 생성 거부(노이즈 차단).
//   - 전이 가드: 상태기계 밖 전이 금지(invalid transition).
//   - decision_log: 모든 전이 자동 기록(감사·되돌리기).
//   - dedup: duplicate_of / 거부된 제안은 재오픈 불가(archived/rejected는 terminal).
import type { Database } from "bun:sqlite";
import { ambientAgents } from "../lib/registry";
import { hasCapability } from "../lib/capabilities";
import { leadActorId } from "../lib/opAuth";
import { isTeamOfficialMember } from "../lib/agentMembership";

// 상태기계: draft→peer_review(단일 review)→gd_report→accepted/rejected (+revise_requested, archived_duplicate)
//   팀장 결정 단계(gd_report)는 승인/반려 2택. 수정요청은 리뷰어 단계(peer_review)에서만 발생한다.
const VALID_TRANSITIONS: Record<string, string[]> = {
  // draft 이후 첫 단계는 팀 크기로 결정(1인→gd_report·2+→peer_review). 라우팅=routes/proposals.ts.
  draft: ["peer_review", "gd_report", "archived_duplicate", "rejected"],
  peer_review: ["gd_report", "revise_requested", "rejected", "archived_duplicate"],
  // legacy drain path: 기존 DB에 남은 pm_review row는 gd_report/revise/reject로 빠져나갈 수 있게만 둔다.
  pm_review: ["gd_report", "revise_requested", "rejected"],
  // 팀장 결정은 승인/반려 둘뿐(GD 2026-07-10). 수정요청은 팀장 단계에서 제거 — 고칠 게 있으면
  //   반려하고 새로 올리게 한다(rejected는 terminal이라 재제출=새 proposal). 리뷰어 단계의
  //   revise_requested 는 그대로 둔다(peer_review→revise_requested).
  gd_report: ["accepted", "rejected"],
  // Codex 교차검토(2026-06-12): revise는 work loop 상태. 권장 경로는 →draft 하나로 좁힘.
  //   (빠른 재상정이 필요하면 draft에서 즉시 peer_review로 올리면 됨 — 품질 게이트 안 흐려지게)
  // 수정요청은 팀 크기에 맞는 첫 리뷰 단계로 재인입(1인→gd_report·2+→peer_review). draft 는 coordinator 대리 경로.
  revise_requested: ["draft", "peer_review", "gd_report"],
  accepted: [], // terminal
  rejected: [], // terminal — 재제출 금지(무한순환 차단)
  archived_duplicate: [], // terminal
};

// 자동화(sweeper·이벤트 승격)가 사람 대신 전이할 때 쓰는 actor.
// draft→review / revise_requested→draft 의 proposer-only 가드에 대한 예외로만 사용한다.
export const SYSTEM_ACTOR = "system";

export interface NewProposal {
  title: string; summary: string; proposer_agent: string;
  body?: string; author_agent?: string;
  source?: string; priority?: string; effort_minutes?: number;
  expected_value?: string; risk_level?: string; evidence_refs?: string;
  north_star_alignment?: string; duplicate_of?: string;
  type?: string; // skill/rule/task/other — 승인 후 실행 유형(미지정 시 제목 태그에서 파생).
}

export interface UpdateProposalInput {
  summary?: string;
  body?: string;
  evidence_refs?: string;
  reason?: string;
}

// 승인 후 실행 유형 도출 — 명시 type 우선, 없으면 제목 태그/키워드에서 파생.
export function deriveProposalType(p: { type?: string; title?: string }): "skill" | "rule" | "task" | "other" {
  const explicit = String(p.type ?? "").trim().toLowerCase();
  if (["skill", "rule", "task", "other"].includes(explicit)) return explicit as "skill" | "rule" | "task" | "other";
  const t = String(p.title ?? "").toLowerCase();
  if (t.includes("[skill]") || t.includes("스킬")) return "skill";
  if (t.includes("[rule]") || t.includes("team-os") || t.includes("규칙")) return "rule";
  if (t.includes("[task]") || t.includes("[workflow]") || t.includes("과제")) return "task";
  return "other";
}

export function isTestProposalTitle(title: string | null | undefined): boolean {
  return String(title ?? "").trimStart().toLowerCase().startsWith("[test]");
}

function pid(): string {
  return "prop_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
function rid(): string {
  return "rev_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function logDecision(db: Database, proposalId: string, actor: string, action: string, from: string | null, to: string | null, reason: string): void {
  db.prepare(
    `INSERT INTO proposal_decision_log (proposal_id, actor, action, from_status, to_status, reason) VALUES (?,?,?,?,?,?)`,
  ).run(proposalId, actor, action, from, to, reason);
}

// 리뷰/팀 규모 계산에서 제외할 id — 비대화(non_interactive) + 비정식 팀원(team_official_member:false).
// Forin 같은 비운영 멤버가 peer로 배정되면 wake allowlist에서 만료되어 proposal이 stuck된다.
function reviewSkipIds(): Set<string> {
  return new Set([
    ...ambientAgents()
      .filter((a) => hasCapability(a, "non_interactive") || !isTeamOfficialMember(a))
      .map((a) => a.id),
  ]);
}

// 리뷰 가능 팀원 수(비대화 제외, blocked 제외).
function activeReviewTeamSize(db: Database): number {
  const skip = reviewSkipIds();
  const rows = db.prepare(
    `SELECT a.id
       FROM agent a
       LEFT JOIN agent_status s ON s.agent_id = a.id
      WHERE COALESCE(s.state, 'idle') != 'blocked'`,
  ).all() as { id: string }[];
  return rows.filter((r) => !skip.has(r.id)).length;
}

// 제안자 제외 리뷰 후보 수(= 팀 크기 판단 기준).
function eligiblePeerReviewerCapacity(db: Database, proposer: string): number {
  const skip = reviewSkipIds();
  const rows = db.prepare(
    `SELECT a.id
       FROM agent a
       LEFT JOIN agent_status s ON s.agent_id = a.id
      WHERE a.id != ?
        AND COALESCE(s.state, 'idle') != 'blocked'`,
  ).all(proposer) as { id: string }[];
  return rows.filter((r) => !skip.has(r.id)).length;
}

// GD 심플 모델: 팀장 보고 전 review는 필수. 단, 제안자 제외 리뷰 후보가 0명이면 gd_report 직행.
function requiredPeerReviewCount(db: Database, proposer: string): number {
  return eligiblePeerReviewerCapacity(db, proposer) >= 1 ? 1 : 0;
}

// GD 모델: pm_review 는 2+ 팀(제안자 제외 후보 1명+)에서 1건 필요.
function requiredPmReviewCount(db: Database, proposer: string): number {
  return eligiblePeerReviewerCapacity(db, proposer) >= 1 ? 1 : 0;
}

function eligiblePeerReviewCount(db: Database, proposalId: string, proposer: string): number {
  const skip = reviewSkipIds();
  const rows = db.prepare(
    `SELECT DISTINCT actor AS id
       FROM proposal_decision_log
      WHERE proposal_id = ?
        AND action LIKE 'review:peer%'
        AND actor != ?
        AND id > COALESCE((
          SELECT MAX(id) FROM proposal_decision_log
           WHERE proposal_id = ? AND to_status = 'peer_review'
        ), 0)`,
  ).all(proposalId, proposer, proposalId) as { id: string }[];
  return rows.filter((r) => !skip.has(r.id)).length;
}

// 이 제안에 등록된 pm 리뷰 수(운영 리뷰 후보만 카운트 — 하드코딩 없음).
function pmReviewCount(db: Database, proposalId: string): number {
  const skip = reviewSkipIds();
  const rows = db.prepare(
    `SELECT DISTINCT actor AS id
       FROM proposal_decision_log
      WHERE proposal_id = ?
        AND action LIKE 'review:pm%'
        AND id > COALESCE((
          SELECT MAX(id) FROM proposal_decision_log
           WHERE proposal_id = ? AND to_status = 'pm_review'
        ), 0)`,
  ).all(proposalId, proposalId) as { id: string }[];
  return rows.filter((r) => !skip.has(r.id)).length;
}

/** 제안 생성 — 품질 하한선 강제(근거·예상효과 없으면 폐기). */
export function createProposal(db: Database, p: NewProposal): { ok: boolean; id?: string; error?: string } {
  // 입력 필드가 non-string(숫자·객체 등)이면 x?.trim()은 optional chaining으로 안 막히고 .trim is not a function 으로 throw됨
  // (옵셔널체이닝은 null/undefined만 단락) → String 코어션으로 안전 처리(실라이브 TypeError 픽스, Demis 2026-06-25).
  const s = (x: unknown): string => String(x ?? "").trim();
  const title = s(p.title), summary = s(p.summary), proposer = s(p.proposer_agent);
  if (!title || !summary || !proposer) {
    return { ok: false, error: "title·summary·proposer_agent 필수" };
  }
  const author = s(p.author_agent) || proposer;
  const proposerExists = db.prepare("SELECT 1 FROM agent WHERE id = ?").get(proposer);
  if (!proposerExists) {
    return { ok: false, error: `proposer_agent는 실제 팀원 id여야 함: ${proposer}` };
  }
  const authorExists = db.prepare("SELECT 1 FROM agent WHERE id = ?").get(author);
  if (!authorExists) {
    return { ok: false, error: `author_agent는 실제 팀원 id여야 함: ${author}` };
  }
  // 품질 하한선(팀 얼라인): 근거+예상효과 없으면 노이즈 → 생성 거부.
  const evidence = s(p.evidence_refs), expected = s(p.expected_value);
  if (!evidence || !expected) {
    return { ok: false, error: "품질 하한선: evidence_refs(근거)와 expected_value(예상효과)가 있어야 제안 생성(없으면 노이즈로 폐기)" };
  }
  const id = pid();
  db.prepare(
    `INSERT INTO proposal (id,title,summary,body,source,proposer_agent,author_agent,status,priority,effort_minutes,expected_value,risk_level,evidence_refs,north_star_alignment,duplicate_of,type)
     VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?)`,
  ).run(id, title, summary, s(p.body) || summary, p.source ?? "loop", proposer, author,
    p.priority ?? null, p.effort_minutes ?? null, expected, p.risk_level ?? null,
    evidence, p.north_star_alignment ?? null, p.duplicate_of ?? null, deriveProposalType(p));
  logDecision(db, id, proposer, "create", null, "draft", "제안 생성");
  return { ok: true, id };
}

/** 제안 본문 수정 — draft/revise_requested 상태에서만, 제안자/팀장만 표준 API로 수정한다. */
export function updateProposal(
  db: Database,
  id: string,
  actor: string,
  input: UpdateProposalInput,
): { ok: boolean; error?: string; updated?: string[] } {
  const row = db.prepare("SELECT status, proposer_agent FROM proposal WHERE id = ?").get(id) as { status: string; proposer_agent: string } | undefined;
  if (!row) return { ok: false, error: "unknown_proposal" };
  if (!["draft", "revise_requested"].includes(row.status)) {
    return { ok: false, error: `proposal update는 draft/revise_requested 상태에서만 가능(현재 ${row.status})` };
  }
  if (actor !== row.proposer_agent && actor !== leadActorId()) {
    return { ok: false, error: `proposal update는 proposer_agent 또는 팀장만 가능(현재 actor=${actor}, proposer=${row.proposer_agent})` };
  }

  const fields: Array<keyof Pick<UpdateProposalInput, "summary" | "body" | "evidence_refs">> = ["summary", "body", "evidence_refs"];
  const sets: string[] = [];
  const args: string[] = [];
  const updated: string[] = [];
  for (const field of fields) {
    if (input[field] === undefined) continue;
    const value = String(input[field] ?? "").trim();
    if (!value) return { ok: false, error: `${field} must be non-empty` };
    sets.push(`${field} = ?`);
    args.push(value);
    updated.push(field);
  }
  if (!sets.length) return { ok: false, error: "summary/body/evidence_refs 중 하나 이상 필요" };

  db.prepare(`UPDATE proposal SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...args, id);
  const reason = String(input.reason ?? "").trim() || `proposal fields updated: ${updated.join(",")}`;
  logDecision(db, id, actor, "update", row.status, row.status, reason);
  return { ok: true, updated };
}

/** 상태 전이 — 상태기계 밖 전이 금지 + 단계별 가드 + decision_log 자동 기록.
 *  Codex 교차검토 가드(2026-06-12):
 *   - peer→gd_report: 리뷰 1건 의무(팀장보고 전 review 생략 방지). emergency_override로만 예외(사유 기록).
 *   - gd_report→accepted/rejected: team lead actor만(감사 무결성). PM은 pm-stage 리뷰로 recommend만. */
export function transitionProposal(
  db: Database, id: string, actor: string, toStatus: string, reason: string,
  opts: { emergency_override?: boolean; expected_from?: string } = {},
): { ok: boolean; error?: string } {
  const row = db.prepare("SELECT status, proposer_agent FROM proposal WHERE id = ?").get(id) as { status: string; proposer_agent: string } | undefined;
  if (!row) return { ok: false, error: "unknown_proposal" };
  const from = row.status;
  // 자동화 경로: 호출 시점에 기대한 상태(expected_from)와 실제가 다르면 이미 다른 데서 전이된 것 → 무효.
  if (opts.expected_from && from !== opts.expected_from) {
    return { ok: false, error: `stale_transition: expected ${opts.expected_from} but is ${from}` };
  }
  if (!(VALID_TRANSITIONS[from] ?? []).includes(toStatus)) {
    return { ok: false, error: `invalid_transition: ${from} → ${toStatus} (허용: ${(VALID_TRANSITIONS[from] ?? []).join(",") || "없음(terminal)"})` };
  }

  // Guard P — 제안자 소유 전이는 proposer_agent만 수행한다.
  // draft 제출(→ 팀 크기별 첫 단계)은 항상 proposer-only(override 불가 — 아무나 제안 가로채기 방지, 적대검토 F5/F6).
  if (from === "draft" && ["peer_review", "gd_report"].includes(toStatus)) {
    // 사람: proposer 본인만(가로채기 방지). 자동화: SYSTEM_ACTOR 허용(생성=즉시 진입/sweeper 대리 제출).
    if (actor !== row.proposer_agent && actor !== SYSTEM_ACTOR) {
      return { ok: false, error: `draft → ${toStatus} 제출은 proposer_agent 또는 system만 가능(현재 actor=${actor}, proposer=${row.proposer_agent})` };
    }
  }
  // revise_requested→draft는 proposer-only이되, proposer 무응답/rate-limited 시 coordinator가
  // emergency_override로 대리 전이 가능(영구 stuck 방지). override는 이 전이로 한정, decision_log 기록.
  if (from === "revise_requested" && toStatus === "draft") {
    if (actor !== row.proposer_agent && actor !== SYSTEM_ACTOR && !opts.emergency_override) {
      return { ok: false, error: `revise_requested → draft 전이는 proposer_agent/system만 가능(현재 actor=${actor}, proposer=${row.proposer_agent}). proposer 무응답 시 coordinator가 emergency_override=true로 대리 전이.` };
    }
  }

  // Guard A — review 의무: peer_review→gd_report는 실제 peer review 1건 이상 필요.
  if (from === "peer_review" && toStatus === "gd_report" && !opts.emergency_override) {
    const requiredPeer = requiredPeerReviewCount(db, row.proposer_agent);
    const peerCount = eligiblePeerReviewCount(db, id, row.proposer_agent);
    if (peerCount < requiredPeer) {
      return { ok: false, error: `팀 규모 기준 peer review ${requiredPeer}건 필요(현재 ${peerCount}건)` };
    }
  }

  // Guard C — legacy pm_review row가 남아 있으면 기존 PM review 1건 가드를 유지한 채 gd_report로 drain한다.
  if (from === "pm_review" && toStatus === "gd_report" && !opts.emergency_override) {
    const requiredPm = requiredPmReviewCount(db, row.proposer_agent);
    const pmCount = pmReviewCount(db, id);
    if (pmCount < requiredPm) {
      return { ok: false, error: `팀 규모 기준 PM review ${requiredPm}건 필요(현재 ${pmCount}건)` };
    }
    // (하드코딩 actor==='codex' 제거 — PM review 를 남긴 담당자/coordinator 가 전이. 리뷰 존재는 pmCount 가드가 보장.)
  }

  // Guard B — 최종 승인/반려는 team lead actor만(이름만 accepted인 내부 결정과 팀장 결정 분리).
  if (from === "gd_report" && (toStatus === "accepted" || toStatus === "rejected")) {
    if (actor !== leadActorId()) {
      return { ok: false, error: `최종 ${toStatus}는 팀장만 가능(현재 actor=${actor}). PM은 pm-stage 리뷰로 recommend_accept/reject만` };
    }
  }

  // 원자 전이: 읽은 시점 상태(from)일 때만 UPDATE. 그 사이 다른 경로가 전이했으면 changes=0 → 부수효과 없이 실패.
  // (read-then-update race 차단 — sweeper와 이벤트 승격 동시 실행 대비.)
  const upd = db.prepare("UPDATE proposal SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?").run(toStatus, id, from);
  if (upd.changes !== 1) {
    return { ok: false, error: `concurrent_transition: ${id} is no longer at ${from}` };
  }
  logDecision(db, id, actor, opts.emergency_override ? "transition(emergency_override)" : "transition", from, toStatus, reason || "");
  return { ok: true };
}

/** 자동화 액션 멱등 클레임 — action_key(PK)를 선점(insert). 이미 있으면 false(중복 실행 차단).
 *  sweeper·이벤트 승격이 같은 전이를 동시에 밀어도 최초 1건만 true를 받는다. */
export function claimAutomationAction(db: Database, actionKey: string, proposalId: string, kind: string): boolean {
  try {
    const res = db.prepare(
      "INSERT INTO proposal_automation_action (action_key, proposal_id, kind) VALUES (?,?,?)",
    ).run(actionKey, proposalId, kind);
    return res.changes === 1;
  } catch {
    // UNIQUE(PK) 충돌 = 이미 실행된 액션.
    return false;
  }
}

/** 선점한 자동화 액션 키 해제 — 전이가 가드 미충족 등으로 실패했을 때 호출.
 *  (없으면 'approve 먼저→반대리뷰 나중' 순서에서 키가 소진돼 정당한 후속 전이가 막힌다. 교차검토 F1.) */
export function releaseAutomationAction(db: Database, actionKey: string): void {
  db.prepare("DELETE FROM proposal_automation_action WHERE action_key = ?").run(actionKey);
}

/** 원자·멱등 자동 전이 코어 — sweeper·이벤트 승격이 반드시 이 함수만 통해 자동 전이한다.
 *  ① actionKey 선점(멱등) → ② transitionProposal(expected_from 원자 가드) → 둘 다 통과해야 advanced=true.
 *  advanced=false면 호출부는 어떤 부수효과(배정·wake·알림)도 실행하지 않아야 한다. */
export function advanceProposalIfCurrent(
  db: Database,
  opts: {
    proposalId: string; expectedFrom: string; to: string;
    actionKey: string; kind: string;
    actor?: string; reason?: string; emergency_override?: boolean;
  },
): { ok: boolean; advanced: boolean; deduped?: boolean; error?: string } {
  if (!claimAutomationAction(db, opts.actionKey, opts.proposalId, opts.kind)) {
    return { ok: true, advanced: false, deduped: true };
  }
  const res = transitionProposal(
    db, opts.proposalId, opts.actor ?? SYSTEM_ACTOR, opts.to, opts.reason ?? `auto:${opts.kind}`,
    { emergency_override: opts.emergency_override, expected_from: opts.expectedFrom },
  );
  if (!res.ok) {
    // 가드 미충족/stale 등으로 전이 실패 → 선점한 키를 해제해 정당한 후속 시도(예: 뒤늦은 반대리뷰)를 허용한다.
    releaseAutomationAction(db, opts.actionKey);
    return { ok: false, advanced: false, error: res.error };
  }
  return { ok: true, advanced: true };
}

/** 리뷰 추가(peer/pm/gd) + decision_log. is_adversarial=반대(거수기 방지). */
export function addReview(db: Database, r: { proposal_id: string; reviewer_agent: string; stage: string; verdict?: string; is_adversarial?: boolean; comments?: string; required_changes?: string }): { ok: boolean; id?: string; error?: string } {
  if (!["peer", "pm", "gd"].includes(r.stage)) return { ok: false, error: "stage must be peer/pm/gd" };
  const proposal = db.prepare("SELECT proposer_agent, status FROM proposal WHERE id = ?").get(r.proposal_id) as { proposer_agent: string; status: string } | undefined;
  if (!proposal) return { ok: false, error: "unknown_proposal" };
  const expectedStatus = r.stage === "peer" ? "peer_review" : r.stage === "pm" ? "pm_review" : "gd_report";
  if (proposal.status !== expectedStatus) return { ok: false, error: `review stage/status mismatch: ${r.stage} requires ${expectedStatus}, current ${proposal.status}` };
  const reviewer = r.reviewer_agent.trim();
  const reviewerRow = db.prepare(
    `SELECT a.id, COALESCE(s.state, 'idle') AS state
       FROM agent a
       LEFT JOIN agent_status s ON s.agent_id = a.id
      WHERE a.id = ?`,
  ).get(reviewer) as { id: string; state: string } | undefined;
  if (!reviewerRow) return { ok: false, error: `reviewer_agent는 실제 팀원 id여야 함: ${reviewer}` };
  if (reviewerRow.state === "blocked") return { ok: false, error: `blocked reviewer는 새 리뷰를 등록할 수 없음: ${reviewer}` };
  if (r.stage === "peer" && (reviewer === proposal.proposer_agent || reviewSkipIds().has(reviewer))) {
    return { ok: false, error: `peer reviewer는 제안자/owner/비대화/비운영 agent가 아니어야 함: ${reviewer}` };
  }
  if (r.stage === "pm" && (reviewer === proposal.proposer_agent || reviewSkipIds().has(reviewer))) {
    return { ok: false, error: `pm reviewer는 제안자/owner/비대화/비운영 agent가 아니어야 함: ${reviewer}` };
  }
  const id = rid();
  db.prepare(
    `INSERT INTO proposal_review (id,proposal_id,reviewer_agent,stage,verdict,is_adversarial,comments,required_changes)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, r.proposal_id, reviewer, r.stage, r.verdict ?? null, r.is_adversarial ? 1 : 0, r.comments ?? null, r.required_changes ?? null);
  logDecision(db, r.proposal_id, reviewer, `review:${r.stage}${r.is_adversarial ? "(adversarial)" : ""}`, null, null, r.verdict ?? "");
  return { ok: true, id };
}

export function listProposals(db: Database, status?: string): unknown[] {
  if (status) return db.prepare("SELECT * FROM proposal WHERE status = ? ORDER BY updated_at DESC").all(status);
  return db.prepare("SELECT * FROM proposal WHERE status != 'archived_duplicate' ORDER BY updated_at DESC").all();
}

export function getProposal(db: Database, id: string): unknown {
  const proposal = db.prepare("SELECT * FROM proposal WHERE id = ?").get(id);
  if (!proposal) return null;
  const reviews = db.prepare("SELECT * FROM proposal_review WHERE proposal_id = ? ORDER BY created_at").all(id);
  const decision_log = db.prepare("SELECT * FROM proposal_decision_log WHERE proposal_id = ? ORDER BY id").all(id);
  return { proposal, reviews, decision_log };
}

export function archiveProposal(db: Database, id: string, actor: string, reason: string): { ok: boolean; error?: string; fromStatus?: string } {
  const row = db.prepare("SELECT status FROM proposal WHERE id = ?").get(id) as { status: string } | undefined;
  if (!row) return { ok: false, error: "unknown_proposal" };
  if (row.status === "archived_duplicate") return { ok: true, fromStatus: row.status };
  db.prepare("UPDATE proposal SET status = 'archived_duplicate', updated_at = datetime('now') WHERE id = ?").run(id);
  logDecision(db, id, actor, "archive", row.status, "archived_duplicate", reason || "manual archive");
  return { ok: true, fromStatus: row.status };
}

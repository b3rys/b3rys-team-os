// Team Self-Loop Governance — Proposal 시스템 HTTP 라우트 (Phase 1, 2026-06-12).
//   루프 파이프라인: draft → peer_review(단일 review) → gd_report → accepted/rejected.
//   가드는 db/proposal.ts에 강제(품질 하한선·전이 상태기계·decision_log·반대리뷰 플래그).
import { Hono, type Context } from "hono";
import type { Database } from "bun:sqlite";
import { getCaptureToken } from "../lib/captureConfig";
import {
  createProposal,
  transitionProposal,
  addReview,
  archiveProposal,
  updateProposal,
  listProposals,
  getProposal,
  advanceProposalIfCurrent,
  claimAutomationAction,
  releaseAutomationAction,
  SYSTEM_ACTOR,
  isTestProposalTitle,
  type NewProposal,
} from "../db/proposal";
import { createTask } from "../db/taskQueries";
import { appendAudit } from "../db/queries";
import { ensureThread, insertMessage } from "../db/inbox/messages";
import { ambientAgents } from "../lib/registry";
import { agentsWith, coordinatorId } from "../lib/capabilities";
import { isTeamOfficialMember } from "../lib/agentMembership";
import { appendAuditFile } from "../lib/auditFile";
import { configureLeadActorDb, leadActorId, trustedActorFromRequest } from "../lib/opAuth";
import type { AgentRecord } from "../types";

interface ProposalRouteDeps {
  db: Database;
  // 팀 레지스트리(capabilities) 접근자 — non_interactive/coordinator 도출용. 기본 = ambientAgents(agents.json).
  // 테스트는 DB agent 픽스처와 일치하는 인메모리 팀 배열을 주입해 라우팅을 검증한다.
  agents?: () => AgentRecord[];
}

type ProposalStatus = "draft" | "peer_review" | "pm_review" | "gd_report" | "revise_requested";

function authError(c: Context, auth: ReturnType<typeof trustedActorFromRequest>) {
  const status = (auth.status ?? 401) as 401 | 403 | 503;
  return c.json({ error: auth.error ?? "unauthorized" }, status);
}

function isCoordinatorOrLead(actor: string, agents: AgentRecord[]): boolean {
  return actor === leadActorId() || actor === coordinatorId(agents);
}

// ── 리뷰 라우팅: 하드코딩 팀원 id 대신 팀 크기 + capability(역량)로 도출 ──────────────
// (2026-07-01 OWNER: 공개 팀에서도 유령배정 없이 동작하게 심플화. 하드코딩 codex/bill 제거.)
//   리뷰 후보 = interactive 팀원(비대화 non_interactive 제외 · 제안자 제외 · blocked 제외).
//   팀 크기(= 후보 수)로 draft 이후 경로 결정:
//     0명(1인 팀)   → draft → gd_report 직행
//     1명+(2+인 팀) → draft → peer_review(그중 1명) → gd_report
//   수정요청(revise)은 팀 크기에 맞는 첫 리뷰 단계로 재인입.

interface ProposalRow {
  id: string;
  title: string;
  proposer_agent: string;
  source?: string | null;
}

function proposalStatus(db: Database, proposalId: string): string | null {
  const row = db.prepare("SELECT status FROM proposal WHERE id = ?").get(proposalId) as { status: string } | undefined;
  return row?.status ?? null;
}

// gd_report 보고/알림용 리뷰 현황 — 누가 어떤 verdict로 검토했는지. 리뷰 없으면 '무응답 자동 승격' 명시.
// (OWNER 2026-07-04: 팀장이 '검증됨/미검증'을 한눈에 보고 결정하게.)
function formatReviewSummaryRow(r: { reviewer_agent: string; verdict: string | null; is_adversarial: number }): string {
  const verdict = r.verdict ? `(${r.verdict})` : "";
  const role = r.is_adversarial ? "[의무 반대리뷰]" : "";
  return `${r.reviewer_agent}${verdict}${role}`;
}

function reviewSummaryText(db: Database, proposalId: string): string {
  const rows = db.prepare(
    `SELECT reviewer_agent, stage, verdict, is_adversarial
       FROM proposal_review WHERE proposal_id = ? AND stage IN ('peer','pm') ORDER BY created_at`,
  ).all(proposalId) as { reviewer_agent: string; stage: string; verdict: string | null; is_adversarial: number }[];
  const fmt = (stage: string) => {
    const rs = rows.filter((r) => r.stage === stage);
    if (rs.length === 0) return "없음(무응답 자동 승격)";
    return rs.map(formatReviewSummaryRow).join(", ");
  };
  return `review: ${fmt("peer")}${rows.some((r) => r.stage === "pm") ? `\nlegacy PM 리뷰: ${fmt("pm")}` : ""}`;
}

function noticeSummaryText(summary: string): string {
  const oneLine = summary.replace(/\s+/g, " ").trim();
  return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 157)}...`;
}

function existingAgent(db: Database, id: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM agent WHERE id = ?").get(id));
}

function firstAvailableAgent(db: Database, candidates: string[], fallback: string): string {
  return candidates.find((id) => existingAgent(db, id)) ?? fallback;
}

// interactive 팀원(비대화 non_interactive · team_official_member:false · 제안자 · blocked 제외) 중 리뷰 후보 id 목록.
function otherReviewers(db: Database, proposer: string, agents: AgentRecord[]): string[] {
  const nonInteractive = new Set(agentsWith(agents, "non_interactive").map((a) => a.id));
  const registry = new Map(agents.map((a) => [a.id, a]));
  const rows = db.prepare(
    `SELECT a.id
      FROM agent a
       LEFT JOIN agent_status s ON s.agent_id = a.id
      WHERE a.id != ?
        AND COALESCE(s.state, 'idle') != 'blocked'`,
  ).all(proposer) as { id: string }[];
  return rows
    .map((r) => r.id)
    .filter((id) => {
      const agent = registry.get(id);
      return !nonInteractive.has(id) && isTeamOfficialMember(agent);
    });
}

// 팀 크기(제안자 제외 리뷰 후보 수)로 draft 이후 첫 단계 결정.
function firstReviewStage(otherCount: number): "peer_review" | "gd_report" {
  if (otherCount <= 0) return "gd_report"; // 1인 팀: 리뷰 없이 팀장 보고 직행
  return "peer_review"; // 2+인 팀: 단일 review → gd_report
}

function isTestProposalSource(source: string | null | undefined): boolean {
  const s = String(source ?? "").trim().toLowerCase();
  if (!s) return false;
  return s === "test" || s.includes("smoke") || s.includes("e2e") || s.includes("fixture");
}

function isTestProposalFixture(p: { title?: string | null; source?: string | null }): boolean {
  return isTestProposalTitle(p.title) || isTestProposalSource(p.source);
}

// 팀장 보고/조율 owner = coordinator(PM 역량) 우선 → 제안자 → 첫 후보 순 폴백(하드코딩 id 없음).
function coordinatorOwner(db: Database, agents: AgentRecord[], proposer: string): string {
  const coord = coordinatorId(agents);
  if (coord && existingAgent(db, coord)) return coord;
  if (existingAgent(db, proposer)) return proposer;
  return otherReviewers(db, proposer, agents)[0] ?? proposer;
}

// peer_review 담당 = 나머지 팀원 중 랜덤 1명. 2+ 팀부터 팀장 보고 전 단일 review가 필수.
function peerReviewOwners(db: Database, proposer: string, agents: AgentRecord[]): string[] {
  const others = otherReviewers(db, proposer, agents);
  if (others.length < 1) return [];
  const pick = others[Math.floor(Math.random() * others.length)];
  return pick ? [pick] : [];
}

// pm_review 담당 = coordinator(PM 역량) 우선, 없으면 랜덤 1명. peer 리뷰어와는 다른 사람.
function pmReviewOwners(db: Database, proposalId: string, proposer: string, agents: AgentRecord[]): string[] {
  const others = otherReviewers(db, proposer, agents);
  if (others.length === 0) return [];
  const peerReviewers = new Set(
    (
      db.prepare(
        `SELECT DISTINCT reviewer_agent AS id FROM proposal_review WHERE proposal_id = ? AND stage = 'peer'`,
      ).all(proposalId) as { id: string }[]
    ).map((r) => r.id),
  );
  const pool = others.filter((id) => !peerReviewers.has(id));
  const candidates = pool.length ? pool : others; // 후보가 전부 peer 를 한 작은 팀이면 others 로 폴백
  const coord = coordinatorId(agents);
  if (coord && candidates.includes(coord)) return [coord];
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return pick ? [pick] : [];
}

function followupSpec(db: Database, p: ProposalRow, status: ProposalStatus, agents: AgentRecord[]): { owner: string; title: string; description: string; body: string } {
  const marker = `proposal:${p.id} status:${status}`;
  if (status === "draft") {
    const owner = existingAgent(db, p.proposer_agent) ? p.proposer_agent : coordinatorOwner(db, agents, p.proposer_agent);
    const stage = firstReviewStage(otherReviewers(db, p.proposer_agent, agents).length);
    return {
      owner,
      title: `[Proposal] Draft ready: ${p.title}`,
      description:
        `${marker}\n` +
        `목표: draft 를 검토 파이프라인에 올린다(팀 규모 기준 다음 단계 = ${stage}).\n` +
        `완료 기준: 준비되면 /api/proposals/${p.id}/transition to=${stage} 실행.`,
      body:
        `[Proposal 재상정 요청]\n` +
        `대상: ${p.title}\nID: ${p.id}\n` +
        `해야 할 일: 내용 확인 후 ${stage} 단계로 올려 주세요(팀 규모상 이 단계가 첫 검토 단계입니다).`,
    };
  }
  if (status === "gd_report") {
    const owner = coordinatorOwner(db, agents, p.proposer_agent);
    return {
      owner,
      title: `[Proposal] 팀장 report 준비: ${p.title}`,
      description:
        `${marker}\n` +
        `목표: 팀장이 accepted/rejected 중 하나를 결정할 수 있게 짧은 보고를 만든다.\n` +
        `리뷰 현황:\n${reviewSummaryText(db, p.id)}\n` +
        `주의: accepted/rejected 최종 전이는 actor=owner만 가능하다.\n` +
        `완료 기준: 팀장-visible 보고 후 팀장 결정 대기.`,
      body:
        `[Proposal 팀장 report 준비]\n` +
        `대상: ${p.title}\nID: ${p.id}\n` +
        `리뷰 현황:\n${reviewSummaryText(db, p.id)}\n` +
        `해야 할 일: 팀장이 결정할 수 있게 요약 보고를 준비해 주세요. 최종 accepted/rejected는 팀장 actor만 가능합니다.`,
    };
  }
  const owner = existingAgent(db, p.proposer_agent) ? p.proposer_agent : coordinatorOwner(db, agents, p.proposer_agent);
  const reviseStage = firstReviewStage(otherReviewers(db, p.proposer_agent, agents).length);
  return {
    owner,
    title: `[Proposal] Revise requested: ${p.title}`,
    description:
      `${marker}\n` +
      `목표: 리뷰에서 요청된 수정사항을 반영하고 검토 단계로 재인입한다.\n` +
      `완료 기준: 수정 반영 후 /api/proposals/${p.id}/transition to=${reviseStage} 실행(팀 규모 기준 재인입 단계).`,
    body:
      `[Proposal revise 요청]\n` +
      `대상: ${p.title}\nID: ${p.id}\n` +
      `해야 할 일: 리뷰 수정사항을 반영한 뒤 ${reviseStage} 단계로 다시 올려 주세요.`,
  };
}

function createLinkedFollowup(
  db: Database,
  p: ProposalRow,
  statusKey: string,
  owner: string,
  title: string,
  description: string,
  body: string,
  priority: "low" | "normal" | "high" = "normal",
  column: "plan" | "doing" | "done" = "doing",
): { owner: string; taskId?: string; skipped?: boolean; messageId?: string } {
  const existing = db.prepare(
    `SELECT t.id
       FROM proposal_followup_task pft
       JOIN task t ON t.id = pft.task_id
      WHERE pft.proposal_id = ? AND pft.status = ? AND pft.closed_at IS NULL AND t.lane != 'done'
      ORDER BY pft.created_at DESC
      LIMIT 1`,
  ).get(p.id, statusKey) as { id: string } | undefined;
  if (existing) return { owner, taskId: existing.id, skipped: true };

  const task = createTask(db, { title, column, owner, description });
  db.prepare(
    `INSERT INTO proposal_followup_task (task_id, proposal_id, status, owner)
     VALUES (?, ?, ?, ?)`,
  ).run(task.id, p.id, statusKey, owner);
  if (column === "done") {
    db.prepare(
      `UPDATE proposal_followup_task
          SET closed_at = datetime('now')
        WHERE task_id = ? AND closed_at IS NULL`,
    ).run(task.id);
  }
  const threadId = `prop-${p.id.replace(/^prop_/, "").slice(0, 12)}-${statusKey.replace(/[^a-z0-9]+/g, "").slice(0, 8)}`;
  const { thread_id } = ensureThread(db, {
    thread_id: threadId,
    from_agent_id: "codex",
    to_agent_id: owner,
    type: "dm",
    body,
  });
  const message = insertMessage(db, {
    thread_id,
    from_agent_id: "codex",
    to_agent_id: owner,
    type: "dm",
    body: `${body}\n\nTasks 카드: ${task.id}`,
    source: "agent",
    hop_count: 0,
    priority,
    dedupe_key: `proposal-followup:${p.id}:${statusKey}:${owner}`,
  });
  const recipient = db.prepare(
    `SELECT delivery_state FROM message_recipient WHERE message_id = ? AND agent_id = ?`,
  ).get(message.id, owner) as { delivery_state: string } | undefined;
  if (!recipient || recipient.delivery_state !== "pending") {
    throw new Error(`followup_wake_missing: proposal=${p.id} status=${statusKey} owner=${owner}`);
  }
  return { owner, taskId: task.id, messageId: message.id };
}

function ensureGdDecisionNotices(
  db: Database,
  proposalId: string,
  toStatus: string,
  comment: string,
): { owner: string; taskId?: string; skipped?: boolean; messageId?: string }[] {
  if (!["accepted", "rejected", "revise_requested"].includes(toStatus)) return [];
  const p = db.prepare("SELECT id, title, proposer_agent, source FROM proposal WHERE id = ?").get(proposalId) as ProposalRow | undefined;
  if (!p) return [];
  const statusLabel =
    toStatus === "accepted" ? "승인" :
      toStatus === "rejected" ? "반려" :
        "수정 요청";
  const cleanComment = comment.trim() || "팀장 코멘트 없음";
  const lifecycleGuard =
    `중요: 이 알림은 b3rys proposal DB 최종 결정 알림입니다. ` +
    `Skill Workshop live 적용 지시가 아닙니다.\n` +
    `skill_workshop apply/reject/quarantine 호출 금지. ` +
    `live skill 적용은 팀장이 별도로 명시 지시하고 Codex PM이 승인 라우팅 안전성을 확인한 뒤에만 진행합니다.\n`;
  const owners = Array.from(new Set([p.proposer_agent, "codex"].filter((id) => existingAgent(db, id))));
  return owners.map((owner) => {
    const isCodexPm = owner === "codex";
    return createLinkedFollowup(
      db,
      p,
      `gd_decision:${toStatus}:${owner}`,
      owner,
      `[Proposal] 팀장 ${statusLabel}: ${p.title}`,
      `proposal:${p.id} status:gd_decision:${toStatus}\n` +
        `목표: 팀장 최종 결정과 코멘트를 확인하고 필요한 후속 조치를 닫는다.\n` +
        `팀장 결정: ${statusLabel}\n` +
        `팀장 코멘트: ${cleanComment}\n` +
        lifecycleGuard +
        (isCodexPm
          ? `완료 기준: 제안자 알림/후속 상태를 확인하고 팀장-visible closure report를 짧게 보낸다. ` +
            `추가 실행이 필요하면 별도 task로 추적한다.`
          : `완료 기준: 최종 결정 사유 확인. 이 알림 자체는 추가 실행 task가 아니며 생성 즉시 done 처리한다. ` +
            (toStatus === "revise_requested"
              ? `수정 실행은 별도 revise_requested follow-up 카드에서 추적한다.`
              : `추가 액션 없음.`)),
      `[Proposal 팀장 결정 알림]\n` +
        `대상: ${p.title}\nID: ${p.id}\n` +
        `결정: ${statusLabel}\n` +
        `팀장 코멘트: ${cleanComment}\n\n` +
        `주의: b3rys proposal 결정 알림이며 Skill Workshop live 적용 지시가 아닙니다. ` +
        `skill_workshop apply/reject/quarantine 호출 금지.\n\n` +
        (isCodexPm
          ? `해야 할 일: 제안자 알림/후속 상태를 확인하고 팀장에게 짧게 최종 처리 결과를 보고하세요. ` +
            `추가 실행은 별도 지시가 있을 때만 새 task로 추적합니다.`
          : toStatus === "revise_requested"
            ? `해야 할 일: 코멘트를 반영해 수정본을 준비하고 draft로 재상정해 주세요.`
            : toStatus === "accepted"
              ? `해야 할 일: 팀장 지시(위 코멘트)를 확인하고, 실행에 들어가기 전에 팀장께 '이렇게 진행하겠습니다' 컨펌 메시지를 먼저 보내세요. 팀장 컨펌 후 실제 실행에 들어갑니다.`
              : `해야 할 일: 최종 결정(반려) 사유를 확인하세요. 추가 액션은 없습니다.`),
      "high",
      isCodexPm || toStatus === "accepted" ? "doing" : "done",
    );
  });
}

function ensureProposalFollowup(db: Database, proposalId: string, status: string, agents: AgentRecord[]): { owner: string; taskId?: string; skipped?: boolean; messageId?: string } | null {
  if (!["draft", "peer_review", "pm_review", "gd_report", "revise_requested"].includes(status)) return null;
  const p = db.prepare("SELECT id, title, proposer_agent, source FROM proposal WHERE id = ?").get(proposalId) as ProposalRow | undefined;
  if (!p) return null;
  if (isTestProposalFixture(p)) {
    auditGdReportNotice(db, "proposal_followup_skipped_test", proposalId, {
      title: p.title,
      source: p.source,
      status,
      reason: "test proposal fixture must not create live follow-up cards",
    });
    return { owner: "system", skipped: true };
  }
  if (status === "peer_review") {
    const owners = peerReviewOwners(db, p.proposer_agent, agents);
    if (owners.length === 0) {
      // 방어: 팀 규모가 줄어 peer 후보가 없으면 coordinator 가 다음 단계를 판단(정상 경로에선 3+ 팀에서만 peer 진입).
      return createLinkedFollowup(
        db,
        p,
        "review_route_decision",
        coordinatorOwner(db, agents, p.proposer_agent),
        `[Proposal] 다음 단계 판단 필요: ${p.title}`,
        `proposal:${p.id} status:review_route_decision\n` +
          `목표: review 후보가 없어 다음 단계(gd_report)를 판단한다.\n` +
          `완료 기준: /api/proposals/${p.id}/transition 으로 gd_report/revise_requested/rejected 중 하나 실행.`,
        `[Proposal 다음 단계 판단 요청]\n` +
          `대상: ${p.title}\nID: ${p.id}\n` +
          `상태: peer 후보가 없습니다. 다음 단계를 판단해 주세요.`,
        "high",
      );
    }
    const followups = owners.map((owner) =>
      createLinkedFollowup(
        db,
        p,
        `peer_review:${owner}`,
        owner,
        `[Proposal] Peer review: ${p.title}`,
        `proposal:${p.id} status:peer_review reviewer:${owner}\n` +
          `목표: 팀장보고 전에 단일 review를 남긴다.\n` +
          `필수: reviewer는 비대화 agent/제안자가 아니어야 한다.\n` +
          `완료 기준: /api/proposals/${p.id}/reviews에 stage=peer 리뷰 등록. review 1건이 있으면 gd_report로 넘어간다.`,
        `[Proposal peer review 요청]\n` +
          `대상: ${p.title}\nID: ${p.id}\n` +
          `역할: reviewer(${owner})\n` +
          `해야 할 일: 팀장 보고 전에 실제 리스크와 개선점을 포함해 review를 남겨 주세요.`,
      ));
    return { owner: followups.map((f) => f.owner).join(","), taskId: followups[0]?.taskId, messageId: followups[0]?.messageId };
  }
  if (status === "pm_review") {
    const owners = pmReviewOwners(db, p.id, p.proposer_agent, agents);
    if (owners.length === 0) {
      // 방어: pm 후보가 없으면(1인 팀은 애초에 pm_review 를 건너뜀) coordinator 가 팀장 보고를 준비.
      return createLinkedFollowup(
        db,
        p,
        "gd_report_ready",
        coordinatorOwner(db, agents, p.proposer_agent),
        `[Proposal] 팀장 report 준비: ${p.title}`,
        `proposal:${p.id} status:gd_report_ready\n` +
          `목표: PM 후보가 없어 팀장 보고를 준비한다.\n` +
          `완료 기준: /api/proposals/${p.id}/transition to=gd_report 실행.`,
        `[Proposal 팀장 report 준비]\n` +
          `대상: ${p.title}\nID: ${p.id}\n` +
          `PM review 후보가 없습니다. 팀장 보고로 올릴지 판단해 주세요.`,
        "high",
      );
    }
    const followups = owners.map((owner) =>
      createLinkedFollowup(
        db,
        p,
        `pm_review:${owner}`,
        owner,
        `[Proposal] PM review: ${p.title}`,
        `proposal:${p.id} status:pm_review reviewer:${owner}\n` +
          `목표: peer review 결과를 바탕으로 팀장 보고 후보인지 판단한다.\n` +
          `완료 기준: /api/proposals/${p.id}/reviews에 stage=pm 리뷰 등록 후 gd_report/revise_requested/rejected로 전이한다.`,
        `[Proposal PM review 요청]\n` +
          `대상: ${p.title}\nID: ${p.id}\n` +
          `역할: PM reviewer(${owner})\n` +
          `해야 할 일: peer review 결과와 evidence를 보고 팀장 보고로 올릴지, revise/reject할지 PM review를 남겨 주세요.`,
        "high",
      ));
    return { owner: followups.map((f) => f.owner).join(","), taskId: followups[0]?.taskId, messageId: followups[0]?.messageId };
  }
  if (status === "revise_requested") {
    // revise_requested 진입 시 proposer + coordinator 둘 다 알림.
    // 적대검토 F1/F3: owner를 comma-join 하지 않는다(owner="a,b"는 agent 조회 실패→500+롤백·카드 미아).
    // → createLinkedFollowup을 각각 1회씩 호출. proposer===coordinator면 dedup(1건만).
    const spec = followupSpec(db, p, status as ProposalStatus, agents);
    const reviseStage = firstReviewStage(otherReviewers(db, p.proposer_agent, agents).length);
    const proposerFollowup = createLinkedFollowup(db, p, "revise_requested", spec.owner, spec.title, spec.description, spec.body);
    const coordOwner = coordinatorOwner(db, agents, p.proposer_agent);
    if (coordOwner !== spec.owner) {
      createLinkedFollowup(
        db, p,
        "revise_requested:coordinator",
        coordOwner,
        `[Proposal] revise watch: ${p.title}`,
        `proposal:${p.id} status:revise_requested:coordinator\n` +
          `목표: revise_requested로 돌아온 제안의 proposer 재상정을 coordinator가 추적한다(영구 stuck 방지).\n` +
          `완료 기준: proposer(${spec.owner})가 수정 반영 후 ${reviseStage} 재상정하면 닫는다. ` +
          `proposer 무응답/rate-limited면 coordinator가 /api/proposals/${p.id}/transition to=draft + emergency_override=true로 대리 전이한다.`,
        `[Proposal revise watch — PM]\n` +
          `대상: ${p.title}\nID: ${p.id}\n` +
          `proposer ${spec.owner}의 수정 재상정을 추적해 주세요. 무응답 시 coordinator가 emergency_override=true로 draft 대리 전이 가능합니다.`,
      );
    }
    // 반환은 proposer followup 기준 단일 id(comma-join 금지).
    return proposerFollowup;
  }
  const spec = followupSpec(db, p, status as ProposalStatus, agents);
  return createLinkedFollowup(db, p, status, spec.owner, spec.title, spec.description, spec.body);
}

function closeProposalFollowups(db: Database, proposalId: string, status: string | null): void {
  if (!status) return;
  const statuses = [status];
  const clauses = statuses.map(() => "(status = ? OR status LIKE ?)").join(" OR ");
  const args = statuses.flatMap((s) => [s, `${s}:%`]);
  db.prepare(
    `UPDATE task
       SET lane = 'done', updated_at = datetime('now')
      WHERE lane != 'done'
        AND id IN (
          SELECT task_id
            FROM proposal_followup_task
           WHERE proposal_id = ? AND (${clauses}) AND closed_at IS NULL
        )`,
  ).run(proposalId, ...args);
  db.prepare(
    `UPDATE proposal_followup_task
        SET closed_at = datetime('now')
      WHERE proposal_id = ? AND (${clauses}) AND closed_at IS NULL`,
  ).run(proposalId, ...args);
}

function closeAllProposalFollowups(db: Database, proposalId: string): void {
  db.prepare(
    `UPDATE task
       SET lane = 'done', updated_at = datetime('now')
      WHERE lane != 'done'
        AND id IN (
          SELECT task_id
            FROM proposal_followup_task
           WHERE proposal_id = ? AND closed_at IS NULL
        )`,
  ).run(proposalId);
  db.prepare(
    `UPDATE proposal_followup_task
        SET closed_at = datetime('now')
      WHERE proposal_id = ? AND closed_at IS NULL`,
  ).run(proposalId);
}

// 이 상태로 진입한 횟수(decision_log to_status 카운트). 자동 액션 멱등키에 회차를 넣어
// revise 재진입 시 같은 전이를 다시 허용하되(회차↑=새 키), 같은 회차 중복 실행은 차단한다.
function stageEntryCount(db: Database, proposalId: string, status: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM proposal_decision_log WHERE proposal_id = ? AND to_status = ?",
  ).get(proposalId, status) as { c: number };
  return row.c;
}

// 자동 승격 시도 — 원자·멱등 코어를 통해 from→to 전이. 성공(advanced) 시에만 후속(카드 정리+다음 배정+wake) 실행.
// 실패/멱등중복이면 아무 부수효과 없음. 이벤트 승격·sweeper 모두 이 함수만 호출한다.
function tryAutoAdvance(
  db: Database, proposalId: string, from: string, to: string, agents: AgentRecord[],
  opts: { emergency_override?: boolean; reason?: string } = {},
): { advanced: boolean; deduped?: boolean; error?: string; followup?: ReturnType<typeof ensureProposalFollowup> } {
  const actionKey = `auto:${from}->${to}:${proposalId}:${stageEntryCount(db, proposalId, from)}`;
  const adv = advanceProposalIfCurrent(db, {
    proposalId, expectedFrom: from, to,
    actionKey, kind: `auto_${from}_${to}`,
    reason: opts.reason ?? `auto ${from}→${to}`,
    emergency_override: opts.emergency_override,
  });
  if (!adv.advanced) return { advanced: false, deduped: adv.deduped, error: adv.error };
  closeProposalFollowups(db, proposalId, from);
  const followup = ensureProposalFollowup(db, proposalId, to, agents);
  return { advanced: true, followup };
}

function ownerChatId(db: Database): string | null {
  const row = db.prepare("SELECT value FROM setting WHERE key = 'owner_chat_id'").get() as { value?: string } | undefined;
  const chatId = row?.value?.trim() ?? "";
  return /^-?\d{1,20}$/.test(chatId) ? chatId : null;
}

function noticeActionKey(proposalId: string, round: number): string {
  return `gd_report_notice:${proposalId}:${round}`;
}

function auditGdReportNotice(db: Database, action: string, proposalId: string, detail: Record<string, unknown>): void {
  appendAudit(db, "proposals", action, proposalId, detail);
  appendAuditFile("proposals", action, proposalId, detail);
}

function resetGdReportNoticeClaimsForRevision(db: Database, proposalId: string): number {
  const res = db
    .prepare("DELETE FROM proposal_automation_action WHERE proposal_id = ? AND kind = 'gd_report_notice'")
    .run(proposalId);
  const cleared = res.changes ?? 0;
  auditGdReportNotice(db, "gd_report_notice_reset_for_revision", proposalId, { cleared });
  return cleared;
}

// gd_report 도달 시 팀장 1:1/op surface에 '결정 요청' 알림 — 상태 도달당 1회(멱등), fire-and-forget.
// (OWNER 2026-07-10: 그룹 broadcast와 coordinator agent sender를 제거. 알림은 team-op/system 성격으로 팀장 DM에만 보낸다.)
// owner_chat_id 또는 capture token 미설정(테스트/퍼블릭 미구성)이면 조용히 skip. 커밋 후 라우트에서 호출(트랜잭션 밖).
async function notifyGdReportReached(db: Database, proposalId: string, _agents: AgentRecord[]): Promise<void> {
  const chatId = ownerChatId(db);
  if (!chatId) return;
  const token = getCaptureToken();
  if (!token) return;
  const p = db.prepare("SELECT title, summary, proposer_agent, source FROM proposal WHERE id = ?").get(proposalId) as {
    title: string;
    summary: string;
    proposer_agent: string;
    source: string | null;
  } | undefined;
  if (!p) return;
  if (isTestProposalFixture(p)) {
    auditGdReportNotice(db, "gd_report_notice_skipped_test", proposalId, {
      round: stageEntryCount(db, proposalId, "gd_report"),
      title: p.title,
      source: p.source,
      reason: "test proposal fixture must not notify OWNER",
    });
    return;
  }
  const round = stageEntryCount(db, proposalId, "gd_report");
  const actionKey = noticeActionKey(proposalId, round);
  if (!claimAutomationAction(db, actionKey, proposalId, "gd_report_notice")) return;
  const text =
    `[Proposal 팀장 결정 요청]\n대상: ${p.title}\n제안자: ${p.proposer_agent}\n` +
    `한줄 요약: ${noticeSummaryText(p.summary)}\nID: ${proposalId}\n` +
    `리뷰 현황:\n${reviewSummaryText(db, proposalId)}\n` +
    `→ 승인/반려를 결정해 주세요(실행 지시 코멘트 필수). 고칠 게 있으면 반려 후 새로 올리게 하세요.`;
  let res: Response;
  let body: { ok?: boolean; description?: string; result?: { message_id?: number } };
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { message_id?: number } };
  } catch {
    releaseAutomationAction(db, actionKey);
    try {
      auditGdReportNotice(db, "gd_report_notice_failed", proposalId, {
        action_key: actionKey,
        round,
        chat: "owner_chat_id",
        error: "send_exception",
      });
    } catch (e) {
      console.error(`[proposals] gd_report notice send-exception audit failed (${proposalId}):`, e);
    }
    // 채널 전송 실패가 파이프라인을 막지 않는다(Proposal DB와 follow-up task가 정본).
    return;
  }

  const telegramOk = Boolean(body.ok);
  const detail = {
    action_key: actionKey,
    round,
    chat: "owner_chat_id",
    http_status: res.status,
    telegram_ok: telegramOk,
    message_id: body.result?.message_id,
    error: telegramOk ? undefined : body.description,
  };
  if (!telegramOk) releaseAutomationAction(db, actionKey);
  try {
    auditGdReportNotice(db, telegramOk ? "gd_report_notice_sent" : "gd_report_notice_failed", proposalId, detail);
  } catch (e) {
    console.error(`[proposals] gd_report notice audit failed after send result (${proposalId}:${telegramOk ? "sent" : "failed"}):`, e);
  }
}

function notifyGdReportReachedSafely(db: Database, proposalId: string, agents: AgentRecord[], source: string): void {
  void notifyGdReportReached(db, proposalId, agents).catch((e) => {
    console.error(`[proposals] gd_report notice failed outside send guard (${source}:${proposalId}):`, e);
  });
}

// 시간 기반 안전망 — 정체(updated_at 임계 초과) 제안을 시스템이 스스로 진행시킨다.
// (OWNER 2026-07-04: 담당자 무응답으로 파이프라인이 멈추지 않게. workers/proposalSweeper 가 주기 호출.)
//   draft/revise_requested 정체 → 첫 리뷰 단계로 자동 제출(이미 멈춘 제안도 구제).
//   peer/pm 무응답 → 1차 재배정(다른 후보 wake) → 2차 리뷰 skip degraded 진행.
//     단 reject/revise verdict 가 있으면 사람 판단이 필요하므로 자동 진행하지 않는다(codex 교차검토 반영).
export function sweepStaleProposals(
  db: Database, agents: AgentRecord[],
  opts: { staleMinutes?: number; limit?: number } = {},
): { advanced: string[]; reassigned: string[]; degraded: string[] } {
  const staleMinutes = opts.staleMinutes ?? 30;
  const limit = opts.limit ?? 20; // thundering herd 방지: 한 tick 당 처리량 제한.
  const rows = db.prepare(
    `SELECT id, title, source, status, proposer_agent, risk_level
       FROM proposal
      WHERE status IN ('draft','revise_requested','peer_review','pm_review')
        AND (julianday('now') - julianday(updated_at)) * 24 * 60 >= ?
      ORDER BY updated_at ASC
      LIMIT ?`,
  ).all(staleMinutes, limit) as { id: string; title: string; source: string | null; status: string; proposer_agent: string; risk_level: string | null }[];
  const out = { advanced: [] as string[], reassigned: [] as string[], degraded: [] as string[] };
  for (const row of rows) {
    if (isTestProposalFixture(row)) continue;
    // 제안 단위 트랜잭션 + try/catch(F1): 부분 실패 시 전이·카드·wake 전부 롤백 → 다음 tick 깨끗한 재시도.
    // 한 제안의 실패가 tick 전체를 멈추지 않게 격리한다. 팀장 push 는 커밋 후(밖)에서.
    let gdReached = false;
    try {
      db.transaction(() => {
        if (row.status === "draft" || row.status === "revise_requested") {
          const stage = firstReviewStage(otherReviewers(db, row.proposer_agent, agents).length);
          const r = tryAutoAdvance(db, row.id, row.status, stage, agents, { reason: "sweeper: 정체 제안 자동 제출" });
          if (r.advanced) {
            out.advanced.push(row.id);
            if (stage === "gd_report") gdReached = true;
          }
          return;
        }
        // peer_review / legacy pm_review 무응답
        const to = "gd_report";
        const round = stageEntryCount(db, row.id, row.status);
        const reassignKey = `sweeper_reassign:${row.id}:${row.status}:${round}`;
        if (claimAutomationAction(db, reassignKey, row.id, "sweeper_reassign")) {
          // 1차: 담당 재배정(기존 카드 닫고 다른 후보 wake).
          closeProposalFollowups(db, row.id, row.status);
          ensureProposalFollowup(db, row.id, row.status, agents);
          out.reassigned.push(row.id);
          return;
        }
        // 2차: 여전히 무응답 → 리뷰 skip degraded 진행.
        // 고위험(risk_level=high)은 무검토 자동 진행 금지(P1). reject/revise verdict 있으면 사람 판단 보존.
        if (String(row.risk_level ?? "").toLowerCase() === "high") return;
        const stageName = row.status === "peer_review" ? "peer" : "pm";
        const blocking = db.prepare(
          `SELECT 1 FROM proposal_review WHERE proposal_id = ? AND stage = ? AND verdict IN ('reject','revise') LIMIT 1`,
        ).get(row.id, stageName);
        if (blocking) return;
        const r = tryAutoAdvance(db, row.id, row.status, to, agents, {
          emergency_override: true,
          reason: "sweeper: 무응답 자동 진행(review_missing)",
        });
        if (r.advanced) {
          out.degraded.push(row.id);
          if (to === "gd_report") gdReached = true;
        }
      })();
    } catch (e) {
      console.error(`[proposalSweeper] proposal ${row.id} 처리 실패(격리, 다음 tick 재시도):`, e);
      continue;
    }
    if (gdReached) notifyGdReportReachedSafely(db, row.id, agents, "sweeper");
  }
  return out;
}

export function createProposalRoutes(deps: ProposalRouteDeps): Hono {
  configureLeadActorDb(deps.db);
  const r = new Hono();

  // GET /api/proposals?status=draft — 목록(현황판). status 옵션 필터.
  r.get("/proposals", (c) => {
    const status = c.req.query("status") || undefined;
    return c.json({ proposals: listProposals(deps.db, status) });
  });

  // GET /api/proposals/:id — 단건 + reviews + decision_log(감사 추적).
  r.get("/proposals/:id", (c) => {
    const out = getProposal(deps.db, c.req.param("id"));
    if (!out) return c.json({ error: "not_found" }, 404);
    return c.json(out);
  });

  // PATCH /api/proposals/:id — draft/revise_requested proposal text update.
  // 수정요청 반영은 direct DB edit 없이 표준 API로 남긴다. 상태/actor 가드는 db/proposal.ts에서 강제.
  r.patch("/proposals/:id", async (c) => {
    const auth = trustedActorFromRequest(c.req.raw, { loopbackDashboardActor: leadActorId() });
    if (!auth.ok || !auth.actor) return authError(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const allowed = new Set(["summary", "body", "evidence_refs", "reason", "actor"]);
    const unknown = Object.keys(body).filter((k) => !allowed.has(k));
    if (unknown.length) return c.json({ error: `unsupported_fields: ${unknown.join(",")}` }, 400);
    for (const key of ["summary", "body", "evidence_refs", "reason"]) {
      if (body[key] !== undefined && typeof body[key] !== "string") {
        return c.json({ error: `${key} must be string` }, 400);
      }
    }
    const res = updateProposal(deps.db, c.req.param("id"), auth.actor.actor, {
      summary: body.summary as string | undefined,
      body: body.body as string | undefined,
      evidence_refs: body.evidence_refs as string | undefined,
      reason: body.reason as string | undefined,
    });
    if (!res.ok) return c.json({ error: res.error }, res.error === "unknown_proposal" ? 404 : 409);
    const out = getProposal(deps.db, c.req.param("id"));
    return c.json({ ok: true, updated: res.updated, proposal: (out as { proposal?: unknown })?.proposal ?? null });
  });

  // DELETE /api/proposals/:id — 실제 삭제가 아니라 manual archive. 기본 목록에서는 숨기고 감사 로그는 보존한다.
  r.delete("/proposals/:id", async (c) => {
    const auth = trustedActorFromRequest(c.req.raw, { loopbackDashboardActor: leadActorId() });
    if (!auth.ok || !auth.actor) return authError(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { actor?: string; reason?: string };
    const actor = auth.actor.actor;
    const reason = String(body.reason ?? "manual archive from proposal tab").trim() || "manual archive from proposal tab";
    const proposalId = c.req.param("id");
    const runArchive = deps.db.transaction(() => {
      const res = archiveProposal(deps.db, proposalId, actor, reason);
      if (!res.ok) return res;
      closeAllProposalFollowups(deps.db, proposalId);
      return res;
    });
    const out = runArchive();
    if (!out.ok) return c.json({ error: out.error }, 404);
    return c.json({ ok: true, archived: true, fromStatus: out.fromStatus });
  });

  // POST /api/proposals — 제안 생성(품질 하한선: 근거+예상효과 필수) + (B) 생성=즉시 제출 자동 진입.
  r.post("/proposals", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<NewProposal>;
    const agents = deps.agents?.() ?? ambientAgents();
    try {
      const run = deps.db.transaction(() => {
        const res = createProposal(deps.db, body as NewProposal);
        if (!res.ok) return { ok: false as const, error: res.error };
        const proposalId = res.id!;
        // (B, OWNER 2026-07-04): 생성 성공 = 곧 제출. 품질 하한선(근거+예상효과)이 이미 미완성을 막으므로
        // draft에 고이지 않고 팀 규모별 첫 리뷰 단계로 자동 진입(+담당자 배정/wake). 사람이 버튼 누를 필요 없음.
        const proposer = String(body.proposer_agent ?? "").trim();
        const stage = firstReviewStage(otherReviewers(deps.db, proposer, agents).length);
        const auto = tryAutoAdvance(deps.db, proposalId, "draft", stage, agents);
        return { ok: true as const, id: proposalId, stage, advanced: auto.advanced, followup: auto.followup };
      });
      const out = run();
      if (!out.ok) return c.json({ error: out.error }, 400);
      // 1인 팀은 생성 즉시 gd_report 직행 → 팀장 알림(트랜잭션 밖, fire-and-forget).
      if (out.stage === "gd_report" && out.advanced) notifyGdReportReachedSafely(deps.db, out.id, agents, "create");
      return c.json({ ok: true, id: out.id, stage: out.stage, auto_advanced: out.advanced, followup: out.followup }, 201);
    } catch (e) {
      console.error("[proposals] create+auto-submit failed:", e);
      return c.json({ error: "create_failed" }, 500);
    }
  });

  // POST /api/proposals/:id/transition {to, actor, reason} — 상태 전이(상태기계 가드).
  r.post("/proposals/:id/transition", async (c) => {
    const auth = trustedActorFromRequest(c.req.raw, { loopbackDashboardActor: leadActorId() });
    if (!auth.ok || !auth.actor) return authError(c, auth);
    const body = (await c.req.json().catch(() => ({}))) as { to?: string; actor?: string; reason?: string; comment?: string; emergency_override?: boolean };
    if (!body.to) return c.json({ error: "to 필수" }, 400);
    // SYSTEM_ACTOR 는 in-process 자동화(sweeper·이벤트 승격) 전용 — HTTP 로 사칭하면 draft 가로채기/감사 위장(교차검토 F2). 차단.
    if (auth.actor.actor === SYSTEM_ACTOR) {
      return c.json({ error: "system actor는 HTTP 전이에 사용할 수 없습니다(자동화 전용)" }, 403);
    }
    const proposalId = c.req.param("id");
    try {
      const runTransition = deps.db.transaction(() => {
        const fromStatus = proposalStatus(deps.db, proposalId);
        // OWNER 2026-07-04: 팀장 최종 결정(gd_report→승인/반려)에는 실행 지시 코멘트가 필수.
        // 지시 판정은 오직 body.comment 만 본다 — 대시보드가 빈 입력에 버튼 라벨("승인")을 채우거나
        // reason fallback 으로 라벨이 새도 우회 못하게(교차검토 후 실측 버그 fix). 이 지시가 제안자에게
        // 전달되어 '팀장께 먼저 컨펌 메시지를 보내는' 진입 트리거가 된다.
        const directive = typeof body.comment === "string" ? body.comment.trim() : "";
        if (fromStatus === "gd_report" && ["accepted", "rejected", "revise_requested"].includes(body.to!) && !directive) {
          return { ok: false as const, error: "팀장 결정에는 실행 지시 코멘트가 필수입니다(빈 결정 불가)" };
        }
        // transition 기록/알림용 코멘트: 지시 우선, 없으면 reason(라벨) fallback(감사 로그용).
        const comment = directive || (body.reason ?? "").trim();
        const agents = deps.agents?.() ?? ambientAgents();
        const emergencyOverride = Boolean(body.emergency_override);
        if (emergencyOverride) {
          if (!comment.trim()) return { ok: false as const, error: "emergency_override_reason_required" };
          if (!isCoordinatorOrLead(auth.actor!.actor, agents)) return { ok: false as const, error: "emergency_override_forbidden" };
          appendAuditFile("proposals", "emergency_override_requested", proposalId, {
            actor: auth.actor!.actor,
            to: body.to,
            from: fromStatus,
            source: auth.actor!.source,
          });
        }
        const res = transitionProposal(deps.db, proposalId, auth.actor!.actor, body.to!, comment, {
          emergency_override: emergencyOverride,
        });
        if (!res.ok) return { ok: false as const, error: res.error };
        if (fromStatus === "gd_report" && body.to === "revise_requested") {
          resetGdReportNoticeClaimsForRevision(deps.db, proposalId);
        }
        closeProposalFollowups(deps.db, proposalId, fromStatus);
        const followup = ensureProposalFollowup(deps.db, proposalId, body.to!, agents);
        const notices = auth.actor!.actor === leadActorId() && fromStatus === "gd_report"
          ? ensureGdDecisionNotices(deps.db, proposalId, body.to!, comment)
          : [];
        return { ok: true as const, followup, notices };
      });
      const out = runTransition();
      if (!out.ok) return c.json({ error: out.error }, 409);
      // 수동 전이(coordinator fallback 등)로 gd_report 도달 시에도 팀장 push(F2). round 멱등이라 자동 경로와 중복 안 됨.
      if (body.to === "gd_report") notifyGdReportReachedSafely(deps.db, proposalId, deps.agents?.() ?? ambientAgents(), "transition");
      return c.json({ ok: true, followup: out.followup, notices: out.notices });
    } catch (e) {
      console.error("[proposals] follow-up creation failed:", e);
      return c.json({ error: "followup_failed" }, 500);
    }
  });

  // POST /api/proposals/:id/reviews {reviewer_agent, stage, verdict, is_adversarial, comments, required_changes}
  r.post("/proposals/:id/reviews", async (c) => {
    const auth = trustedActorFromRequest(c.req.raw, { loopbackDashboardActor: leadActorId() });
    if (!auth.ok || !auth.actor) return authError(c, auth);
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const suppliedReviewer = String(body.reviewer_agent ?? "").trim();
      if (suppliedReviewer && suppliedReviewer !== auth.actor.actor) {
        return c.json({ error: "reviewer_actor_mismatch" }, 403);
      }
      const proposalId = c.req.param("id");
      const agents = deps.agents?.() ?? ambientAgents();
      const runReview = deps.db.transaction(() => {
        const stage = String(body.stage ?? "");
        const res = addReview(deps.db, {
          proposal_id: proposalId,
          reviewer_agent: auth.actor!.actor,
          stage,
          verdict: body.verdict as string | undefined,
          is_adversarial: Boolean(body.is_adversarial),
          comments: body.comments as string | undefined,
          required_changes: body.required_changes as string | undefined,
        });
        if (!res.ok) return { ok: false as const, error: res.error };
        // 리뷰 등록 = 승격 트리거. 현재 단계에서 가드(반대 peer 리뷰 / PM 리뷰) 충족 시 자동 전이 + 다음 배정.
        // 가드 미충족(예: approve만)이면 advanced=false로 머무르고, sweeper가 나중에 처리(degraded).
        // OWNER 2026-07-04: peer/pm verdict=reject 는 그 자리서 최종 반려(rejected) + 제안자·팀장 노티.
        // concern/revise/approve 는 진행성 판정이라 그냥 다음 단계로만 흐르고 노티 안 함(중간은 팀원끼리).
        const status = proposalStatus(deps.db, proposalId);
        const verdict = String(body.verdict ?? "");
        let auto: { advanced: boolean; followup?: ReturnType<typeof ensureProposalFollowup> } = { advanced: false };
        let rejected = false;
        if (stage === "peer" && status === "peer_review") {
          auto = verdict === "reject"
            ? tryAutoAdvance(deps.db, proposalId, "peer_review", "rejected", agents)
            : tryAutoAdvance(deps.db, proposalId, "peer_review", "gd_report", agents);
          rejected = verdict === "reject" && auto.advanced;
        } else if (stage === "pm" && status === "pm_review") {
          auto = verdict === "reject"
            ? tryAutoAdvance(deps.db, proposalId, "pm_review", "rejected", agents)
            : tryAutoAdvance(deps.db, proposalId, "pm_review", "gd_report", agents);
          rejected = verdict === "reject" && auto.advanced;
        }
        // reject 최종 반려 시 '왜 반려됐는지'를 제안자+팀장에게 노티(gd_report 승인/반려와 동일 방식·표면화).
        const rejectReason = String(body.required_changes ?? body.comments ?? "").trim() || `${stage} reject`;
        const rejectNotices = rejected ? ensureGdDecisionNotices(deps.db, proposalId, "rejected", `${stage} reject: ${rejectReason}`) : [];
        return { ok: true as const, id: res.id, advanced: auto.advanced, followup: auto.followup, reachedGd: ["peer", "pm"].includes(stage) && !rejected && auto.advanced, rejectNotices };
      });
      const out = runReview();
      if (!out.ok) return c.json({ error: out.error }, 400);
      // 단일 review(또는 legacy pm 리뷰)로 gd_report 도달 시 팀장 알림(트랜잭션 밖, fire-and-forget).
      if (out.reachedGd) notifyGdReportReachedSafely(deps.db, proposalId, agents, "review");
      return c.json({ ok: true, id: out.id, auto_advanced: out.advanced, followup: out.followup }, 201);
    } catch (e) {
      console.error("[proposals] review follow-up creation failed:", e);
      return c.json({ error: "followup_failed" }, 500);
    }
  });

  return r;
}

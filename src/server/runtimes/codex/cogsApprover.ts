/**
 * cogs 정책 코덱스 팀원의 승인 요청 → cogs 카드 → 결정 → 코덱스 응답 하나.
 *
 * 역할만 잇는다: 해석(appServerPopup) · 상태기계(cogsPermissions/approvals) · 대기(waiters) · 카드(card).
 * 응답 원칙:
 *   - 허용은 인계(handOffCogsApproval)가 이긴 경우에만, 원래 요청 하나에 "이번만"으로 답한다.
 *     세션 허용은 앱(PR1 세션 허용 표)에서만 기억한다 — 코덱스의 세션 승인(acceptForSession)을 쓰지 않는다.
 *   - 권한 묶음 요청(item/permissions)은 범위를 나눠 인가할 수 없어 거절한다(요청 묶음 전체를 무검증으로 주지 않는다).
 *   - 그 밖의 모든 실패(정책 못 읽음·카드 실패·DB 오류·만료·무효화)는 거절.
 * '항상 허용' 은 코덱스에서 안전한 지속 규칙으로 못 적으므로 버튼을 주지 않는다.
 */
import type { Database } from "bun:sqlite";
import { tierDReasons } from "../../lib/permissionGate";
import { createCogsApproval, handOffCogsApproval, hasCogsSessionGrant, recordCardMessage } from "../../lib/cogsPermissions/approvals";
import type { CogsDecisionWaiters } from "../../lib/cogsPermissions/waiters";
import type { ApprovalCardInput, CardSendResult } from "../../lib/cogsPermissions/card";
import { buildOperationFromApproval, cogsCardInputFor, oversizedForReview } from "./appServerPopup";
import type { ApprovalRequest, ReviewDecision } from "./appServerClient";

/** 코덱스 app-server 가 사람 응답을 기다리는 시간보다 짧게 — 늦은 허용이 끊긴 요청에 가지 않게. */
export const COGS_APPROVAL_TTL_MS = 240_000;

export interface CogsApproverDeps {
  agentId: string;
  /** 카드를 띄울 방(팀원 주인의 1:1 방). 없으면 묻지 않고 거절. */
  roomId: string | null;
  processGen: string;
  cwd?: string;
  openDb: () => Database;
  /** 원본에서 막 읽은 정책 도장. 없음·깨짐이면 null. */
  currentStamp: () => string | null;
  waiters: CogsDecisionWaiters;
  sendCard: (input: ApprovalCardInput) => Promise<CardSendResult>;
  now?: () => number;
  ttlMs?: number;
  log?: (line: string) => void;
}

export type CogsApproverOutcome =
  | "denied_permissions_profile" | "denied_oversized" | "denied_no_room" | "denied_no_policy"
  | "session_grant" | "card_failed" | "allowed" | "handoff_lost" | "denied" | "error";

export function createCogsCodexApprover(deps: CogsApproverDeps): {
  approve: (req: ApprovalRequest) => Promise<ReviewDecision>;
  /** 마지막 판정 사유(시험·로그용). */
  lastOutcome: () => CogsApproverOutcome | null;
} {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  let last: CogsApproverOutcome | null = null;
  const done = (o: CogsApproverOutcome, d: ReviewDecision): ReviewDecision => { last = o; return d; };

  const approve = async (req: ApprovalRequest): Promise<ReviewDecision> => {
    if (req.method === "item/permissions/requestApproval") return done("denied_permissions_profile", "denied");
    if (oversizedForReview(req) !== null) return done("denied_oversized", "denied");
    if (!deps.roomId) return done("denied_no_room", "denied");
    const stamp = deps.currentStamp();
    if (!stamp) return done("denied_no_policy", "denied");
    const p = (req.params ?? {}) as Record<string, unknown>;
    // 세션 = 코덱스 대화(thread). 세션 허용은 이 대화·이 프로세스 세대·이 도장에서만 다시 쓴다.
    const sessionId = typeof p.threadId === "string" && p.threadId ? p.threadId : "no_thread";
    const op = { ...buildOperationFromApproval(req, deps.agentId, deps.cwd), agent_id: deps.agentId };
    const risks = tierDReasons(op);

    let requestId: string;
    let db: Database | null = null;
    try {
      db = deps.openDb();
      // 위험 표시가 있는 일은 세션 허용으로도 묻지 않고 넘기지 않는다 — 매번 사람이 본다.
      if (!risks.length && hasCogsSessionGrant(db, { agentId: deps.agentId, sessionId, processGen: deps.processGen, op, currentStamp: stamp })) {
        return done("session_grant", "approved");
      }
      requestId = createCogsApproval(db, {
        op, roomId: deps.roomId, policyStamp: stamp, sessionId, processGen: deps.processGen,
        ttlMs: deps.ttlMs ?? COGS_APPROVAL_TTL_MS, nowMs: now(), alwaysRule: null,
      }).request.id;
    } catch (e) {
      log(`[cogs-approval] 요청 생성 실패 agent=${deps.agentId}: ${e instanceof Error ? e.message : e}`);
      return done("error", "denied");
    } finally {
      try { db?.close(); } catch { /* best-effort */ }
    }

    // 등록 먼저 — 카드가 가고 바로 눌려도 놓치지 않는다(대기는 등록 뒤 DB 를 한 번 읽는다).
    const waiting = deps.waiters.wait(requestId);
    const sent = await deps.sendCard(cogsCardInputFor(req, requestId, risks, false)).catch(() => ({ ok: false } as CardSendResult));
    if (!sent.ok) {
      log(`[cogs-approval] 카드 전송 실패 → 거절 agent=${deps.agentId} request=${requestId}`);
      deps.waiters.cancel(requestId, "card_failed");
      return done("card_failed", "denied");
    }
    if (sent.messageId !== undefined) {
      try { const d = deps.openDb(); try { recordCardMessage(d, requestId, sent.messageId); } finally { d.close(); } } catch { /* 표시 정리용 — 판정과 무관 */ }
    }

    const outcome = await waiting;
    if (outcome.kind !== "allowed") return done("denied", "denied");
    // 넘기기 직전에 원본 도장·만료·세션·세대를 다시 본다. 이긴 인계만 실행된다(최대 한 번).
    try {
      const d = deps.openDb();
      try {
        const won = handOffCogsApproval(d, { requestId, agentId: deps.agentId, sessionId, processGen: deps.processGen, currentStamp: deps.currentStamp(), nowMs: now() });
        return won ? done("allowed", "approved") : done("handoff_lost", "denied");
      } finally { d.close(); }
    } catch (e) {
      log(`[cogs-approval] 인계 실패 → 거절 agent=${deps.agentId} request=${requestId}: ${e instanceof Error ? e.message : e}`);
      return done("error", "denied");
    }
  };

  return { approve, lastOutcome: () => last };
}

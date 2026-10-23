/**
 * cogs 정책 클로드 팀원의 권한 요청(--permission-prompt-tool 호출 하나) → cogs 카드 → 결정 → CLI 응답 하나.
 *
 * 코덱스 승인(runtimes/codex/cogsApprover)과 같은 사슬을 쓴다: 상태기계(cogsPermissions/approvals) · 대기(waiters) ·
 * 카드(card). 다른 점만 여기 있다 — 요청 모양(tool_name·input), [항상] 규칙(alwaysRuleFor), 응답 모양.
 * 응답 원칙:
 *   - 허용은 인계(handOffCogsApproval)가 이긴 경우에만, 원래 입력 그대로(updatedInput = 받은 input). 입력을 바꿔서
 *     허용하지 않는다 — 사람이 본 것과 실행되는 것이 같아야 한다.
 *   - 카드에 대상(명령·경로·주소)을 자르지 않고 전부 보여 줄 수 없으면 묻지 않고 거절한다 — 사람이 본 것과
 *     실행되는 것이 같아야 한다(잘린 꼬리에 다른 명령이 숨을 수 있다).
 *   - 샌드박스 밖 실행 요청·정책 못 읽음·방 없음·카드 실패·DB 오류·만료·무효화는 모두 거절.
 */
import type { Database } from "bun:sqlite";
import { tierDReasons, type PermissionOperation } from "../../lib/permissionGate";
import { createCogsApproval, handOffCogsApproval, hasCogsSessionGrant, recordCardMessage } from "../../lib/cogsPermissions/approvals";
import type { CogsDecisionWaiters } from "../../lib/cogsPermissions/waiters";
import { approvalCardBody, type ApprovalCardInput, type CardSendResult } from "../../lib/cogsPermissions/card";
import { alwaysRuleFor } from "./cogsClaudeRunPolicy";

/** 팀장 결정(10/23): 답이 없으면 20분 뒤 거절. */
export const COGS_CLAUDE_APPROVAL_TTL_MS = 20 * 60_000;
export const CARD_SEND_TIMEOUT_MS = 15_000;
/** 작업 기록에 남기는 모르는 도구 입력의 상한(판정용, 카드에는 쓰지 않는다). */
export const COMMAND_REVIEW_LIMIT = 2_000;
/** 요청 번호 자리(prm_ + 18자). 번호를 만들기 전에 카드에 다 들어가는지 재는 데 쓴다. */
const REQUEST_ID_PLACEHOLDER = `prm_${"x".repeat(18)}`;

export interface ClaudePermissionRequest {
  tool_name: string;
  input: unknown;
  tool_use_id?: string;
}

export type ClaudePermissionAnswer =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export interface CogsClaudeApproverDeps {
  agentId: string;
  /** 카드를 띄울 방(팀원 주인의 1:1 방). 없으면 묻지 않고 거절. */
  roomId: string | null;
  processGen: string;
  /** 이 실행의 세션(클로드 세션 id). 세션 허용은 이 세션에서만 다시 쓴다. */
  sessionId: string;
  workspace: string;
  controlPaths: string[];
  openDb: () => Database;
  /** 원본에서 막 읽은 정책 도장. 없음·깨짐이면 null. */
  currentStamp: () => string | null;
  waiters: CogsDecisionWaiters;
  sendCard: (input: ApprovalCardInput) => Promise<CardSendResult>;
  now?: () => number;
  ttlMs?: number;
  cardTimeoutMs?: number;
  log?: (line: string) => void;
}

export type CogsClaudeApproverOutcome =
  | "denied_unsandboxed" | "denied_bad_request" | "denied_unreviewable" | "denied_no_room" | "denied_no_policy"
  | "session_grant" | "card_failed" | "allowed" | "handoff_lost" | "denied" | "error";

const deny = (message: string): ClaudePermissionAnswer => ({ behavior: "deny", message });

export function createCogsClaudeApprover(deps: CogsClaudeApproverDeps): {
  approve: (req: ClaudePermissionRequest) => Promise<ClaudePermissionAnswer>;
  lastOutcome: () => CogsClaudeApproverOutcome | null;
} {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  let last: CogsClaudeApproverOutcome | null = null;
  const done = (o: CogsClaudeApproverOutcome, a: ClaudePermissionAnswer) => { last = o; return a; };

  const approve = async (req: ClaudePermissionRequest): Promise<ClaudePermissionAnswer> => {
    if (!req || typeof req.tool_name !== "string" || !req.tool_name || !req.input || typeof req.input !== "object" || Array.isArray(req.input)) {
      return done("denied_bad_request", deny("bad_request"));
    }
    const input = req.input as Record<string, unknown>;
    // 샌드박스 밖 실행은 설정으로 이미 막혀 있다. 그래도 여기 오면 묻지 않고 거절한다(보호가 샌드박스에 걸려 있다).
    if (input.dangerouslyDisableSandbox === true) return done("denied_unsandboxed", deny("unsandboxed_not_allowed"));
    if (!deps.roomId) return done("denied_no_room", deny("no_approval_room"));
    const stamp = deps.currentStamp();
    if (!stamp) return done("denied_no_policy", deny("no_policy"));

    const op = claudeOperation(req.tool_name, input, deps.agentId, deps.workspace);
    const risks = tierDReasons(op);
    // 위험 표시가 있으면 [항상] 을 주지 않는다 — 매번 사람이 본다.
    const always = risks.length ? null : alwaysRuleFor(req.tool_name, input, { workspace: deps.workspace, controlPaths: deps.controlPaths }).rule;
    if (!fitsOnCard(claudeCardInput(req.tool_name, input, REQUEST_ID_PLACEHOLDER, risks, always !== null))) {
      return done("denied_unreviewable", deny("too_long_to_review"));
    }

    let requestId: string;
    let db: Database | null = null;
    try {
      db = deps.openDb();
      if (!risks.length && hasCogsSessionGrant(db, { agentId: deps.agentId, sessionId: deps.sessionId, processGen: deps.processGen, op, currentStamp: stamp })) {
        return done("session_grant", { behavior: "allow", updatedInput: input });
      }
      requestId = createCogsApproval(db, {
        op, roomId: deps.roomId, policyStamp: stamp, sessionId: deps.sessionId, processGen: deps.processGen,
        ttlMs: deps.ttlMs ?? COGS_CLAUDE_APPROVAL_TTL_MS, nowMs: now(), alwaysRule: always,
      }).request.id;
    } catch (e) {
      log(`[cogs-approval] 요청 생성 실패 agent=${deps.agentId}: ${e instanceof Error ? e.message : e}`);
      return done("error", deny("approval_error"));
    } finally {
      try { db?.close(); } catch { /* best-effort */ }
    }

    // 등록 먼저 — 카드가 가고 바로 눌려도 놓치지 않는다.
    const waiting = deps.waiters.wait(requestId);
    const afterSend = async (sent: CardSendResult) => {
      if (!sent.ok) {
        log(`[cogs-approval] 카드 전송 실패 → 거절 agent=${deps.agentId} request=${requestId}`);
        deps.waiters.cancel(requestId, "card_failed");
        return null;
      }
      if (sent.messageId !== undefined) {
        try { const d = deps.openDb(); try { recordCardMessage(d, requestId, sent.messageId); } finally { d.close(); } } catch { /* 표시 정리용 */ }
      }
      return waiting;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      deps.sendCard(claudeCardInput(req.tool_name, input, requestId, risks, always !== null))
        .then((r) => ({ sent: r }), () => ({ sent: { ok: false } as CardSendResult })),
      waiting.then((o) => ({ early: o })),
      new Promise<{ sent: CardSendResult }>((r) => { timer = setTimeout(() => r({ sent: { ok: false } }), deps.cardTimeoutMs ?? CARD_SEND_TIMEOUT_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    const outcome = "early" in raced ? raced.early : await afterSend(raced.sent);
    if (outcome === null) return done("card_failed", deny("card_failed"));
    if (outcome.kind !== "allowed") return done("denied", deny("denied_by_owner"));
    // 넘기기 직전에 원본 도장·만료·세션·세대를 다시 본다. 이긴 인계만 실행된다(최대 한 번).
    try {
      const d = deps.openDb();
      try {
        const won = handOffCogsApproval(d, { requestId, agentId: deps.agentId, sessionId: deps.sessionId, processGen: deps.processGen, currentStamp: deps.currentStamp(), nowMs: now() });
        return won ? done("allowed", { behavior: "allow", updatedInput: input }) : done("handoff_lost", deny("approval_expired"));
      } finally { d.close(); }
    } catch (e) {
      log(`[cogs-approval] 인계 실패 → 거절 agent=${deps.agentId} request=${requestId}: ${e instanceof Error ? e.message : e}`);
      return done("error", deny("approval_error"));
    }
  };

  return { approve, lastOutcome: () => last };
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

/** 클로드 도구 요청 → 권한 판정용 작업. 모르는 도구도 이름과 입력을 그대로 남겨 위험 패턴 검사를 받게 한다. */
export function claudeOperation(toolName: string, input: Record<string, unknown>, agentId: string, workspace: string): PermissionOperation & { agent_id: string } {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const provenance = { source: "claude_permission_prompt", tool: toolName, cwd: workspace, input_origin: "claude_turn" };
  const base = { runtime: "claude", agent_id: agentId, requested_by: agentId, provenance };
  if (toolName === "Bash") return { ...base, action: "shell", command: str(input.command) ?? "" };
  if (WRITE_TOOLS.has(toolName)) return { ...base, action: "write", path: str(input.file_path) ?? str(input.notebook_path) ?? "" };
  if (READ_TOOLS.has(toolName)) return { ...base, action: "read", path: str(input.file_path) ?? str(input.path) ?? str(input.pattern) ?? "" };
  if (toolName === "WebFetch") return { ...base, action: "network", egress_url: str(input.url) ?? "" };
  if (toolName === "WebSearch") return { ...base, action: "network", text: str(input.query) ?? "" };
  return { ...base, action: "tool", text: `${toolName} ${safeJson(input)}`.slice(0, COMMAND_REVIEW_LIMIT) };
}

/** 카드 = 무엇을(operation_code) + 대상 전체(detail). 자르지 않는다. 문구는 앱이 쓴다(서버·브리지는 코드만). */
export function claudeCardInput(toolName: string, input: Record<string, unknown>, requestId: string, risks: string[], allowAlways: boolean): ApprovalCardInput {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const operationCode = toolName === "Bash" ? "run_command" : WRITE_TOOLS.has(toolName) ? "edit_files" : "request_permission";
  const detail = toolName === "Bash" ? str(input.command)
    : str(input.file_path) ?? str(input.notebook_path) ?? str(input.url) ?? str(input.path) ?? str(input.pattern) ?? toolName;
  return { requestId, operationCode, detail, risks, allowAlways };
}

/** 카드 본문이 대상 전체를 그대로 싣는가. 서버 한도로 detail 이 빠지거나 본문이 안 만들어지면 false. */
export function fitsOnCard(card: ApprovalCardInput): boolean {
  if (card.detail === undefined || card.detail === "") return false;
  const body = approvalCardBody("0", card);
  const args = body?.payload.cogs_activity_args as Record<string, unknown> | undefined;
  return args?.detail === card.detail;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return ""; }
}

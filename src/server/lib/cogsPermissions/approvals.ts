/**
 * cogs AI 팀원 승인 — 요청 결합·누름 판정·무효화·실행 인계.
 *
 * permission_request 표는 permissionGate 와 같이 쓰지만, 전역 grant 조회·24시간 grant 는 거치지 않는다.
 * 상태표(요청 status × 사건):
 *   pending        press(검증 통과)→ 결정(CAS) · press(인가 실패)→ 그대로 · expire/policy/session_end → expired+이유
 *   allowed, 인계 전  press→ 처리됨 응답 · expire/policy/session_end → expired+이유(실행권 무효)
 *   allowed, 인계 후  press→ 처리됨 응답 · policy/session_end → 이력 유지, 세션 허용만 폐기
 *   denied/expired  모든 사건 → 그대로
 *   없는 요청       press → 만료 응답
 * 판정에 쓰는 '지금 정책 revision' 은 부르는 쪽이 원본(agents.json)에서 막 읽은 값이다 — 이벤트가 늦어도 옛 카드가 결정되지 않는다.
 */
import type { Database } from "bun:sqlite";
import { migrateCogsPermissions } from "../../db/migrate";
import {
  auditPermissionRow,
  decidePendingRow,
  getPermissionRequest,
  insertPendingPermissionRequest,
  scopeKeyForOperation,
  type PermissionDecisionInput,
  type PermissionOperation,
  type PermissionRequestRow,
  type PermissionRequestStatus,
} from "../permissionGate";
import type { CogsPermissionEvents } from "./events";

export type CardAction = "pg1" | "pgs" | "pga" | "pgd";
export type InvalidationReason = "timeout" | "policy_narrowed" | "policy_changed" | "session_end";

export interface BindingRow {
  request_id: string;
  agent_id: string;
  room_id: string;
  policy_revision: number;
  session_id: string;
  process_gen: string;
  expires_at_ms: number;
  always_rule: string | null;
  card_message_id: number | null;
  invalidation_reason: string | null;
  handed_off_at_ms: number | null;
}

const ACTION_DECISION: Record<CardAction, PermissionDecisionInput> = {
  pg1: "allow_once",
  pgs: "allow_session",
  pga: "allow_always",
  pgd: "deny",
};
const ALLOWED: readonly PermissionRequestStatus[] = ["allowed_once", "allowed_always"];

export function ensureCogsPermissionTables(db: Database): void {
  migrateCogsPermissions(db);
}

export function getBinding(db: Database, requestId: string): BindingRow | undefined {
  return db.prepare("SELECT * FROM cogs_permission_binding WHERE request_id = ?").get(requestId) as BindingRow | undefined;
}

export interface CreateApprovalInput {
  op: PermissionOperation & { agent_id: string };
  roomId: string;
  policyRevision: number;
  sessionId: string;
  processGen: string;
  ttlMs: number;
  nowMs: number;
  /** '항상 허용' 으로 원본에 넣을 정확한 규칙(클로드 규칙 또는 코덱스 경로). 없으면 그 버튼을 주지 않는다. */
  alwaysRule?: string | null;
}

/** 요청 행 + 결합을 한 트랜잭션으로 만든다. */
export function createCogsApproval(db: Database, input: CreateApprovalInput): { request: PermissionRequestRow; binding: BindingRow } {
  return db.transaction(() => {
    const request = insertPendingPermissionRequest(db, input.op);
    db.prepare(
      `INSERT INTO cogs_permission_binding(request_id, agent_id, room_id, policy_revision, session_id, process_gen, expires_at_ms, always_rule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(request.id, input.op.agent_id, input.roomId, input.policyRevision, input.sessionId, input.processGen, input.nowMs + input.ttlMs, input.alwaysRule ?? null);
    auditPermissionRow(db, request, "requested", null, { surface: "cogs", room_id: input.roomId, policy_revision: input.policyRevision });
    return { request, binding: getBinding(db, request.id)! };
  })();
}

export function recordCardMessage(db: Database, requestId: string, messageId: number): void {
  db.prepare("UPDATE cogs_permission_binding SET card_message_id = ? WHERE request_id = ?").run(messageId, requestId);
}

export type PressResult =
  | { kind: "decided"; status: PermissionRequestStatus; decision: PermissionDecisionInput }
  | { kind: "forbidden" }
  | { kind: "processed"; status: PermissionRequestStatus }
  | { kind: "expired" }
  | { kind: "failed" };

export interface PressInput {
  requestId: string;
  action: CardAction;
  /** 누른 사람(cogs 서버가 채운 callback from.id). */
  actorUserId: string | number | undefined;
  /** 봇 주인(cogs 서버가 DB 에서 읽어 callback 에 실은 값). 없으면 아무도 결정 못 한다. */
  ownerUserId: string | number | undefined;
  /** 카드가 있는 방(callback message.chat.id). */
  roomId: string | number | undefined;
  /** 이 브리지가 맡은 팀원. */
  bridgeAgentId: string;
  /** 원본에서 막 읽은 그 팀원 정책 revision(없음·깨짐이면 null). */
  currentRevision: number | null;
  nowMs: number;
  /** '항상 허용' — 원본 정책에 규칙을 넣고 새 revision 을 돌려준다. 실패하면 승인하지 않는다. */
  /** 원본 쓰기 때 이 요청(row.id)만은 무효화에서 빼야 한다 — 바로 뒤에 새 revision 으로 다시 묶는다. */
  persistAlways?: (rule: string, row: PermissionRequestRow) => { ok: true; revision: number } | { ok: false };
  events?: CogsPermissionEvents;
}

/** 카드 누름 하나를 판정한다. 검증 순서: 결합 → 팀원·방 → 주인 → 상태 → 만료 → revision. */
export function pressCogsApproval(db: Database, input: PressInput): PressResult {
  const binding = getBinding(db, input.requestId);
  const row = getPermissionRequest(db, input.requestId);
  if (!binding || !row) return { kind: "expired" };
  if (row.agent_id !== binding.agent_id || binding.agent_id !== input.bridgeAgentId) return { kind: "forbidden" };
  if (input.roomId === undefined || String(input.roomId) !== binding.room_id) return { kind: "forbidden" };
  if (input.ownerUserId === undefined || input.ownerUserId === null || String(input.ownerUserId) === ""
    || input.actorUserId === undefined || String(input.actorUserId) !== String(input.ownerUserId)) {
    return { kind: "forbidden" };
  }
  if (row.status !== "pending") return { kind: "processed", status: row.status };
  if (input.nowMs >= binding.expires_at_ms) {
    invalidateOne(db, binding, row.status, "timeout", input.events);
    return { kind: "expired" };
  }
  if (input.currentRevision === null || input.currentRevision !== binding.policy_revision) {
    invalidateOne(db, binding, row.status, "policy_changed", input.events);
    return { kind: "expired" };
  }

  const decision = ACTION_DECISION[input.action];
  const provenance = { surface: "cogs_member_room", approver_user_id: String(input.actorUserId), room_id: binding.room_id, policy_revision: binding.policy_revision };
  if (decision === "allow_always") {
    // 지속 규칙으로 못 적는 일은 '항상' 을 받지 않는다(버튼도 안 준다).
    if (!binding.always_rule || !input.persistAlways) return { kind: "failed" };
    const saved = input.persistAlways(binding.always_rule, row);
    if (!saved.ok) return { kind: "failed" };
    // 원본에 넣은 그 요청 하나만 새 revision 에 다시 묶는다. 다른 옛 카드는 policy_changed 로 이미 무효다.
    db.prepare("UPDATE cogs_permission_binding SET policy_revision = ? WHERE request_id = ?").run(saved.revision, binding.request_id);
  }
  const changed = db.transaction(() => {
    const n = decidePendingRow(db, row.id, decision, { approver: String(input.actorUserId), provenance });
    if (n === 1 && decision === "allow_session") {
      db.prepare(
        `INSERT OR REPLACE INTO cogs_permission_session_grant(agent_id, session_id, process_gen, scope_key, policy_revision, request_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(binding.agent_id, binding.session_id, binding.process_gen, row.scope_key, binding.policy_revision, row.id);
    }
    if (n === 1) auditPermissionRow(db, row, decision, String(input.actorUserId), provenance);
    return n;
  })();
  if (changed !== 1) {
    const now = getPermissionRequest(db, row.id);
    return { kind: "processed", status: now?.status ?? "expired" };
  }
  const status = getPermissionRequest(db, row.id)!.status;
  input.events?.emit({ type: "approval_decided", request_id: row.id, agent_id: binding.agent_id, status });
  return { kind: "decided", status, decision };
}

function invalidateOne(db: Database, binding: BindingRow, from: PermissionRequestStatus, reason: InvalidationReason, events?: CogsPermissionEvents): boolean {
  const changed = db.transaction(() => {
    const n = db.prepare(
      `UPDATE permission_request SET status = 'expired', decided_at = COALESCE(decided_at, datetime('now'))
        WHERE id = ? AND status = ?`,
    ).run(binding.request_id, from).changes;
    if (n === 1) {
      db.prepare("UPDATE cogs_permission_binding SET invalidation_reason = ? WHERE request_id = ? AND invalidation_reason IS NULL").run(reason, binding.request_id);
    }
    return n;
  })();
  if (changed === 1) {
    events?.emit({ type: "approval_invalidated", request_id: binding.request_id, agent_id: binding.agent_id, room_id: binding.room_id, card_message_id: binding.card_message_id, reason });
  }
  return changed === 1;
}

/**
 * 그 팀원(또는 그 세션)의 아직 실행에 넘기지 않은 요청을 모두 무효화한다.
 * 세션 허용: 축소·세션 종료면 폐기, 넓히기만 했으면 새 revision 으로 옮긴다.
 */
export function invalidateCogsApprovals(
  db: Database,
  input: {
    agentId: string; reason: InvalidationReason; sessionId?: string; newRevision?: number; events?: CogsPermissionEvents;
    /** 바로 직전 정책 revision. 넓히기일 때 이 revision 의 세션 허용만 새 revision 으로 옮긴다(더 오래된 것은 폐기). */
    oldRevision?: number;
    /** 이 revision 에 묶인 것은 남긴다(재시작 정리용 — 원본과 다른 것만 지운다). */
    keepRevision?: number;
    /** '항상 허용' 을 일으킨 그 요청 — 새 revision 에 다시 묶이므로 무효화하지 않는다. */
    exceptRequestId?: string;
  },
): number {
  const rows = db.prepare(
    `SELECT b.*, r.status AS status FROM cogs_permission_binding b JOIN permission_request r ON r.id = b.request_id
      WHERE b.agent_id = ? AND b.invalidation_reason IS NULL AND b.handed_off_at_ms IS NULL
        AND r.status IN ('pending','allowed_once','allowed_always')
        ${input.sessionId !== undefined ? "AND b.session_id = ?" : ""}`,
  ).all(...(input.sessionId !== undefined ? [input.agentId, input.sessionId] : [input.agentId])) as Array<BindingRow & { status: PermissionRequestStatus }>;
  let n = 0;
  for (const b of rows) {
    if (input.keepRevision !== undefined && b.policy_revision === input.keepRevision) continue;
    if (input.exceptRequestId !== undefined && b.request_id === input.exceptRequestId) continue;
    if (invalidateOne(db, b, b.status, input.reason, input.events)) n++;
  }
  if (input.keepRevision !== undefined) {
    db.prepare("DELETE FROM cogs_permission_session_grant WHERE agent_id = ? AND policy_revision <> ?").run(input.agentId, input.keepRevision);
    return n;
  }
  const sessionFilter = input.sessionId !== undefined ? " AND session_id = ?" : "";
  const args = input.sessionId !== undefined ? [input.agentId, input.sessionId] : [input.agentId];
  if (input.reason === "policy_changed" && input.newRevision !== undefined && input.oldRevision !== undefined) {
    // 바로 직전 revision 에 묶인 것만 옮긴다. 그보다 오래된 것(중간에 축소가 있었을 수 있다)은 되살리지 않는다.
    db.prepare(`UPDATE cogs_permission_session_grant SET policy_revision = ? WHERE agent_id = ? AND policy_revision = ?${sessionFilter}`)
      .run(input.newRevision, input.agentId, input.oldRevision, ...args.slice(1));
    db.prepare(`DELETE FROM cogs_permission_session_grant WHERE agent_id = ? AND policy_revision <> ?${sessionFilter}`)
      .run(input.agentId, input.newRevision, ...args.slice(1));
  } else {
    db.prepare(`DELETE FROM cogs_permission_session_grant WHERE agent_id = ?${sessionFilter}`).run(...args);
  }
  return n;
}

/** 시간 지난 pending 을 만료한다(타이머가 부른다). */
export function expireDueCogsApprovals(db: Database, nowMs: number, events?: CogsPermissionEvents): number {
  const rows = db.prepare(
    `SELECT b.*, r.status AS status FROM cogs_permission_binding b JOIN permission_request r ON r.id = b.request_id
      WHERE b.invalidation_reason IS NULL AND b.handed_off_at_ms IS NULL AND b.expires_at_ms <= ?
        AND r.status IN ('pending','allowed_once','allowed_always')`,
  ).all(nowMs) as Array<BindingRow & { status: PermissionRequestStatus }>;
  let n = 0;
  for (const b of rows) if (invalidateOne(db, b, b.status, "timeout", events)) n++;
  return n;
}

/**
 * 허용된 요청을 실행에 넘긴다 — 딱 한 번. 넘기기 직전에 만료·revision·세션·프로세스 세대를 다시 본다.
 * false 면 실행하지 않는다.
 */
export function handOffCogsApproval(
  db: Database,
  input: { requestId: string; agentId: string; sessionId: string; processGen: string; currentRevision: number | null; nowMs: number; events?: CogsPermissionEvents },
): boolean {
  const b = getBinding(db, input.requestId);
  const row = getPermissionRequest(db, input.requestId);
  if (!b || !row || b.agent_id !== input.agentId || b.session_id !== input.sessionId || b.process_gen !== input.processGen) return false;
  if (!ALLOWED.includes(row.status) || b.invalidation_reason !== null || b.handed_off_at_ms !== null) return false;
  if (input.nowMs >= b.expires_at_ms) { invalidateOne(db, b, row.status, "timeout", input.events); return false; }
  if (input.currentRevision === null || input.currentRevision !== b.policy_revision) { invalidateOne(db, b, row.status, "policy_changed", input.events); return false; }
  return db.prepare(
    "UPDATE cogs_permission_binding SET handed_off_at_ms = ? WHERE request_id = ? AND handed_off_at_ms IS NULL AND invalidation_reason IS NULL",
  ).run(input.nowMs, input.requestId).changes === 1;
}

/** 세션 허용이 있나 — 같은 팀원·세션·프로세스 세대·작업 범위·지금 revision 일 때만. */
export function hasCogsSessionGrant(
  db: Database,
  input: { agentId: string; sessionId: string; processGen: string; op: PermissionOperation; currentRevision: number | null },
): boolean {
  if (input.currentRevision === null) return false;
  return Boolean(db.prepare(
    `SELECT 1 FROM cogs_permission_session_grant
      WHERE agent_id = ? AND session_id = ? AND process_gen = ? AND scope_key = ? AND policy_revision = ?`,
  ).get(input.agentId, input.sessionId, input.processGen, scopeKeyForOperation(input.op), input.currentRevision));
}

/** 세션이 끝났다 — 그 세션의 대기·미인계 요청과 세션 허용을 정리한다. 원본의 '항상' 은 건드리지 않는다. */
export function endCogsSession(db: Database, agentId: string, sessionId: string, events?: CogsPermissionEvents): number {
  return invalidateCogsApprovals(db, { agentId, reason: "session_end", sessionId, events });
}

/**
 * 결정을 기다린다 — 이벤트로 깨고, 만료 시각 타이머로 끝낸다(반복 폴링 없음).
 * 같은 프로세스의 이벤트만 듣는다. 다른 프로세스가 결정하면 만료 타이머 때 DB 를 다시 읽어 안다 —
 * 실행 여부는 어쨌든 handOffCogsApproval 이 정한다.
 */
export function waitForCogsDecision(
  db: Database,
  requestId: string,
  events: CogsPermissionEvents,
  deps: { nowMs: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } ,
): Promise<PermissionRequestStatus> {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  return new Promise((resolve) => {
    let done = false;
    let off: () => void = () => {};
    let timer: unknown;
    const finish = () => {
      const row = getPermissionRequest(db, requestId);
      if (!row) { settle("expired"); return true; }
      if (row.status !== "pending") { settle(row.status); return true; }
      return false;
    };
    const settle = (s: PermissionRequestStatus) => {
      if (done) return;
      done = true;
      off();
      if (timer !== undefined) clearTimer(timer);
      resolve(s);
    };
    if (finish()) return;
    off = events.on((e) => {
      if ((e.type === "approval_decided" || e.type === "approval_invalidated") && e.request_id === requestId) finish();
    });
    const b = getBinding(db, requestId);
    const left = Math.max(0, (b?.expires_at_ms ?? 0) - deps.nowMs());
    timer = setTimer(() => {
      if (finish()) return;
      expireDueCogsApprovals(db, deps.nowMs(), events);
      if (!finish()) settle("expired");
    }, left);
  });
}

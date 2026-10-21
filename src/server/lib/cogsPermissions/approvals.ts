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
 * 판정에 쓰는 '지금 정책 도장'(revision:내용 해시)은 부르는 쪽이 원본(agents.json)에서 막 읽은 값이다 — 이벤트가 늦어도 옛 카드가 결정되지 않는다.
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
export type InvalidationReason = "timeout" | "policy_narrowed" | "policy_changed" | "session_end" | "always_persist_failed";

export interface BindingRow {
  request_id: string;
  agent_id: string;
  room_id: string;
  /** 결합한 정책 도장(revision:내용 해시). 같은 revision 이라도 내용이 바뀌면 다르다. */
  policy_stamp: string;
  session_id: string;
  process_gen: string;
  expires_at_ms: number;
  always_rule: string | null;
  card_message_id: number | null;
  invalidation_reason: string | null;
  handed_off_at_ms: number | null;
  /** '항상 허용' 규칙이 원본에 저장됐나. allowed_always 는 1 일 때만 실행에 넘긴다. */
  always_persisted: number;
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
  policyStamp: string;
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
      `INSERT INTO cogs_permission_binding(request_id, agent_id, room_id, policy_stamp, session_id, process_gen, expires_at_ms, always_rule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(request.id, input.op.agent_id, input.roomId, input.policyStamp, input.sessionId, input.processGen, input.nowMs + input.ttlMs, input.alwaysRule ?? null);
    auditPermissionRow(db, request, "requested", null, { surface: "cogs", room_id: input.roomId, policy_stamp: input.policyStamp });
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
  /** 원본에서 막 읽은 그 팀원 정책 도장(없음·깨짐이면 null). */
  currentStamp: string | null;
  nowMs: number;
  /**
   * '항상 허용' — 결정이 이긴 뒤에만 부른다. 원본 정책에 규칙을 넣고 새 도장을 돌려준다.
   * 원본 쓰기 때 이 요청(row.id)은 무효화에서 빼야 한다 — 바로 뒤에 새 도장으로 다시 묶는다.
   * decidedStamp = 결정 당시 정책 도장. 원본이 그사이 바뀌었으면(예: 축소) 쓰지 않고 실패해야 한다.
   */
  persistAlways?: (rule: string, row: PermissionRequestRow, decidedStamp: string) => { ok: true; stamp: string } | { ok: false };
  events?: CogsPermissionEvents;
}

/** 카드 누름 하나를 판정한다. 검증 순서: 결합 → 팀원·방 → 주인 → 상태 → 만료 → 정책 도장. */
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
  if (input.currentStamp === null || input.currentStamp !== binding.policy_stamp) {
    invalidateOne(db, binding, row.status, "policy_changed", input.events);
    return { kind: "expired" };
  }

  const decision = ACTION_DECISION[input.action];
  const provenance = { surface: "cogs_member_room", approver_user_id: String(input.actorUserId), room_id: binding.room_id, policy_stamp: binding.policy_stamp };
  // 지속 규칙으로 못 적는 일은 '항상' 을 받지 않는다(버튼도 안 준다).
  if (decision === "allow_always" && (!binding.always_rule || !input.persistAlways)) return { kind: "failed" };
  // 결정이 먼저다(CAS). 취소·만료·다른 누름에 졌으면 원본에 아무것도 쓰지 않는다.
  const changed = db.transaction(() => {
    const n = decidePendingRow(db, row.id, decision, { approver: String(input.actorUserId), provenance });
    if (n === 1 && decision === "allow_session") {
      db.prepare(
        `INSERT OR REPLACE INTO cogs_permission_session_grant(agent_id, session_id, process_gen, scope_key, policy_stamp, request_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(binding.agent_id, binding.session_id, binding.process_gen, row.scope_key, binding.policy_stamp, row.id);
    }
    if (n === 1) auditPermissionRow(db, row, decision, String(input.actorUserId), provenance);
    return n;
  })();
  if (changed !== 1) {
    const now = getPermissionRequest(db, row.id);
    return { kind: "processed", status: now?.status ?? "expired" };
  }
  if (decision === "allow_always") {
    // 이긴 결정만 원본에 남긴다. 저장 실패 → 그 요청을 닫는다(실행되지 않음).
    // 결정 뒤 저장 전에 죽으면 always_persisted=0 이라 실행에 넘기지 않고, 재시작 정리가 닫는다.
    const saved = input.persistAlways!(binding.always_rule!, row, binding.policy_stamp);
    if (!saved.ok) {
      invalidateOne(db, binding, "allowed_always", "always_persist_failed", input.events);
      return { kind: "failed" };
    }
    db.prepare("UPDATE cogs_permission_binding SET policy_stamp = ?, always_persisted = 1 WHERE request_id = ?").run(saved.stamp, binding.request_id);
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
 * 세션 허용: 축소·세션 종료면 폐기, 넓히기만 했으면 직전 도장 것만 새 도장으로 옮긴다.
 */
export function invalidateCogsApprovals(
  db: Database,
  input: {
    agentId: string; reason: InvalidationReason; sessionId?: string; newStamp?: string; events?: CogsPermissionEvents;
    /** 바로 직전 정책 도장. 넓히기일 때 이 도장의 세션 허용만 새 도장으로 옮긴다(더 오래된 것은 폐기). */
    oldStamp?: string;
    /** 이 도장에 묶인 것은 남긴다(재시작 정리용 — 원본과 다른 것만 지운다). */
    keepStamp?: string;
    /** '항상 허용' 을 일으킨 그 요청 — 새 도장에 다시 묶이므로 무효화하지 않는다. */
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
    if (input.keepStamp !== undefined && b.policy_stamp === input.keepStamp) continue;
    if (input.exceptRequestId !== undefined && b.request_id === input.exceptRequestId) continue;
    if (invalidateOne(db, b, b.status, input.reason, input.events)) n++;
  }
  if (input.keepStamp !== undefined) {
    db.prepare("DELETE FROM cogs_permission_session_grant WHERE agent_id = ? AND policy_stamp <> ?").run(input.agentId, input.keepStamp);
    return n;
  }
  const sessionFilter = input.sessionId !== undefined ? " AND session_id = ?" : "";
  const args = input.sessionId !== undefined ? [input.agentId, input.sessionId] : [input.agentId];
  if (input.reason === "policy_changed" && input.newStamp !== undefined && input.oldStamp !== undefined) {
    // 바로 직전 도장에 묶인 것만 옮긴다. 그보다 오래된 것(중간에 축소가 있었을 수 있다)은 되살리지 않는다.
    db.prepare(`UPDATE cogs_permission_session_grant SET policy_stamp = ? WHERE agent_id = ? AND policy_stamp = ?${sessionFilter}`)
      .run(input.newStamp, input.agentId, input.oldStamp, ...args.slice(1));
    db.prepare(`DELETE FROM cogs_permission_session_grant WHERE agent_id = ? AND policy_stamp <> ?${sessionFilter}`)
      .run(input.agentId, input.newStamp, ...args.slice(1));
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
 * 허용된 요청을 실행에 넘긴다 — 딱 한 번. 넘기기 직전에 만료·정책 도장·세션·프로세스 세대를 다시 본다.
 * '항상 허용' 은 규칙이 원본에 저장된 것만 넘긴다. false 면 실행하지 않는다.
 * beforeClaim 은 시험용 — 읽은 뒤 쓰기 전에 다른 인계를 끼워 넣어 경쟁을 재현한다.
 */
export function handOffCogsApproval(
  db: Database,
  input: { requestId: string; agentId: string; sessionId: string; processGen: string; currentStamp: string | null; nowMs: number; events?: CogsPermissionEvents; beforeClaim?: () => void },
): boolean {
  const b = getBinding(db, input.requestId);
  const row = getPermissionRequest(db, input.requestId);
  if (!b || !row || b.agent_id !== input.agentId || b.session_id !== input.sessionId || b.process_gen !== input.processGen) return false;
  if (!ALLOWED.includes(row.status) || b.invalidation_reason !== null || b.handed_off_at_ms !== null) return false;
  if (row.status === "allowed_always" && b.always_persisted !== 1) return false;
  if (input.nowMs >= b.expires_at_ms) { invalidateOne(db, b, row.status, "timeout", input.events); return false; }
  if (input.currentStamp === null || input.currentStamp !== b.policy_stamp) { invalidateOne(db, b, row.status, "policy_changed", input.events); return false; }
  input.beforeClaim?.();
  return db.prepare(
    "UPDATE cogs_permission_binding SET handed_off_at_ms = ? WHERE request_id = ? AND handed_off_at_ms IS NULL AND invalidation_reason IS NULL",
  ).run(input.nowMs, input.requestId).changes === 1;
}

/** 세션 허용이 있나 — 같은 팀원·세션·프로세스 세대·작업 범위·지금 정책 도장일 때만. */
export function hasCogsSessionGrant(
  db: Database,
  input: { agentId: string; sessionId: string; processGen: string; op: PermissionOperation; currentStamp: string | null },
): boolean {
  if (input.currentStamp === null) return false;
  return Boolean(db.prepare(
    `SELECT 1 FROM cogs_permission_session_grant
      WHERE agent_id = ? AND session_id = ? AND process_gen = ? AND scope_key = ? AND policy_stamp = ?`,
  ).get(input.agentId, input.sessionId, input.processGen, scopeKeyForOperation(input.op), input.currentStamp));
}

/** 세션이 끝났다 — 그 세션의 대기·미인계 요청과 세션 허용을 정리한다. 원본의 '항상' 은 건드리지 않는다. */
export function endCogsSession(db: Database, agentId: string, sessionId: string, events?: CogsPermissionEvents): number {
  return invalidateCogsApprovals(db, { agentId, reason: "session_end", sessionId, events });
}

/** 결정은 됐는데 규칙이 원본에 저장되지 않은 '항상 허용'(저장 전에 멈춤)을 닫는다 — 재시작 정리가 부른다. */
export function closeUnpersistedAlways(db: Database, events?: CogsPermissionEvents): number {
  const rows = db.prepare(
    `SELECT b.*, r.status AS status FROM cogs_permission_binding b JOIN permission_request r ON r.id = b.request_id
      WHERE r.status = 'allowed_always' AND b.always_persisted = 0 AND b.invalidation_reason IS NULL AND b.handed_off_at_ms IS NULL`,
  ).all() as Array<BindingRow & { status: PermissionRequestStatus }>;
  let n = 0;
  for (const b of rows) if (invalidateOne(db, b, b.status, "always_persist_failed", events)) n++;
  return n;
}

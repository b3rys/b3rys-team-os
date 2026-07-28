import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

export const CODEX_SURFACE_TEAM_BUS = "team_bus";
export const CODEX_SURFACE_TELEGRAM = "telegram";

export type CodexRunStatus = "started" | "succeeded" | "failed" | "timed_out" | "deduped";

export interface CodexRunArtifactInput {
  id?: string;
  agentId: string;
  messageId: string;
  threadId: string;
  taskId?: string | null;
  codexSessionId?: string | null;
  status: CodexRunStatus;
  elapsedMs?: number | null;
  replyMessageId?: string | null;
  detail?: string | null;
  artifact?: Record<string, unknown>;
}

export interface CodexSessionRow {
  agent_id: string;
  surface: string;
  conversation_key: string;
  codex_session_id: string;
  last_message_id: string | null;
  last_task_id: string | null;
  updated_at: string;
}

export class CodexSessionStore {
  constructor(private readonly db: Database) {}

  get(agentId: string, surface: string, conversationKey: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT codex_session_id FROM codex_session_map
         WHERE agent_id = ? AND surface = ? AND conversation_key = ?`,
      )
      .get(agentId, surface, conversationKey) as { codex_session_id: string } | undefined;
    return row?.codex_session_id;
  }

  save(input: {
    agentId: string;
    surface: string;
    conversationKey: string;
    codexSessionId: string;
    lastMessageId?: string | null;
    lastTaskId?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO codex_session_map
           (agent_id, surface, conversation_key, codex_session_id, last_message_id, last_task_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(agent_id, surface, conversation_key) DO UPDATE SET
           codex_session_id = excluded.codex_session_id,
           last_message_id = excluded.last_message_id,
           last_task_id = excluded.last_task_id,
           updated_at = datetime('now')`,
      )
      .run(
        input.agentId,
        input.surface,
        input.conversationKey,
        input.codexSessionId,
        input.lastMessageId ?? null,
        input.lastTaskId ?? null,
      );
  }

  clear(agentId: string, surface: string, conversationKey: string): void {
    this.db
      .prepare(
        `DELETE FROM codex_session_map
         WHERE agent_id = ? AND surface = ? AND conversation_key = ?`,
      )
      .run(agentId, surface, conversationKey);
  }

  list(): CodexSessionRow[] {
    return this.db
      .prepare(`SELECT * FROM codex_session_map ORDER BY updated_at DESC`)
      .all() as CodexSessionRow[];
  }
}

export class CodexRunArtifactStore {
  constructor(private readonly db: Database) {}

  record(input: CodexRunArtifactInput): string {
    const id = input.id ?? `codex_run_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO codex_run_artifact
           (id, agent_id, message_id, thread_id, task_id, codex_session_id, status,
            elapsed_ms, reply_message_id, detail, artifact_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        id,
        input.agentId,
        input.messageId,
        input.threadId,
        input.taskId ?? null,
        input.codexSessionId ?? null,
        input.status,
        input.elapsedMs ?? null,
        input.replyMessageId ?? null,
        input.detail ?? null,
        JSON.stringify(input.artifact ?? {}),
      );
    return id;
  }
}

export class CodexInflightStore {
  constructor(private readonly db: Database) {}

  mark(messageId: string, agentId: string, threadId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO codex_inflight (message_id, agent_id, thread_id, started_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(messageId, agentId, threadId);
  }

  clear(messageId: string, agentId: string): void {
    this.db
      .prepare(`DELETE FROM codex_inflight WHERE message_id = ? AND agent_id = ?`)
      .run(messageId, agentId);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM codex_inflight`).get() as { n: number };
    return row.n;
  }
}

export type CodexApprovalState = "pending" | "decided" | "delivered" | "expired" | "orphaned";

export interface CodexApprovalCorrelationInput {
  requestId: string; // = permission_request.id (팝업)
  agentId: string;
  serverRequestId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  operationHash: string;
  processInstance: string;
}

export interface CodexApprovalCorrelationRow {
  request_id: string;
  agent_id: string;
  server_request_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  item_id: string | null;
  operation_hash: string;
  process_instance: string;
  state: CodexApprovalState;
  created_at: string;
  decided_at: string | null;
}

/**
 * codex app-server 승인 팝업 ↔ server-request 상관키 + CAS 상태(Phase1 ③).
 * 팝업(permission_request.id)과 실제 승인 요청을 1:1로 묶고, 상태전이를 CAS(원자적 UPDATE ... WHERE state=)로만 해
 * 중복 버튼(exactly-once)·TTL 늦은승인·서버재시작 orphan·요청 불일치(operation_hash 대조)를 안전 처리한다.
 * ★operation_hash는 승인 전 캡처값이라 실행 직전 변경 검출이 아니고, 권한 grant scope에도 들어가지 않는다(알려진 갭).★
 */
export class CodexApprovalCorrelationStore {
  constructor(private readonly db: Database) {}

  /** 팝업 생성 시 pending 기록. 중복 request_id는 무시(INSERT OR IGNORE = exactly-once). */
  record(input: CodexApprovalCorrelationInput): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO codex_approval_correlation
           (request_id, agent_id, server_request_id, thread_id, turn_id, item_id, operation_hash, process_instance, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      )
      .run(
        input.requestId, input.agentId, input.serverRequestId ?? null,
        input.threadId ?? null, input.turnId ?? null, input.itemId ?? null,
        input.operationHash, input.processInstance,
      );
  }

  get(requestId: string): CodexApprovalCorrelationRow | undefined {
    return this.db
      .prepare(`SELECT * FROM codex_approval_correlation WHERE request_id = ?`)
      .get(requestId) as CodexApprovalCorrelationRow | undefined;
  }

  /** CAS pending→decided. 정확히 1회만 성공(true); 이미 decided/expired/orphaned면 false(중복/무효 차단). */
  markDecided(requestId: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE codex_approval_correlation SET state='decided', decided_at=datetime('now')
         WHERE request_id = ? AND state = 'pending'`,
      )
      .run(requestId);
    return r.changes === 1;
  }

  /**
   * delivery: decided→delivered. ★operation_hash 일치(요청 대조) + process_instance 일치(재시작 재결합 금지)일 때만★ 성공.
   * true면 codex에 승인 전달 허용. false면 거부(불일치/orphan/재시작/이미처리).
   */
  markDelivered(requestId: string, operationHash: string, processInstance: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE codex_approval_correlation SET state='delivered'
         WHERE request_id = ? AND state = 'decided' AND operation_hash = ? AND process_instance = ?`,
      )
      .run(requestId, operationHash, processInstance);
    return r.changes === 1;
  }

  /** 임의 상태(단 delivered 제외)→expired. TTL 늦은승인/무효화용. */
  expire(requestId: string): void {
    this.db
      .prepare(`UPDATE codex_approval_correlation SET state='expired' WHERE request_id = ? AND state != 'delivered'`)
      .run(requestId);
  }

  /** cancel/interrupt: 그 turn의 pending/decided 팝업 전부 expire. 반환=전이 수. */
  expireTurn(threadId: string, turnId: string): number {
    const r = this.db
      .prepare(
        `UPDATE codex_approval_correlation SET state='expired'
         WHERE thread_id = ? AND turn_id = ? AND state IN ('pending','decided')`,
      )
      .run(threadId, turnId);
    return r.changes;
  }

  /** 부팅 시: 다른 process_instance의 pending/decided를 orphaned로(재시작 → 옛 팝업을 새 turn에 재결합 금지). 반환=전이 수. */
  sweepOrphans(currentProcessInstance: string): number {
    const r = this.db
      .prepare(
        `UPDATE codex_approval_correlation SET state='orphaned'
         WHERE process_instance != ? AND state IN ('pending','decided')`,
      )
      .run(currentProcessInstance);
    return r.changes;
  }
}

export function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

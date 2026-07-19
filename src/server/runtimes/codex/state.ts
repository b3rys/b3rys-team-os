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

export function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

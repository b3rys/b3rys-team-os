/**
 * Team Bus v1 — shared type definitions.
 * Interfaces for wake adapters, dispatch results, and sync levels.
 */

// ─── Delivery state (message_recipient outbox) ───────────────────────────────

export type DeliveryState =
  | "pending"
  | "dispatching"
  | "wake_dispatched"
  | "agent_ack"
  | "completed"
  | "failed"
  | "dead_letter"
  | "blocked"   // v1.2: policy-block terminal state (untrusted/hop_limit/pingpong) — distinct from dead_letter (adapter failure)
  | "expired";  // 2026-05-27: ambiguous cases (allowlist_not_enabled / execute_timeout_maybe_partial) — drop, no retry. Sender re-sends if needed.

// ─── Sync levels ─────────────────────────────────────────────────────────────

export type SyncLevel = "none" | "status" | "handoff" | "result";

// ─── Pending dispatch row (from message_recipient + message JOIN) ─────────────

export interface PendingDispatchRow {
  // message_recipient cols
  message_id: string;
  agent_id: string;        // target recipient
  delivery_state: string;
  retry_count: number;
  last_error: string | null;
  // message cols (joined)
  from_agent_id: string;
  to_agent_id: string;
  body: string;
  source: string;          // 'agent' | 'user' | 'system'
  created_by: string | null;
  max_hop: number;
  hop_count: number;
  in_reply_to: string | null;
  parent_message_id: string | null;
  sync: string;            // SyncLevel
  thread_id: string;
  type: string;
  created_at: string;
  priority: string;        // 'low' | 'normal' | 'high'
  attachments_json?: string | null;
  meta_json?: string | null;
}

// ─── Wake adapter interface ───────────────────────────────────────────────────

export interface WakeResult {
  ok: boolean;
  /** true when the lock was busy — retry_count must NOT be incremented */
  deferred?: boolean;
  detail?: string;
}

export interface WakeAdapter {
  wake(targetAgentId: string, row: PendingDispatchRow, teamContext: string): Promise<WakeResult>;
}

// ─── Dispatch result ──────────────────────────────────────────────────────────

export interface DispatchResult {
  messageId: string;
  agentId: string;
  state: DeliveryState;
  detail?: string;
}

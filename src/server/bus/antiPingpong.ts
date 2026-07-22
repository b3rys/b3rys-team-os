/**
 * Team Bus v1 — Anti-pingpong guard.
 *
 * Prevents bot↔bot infinite loops by counting automatic agent rounds in a
 * message chain (via parent_message_id) and blocking dispatch when the count
 * exceeds BUS_MAX_AUTO_ROUNDS (default 6).
 *
 * 2026-06-04: default 2→6. max=2 는 1 round-trip(Q→A) 후 후속을 막아서,
 * OWNER 가 지시한 정당한 다단계 기술 협의(질문→답→재질문→답…)까지 dispatch_blocked
 * 되었다(오늘 "member 무응답"의 실제 원인). 6 = 3 round-trip 허용으로 실무 협의를
 * 통과시키되, 진짜 runaway 루프는 여전히 6 에서 bounded (무한 아님). 봇이 무의미한
 * 반복(인사·동의·감사)을 안 하는 건 TEAM-OS §5 규범이 1차로 담당하고, 이 가드는 backstop.
 *
 * TRUSTED-SOURCE guard: only messages from known agents/users trigger wake.
 * Messages with unknown source/created_by or exceeding max_hop are rejected.
 */

import type { Database } from "bun:sqlite";
import type { PendingDispatchRow } from "./types";
import { countAutoRounds } from "../db/inboxQueries";

export const MAX_AUTO_ROUNDS = Number(process.env.BUS_MAX_AUTO_ROUNDS ?? 6);

// Agents registered in agents.json at runtime (passed in by dispatcher)
export type AgentRoster = ReadonlySet<string>;

export interface PingpongVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * Check whether this dispatch should be allowed.
 *
 * Blocks if:
 * 1. source is not 'agent', 'user', or 'system'   (trusted-source check)
 * 2. from_agent_id is not in the known agent roster AND not a reserved sender
 * 3. hop_count >= max_hop                          (hop limit)
 * 4. auto round count >= MAX_AUTO_ROUNDS            (pingpong limit)
 */
export function checkPingpong(
  db: Database,
  row: PendingDispatchRow,
  agentRoster: AgentRoster,
): PingpongVerdict {
  const RESERVED_SENDERS = new Set(["user", "system", "moderator"]);

  // 1. Trusted-source check
  if (!["agent", "user", "system"].includes(row.source)) {
    return { allowed: false, reason: `untrusted_source:${row.source}` };
  }

  // 2. created_by / from_agent_id must be known
  const sender = row.created_by ?? row.from_agent_id;
  if (!RESERVED_SENDERS.has(sender) && !agentRoster.has(sender)) {
    return { allowed: false, reason: `unknown_sender:${sender}` };
  }

  // 3. Hop limit
  if (row.hop_count >= row.max_hop) {
    return {
      allowed: false,
      reason: `hop_limit_exceeded:hop_count=${row.hop_count},max_hop=${row.max_hop}`,
    };
  }

  // 4. Auto-round (bot↔bot pingpong) limit
  // Only apply when the message is from an agent (not from a user).
  if (row.source === "agent" && row.parent_message_id) {
    const rounds = countAutoRounds(db, row.parent_message_id);
    if (rounds >= MAX_AUTO_ROUNDS) {
      return {
        allowed: false,
        reason: `pingpong_limit_exceeded:rounds=${rounds},max=${MAX_AUTO_ROUNDS}`,
      };
    }
  }

  return { allowed: true, reason: "ok" };
}

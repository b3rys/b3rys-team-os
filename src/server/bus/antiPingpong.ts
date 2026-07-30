/**
 * Team Bus v1 — Anti-pingpong guard.
 *
 * Prevents bot↔bot infinite loops by counting automatic agent rounds in a
 * message chain (via parent_message_id) and blocking dispatch when the count
 * exceeds BUS_MAX_AUTO_ROUNDS (default 8).
 *
 * 2026-06-04: default 2→6. max=2 는 1 round-trip(Q→A) 후 후속을 막아서,
 * GD 가 지시한 정당한 다단계 기술 협의(질문→답→재질문→답…)까지 dispatch_blocked
 * 되었다(오늘 "코덱스 무응답"의 실제 원인). 6 = 3 round-trip 허용으로 실무 협의를
 * 통과시키되, 진짜 runaway 루프는 여전히 6 에서 bounded (무한 아님). 봇이 무의미한
 * 반복(인사·동의·감사)을 안 하는 건 TEAM-OS §5 규범이 1차로 담당하고, 이 가드는 backstop.
 *
 * TRUSTED-SOURCE guard: only messages from known agents/users trigger wake.
 * Messages with unknown source/created_by or exceeding max_hop are rejected.
 */

import type { Database } from "bun:sqlite";
import type { PendingDispatchRow } from "./types";
import { countAutoRounds } from "../db/inboxQueries";

// 2026-07-27: 기본 6→8 (GD 결정). ★홉 이중증가 수정(#86)이 배포된 뒤에 올렸다★ —
//   그 전엔 홉이 메시지당 2씩 올라 실효 한도가 8메시지였고, 체인을 먼저 올리면 ★홉이 먼저 걸려★
//   체인 상향이 아무 효과가 없었다. 순서를 지켜야 계산이 맞는다.
//   실측 근거: 어제 스티브의 정당한 리뷰 왕복이 6에서 끊겼다(dispatch_blocked).
//   8 = 4 round-trip. 진짜 runaway 는 여전히 8에서 bounded 다.
export const MAX_AUTO_ROUNDS = Number(process.env.BUS_MAX_AUTO_ROUNDS ?? 8);

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
      // ★"rounds" 는 왕복 횟수가 아니라 체인에 쌓인 agent 메시지 개수다.★
      // countAutoRounds 는 parent 체인을 거슬러 올라가며 source='agent' 인 것을 하나씩 센다.
      // 그래서 rounds=8 은 ★왕복 8회가 아니라 메시지 8건 = 왕복 4회★ 다.
      // 2026-07-30: 이 숫자를 왕복으로 읽은 팀원 둘이 "8왕복이나 했다" 로 판단했다.
      // 실제로는 4왕복·53분짜리 코드리뷰였다. 숫자 자체는 맞으므로 세는 법은 그대로 두고,
      // ★읽는 사람이 오해하지 않게 단위를 같이 적는다.★
      const exchanges = Math.floor(rounds / 2);
      return {
        allowed: false,
        reason:
          `pingpong_limit_exceeded:messages=${rounds},max=${MAX_AUTO_ROUNDS}` +
          `(왕복 약 ${exchanges}회 — 이 숫자는 왕복이 아니라 메시지 개수다)`,
      };
    }
  }

  return { allowed: true, reason: "ok" };
}

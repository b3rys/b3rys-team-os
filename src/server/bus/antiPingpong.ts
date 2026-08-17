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
import { RESERVED_AGENT_IDS as INGRESS_RESERVED } from "../../shared/envelopeSchema";

/** 입구 예약어에서 ★발신자가 될 수 있는 것만★ 남긴다. broadcast 는 목적지라 제외. */
export const RESERVED_SENDER_IDS: ReadonlySet<string> = new Set(
  [...INGRESS_RESERVED].filter((id) => id !== "broadcast"),
);

// 2026-07-27: 기본 6→8. ★홉 이중증가 수정(#86)이 배포된 뒤에 올렸다★ —
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
  // ★사본을 두지 않는다★ — 공유 상수에서 깎아 쓴다(빌 리뷰 2026-08-06: 사본이 남으면
  //   "여기가 정본" 이라는 주석이 거짓이 된다). ★broadcast 는 뺀다★: 그건 ★수신 주소★ 이지
  //   발신자가 아니다. 여기 넣으면 from='broadcast' 위조가 신뢰-출처 문을 통과하게 되어
  //   ★게이트가 넓어진다★ — 사본을 없애자고 문을 열지는 않는다.

  // 1. Trusted-source check
  if (!["agent", "user", "system"].includes(row.source)) {
    return { allowed: false, reason: `untrusted_source:${row.source}` };
  }

  // 2. created_by / from_agent_id must be known
  const sender = row.created_by ?? row.from_agent_id;
  if (!RESERVED_SENDER_IDS.has(sender) && !agentRoster.has(sender)) {
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
      //
      // ★환산 횟수는 일부러 넣지 않는다(Codex 리뷰 2026-07-30).★ 처음엔 Math.floor(rounds/2) 로
      //   "왕복 약 N회" 를 붙였는데, 홀수에서 과소표시한다 — 7건은 3왕복 + 편도 1건인데 "약 3회" 가 된다.
      //   ★그건 내가 고치려던 것과 같은 종류의 오해를 새로 만드는 것이다★ — 사람은 반올림된 숫자도
      //   정확한 값으로 읽는다. 그래서 유도 숫자를 빼고 ★센 것과 그 단위만★ 말한다.
      return {
        allowed: false,
        reason:
          `pingpong_limit_exceeded:messages=${rounds},max=${MAX_AUTO_ROUNDS}` +
          `(체인에 쌓인 agent 메시지 개수다 — 왕복 횟수가 아니다. 한 왕복은 메시지 2건)`,
      };
    }
  }

  return { allowed: true, reason: "ok" };
}

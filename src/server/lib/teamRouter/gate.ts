import type { AgentRecord } from "../../types";
import { aliasesFor, escapeRegex } from "./mention";
import { hasCapability } from "../capabilities";

// ─── owner-gate suppress 판단: owner 로직의 단일 출처 (OWNER 2098 — 판단은 서버 한 곳) ───
// gate/react 훅은 thin-client로 이 결정만 따른다(자체 로직 없음). 룰 변경은 여기서만 → 서버 재시작으로 배포.
const CONFIDENT_OWNER_REASONS = new Set(["explicit_mention", "reply_author", "active_assignee_followup"]);

/** "확실 owner" reason 인가 (default_intake/default_step/broadcast/ask_owner 등 추측·전체는 아님). */
export function isConfidentOwner(reason: string): boolean {
  return CONFIDENT_OWNER_REASONS.has(reason);
}

/** selfId 봇이 이 메시지에 응답·👀를 억제해야 하는가 = 확실 owner가 있는데 내가 그 owner가 아님.
 *  추측성/전체/에러는 false(fail-open). 훅은 이 결과만 obey 한다. */
export function shouldSuppress(reason: string, targetAgentIds: string[], selfId: string): boolean {
  if (!selfId) return false;
  return isConfidentOwner(reason) && !targetAgentIds.includes(selfId);
}

// 선두 호격 — 메시지 맨앞의 @이름이 수신자(orchestrator). "@member. ~", "@member야 ~", "@member ~".
export function leadingAddressee(text: string, agents: AgentRecord[]): string | null {
  for (const agent of agents) {
    if (hasCapability(agent, "restricted_mention")) {
      // restricted_mention: 선두 @별칭(조사 없는 명시 호격)만 owner. 토큰은 aliasesFor 에서 생성.
      // codex 기준 기존 동작 보존: aliasesFor 가 codex/Codex/member/@봇유저명을 모두 제공하므로
      // 대소문자 분기(@codex|@Codex)도 그대로 커버된다(원본도 /i 없이 둘을 명시 나열).
      const toks = aliasesFor(agent)
        .map((a) => escapeRegex(a.replace(/^@/, "")))
        .filter(Boolean);
      if (toks.length && new RegExp("^\\s*(@(?:" + toks.join("|") + "))([.,!?\\s]|$)").test(text)) {
        return agent.id;
      }
      continue;
    }
    for (const alias of aliasesFor(agent)) {
      const raw = alias.startsWith("@") ? alias : "@" + alias;
      const a = escapeRegex(raw);
      if (new RegExp("^\\s*" + a + "([.,!?\\s]|야|아|님|$)", "i").test(text)) return agent.id;
    }
  }
  return null;
}

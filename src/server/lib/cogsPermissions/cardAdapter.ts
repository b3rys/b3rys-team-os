/**
 * 카드 표시 구독자 — 승인이 무효가 되면(정책 바뀜·만료·세션 종료) 그 카드의 버튼을 걷는다.
 * 표시 실패는 취소를 되돌리지 않는다: 남은 버튼을 눌러도 결정 경로가 만료로 답한다.
 */
import { readFileSync } from "node:fs";
import { clearApprovalCardButtons } from "./card";
import type { CogsPermissionEvents } from "./events";

export interface CardAdapterDeps {
  /** 그 팀원 봇의 cogs 주소(channel.api_base). 모르면 null. */
  apiBaseOf: (agentId: string) => string | null;
  /** 그 팀원 봇 토큰 파일 경로(0600). */
  tokenFileOf: (agentId: string) => string;
  fetchFn?: typeof fetch;
}

export function subscribeCardAdapter(events: CogsPermissionEvents, deps: CardAdapterDeps): () => void {
  return events.on(async (e) => {
    if (e.type !== "approval_invalidated" || e.card_message_id === null) return;
    const apiBase = deps.apiBaseOf(e.agent_id);
    if (!apiBase) return;
    let token = "";
    try { token = readFileSync(deps.tokenFileOf(e.agent_id), "utf-8").trim(); } catch { return; }
    if (!token) return;
    const ok = await clearApprovalCardButtons(apiBase, token, e.room_id, e.card_message_id, deps.fetchFn ?? fetch);
    if (!ok) console.warn(`[cogs-permissions] 카드 버튼 걷기 실패(취소는 그대로) agent=${e.agent_id} request=${e.request_id}`);
  });
}

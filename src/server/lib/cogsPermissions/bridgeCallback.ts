/**
 * cogs 방 승인 카드 누름 처리 — 브리지가 b3chat 채널일 때만 부른다(텔레그램은 기존 handleApprovalCallback).
 *
 * 누가 눌렀나(from.id)·어느 방인가(message.chat.id)·봇 주인(cogs_bot_owner_id)은 cogs 서버가 채운 값이다
 * (봇 토큰으로 받은 getUpdates). 앱이 보낸 값이나 callback_data 로 승인자·팀원을 정하지 않는다.
 * 메시지 수신 허용 목록(CODEX_ALLOW_FROM = 방 id)은 여기서 인가에 쓰지 않는다 — 방과 사람은 다른 값이다.
 */
import { openDb } from "../../db/migrate";
import { ensureCogsPermissionTables, pressCogsApproval, type CardAction, type PressResult } from "./approvals";
import { clearApprovalCardButtons } from "./card";
import { createCogsPolicyService, currentCogsRevision } from "./service";

export interface CogsCallbackQuery {
  id: string;
  data?: string;
  from?: { id: number };
  message?: { message_id: number; chat: { id: number } };
  /** cogs 서버가 DB 의 봇 owner_id 로 채운다. 옛 서버에는 없다 → 아무도 결정하지 못한다. */
  cogs_bot_owner_id?: number;
}

export interface CogsCallbackDeps {
  apiBase: string;
  agentId: string;
  registryPath: string;
  dbPath: string;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
}

const DATA_RE = /^(pg1|pgs|pga|pgd):(prm_[a-f0-9]+)$/;

export async function handleCogsApprovalCallback(token: string, cb: CogsCallbackQuery, deps: CogsCallbackDeps): Promise<PressResult["kind"] | "ignored"> {
  const m = DATA_RE.exec(cb.data ?? "");
  if (!m) return "ignored";
  const doFetch = deps.fetchFn ?? fetch;
  const answer = (code: string, alert = false, args: Record<string, unknown> = {}) =>
    doFetch(`${deps.apiBase}/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: cb.id, text_code: code, text_args: args, show_alert: alert }),
    }).catch(() => undefined);

  const db = openDb(deps.dbPath);
  let result: PressResult;
  try {
    ensureCogsPermissionTables(db);
    const svc = createCogsPolicyService({ registryPath: deps.registryPath, db });
    result = pressCogsApproval(db, {
      requestId: m[2]!,
      action: m[1] as CardAction,
      actorUserId: cb.from?.id,
      ownerUserId: cb.cogs_bot_owner_id,
      roomId: cb.message?.chat.id,
      bridgeAgentId: deps.agentId,
      currentRevision: currentCogsRevision(deps.registryPath, deps.agentId),
      nowMs: (deps.nowMs ?? Date.now)(),
      persistAlways: (rule, row) => svc.addAlways(deps.agentId, rule, row.id),
    });
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }

  // 인가 실패는 버튼을 남긴다 — 주인은 아직 누를 수 있어야 한다.
  if (result.kind === "forbidden") { await answer("callback_forbidden", true); return result.kind; }
  if (result.kind === "failed") { await answer("callback_failed", true); return result.kind; }
  if (result.kind === "processed") await answer("callback_processed", false, { status: result.status });
  else if (result.kind === "expired") await answer("callback_expired");
  else await answer(`callback_${result.decision}`);
  if (cb.message) await clearApprovalCardButtons(deps.apiBase, token, cb.message.chat.id, cb.message.message_id, doFetch).catch(() => false);
  return result.kind;
}

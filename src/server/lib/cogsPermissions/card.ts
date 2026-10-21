/**
 * cogs 승인 카드 전송 — 런타임 중립. 무엇을 하려는지(operation_code·detail·risks)는 부르는 쪽이 정한다.
 * 계약: cogs docs/ui-strings-contract.md "approval_required" — 서버·브리지는 코드만, 글은 앱이 쓴다.
 * 코덱스 요청 해석은 appServerPopup 에 남고, 텔레그램 HTML 카드는 여기와 무관하다.
 */
export interface ApprovalCardInput {
  requestId: string;
  operationCode: string;
  detail?: string;
  grantRoot?: string;
  risks: string[];
  /** '항상 허용' 버튼을 줄지. 위험 표시가 있거나 지속 규칙으로 못 적는 일이면 false. */
  allowAlways: boolean;
}

export interface CardSendResult { ok: boolean; messageId?: number }

const ARGS_LIMIT = 512;

/** 카드 본문. 인자는 서버 한도(512바이트) 안 — detail 부터 뺀다. 그래도 넘으면 null. */
export function approvalCardBody(chatId: string, input: ApprovalCardInput): { payload: Record<string, unknown>; buttons: Array<{ text_code: string; callback_data: string }> } | null {
  const args: Record<string, string | number> = { request_id: input.requestId, operation_code: input.operationCode };
  if (input.detail !== undefined) args.detail = input.detail;
  if (input.risks.length) args.risks = input.risks.join(",");
  if (input.grantRoot) args.grant_root = input.grantRoot;
  if (Buffer.byteLength(JSON.stringify(args)) > ARGS_LIMIT) delete args.detail;
  if (Buffer.byteLength(JSON.stringify(args)) > ARGS_LIMIT) return null;
  const button = (text_code: string, action: string) => ({ text_code, callback_data: `${action}:${input.requestId}` });
  const buttons = input.allowAlways
    ? [button("approval_allow_once", "pg1"), button("approval_allow_session", "pgs"), button("approval_allow_always", "pga"), button("approval_deny", "pgd")]
    : [button("approval_allow_once", "pg1"), button("approval_allow_session", "pgs"), button("approval_deny", "pgd")];
  return {
    payload: { chat_id: chatId, text: "", cogs_response_state: "activity", cogs_activity_code: "approval_required", cogs_activity_args: args },
    buttons,
  };
}

async function post(apiBase: string, token: string, method: string, body: Record<string, unknown>, doFetch: typeof fetch): Promise<{ ok: boolean; reason: string; messageId?: number }> {
  try {
    const res = await doFetch(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error_code?: number; description?: string; result?: { message_id?: number } };
    if (res.ok && j.ok === true) return { ok: true, reason: "", messageId: typeof j.result?.message_id === "number" ? j.result.message_id : undefined };
    return { ok: false, reason: `code=${j.error_code ?? res.status} ${j.description ?? ""}`.trim() };
  } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
}

/**
 * 카드를 보낸다. 버튼 전송이 거절되면 버튼 없이 한 번 더 보낸다(대화에는 남게).
 * 버튼 없는 카드는 누를 수 없으므로 만료까지 기다린 뒤 실행되지 않는다.
 */
export async function sendApprovalCard(
  apiBase: string, token: string, chatId: string, input: ApprovalCardInput, doFetch: typeof fetch,
  log: { agentId: string } = { agentId: "" },
): Promise<CardSendResult> {
  const body = approvalCardBody(chatId, input);
  if (!body) {
    console.warn(`[codex-approval] metadata exceeds limit request=${input.requestId}`);
    return { ok: false };
  }
  const first = await post(apiBase, token, "sendMessage", { ...body.payload, reply_markup: { inline_keyboard: [body.buttons] } }, doFetch);
  if (first.ok) return { ok: true, messageId: first.messageId };
  console.warn(`[codex-approval] b3chat 승인 버튼 전송 실패 → 글자만 재전송: agent=${log.agentId} request=${input.requestId} ${first.reason}`);
  const second = await post(apiBase, token, "sendMessage", body.payload, doFetch);
  if (!second.ok) console.warn(`[codex-approval] ★b3chat 승인 요청 전송 실패 — 대화에 안 남았다★ agent=${log.agentId} request=${input.requestId} ${second.reason}`);
  return { ok: second.ok, messageId: second.messageId };
}

/** 카드 버튼을 걷는다(결정·취소·만료 뒤). 실패해도 취소는 그대로다 — 남은 버튼을 눌러도 서버가 만료로 답한다. */
export async function clearApprovalCardButtons(apiBase: string, token: string, chatId: string | number, messageId: number, doFetch: typeof fetch): Promise<boolean> {
  const r = await post(apiBase, token, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }, doFetch);
  return r.ok;
}

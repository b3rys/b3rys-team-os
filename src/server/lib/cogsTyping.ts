import { CogsApiRejected, CogsDeliveryUnknown, cogsCall, type CogsInbox } from "./cogsRelay";

/**
 * cogs 에서 받은 말을 팀원 세션에 넣은 뒤, 그 팀원이 답을 낼 때까지 그 방에 '입력 중'(sendChatAction typing)을 계속 보낸다.
 * 팀원 세션은 cogs 를 직접 모르니(버스로 받고 버스로 답한다) b3os 가 대신 보낸다. 앱은 이 신호로 팀원이 아직 일하는 줄 안다.
 * 단위는 (팀원, cogs 방)이다 — typing 은 방마다 봇 하나의 상태이고, 답이 어느 버스 thread 로 오든 실제로 올라가는 곳은 그 방이다.
 * 멈춤: 그 방에 답을 보낼 때 · 글 답 없이 끝낼 때(no_reply) · 상한 시간이 지날 때.
 * typing 은 보조 신호라 실패해도 조용히 넘긴다(답·주입과 무관). 서버를 다시 띄우면 기억이 사라지고 멈춘다.
 */
export interface CogsTypingOptions {
  intervalMs?: number;
  capMs?: number;
  call?: typeof cogsCall;
  replyToMessageId?: number;
}

const DEFAULT_INTERVAL_MS = 4000;
const DEFAULT_CAP_MS = 10 * 60 * 1000;

interface Processing {
  interval: ReturnType<typeof setInterval>;
  cap: ReturnType<typeof setTimeout>;
  call: typeof cogsCall;
  config: Pick<CogsInbox, "api_base">;
  token: string;
  accepting: boolean;
  finishing?: boolean;
  messageId?: number;
  replyToMessageId?: number;
  lastCode?: string;
  uncertainOpen?: boolean;
  uncertainComplete?: boolean;
  pending: Promise<unknown>;
}
const active = new Map<string, Processing>();

function key(agentId: string, chatId: string): string {
  return `${agentId}\n${chatId}`;
}

/** 같은 방에서 다시 부르면 상한 시계를 처음부터 다시 잰다(새 말이 왔다). */
export function startCogsTyping(agentId: string, chatId: string, config: Pick<CogsInbox, "api_base">, token: string,
  opts: CogsTypingOptions = {}): void {
  const previous = active.get(key(agentId, chatId));
  if (previous?.accepting) {
    clearTimeout(previous.cap);
    previous.cap = setTimeout(() => stopCogsTyping(agentId, chatId), opts.capMs ?? DEFAULT_CAP_MS);
    (previous.cap as { unref?: () => void }).unref?.();
    return; // A new inbound message in this room retains its one response bubble.
  }
  stopCogsTyping(agentId, chatId);
  const call = opts.call ?? cogsCall;
  const send = () => { call(config, token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => { /* 보조 신호 */ }); };
  const k = key(agentId, chatId);
  const interval = setInterval(send, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const cap = setTimeout(() => stopCogsTyping(agentId, chatId), opts.capMs ?? DEFAULT_CAP_MS);
  (interval as { unref?: () => void }).unref?.();
  (cap as { unref?: () => void }).unref?.();
  active.set(k, { interval, cap, call, config, token, replyToMessageId: opts.replyToMessageId, accepting: true, pending: Promise.resolve() });
  send();
}

export function stopCogsTyping(agentId: string, chatId: string): void {
  const k = key(agentId, chatId);
  const entry = active.get(k);
  if (!entry) return;
  clearInterval(entry.interval);
  clearTimeout(entry.cap);
  active.delete(k);
  entry.accepting = false;
  // Wait for an already-sent opening request before cancelling its returned id.
  void entry.pending.then(async () => {
    if (entry.messageId !== undefined) {
      await entry.call(entry.config, entry.token, "editMessageText", {
        chat_id: chatId, message_id: entry.messageId, text: "", cogs_response_state: "cancelled",
      });
    }
  }).catch(() => { /* Auxiliary cleanup never logs tool input or remote bodies. */ });
}

/** Only canonical activity codes, never tool arguments, reach the response message. */
export async function updateCogsProgress(agentId: string, chatId: string, code: string): Promise<boolean> {
  const entry = active.get(key(agentId, chatId));
  if (!entry?.accepting || process.env.B3OS_COGS_PROGRESS === "0") return false;
  const next = entry.pending.then(async () => {
    if (!entry.accepting || entry.uncertainOpen) return false;
    if (entry.lastCode === code) return true;
    const body = { chat_id: chatId, text: "", cogs_response_state: "activity", cogs_activity_code: code, cogs_activity_args: {} };
    if (entry.messageId !== undefined) {
      await entry.call(entry.config, entry.token, "editMessageText", { ...body, message_id: entry.messageId });
    } else {
      try {
        const result = await entry.call(entry.config, entry.token, "sendMessage", { ...body, ...(entry.replyToMessageId !== undefined ? { reply_to_message_id: entry.replyToMessageId } : {}) });
        if (!Number.isSafeInteger(result?.message_id)) throw new CogsDeliveryUnknown();
        entry.messageId = result.message_id;
      } catch (error) {
        if (error instanceof CogsDeliveryUnknown) entry.uncertainOpen = true;
        throw error;
      }
    }
    entry.lastCode = code;
    return true;
  });
  entry.pending = next.catch(() => {});
  return next;
}

/** A known response id permits retrying the identical edit without a duplicate answer. */
export class CogsProgressEditRetry extends Error {
  constructor() { super("cogs_progress_edit_failed"); }
}

/** Stop accepting tools synchronously, then replace the activity bubble with the first reply. */
export async function completeCogsProgress(agentId: string, chatId: string, text: string): Promise<number | undefined> {
  const k = key(agentId, chatId);
  const entry = active.get(k);
  if (!entry) return undefined;
  if (entry.finishing) {
    await entry.pending;
    if (entry.messageId !== undefined) throw new CogsProgressEditRetry();
    return undefined; // Subsequent reply parts must become new messages.
  }
  entry.finishing = true;
  entry.accepting = false;
  clearInterval(entry.interval);
  const next = entry.pending.then(async () => {
    if (entry.messageId !== undefined) {
      try {
        await entry.call(entry.config, entry.token, "editMessageText", {
          chat_id: chatId, message_id: entry.messageId, text, cogs_response_state: "complete",
        });
      } catch (error) {
        if (error instanceof CogsApiRejected && !entry.uncertainComplete) {
          // The server explicitly rejected the answer edit: close the auxiliary bubble,
          // then let the inbox send the real answer through the normal reply path.
          await entry.call(entry.config, entry.token, "editMessageText", {
            chat_id: chatId, message_id: entry.messageId, text: "", cogs_response_state: "cancelled",
          }).catch(() => {});
          entry.messageId = undefined;
        } else {
          // A lost edit ACK may already contain the answer. Retain its id for safe retry.
          entry.uncertainComplete = true;
          entry.finishing = false;
          throw new CogsProgressEditRetry();
        }
      }
    }
    clearTimeout(entry.cap);
    if (active.get(k) === entry) active.delete(k);
    const completedId = entry.messageId;
    entry.messageId = undefined;
    return completedId;
  });
  entry.pending = next.catch(() => {});
  return next;
}

/** 시험용 — 지금 '입력 중'을 보내고 있는 방 수. */
export function activeCogsTypingCount(): number {
  return active.size;
}

/** Progress is accepted only while this member is processing this room. */
export function isActive(agentId: string, chatId: string): boolean {
  return active.get(key(agentId, chatId))?.accepting === true;
}

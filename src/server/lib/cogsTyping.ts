import { cogsCall, type CogsInbox } from "./cogsRelay";

/**
 * cogs 에서 받은 말을 팀원 세션에 넣은 뒤, 그 팀원이 답을 낼 때까지 그 방에 '입력 중'(sendChatAction typing)을 계속 보낸다.
 * 팀원 세션은 cogs 를 직접 모르니(버스로 받고 버스로 답한다) b3os 가 대신 보낸다. 앱은 이 신호로 팀원이 아직 일하는 줄 안다.
 * 멈춤: 같은 thread 로 답을 cogs 에 보낼 때 · 글 답 없이 끝낼 때(no_reply) · 상한 시간이 지날 때.
 * typing 은 보조 신호라 실패해도 조용히 넘긴다(답·주입과 무관). 서버를 다시 띄우면 기억이 사라지고 멈춘다.
 */
export interface CogsTypingOptions {
  intervalMs?: number;
  capMs?: number;
  call?: typeof cogsCall;
}

const DEFAULT_INTERVAL_MS = 4000;
const DEFAULT_CAP_MS = 10 * 60 * 1000;

const active = new Map<string, { interval: ReturnType<typeof setInterval>; cap: ReturnType<typeof setTimeout> }>();

function key(agentId: string, threadId: string): string {
  return `${agentId}\n${threadId}`;
}

/** 같은 thread 에서 다시 부르면 상한 시계를 처음부터 다시 잰다(새 말이 왔다). */
export function startCogsTyping(agentId: string, threadId: string, config: Pick<CogsInbox, "api_base">, token: string, chatId: string,
  opts: CogsTypingOptions = {}): void {
  stopCogsTyping(agentId, threadId);
  const call = opts.call ?? cogsCall;
  const send = () => { call(config, token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => { /* 보조 신호 */ }); };
  const k = key(agentId, threadId);
  const interval = setInterval(send, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const cap = setTimeout(() => stopCogsTyping(agentId, threadId), opts.capMs ?? DEFAULT_CAP_MS);
  (interval as { unref?: () => void }).unref?.();
  (cap as { unref?: () => void }).unref?.();
  active.set(k, { interval, cap });
  send();
}

export function stopCogsTyping(agentId: string, threadId: string): void {
  const k = key(agentId, threadId);
  const entry = active.get(k);
  if (!entry) return;
  clearInterval(entry.interval);
  clearTimeout(entry.cap);
  active.delete(k);
}

/** 시험용 — 지금 '입력 중'을 보내고 있는 thread 수. */
export function activeCogsTypingCount(): number {
  return active.size;
}

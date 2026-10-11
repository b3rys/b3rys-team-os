// direct_to_gd 보고는 ★보낸 팀원의 봇★ 으로 팀장 DM 에 게시된다(inbox.ts 릴레이).
// 그 팀원의 텔레그램 수신(poller)이 죽어 있으면 팀장이 그 대화에 답해도 아무도 받지 못하고, 텔레그램은
// 안 가져간 업데이트를 24시간까지만 보관한다. 그래서 릴레이 본문 끝에 시스템 문구 한 줄로 그 사실과
// 답을 받을 수 있는 팀원을 적는다.
//
// 판정: 발신 시점에 런타임 essentials 를 직접 잰다(health 틱을 기다리지 않는다). "수신이 죽었다" 는
//   `poller:` 로 시작하는 항목만 본다 — 토큰·plist 같은 다른 항목은 수신 여부를 말하지 않고, poller 항목이
//   없는 런타임(openclaw·hermes_agent)은 이 경고 대상이 아니다.
// 대상: 채널이 텔레그램인 발신자만. 다른 채널(b3chat 등)은 수신 방식이 달라 이 판정·문구가 맞지 않는다.
// 범위 밖: 수신이 살아 있을 때 보낸 보고에 팀장이 나중에 답하는 경우(그 시점엔 알 수 없다).
import type { AgentRecord } from "../types";
import { checkEssentialSettings, type RuntimeEssentials } from "./runtimeEssentials";
import { pickOpNoticeRecipient } from "./opNotice";
import { memberChannel } from "./memberChannel";
import { TELEGRAM_SEND_LIMIT } from "./telegramBotSend";

type EssentialsAgent = Pick<AgentRecord, "id" | "runtime" | "openclaw_agent_id" | "hermes_profile">;

export function receiverDownFromMissing(missing: readonly string[]): boolean {
  return missing.some((m) => m.startsWith("poller:"));
}

export async function isTelegramReceiverDown(
  agent: EssentialsAgent,
  registry?: Record<string, RuntimeEssentials>,
): Promise<boolean> {
  const r = await checkEssentialSettings(agent, registry);
  return receiverDownFromMissing(r.missing ?? []);
}

const nameOf = (a: Pick<AgentRecord, "id" | "display_name">) => a.display_name?.trim() || a.id;

/** 표시 이름으로 쓴다. "— [b3os]" 로 시작해 팀원 본문이 아니라 시스템이 붙인 줄임을 보인다. */
export function buildDeadReceiverNote(
  sender: Pick<AgentRecord, "id" | "display_name">,
  replyTo: Pick<AgentRecord, "id" | "display_name"> | null,
): string {
  const head = `— [b3os] ⚠ 지금 ${nameOf(sender)}의 텔레그램 수신이 끊겨 이 대화에 답하셔도 받지 못합니다.`;
  return replyTo ? `${head} 답은 ${nameOf(replyTo)} 봇 대화로 주세요.` : head;
}

/**
 * 답을 받을 팀원 = op 알림 수신자와 같은 규칙(pickOpNoticeRecipient: coordinator 우선, 본인 제외).
 * 알려진 트레이드오프(그 규칙의 제품 결정을 그대로 따른다): 지목된 팀원도 수신이 죽어 있을 수 있다.
 * liveness 로 거르지 않는다 — 수신자 규칙을 여기서 따로 만들면 op 알림과 갈린다.
 */
export function pickReplyRecipient(roster: AgentRecord[], senderId: string): AgentRecord | null {
  const id = pickOpNoticeRecipient(roster, senderId);
  return id ? roster.find((a) => a.id === id) ?? null : null;
}

/** 이 경고의 대상인가 — 채널이 텔레그램인 발신자만(memberChannel 기본값이 텔레그램이다). */
export function isTelegramChannel(agent: { channel?: unknown }): boolean {
  return memberChannel(agent).kind === "telegram";
}

export const TRUNCATED_MARK = "…(잘림)";
const SEP = "\n\n";

/**
 * 본문 끝에 경고 줄을 붙인다. 게시는 TELEGRAM_SEND_LIMIT 에서 잘리므로, 합친 길이가 넘으면 본문을 먼저 줄이고
 * TRUNCATED_MARK 를 남긴 뒤 경고를 붙인다 — 경고는 항상 살아남는다. 길이는 게시 쪽 slice 와 같은 UTF-16 단위.
 */
export function appendDeadReceiverNote(body: string, note: string, limit: number = TELEGRAM_SEND_LIMIT): string {
  const full = `${body}${SEP}${note}`;
  if (full.length <= limit) return full;
  const room = Math.max(0, limit - note.length - SEP.length - TRUNCATED_MARK.length);
  return `${body.slice(0, room)}${TRUNCATED_MARK}${SEP}${note}`;
}

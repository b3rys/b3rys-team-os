// 시스템 알림을 팀 그룹방에 게시하는 공용 함수. 재부팅 알림(rebootNotice)과 inbox 라우트(system 발신 op_notice 중계)가 같이 쓴다.
// 그룹방에는 코디네이터 봇 이름으로 올라가므로, 본문 첫 줄을 [b3os 시스템 알림] 으로 시작해 그 팀원이 쓴 글로 읽히지 않게 한다.
import type { AgentRecord } from "../types";
import { getChannel } from "../channels/registry";
import { getCaptureGroupId } from "./captureConfig";
import { pickOpNoticeRecipient } from "./opNotice";

export const SYSTEM_HEAD = "[b3os 시스템 알림]";

export function withSystemHead(text: string): string {
  return text.startsWith(SYSTEM_HEAD) ? text : `${SYSTEM_HEAD}\n${text}`;
}

/** 게시까지 성공해야 ok. 그룹이 설정돼 있지 않거나 보낼 봇(코디네이터)이 없으면 ok:false 와 이유. */
export async function postToGroup(agents: AgentRecord[], text: string): Promise<{ ok: boolean; error?: string }> {
  const group = getCaptureGroupId();
  if (!group) return { ok: false, error: "capture_group_not_configured" };
  const sender = agents.find((a) => a.id === pickOpNoticeRecipient(agents, ""));
  if (!sender) return { ok: false, error: "no_sender_agent" };
  const r = await getChannel("telegram").send({ agent: sender, target: group, text: withSystemHead(text) });
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "telegram_send_failed" };
}

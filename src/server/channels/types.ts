// 채널 어댑터 표준 인터페이스 (축B: 메시지가 외부 표면↔버스를 드나드는 통로).
// 런타임 축(WakeAdapter, bus/types.ts)과 대칭. P1 = SEND seam만 — ingest/resolveAgent는 P3.
//
// 설계: docs/ADAPTER_INTERFACE_DESIGN.md / 보고서 bill/reports/channel-adapter-refactor-20260621.
// behavior-preserving: send()는 기존 발신 함수(postTelegramAsHermes/postTelegramAsOpenclaw/postMessage)에
// 위임만 한다 — 새 fetch/spawn 로직 0.
import type { AgentRecord } from "../types";

export type ChannelKind = "telegram" | "slack" | "dashboard" | "kakao";

// thread_id 모양으로 채널 종류를 명시 판정(매직 prefix 직접비교 대체용).
export type ThreadKind = "telegram_group" | "bus_directed";

export interface SendRequest {
  target: string; // telegram chatId / slack channel id
  text: string;
  agent?: AgentRecord; // telegram bridge가 토큰/cmd 해석에 필요(어느 발신 구현 쓸지 runtime으로 판정)
  threadRef?: string; // slack thread_ts (telegram은 무시)
  replyToMessageId?: string | number; // telegram quote-reply
  botToken?: string; // slack creds.bot_token
}

export interface SendResult {
  ok: boolean;
  messageId?: number; // telegram message_id (완료 판정에 쓰임)
  ts?: string; // slack thread ts (thread tracking)
  error?: string;
}

export interface ChannelAdapter {
  id: ChannelKind;
  send(req: SendRequest): Promise<SendResult>;
  // 인바운드 외부 식별자(telegram bot username / slack bot user id 등) → 팀원 id.
  // 채널별 신원 규칙을 캡슐화(P3 resolveAgent seam). 없으면 null.
  // 우선순위: agent.channel_identities[kind] → legacy 평면필드 폴백(behavior-preserving).
  resolveAgentId(externalId: string, agents: AgentRecord[]): string | null;
}

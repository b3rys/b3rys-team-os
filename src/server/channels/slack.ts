// 슬랙 발신 채널 어댑터 — 기존 lib/slack.postMessage에 위임만(로직 이동 0).
import type { AgentRecord } from "../types";
import type { ChannelAdapter, SendRequest, SendResult } from "./types";
import { postMessage } from "../lib/slack";

export const slackChannel: ChannelAdapter = {
  id: "slack",
  async send(req: SendRequest): Promise<SendResult> {
    if (!req.botToken) return { ok: false, error: "slack send requires botToken" };
    const r = await postMessage({
      bot_token: req.botToken,
      channel: req.target,
      text: req.text,
      thread_ts: req.threadRef,
    });
    return { ok: r.ok, ts: r.ts, error: r.error };
  },
  // 인바운드 slack bot user id → 팀원 id. legacy(routes/slack.ts:156)와 byte-동일 매칭:
  // channel_identities.slack 우선 → slack_bot_user_id 폴백, 정확 일치.
  resolveAgentId(externalId: string, agents: AgentRecord[]): string | null {
    for (const a of agents) {
      const uid = a.channel_identities?.slack || a.slack_bot_user_id; // ||: 빈문자열도 legacy 폴백(?? footgun 방지)
      if (uid && uid === externalId) return a.id;
    }
    return null;
  },
};

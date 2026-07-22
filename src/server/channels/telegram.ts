// 텔레그램 발신 채널 어댑터 — 기존 발신 함수에 위임만(로직 이동 0).
// 어느 발신 구현을 쓸지는 agent.runtime으로 결정:
//   openclaw    → postTelegramAsOpenclaw (게이트웨이 봇 토큰 fetch, messageId 반환)
//   그 외(hermes 등) → postTelegramAsHermes (hermes CLI bridge spawn, boolean 반환)
import type { AgentRecord } from "../types";
import type { ChannelAdapter, SendRequest, SendResult } from "./types";
import { postTelegramAsHermes } from "../lib/hermesBridge";
import { postTelegramAsOpenclaw } from "../lib/openclawBridge";
import { canSendAsBot, sendAsAgentBot } from "../lib/telegramBotSend";

const normTgHandle = (s: string): string => s.replace(/^@/, "").toLowerCase();

export const telegramChannel: ChannelAdapter = {
  id: "telegram",
  async send(req: SendRequest): Promise<SendResult> {
    if (!req.agent) return { ok: false, error: "telegram send requires agent" };
    if (req.agent.runtime === "openclaw") {
      const r = await postTelegramAsOpenclaw(req.agent, req.target, req.text, req.replyToMessageId);
      return { ok: r.ok, messageId: r.messageId };
    }
    // ★런타임이 아니면 전부 hermes CLI 로 보내던 게 팀장 보고를 유실시켰다.★ (2026-07-14 실측)
    //   claude 팀원(steve·lui·dbak·demis)은 ★hermes 런타임이 아니다★ → `hermes send` 가 실패 →
    //   ★완성된 보고(서귀포 날씨)가 팀장께 안 갔다.★ telegram_send_failed 로만 남고 끝.
    //   ★"팀원이 직접 보낸다" 로 바꿨으면 ★모든 런타임이 실제로 보낼 수 있어야 한다.★★
    //   → ★자기 봇 토큰이 있으면 Bot API 로 직접 보낸다★ (런타임 무관, 가장 확실한 경로).
    if (canSendAsBot(req.agent.id)) {
      const r = await sendAsAgentBot(req.agent, req.target, req.text);
      if (r.ok) return { ok: true };
      // 토큰은 있는데 실패 → ★조용히 묻지 않는다.★ 이유를 올려보낸다(토큰 값은 안 실린다).
      return { ok: false, error: r.error };
    }
    // 봇 토큰이 없는 런타임(hermes 계열)만 CLI 경로
    const ok = await postTelegramAsHermes(req.agent, req.target, req.text);
    return { ok };
  },
  // 인바운드 텔레그램 bot username → 팀원 id. legacy(telegramCapture.ts:244)와 byte-동일 매칭:
  // channel_identities.telegram 우선 → telegram_bot_username 폴백, 둘 다 @·대소문자 정규화 비교.
  resolveAgentId(externalId: string, agents: AgentRecord[]): string | null {
    const target = normTgHandle(externalId);
    for (const a of agents) {
      const handle = a.channel_identities?.telegram || a.telegram_bot_username; // ||: 빈문자열도 legacy 폴백(?? footgun 방지)
      if (handle && normTgHandle(handle) === target) return a.id;
    }
    return null;
  },
};

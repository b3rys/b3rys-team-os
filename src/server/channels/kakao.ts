// KakaoTalk 채널 어댑터 — 확장성 예제(P3 "카카오=1파일" 증명).
// GD 목표: 새 채널 추가 = 이 파일 1개 + registry 1줄(코어 0수정). 이 파일이 그 "1파일"의 모양이다.
//
// 현재 상태: 예제/템플릿 — 라이브 channelRegistry에 등록하지 않음(실 KakaoTalk 봇/토큰 없음, dead 라이브경로 회피).
// 활성화(=GD가 말한 "1줄"): ① channels/registry.ts에 ["kakao", kakaoChannel] 추가 ② agents.json
//   channel_identities.kakao 로 팀원 신원 등록 ③ 카카오 ingest 워커(telegramCapture/slackPoll 류) 추가.
// send/resolveAgentId는 telegram·slack 어댑터와 동일 ChannelAdapter 계약을 그대로 구현한다.
import type { AgentRecord } from "../types";
import type { ChannelAdapter, SendRequest, SendResult } from "./types";

export const kakaoChannel: ChannelAdapter = {
  id: "kakao",
  async send(req: SendRequest): Promise<SendResult> {
    // 실제 구현 시: KakaoTalk Bot API(또는 채널 게이트웨이)로 req.target에 req.text 전송.
    // 토큰/엔드포인트는 telegram(openclawTelegramBotToken)·slack(creds.bot_token)처럼 채널별 비밀에서.
    if (!req.botToken) return { ok: false, error: "kakao not configured (예제 어댑터 — 토큰 미설정)" };
    return { ok: false, error: "kakao send 미구현 (확장 예제)" };
  },
  // 인바운드 카카오 식별자 → 팀원 id. telegram/slack과 동일 패턴: channel_identities.kakao 매칭.
  resolveAgentId(externalId: string, agents: AgentRecord[]): string | null {
    for (const a of agents) {
      const id = a.channel_identities?.kakao;
      if (id && id === externalId) return a.id;
    }
    return null;
  },
};

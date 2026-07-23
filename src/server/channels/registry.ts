// 채널 어댑터 레지스트리 — runtimeAdapters Map(wakeDispatcher.ts) 패턴을 채널 축에 적용.
// 새 채널 추가 = 어댑터 1파일 + 이 Map 한 줄(코어 0수정).
import type { ChannelAdapter, ChannelKind, ThreadKind } from "./types";
import { telegramChannel } from "./telegram";
import { slackChannel } from "./slack";
import { pick, type Locale } from "../lib/i18n";

export const channelRegistry = new Map<ChannelKind, ChannelAdapter>([
  ["telegram", telegramChannel],
  ["slack", slackChannel],
]);

export function getChannel(kind: ChannelKind): ChannelAdapter {
  const adapter = channelRegistry.get(kind);
  if (!adapter) throw new Error(`no channel adapter registered for kind: ${kind}`);
  return adapter;
}

// ★"이 스레드의 방이 어디냐" — 이 질문의 정본은 여기 하나다.★ (GD 2026-07-14 "기본부터 다지자")
//
//   단톡방 스레드는 `tg-<chat_id>` 로 채번된다 — 즉 ★이름이 방의 정체(chat_id)를 품고 있다.★
//   그래서 접두사 비교 자체가 틀린 건 아니다. ★틀린 건 그 비교를 여기저기 복붙한 것이다.★
//   실제로 4곳에 복붙돼 있었고, 그중 하나(inbox.ts)가 "이름이 tg- 로 시작할 때만 단톡방에 게시"
//   라는 규칙이 되어 ★14일간 36건(26%)의 팀 발언을 조용히 삼켰다.★
//   ★판단이 여러 벌이면 언젠가 갈린다.★ → 전부 이 함수로 모은다.
export function resolveThreadKind(threadId: string): ThreadKind {
  return threadId.startsWith("tg-") ? "telegram_group" : "bus_directed";
}

/**
 * 단톡방 스레드가 품고 있는 텔레그램 chat_id. 그 방 스레드가 아니면 null.
 * (`tg--2000000000001` → `-2000000000001`. 앞의 `-` 는 chat_id 의 일부다 — 잘라내면 안 된다.)
 */
export function groupChatIdFromThread(threadId: string): string | null {
  return resolveThreadKind(threadId) === "telegram_group" ? threadId.replace(/^tg-/, "") : null;
}

// 주입문 문맥 라벨 — 그룹방이면 "단톡방" 명시(참고용=상황파악용). 간결 (GD 2026-07-16).
export function teamContextLabel(threadId: string, locale: Locale | undefined): string {
  return resolveThreadKind(threadId) === "telegram_group"
    ? pick(locale, "[단톡방 대화 — 참고용]", "[Group-room chat — for reference]")
    : pick(locale, "[최근 팀 대화 — 참고용]", "[Recent team chat — for reference]");
}

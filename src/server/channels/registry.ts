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

/**
 * 주입된 한 줄이 ★어디를 거쳐 왔는지★. 읽는 쪽이 알아야 하는 것은 딱 하나다 —
 * ★이 말이 방에 떠 있는가, 나한테만 왔는가.★ 그걸 못 가르면 버스로만 받은 지시를
 * "방에서 다들 봤다" 로 읽는다.
 *
 * 한국어 고정이다 — 줄 본문이 이미 한국어 고정("너", "…(잘림: 원문 N자)")이라 여기만
 * 번역하면 한 줄에 두 언어가 섞인다. 머리말(`teamContextLabel`)은 locale 을 따른다.
 */
export type LineOrigin = "단체" | "1:1" | "팀버스" | "시스템";

/**
 * ★한 줄의 출처.★ 스레드 이름만으로는 못 정한다 — 같은 `tg-` 스레드에 방 글과
 * 버스 DM 이 ★섞여서★ 들어오기 때문이다. 그래서 발신 축(`source`)과 수신 축을 함께 본다.
 *
 *   `system`        → 시스템 (사람 발언이 아니다)
 *   팀장님(`user`)  → 그룹 스레드면 단체, 아니면 1:1
 *   팀원(`agent`)   → broadcast 면 방에 올라간 글이므로 단체, 개인 수신자면 팀버스
 *
 * ★그룹 스레드 여부를 인자로 받는다★ — 호출부가 이미 `resolveThreadKind` 를 계산해 두므로
 * 같은 판정을 두 번 하지 않는다(그리고 판정이 갈릴 여지를 안 만든다).
 */
export function lineOrigin(
  m: { source?: string | null; to_agent_id?: string | null; type?: string | null },
  isGroupThread: boolean,
): LineOrigin {
  if (m.source === "system") return "시스템";
  const inRoom = m.to_agent_id === "broadcast" || m.type === "broadcast";
  if (isGroupThread) {
    // 방 안에서는 팀장님 글도, 방에 올린 글도 전부 "방에 떠 있는 말" 이다.
    // 방 스레드로 들어온 개인 수신 DM 만 팀버스다.
    if (m.source === "user" || inRoom) return "단체";
    return "팀버스";
  }
  // ★그룹이 아닌 방 — 상대가 팀장님이면 양방향 다 1:1 이다.★
  //   예전에는 발신 축만 봐서 ★같은 1:1 방인데 내 답만 '팀버스' 로 찍혔다.★
  //   한 방이 두 이름으로 보이면 읽는 쪽은 다른 경로라고 읽는다 — ★이 표시가 없애려던 바로 그 오독이다.★
  if (m.source === "user" || m.to_agent_id === "user") return "1:1";
  return "팀버스";
}

/**
 * 주입문 머리말. ★출처를 단정하지 않는다★ — 출처는 줄마다 붙는다(`lineOrigin`).
 * 예전에는 스레드 이름이 `tg-` 로 시작하면 블록 전체를 "단톡방 대화" 라고 했는데,
 * 그 스레드로 들어온 ★버스 DM 까지 방에 올라간 글로 보였다.★
 */
export function teamContextLabel(locale: Locale | undefined): string {
  return pick(locale, "[최근 팀 대화 — 참고용]", "[Recent team chat — for reference]");
}

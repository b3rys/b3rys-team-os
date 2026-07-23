import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import type { PendingDispatchRow } from "./types";

/**
 * ★턴의 답변을 누구에게 보낼 것인가.★ (2026-07-13 — Steve 가 코드와 데이터로 잡은 진짜 버그)
 *
 * ═══ 무엇이 잘못됐었나 ═══
 * 예전 규칙은 딱 하나였다: ★"나를 깨운 사람에게 답한다"★ (`row.from_agent_id`).
 * 1:1 문답이면 맞다. ★그런데 수집에서는 정확히 틀린다.★
 *
 *   팀장 → hermes : "steve·dbak 한테 물어보고 ★종합해서 나한테★ 보고해줘"
 *   hermes → steve/dbak : (팬아웃 질문)
 *   dbak  → hermes : "네이비요"            ← ★이 답이 hermes 를 깨운다★
 *   hermes 가 그 턴에서 ★훌륭한 종합을 쓴다★ … 그리고 그 종합이 ★dbak 에게 간다.★ ★팀장은 못 받는다.★
 *
 * ★실측 4표본: 성공 1 · 실패 3. 그리고 그 성공 1건도 "팀장이 우연히 마지막 waker 였을 때" 다.★
 * ★= 성공이 운이었다.★ 기여자가 하나라도 뒤에 답하면 종합은 그쪽으로 샌다.
 *
 * ★그동안 이걸 "게이트웨이는 기억이 없어 종합을 못 한다" 로 오진했다.★
 * ★종합은 하고 있었다. 주소를 못 찾았을 뿐이다.★ (그래서 상시세션으로는 안 고쳐진다 — 수송과 무관)
 *
 * ═══ 새 규칙 ═══
 * ★"내가 보낸 메시지에 대한 답" 이 나를 깨웠다면★, 그 턴의 산출물은 ★그 기여자에게 줄 답이 아니라
 * 나에게 일을 시킨 사람에게 줄 보고★ 다 → ★원 위임자★ 에게 보낸다.
 * 그 외에는 ★예전 그대로★ (나를 깨운 사람에게 답한다).
 */
export function turnReplyTarget(
  db: Database,
  row: PendingDispatchRow,
  targetAgentId: string,
  roster: AgentRecord[],
): string {
  const waker = row.from_agent_id;
  const fallback =
    waker !== targetAgentId && roster.some((a) => a.id === waker) ? waker : "broadcast";

  // 이 wake 가 ★내 질문에 대한 답★ 인가? (부모 메시지를 내가 보냈나)
  if (!row.in_reply_to) return fallback;
  const parent = db
    .prepare(`SELECT from_agent_id FROM message WHERE id = ?`)
    .get(row.in_reply_to) as { from_agent_id: string } | undefined;
  if (parent?.from_agent_id !== targetAgentId) return fallback; // 내 질문의 답이 아니다 → 그대로

  // ★내 질문의 답이다.★ 그럼 내 산출물은 ★나에게 일을 시킨 사람★ 의 것이다.
  //
  // ═══ 🔴 "누가 시켰나" 를 어떻게 찾나 — 여기서 한 번 크게 틀렸다 ═══
  // 처음엔 ★"이 스레드에서 나에게 ★처음★ 일을 시킨 사람"★ 을 찾았다 (ORDER BY created_at ASC).
  // ★그룹 스레드는 영원히 하나다★ — 실측 3,072건 · 6주 · 8명. ★"처음" 은 6주 전 사람이다.★
  // 그래서 "요청자가 정확히 1명일 때만" 이라는 ★과보수적 가드★ 를 걸었고,
  // ★그 결과 그룹에서는 fix 가 아예 안 걸렸다★ → 종합이 또 ★깨운 기여자에게★ 갔다 (라이브 실측).
  //
  // ★맞는 질문은 "처음" 이 아니라 "★지금 내가 처리 중인 요청★" 이다.★
  //   = ★나를 깨운 메시지보다 앞서서, 나에게 온 것 중 가장 최근의 '요청'★
  //   ('요청' = 내 질문의 답이 아닌 것. 기여자 답을 세면 안 된다 — 그러면 수집에선 항상 답이 최신이다)
  // ★이러면 그룹이든 1:1이든 똑같이 맞는다.★ 스레드 전체를 볼 필요가 없다.
  // ★기준 시각 = 내 팬아웃이 나간 때★ (나를 깨운 메시지의 ★부모★ = 내가 보낸 그 질문).
  //   ★"나를 깨운 때" 를 기준으로 하면 안 된다★ — 바쁜 그룹에선 위임 ★이후에★ 누가 딴 말을 걸 수 있고,
  //   그러면 그게 "최근 요청" 이 되어 ★엉뚱한 사람에게 보고한다.★
  //   ★내가 그 질문을 보낼 때 이미 알고 있던 요청★ 이 진짜 위임이다.
  const myAsk = db
    .prepare(`SELECT created_at FROM message WHERE id = ?`)
    .get(row.in_reply_to) as { created_at: string } | undefined;
  const woke = myAsk;

  const requester = db
    .prepare(
      `SELECT m.from_agent_id AS who
         FROM message m
         LEFT JOIN message p ON p.id = m.in_reply_to
        WHERE m.thread_id = ?
          AND m.to_agent_id = ?
          AND m.from_agent_id <> ?
          AND (m.in_reply_to IS NULL OR p.from_agent_id <> ?)   -- 내 질문의 답이 아닌 것 = 나에게 온 '요청'
          AND (? IS NULL OR m.created_at <= ?)                  -- ★내 팬아웃이 나간 시점★ 이전 (아래 myAsk)
        ORDER BY m.created_at DESC LIMIT 1`,
    )
    .get(
      row.thread_id,
      targetAgentId,
      targetAgentId,
      targetAgentId,
      woke?.created_at ?? null,
      woke?.created_at ?? null,
    ) as { who: string } | undefined;

  const origin = requester?.who;
  if (!origin) return fallback;
  if (origin === waker) return fallback; // 위임자가 직접 깨웠으면 어차피 같다
  if (!roster.some((a) => a.id === origin)) return fallback; // 모르는 사람에게 보내지 않는다
  return origin;
}

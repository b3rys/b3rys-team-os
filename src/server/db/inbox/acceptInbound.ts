import type { Database } from "bun:sqlite";
import type { EnvelopeInbound, EnvelopeStored } from "../../../shared/envelopeSchema";
import { buildDedupeKey } from "../../../shared/envelopeSchema";
import { ensureThread, insertMessage } from "./messages";
import { findRecentDuplicate } from "./lifecycle";
import type { Broadcaster } from "../../workers/types";
import { emitLoopEventSafe, EVENT, makeEpisodeId } from "../../metrics/loopEvent";

// acceptInbound — 채널 ingress 공통 꼬리 (P2 ChannelAdapter: telegramCapture·routes/inbox·routes/slack에
//   복붙돼 있던 동일 시퀀스를 단일 코어로 추출). dedupe → ensureThread → insertMessage → broadcast.
// 채널별 차이(dedupe window·meta·source·attachments·explicit_recipients)는 호출자가 env로 넘기고,
//   중복(duplicate) 후처리(텔레그램 audit / inbox 409 / slack skip)와 채널별 추가 audit도 호출자가 한다.
// ★ 불변식 보존: ensureThread·findRecentDuplicate·insertMessage를 '그대로' 호출(변경 0) →
//   completed-on-insert(messages.ts: env.source==="user" && !env.dispatch → recipient 'completed'),
//   dedupe(content-hash·window), thread 생성/재사용 로직이 인라인이던 때와 byte-동일하게 보존된다.
//   acceptInbound는 코어를 건드리지 않는 얇은 composition일 뿐(코어 불가침).

export type InboundEnv = EnvelopeInbound & { explicit_recipients?: string[]; thread_id?: string };

export type AcceptInboundResult =
  | { ok: true; stored: EnvelopeStored }
  | { ok: false; duplicate: string; dedupeKey: string };

/**
 * ★리터럴 "\\n" 이 팀장 단톡방에 문자 그대로 찍혔다.★ (2026-07-13 · 재발 2026-07-14 01:03)
 *
 * ═══ 왜 나나 ═══
 *   ★[B] 전환으로 팀원이 본문을 직접 쓴다.★ 셸에서 `--body "…\\n\\n…"` 라고 쓰면
 *   ★큰따옴표 안의 \\n 은 개행이 아니라 백슬래시+n 두 글자★ 다. JSON 을 직접 만들 때 이중 이스케이프해도 같다.
 *   send.sh 에서 한 번 고쳤는데, ★긴 본문에서 팀원이 send.sh 를 우회해 API 를 직접 부르면 또 샌다.★
 *   ★통로가 여럿이면 가드도 여럿이어야 한다 — 그게 오늘 [NO_REPLY] 가 샌 이유다.★
 *   → ★모든 발신이 지나는 문(여기)에서 막는다.★
 *
 * ═══ 코드를 망가뜨리지 않는다 ═══
 *   ★이미 진짜 개행이 있으면 손대지 않는다.★ 그건 작성자가 의도한 형식이고, 코드 붙여넣기일 수 있다.
 *   ★진짜 개행이 하나도 없는데 리터럴 \\n 만 있는 경우★ = ★이스케이프가 깨진 것이 확실하다.★ 그때만 편다.
 */
export function normalizeEscapedNewlines(body: string): string {
  if (body.includes("\n")) return body;              // ★진짜 개행이 있다 → 작성자 의도. 안 건드린다★
  if (!/\\n/.test(body)) return body;                 // 리터럴도 없다 → 그대로
  // ★\n 만 편다★ — 실제로 난 문제는 이것뿐이다. ★안 겪은 문제를 추측으로 처리하면 그게 다음 버그다.★
  return body.replace(/\\n/g, "\n");
}

export function acceptInbound(
  db: Database,
  env: InboundEnv,
  opts: {
    dedupeWindowSec: number;
    broadcast?: Broadcaster;
    // insert 직후·broadcast 직전 hook (채널별 audit 등). 기존 'insert→audit→broadcast' 관측순서 보존용
    // (Codex P2 리뷰 ②: WS 구독자가 message 이벤트 수신 시점에 audit이 이미 있길 기대하는 암묵계약 보호).
    onInserted?: (stored: EnvelopeStored) => void;
  },
): AcceptInboundResult {
  // 채널이 dedupe_key를 미리 지정했으면(텔레그램 origin msg_id 레벨 등) 그걸 쓰고, 아니면 content-hash.
  // ★깨진 이스케이프를 펴준다★ — 팀원을 탓할 일이 아니다. 받아주는 쪽이 맞다.
  if (env.source === "agent") {
    const fixed = normalizeEscapedNewlines(env.body);
    if (fixed !== env.body) env = { ...env, body: fixed };
  }
  const dedupeKey = env.dedupe_key ?? buildDedupeKey(env.from_agent_id, env.to_agent_id, env.body);
  const dup = findRecentDuplicate(db, dedupeKey, opts.dedupeWindowSec);
  if (dup) return { ok: false, duplicate: dup, dedupeKey };


  const { thread_id } = ensureThread(db, {
    thread_id: env.thread_id,
    from_agent_id: env.from_agent_id,
    to_agent_id: env.to_agent_id,
    type: env.type ?? "dm",
    body: env.body,
  });
  const stored = insertMessage(db, { ...env, thread_id, dedupe_key: dedupeKey });
  opts.onInserted?.(stored); // audit 등 — broadcast 전에 (기존 순서 보존)

  // ③ [측정 W1] request.created loop_event emit — ★best-effort(측정 실패가 ingress 전달 절대 안 깸)★, 같은 db.
  //   spec §30: acceptInbound ok:true + episode-first(원 요청) → episode_id는 이 stored.id(origin·first-seen).
  //
  // ★가드는 "ack 이 날 수 있는 open 수신자 행을 실제로 만들었는가" 를 직접 본다.★ (Bill 리뷰 2026-07-27)
  //   왜 heuristic 을 버렸나 — 이전 가드는 `type !== "reply" && !in_reply_to && to !== "broadcast"` 로
  //   "ack 가능성" 을 ★간접 추정★ 했는데, 우리 핵심룰이 버스 발신에 항상 `--in-reply-to` 를 붙이라고 해서
  //   ★스레드 안에서 오는 새 위임(= 실제 요청의 대다수)이 통째로 배제★ 됐다. 그런데 ack 쪽은 그 배제를
  //   모르므로 수신자 행은 open 으로 생기고, 답이 오면 ack.observed 가 그대로 뜬다 →
  //   ★request.created=0 / ack.observed=1 = 고아 ack + 분모 누락★ (Bill·Demis 각각 재현).
  //   emit 짝은 같은 사실에서 나와야 어긋나지 않는다. 그 사실 = ★open 수신자 행의 존재★ 다.
  //   부수효과로 특수 케이스가 별도 조건 없이 따라온다:
  //     · broadcast      → 수신자 행이 'acknowledged'(close_reason=broadcast_fyi) 로 생성돼 open 이 아니다 → 무emit
  //     · completed-on-insert(user source·비dispatch) → open 아님 → 무emit
  //   즉 "ack 이 날 수 없는 것은 request 로도 세지 않는다" 가 ★정의상★ 보장된다(추정이 아니라).
  const ackable = db
    .prepare(`SELECT COUNT(*) AS n FROM message_recipient WHERE message_id = ? AND recipient_state = 'open'`)
    .get(stored.id) as { n: number } | undefined;
  if ((ackable?.n ?? 0) > 0) {
    emitLoopEventSafe(db, {
      event_id: `req:${stored.id}`,
      event_name: EVENT.request_created,
      schema_version: "0.2",
      occurred_at: new Date().toISOString(),
      episode_id: makeEpisodeId(thread_id, { requestMessageId: stored.id }),
      thread_id,
      request_message_id: stored.id,
      actor: env.from_agent_id,
      target: env.to_agent_id,
      owner: env.to_agent_id,
      metric_scope: "both",
      reason: `inbound ${env.source ?? "?"}`,
    });
  }

  opts.broadcast?.({ type: "message", message: stored });
  return { ok: true, stored };
}

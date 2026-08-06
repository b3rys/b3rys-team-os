import { z } from "zod";

// ---------------------------------------------------------------------------
// Envelope — 6 agent 간 메시지의 공통 양식 (SPEC-team-collab.md 의 message + thread 데이터 모델).
// 이 파일이 frontend / backend / agent skill / OpenClaw tool 모두의 single source of truth.
// 변경 시 모든 consumer 가 영향받음 → multi-AI 리뷰 권장.
// ---------------------------------------------------------------------------

// hop cap(거친 TTL backstop). pingpong 가드(countAutoRounds, MAX_AUTO_ROUNDS=6)가 진짜 봇루프 1차 방어이고
// hop 은 coarse backstop이므로 pingpong cap 보다 높아야 한다. 2026-06-11: 5→16 (5는 pingpong 6보다 낮아
// 정당한 다단계 협의/handoff가 hop=5에서 먼저 차단되던 버그. Forin handoff 차단의 근본원인). Codex 검토 승인.
export const MAX_HOPS_DEFAULT = 16;
export const BODY_MAX_CHARS = 8000;
export const TITLE_MAX_CHARS = 200;

export const messageTypeSchema = z.enum([
  "dm",
  "broadcast",
  "reply",
  "status",
  "system",
  "meeting_open",
  "meeting_round",
  "meeting_close",
]);
export type MessageType = z.infer<typeof messageTypeSchema>;

export const sourceSchema = z.enum(["agent", "user", "system"]);
export type EnvelopeSource = z.infer<typeof sourceSchema>;

export const prioritySchema = z.enum(["low", "normal", "high"]);
export type Priority = z.infer<typeof prioritySchema>;

// sync level — 버스 메시지를 텔레그램 그룹에 미러할지/어떻게. none=미러 안 함(기본),
// status=전송사실만, handoff/result=본문 요약 미러. 도배 방지 위해 기본 none(opt-in).
export const syncLevelSchema = z.enum(["none", "status", "handoff", "result"]);
export type SyncLevel = z.infer<typeof syncLevelSchema>;

export const deliveryStatusSchema = z.enum(["pending", "delivered", "failed", "expired"]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const threadKindSchema = z.enum(["dm", "meeting", "broadcast"]);
export const threadStatusSchema = z.enum(["open", "paused", "closed", "failed"]);
export const threadStateSchema = z.enum([
  "opening",
  "round_prompting",
  "collecting",
  "summarizing",
  "idle",
]);

// Agent id pattern — slug only (a-z0-9_-). Plus special values "user", "system", "moderator", "broadcast".
const agentIdRegex = /^[a-z0-9_-]+$/;
export const agentIdSchema = z.string().min(1).max(64).regex(agentIdRegex);
export const senderIdSchema = agentIdSchema; // includes "user", "system", "moderator" by convention
export const recipientIdSchema = agentIdSchema; // includes "broadcast" by convention

// ---------------------------------------------------------------------------
// Envelope inbound (client → server, POST /api/inbox)
// ---------------------------------------------------------------------------

export const envelopeInboundSchema = z.object({
  thread_id: z.string().min(4).max(32).optional(), // omitted → server creates new dm thread
  from_agent_id: senderIdSchema,
  to_agent_id: recipientIdSchema,
  type: messageTypeSchema.default("dm"),
  body: z.string().min(1).max(BODY_MAX_CHARS),
  source: sourceSchema.default("agent"),
  // 대시보드 1:1 등 채널-poller 없는 user 메시지: 버스가 그 팀원을 깨워야 함(true→pending+dispatch).
  // 텔레그램 user 메시지는 poller가 배달하므로 false(기본)로 두어 더블웨이크 방지.
  dispatch: z.boolean().optional(),
  hop_count: z.number().int().nonnegative().max(MAX_HOPS_DEFAULT).default(0),
  // Optional per-message cap for bounded smoke/acceptance flows. Defaults to MAX_HOPS_DEFAULT when omitted.
  max_hop: z.number().int().positive().max(MAX_HOPS_DEFAULT).optional(),
  in_reply_to: z.string().min(4).max(32).nullable().optional(),
  /**
   * ★전체공지 사유★ (GD 2026-08-01). 팀원 broadcast 는 coordinator + 이 사유가 있어야 나간다.
   * 목적은 허가가 아니라 ★기록★ 이다 — "전원이 봐야 하는 사실인가" 를 나중에 팀장이 판정할 수 있게 남긴다.
   * (실측: 게이트 없던 70분에 팀원 broadcast 47건 → wake 517회)
   */
  all_hands: z.string().min(1).max(200).optional(),
  priority: prioritySchema.default("normal"),
  sync: syncLevelSchema.optional(), // 생략 시 insertMessage 가 'none' 처리 (미설정=미러 안 함)
  dedupe_key: z.string().min(1).max(128).nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(), // ISO 8601
  attachments: z
    .array(
      z.object({
        kind: z.enum(["path", "url"]),
        value: z.string().min(1).max(512),
        note: z.string().max(200).optional(),
      }),
    )
    .max(10)
    .optional(),
  meta: z.record(z.unknown()).optional(),
});
export type EnvelopeInbound = z.infer<typeof envelopeInboundSchema>;

/**
 * ★레지스트리 검사를 건너뛰는 예약 id★ — `/api/inbox` 가 ★from 과 to 양쪽에★ 이 목록을 쓴다.
 *   ★그래서 발신자 전용이 아니다★: `broadcast` 는 ★수신 주소로만★ 쓰이려고 여기 들어 있다
 *   (팀원이 방에 말할 때 `to_agent_id: "broadcast"`). 발신자로는 쓰이지 않는다.
 *   → 발신자만 보는 곳(antiPingpong)은 이 목록에서 broadcast 를 ★깎아서★ 쓴다.
 *
 * 사람이 아닌 주체이거나(system·moderator),
 * 팀원 명부에 일부러 없는 주체(user = 팀 리드)다. `/api/inbox` 가 이 목록으로 판정한다.
 *
 * ★사본을 만들지 말고 여기서 파생하라★: 시험용 가짜 입구가 자기 목록을 따로 들면 진짜와 갈리고,
 * 그러면 가짜가 더 관대해져 시험이 통과를 보장하지 못한다(2026-08-06 실사고).
 * 발신자 판정처럼 ★범위가 다른 곳★ 은 이 집합에서 ★깎아서★ 쓴다(antiPingpong 의 SENDER 파생 참고) —
 * 새로 적지 않는다. 그래야 "여기가 정본" 이 사실로 남는다.
 */
export const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set(["user", "system", "moderator", "broadcast"]);


// ---------------------------------------------------------------------------
// Envelope persisted (server → client, GET /api/inbox)
// ---------------------------------------------------------------------------

export const envelopeStoredSchema = envelopeInboundSchema.extend({
  id: z.string().min(4).max(32),
  thread_id: z.string().min(4).max(32),
  read_at: z.string().datetime().nullable(),
  delivery_status: deliveryStatusSchema.default("pending"),
  retry_count: z.number().int().nonnegative().default(0),
  created_at: z.string().datetime(),
});
export type EnvelopeStored = z.infer<typeof envelopeStoredSchema>;

// ---------------------------------------------------------------------------
// Thread (returned by GET /api/threads, GET /api/threads/:id)
// ---------------------------------------------------------------------------

export const threadSchema = z.object({
  id: z.string().min(4).max(32),
  title: z.string().min(1).max(TITLE_MAX_CHARS),
  kind: threadKindSchema,
  participants: z.array(agentIdSchema).min(1).max(20),
  moderator_agent_id: agentIdSchema.nullable(),
  status: threadStatusSchema,
  state: threadStateSchema,
  round_no: z.number().int().nonnegative(),
  next_responder_agent_id: agentIdSchema.nullable(),
  last_message_at: z.string().datetime().nullable(),
  opened_by: senderIdSchema,
  opened_at: z.string().datetime(),
  closed_at: z.string().datetime().nullable(),
  summary: z.string().nullable(),
});
export type Thread = z.infer<typeof threadSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildDedupeKey(from: string, to: string, body: string): string {
  // Hash-like key; collision OK for 60s dedupe window since (from, to, body) is rare to repeat exactly.
  let h = 0;
  for (let i = 0; i < body.length; i++) h = (h * 31 + body.charCodeAt(i)) | 0;
  return `${from}>${to}:${(h >>> 0).toString(36)}`;
}

export function isExpired(expiresAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!expiresAt) return false;
  // ★DB(expires_at)는 UTC 인데 Z 가 없다 ("2026-07-13 04:48:15").★ 그대로 new Date 에 넘기면 로컬로 읽혀
  //   KST 에서 9시간 어긋난다 → ★안 만료된 봉투가 만료로, 만료된 봉투가 유효로 뒤집힌다.★
  //   지금은 호출자가 없지만 ★DB 값을 넘기는 순간 터지는 지뢰라 여기서 못박는다.★
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(expiresAt) && !/[Z+]/.test(expiresAt)
    ? expiresAt.replace(" ", "T") + "Z"
    : expiresAt;
  return new Date(iso).getTime() < nowMs;
}

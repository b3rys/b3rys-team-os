// OWNER 1:1 DM "누가 나한테 보냈나" 조회 — 비-tmux 런타임(openclaw/hermes) 챗 답변용.
// BWF 분담(Steve 킥오프): 사적DM분=Demis. (버스 message_recipient "누가 확인했나"=Ames)
//
// dm_message(direction="in" = OWNER→봇) 읽기 전용. ★member_id 격리 준수★ — 타 멤버의 OWNER DM은
// 절대 포함하지 않는다(dmCapture 프라이버시 원칙 그대로). 이 테이블은 OWNER 1:1 DM 전용이므로
// inbound 발신자는 항상 OWNER.
import type { Database } from "bun:sqlite";
import type { DmMessageRow } from "./dmCapture";

const KST_OFFSET_MS = 9 * 3600 * 1000;
const DEFAULT_LIMIT = 10;
const PREVIEW_LEN = 80;

/** UTC Date → "YYYY-MM-DD HH:MM:SS" (dmCapture.toUtcSql와 동일 포맷 — sinceHours 컷오프 비교용). */
function toUtcSql(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** UTC "YYYY-MM-DD HH:MM:SS" → KST "MM-DD HH:MM KST" (렌더 시 +9h — dmCapture 저장은 UTC). */
function toKstShort(utcSql: string): string {
  const ms = Date.parse(utcSql.replace(" ", "T") + "Z");
  if (Number.isNaN(ms)) return utcSql;
  const k = new Date(ms + KST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())} KST`;
}

/** 본문 프리뷰 — 공백 접기 + 길이 컷. */
function preview(body: string): string {
  const s = body.replace(/\s+/g, " ").trim();
  return s.length > PREVIEW_LEN ? s.slice(0, PREVIEW_LEN) + "…" : s;
}

export interface InboundDmOpts {
  limit?: number; // 기본 10
  sinceHours?: number; // 있으면 최근 N시간 창으로 제한
}

/**
 * 특정 멤버가 OWNER로부터 받은(inbound) 최근 DM (최신 → 과거). ★member_id 격리★.
 * direction='in'만 — 봇이 OWNER에게 보낸 out은 "누가 보냈나"에 해당 없음.
 */
export function recentInboundDms(db: Database, memberId: string, opts: InboundDmOpts = {}): DmMessageRow[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (opts.sinceHours !== undefined) {
    const cutoff = toUtcSql(new Date(Date.now() - opts.sinceHours * 3600_000));
    return db
      .prepare(
        `SELECT * FROM dm_message WHERE member_id = ? AND direction = 'in' AND created_at >= ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(memberId, cutoff, limit) as DmMessageRow[];
  }
  return db
    .prepare(
      `SELECT * FROM dm_message WHERE member_id = ? AND direction = 'in'
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(memberId, limit) as DmMessageRow[];
}

export interface InboundDmSummary {
  memberId: string;
  sender: string; // OWNER 1:1 DM 전용 테이블이라 항상 "OWNER"
  count: number; // 조회된 inbound 건수(limit/sinceHours 창 내)
  sinceHours: number | null;
  latest: { atKst: string; preview: string } | null;
  items: { atKst: string; preview: string }[]; // 최신 → 과거
}

/** "누가 나한테 보냈나" 구조화 요약 (챗 답변·상태카드 재료). */
export function summarizeInboundDms(db: Database, memberId: string, opts: InboundDmOpts = {}): InboundDmSummary {
  const rows = recentInboundDms(db, memberId, opts);
  const items = rows.map((r) => ({ atKst: toKstShort(r.created_at), preview: preview(r.body) }));
  return {
    memberId,
    sender: "OWNER",
    count: rows.length,
    sinceHours: opts.sinceHours ?? null,
    latest: items[0] ?? null,
    items,
  };
}

/**
 * 비-tmux 런타임이 "누가 나한테 메시지 보냈어?"에 그대로 답할 수 있는 1개 문자열.
 * 건수 0이면 명시적으로 "없음" — 조용한 빈 답 방지.
 */
export function describeInboundDms(db: Database, memberId: string, opts: InboundDmOpts = {}): string {
  const s = summarizeInboundDms(db, memberId, opts);
  const window = s.sinceHours != null ? `최근 ${s.sinceHours}시간` : "최근";
  if (s.count === 0) return `${window} OWNER가 보낸 1:1 DM은 없습니다.`;
  const head = `${window} OWNER가 1:1 DM ${s.count}건을 보냈습니다. 최신: "${s.latest!.preview}" (${s.latest!.atKst}).`;
  if (s.count === 1) return head;
  const more = s.items
    .slice(1, 4)
    .map((it) => `· "${it.preview}" (${it.atKst})`)
    .join("\n");
  const tail = s.count > 4 ? `\n… 외 ${s.count - 4}건` : "";
  return `${head}\n${more}${tail}`;
}

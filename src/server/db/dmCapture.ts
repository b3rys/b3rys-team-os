// GD와의 1:1 DM 캡처 — 재시작 후에도 recall이 보이도록 team.db에 durable 저장.
// ★버스 message 테이블과 완전 분리★: dispatch/wake 컬럼이 아예 없어 이중응대(재전달) 함정이
// 구조적으로 불가. recall만 이 테이블을 읽는다. member_id 필터로 멤버별 격리(타 멤버의 GD DM
// 열람 불가 — GD 개인데이터 프라이버시 built-in).
import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";

export type DmDirection = "in" | "out"; // in=GD→봇, out=봇→GD

export interface DmMessageInput {
  id?: string;
  memberId: string; // 격리 핵심키 (bill/demis/steve/…)
  runtime?: string | null; // claude_channel/openclaw/hermes_agent
  direction: DmDirection;
  body: string;
  createdAt: Date; // UTC instant (KST는 렌더 시 +9h)
  dedupeKey: string; // telegram:chatid:msgid 또는 ts+본문해시 — 재삽입 중복 0
  sourceRef?: string | null; // 추출 소스 감사용
}

export interface DmMessageRow {
  id: string;
  member_id: string;
  runtime: string | null;
  direction: DmDirection;
  body: string;
  created_at: string; // UTC "YYYY-MM-DD HH:MM:SS"
  dedupe_key: string;
  source_ref: string | null;
}

// UTC Date → "YYYY-MM-DD HH:MM:SS" (버스/스케줄러 toSqliteDate와 동일 포맷).
function toUtcSql(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * GD 1:1 DM 한 건 저장. dedupe_key UNIQUE + INSERT OR IGNORE로 재삽입 시 중복 무시
 * (같은 메시지를 훅이 두 번 봐도 행 1개). 삽입되면 true, 중복이면 false.
 */
export function insertDmMessage(db: Database, input: DmMessageInput): boolean {
  const id = input.id ?? `dm_${nanoid(12)}`;
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO dm_message
         (id, member_id, runtime, direction, body, created_at, dedupe_key, source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.memberId,
      input.runtime ?? null,
      input.direction,
      input.body,
      toUtcSql(input.createdAt),
      input.dedupeKey,
      input.sourceRef ?? null,
    );
  return res.changes === 1;
}

/**
 * 특정 멤버의 GD 1:1 최근 메시지 (최신 → 과거). ★member_id 필터 = 멤버별 격리★:
 * 타 멤버의 GD DM은 절대 포함되지 않는다. recall 슬롯에서 시간순으로 쓰려면 호출부에서 reverse.
 */
export function recallDmMessages(db: Database, memberId: string, limit = 10): DmMessageRow[] {
  return db
    .prepare(`SELECT * FROM dm_message WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(memberId, limit) as DmMessageRow[];
}

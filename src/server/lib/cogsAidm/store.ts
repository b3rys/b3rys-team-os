/**
 * 팀원끼리 대화 → cogs AI DM 중계의 영속 상태. 버스 기록(message)은 건드리지 않고 옆에 표 두 개만 둔다.
 *
 *   cogs_aidm_outbox — 보낼 것 한 줄씩. seq(AUTOINCREMENT) = cogs 게시 순서(영속·불변·재사용 없음).
 *                      dedupe_key UNIQUE: 메시지는 버스 message id, 종료는 "complete:<답 message id>".
 *                      건너뛴 것도 이유와 함께 남긴다(다시 대조하지 않게, 왜 안 갔는지 보이게).
 *   cogs_aidm_work   — (버스 thread, 정렬된 짝, generation) → cogs AI DM 방·work. 완료되면 다음 generation.
 */
import type { Database } from "bun:sqlite";

export type OutboxState = "pending" | "sent" | "skipped" | "failed";
export interface OutboxRow {
  seq: number;
  dedupe_key: string;
  kind: "message" | "complete";
  thread_id: string;
  bus_message_id: string | null;
  from_agent: string | null;
  to_agent: string | null;
  no_wake: number;
  state: OutboxState;
  reason: string | null;
  attempts: number;
  cogs_message_id: number | null;
}
export interface WorkRow {
  thread_id: string;
  pair_key: string;
  generation: number;
  chat_id: string | null;
  work_id: number | null;
  state: "open" | "completed";
  last_seq: number | null;
}

export function migrateCogsAidm(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS cogs_aidm_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('message','complete')),
    thread_id TEXT NOT NULL,
    bus_message_id TEXT REFERENCES message(id) ON DELETE SET NULL,
    from_agent TEXT,
    to_agent TEXT,
    no_wake INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','skipped','failed')),
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    cogs_message_id INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_cogs_aidm_outbox_state ON cogs_aidm_outbox(state, seq)");
  db.run("CREATE INDEX IF NOT EXISTS idx_cogs_aidm_outbox_thread ON cogs_aidm_outbox(thread_id, seq)");
  db.run(`CREATE TABLE IF NOT EXISTS cogs_aidm_work (
    thread_id TEXT NOT NULL,
    pair_key TEXT NOT NULL,
    generation INTEGER NOT NULL,
    chat_id TEXT,
    work_id INTEGER,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','completed')),
    last_seq INTEGER,
    PRIMARY KEY (thread_id, pair_key, generation)
  )`);
}

export function enqueue(
  db: Database,
  row: { dedupe_key: string; kind: "message" | "complete"; thread_id: string; bus_message_id?: string | null; from_agent?: string | null; to_agent?: string | null; no_wake?: boolean; state?: OutboxState; reason?: string | null },
  nowMs: number,
): boolean {
  return db.prepare(
    `INSERT OR IGNORE INTO cogs_aidm_outbox (dedupe_key, kind, thread_id, bus_message_id, from_agent, to_agent, no_wake, state, reason, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.dedupe_key, row.kind, row.thread_id, row.bus_message_id ?? null, row.from_agent ?? null, row.to_agent ?? null,
    row.no_wake ? 1 : 0, row.state ?? "pending", row.reason ?? null, nowMs, nowMs).changes === 1;
}

export function pendingRows(db: Database, limit = 200): OutboxRow[] {
  return db.prepare("SELECT * FROM cogs_aidm_outbox WHERE state = 'pending' ORDER BY seq LIMIT ?").all(limit) as OutboxRow[];
}

export function markRow(db: Database, seq: number, patch: { state: OutboxState; reason?: string | null; cogs_message_id?: number | null; attemptsDelta?: number }, nowMs: number): void {
  db.prepare(
    `UPDATE cogs_aidm_outbox SET state = ?, reason = COALESCE(?, reason), cogs_message_id = COALESCE(?, cogs_message_id),
       attempts = attempts + ?, updated_at_ms = ? WHERE seq = ?`,
  ).run(patch.state, patch.reason ?? null, patch.cogs_message_id ?? null, patch.attemptsDelta ?? 0, nowMs, seq);
}

/** 그 짝의 지금 work(가장 높은 generation). 완료됐거나 없으면 다음 generation 번호를 준다. */
export function currentWork(db: Database, threadId: string, pairKey: string): { open: WorkRow | null; nextGeneration: number } {
  const w = db.prepare("SELECT * FROM cogs_aidm_work WHERE thread_id = ? AND pair_key = ? ORDER BY generation DESC LIMIT 1").get(threadId, pairKey) as WorkRow | undefined;
  if (w && w.state === "open") return { open: w, nextGeneration: w.generation };
  return { open: null, nextGeneration: (w?.generation ?? 0) + 1 };
}

export function saveWork(db: Database, w: WorkRow): void {
  db.prepare(
    `INSERT INTO cogs_aidm_work (thread_id, pair_key, generation, chat_id, work_id, state, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, pair_key, generation) DO UPDATE SET chat_id = excluded.chat_id, work_id = excluded.work_id, state = excluded.state, last_seq = excluded.last_seq`,
  ).run(w.thread_id, w.pair_key, w.generation, w.chat_id, w.work_id, w.state, w.last_seq);
}

export function openWorks(db: Database, threadId: string): WorkRow[] {
  return db.prepare("SELECT * FROM cogs_aidm_work WHERE thread_id = ? AND state = 'open'").all(threadId) as WorkRow[];
}

/** 이 thread 에서 종료 행보다 앞선(seq 작은) 아직 안 끝난 메시지 행이 있나. */
export function hasPendingBefore(db: Database, threadId: string, seq: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM cogs_aidm_outbox WHERE thread_id = ? AND seq < ? AND kind = 'message' AND state = 'pending' LIMIT 1").get(threadId, seq));
}

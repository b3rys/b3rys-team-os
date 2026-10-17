/** 분리 실행은 배달 lease보다 오래 살아 재시작 때 기존 dispatching 복구에서 누락되므로 턴 시작·종료를 영속 마커로 기록한다.
 * 오래된 마커만 회수해 실행 중 턴을 보호하고, 답이 있으면 마커만 지우며 없으면 pending으로 되돌려 중복 게시 없이 재실행한다. */
import type { Database } from "bun:sqlite";

/** 라이브 턴(LLM 타임아웃 120s, runner CALL_TIMEOUT_MS) + 여유. 이보다 오래된 마커만 "크래시"로 간주. */
export const INFLIGHT_STALE_SEC = 150;

/** 턴 시작 — 처리중 마커 기록(같은 message+agent는 1개로 갱신). */
export function markInflight(db: Database, messageId: string, agentId: string, threadId: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO b3os_native_inflight (message_id, agent_id, thread_id, started_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(messageId, agentId, threadId);
}

/** 턴 정상 종료(성공/dup/에러) — 마커 삭제. 크래시면 호출 안 돼 마커가 남는다. */
export function clearInflight(db: Database, messageId: string, agentId: string): void {
  db.prepare(`DELETE FROM b3os_native_inflight WHERE message_id = ? AND agent_id = ?`).run(
    messageId,
    agentId,
  );
}

/** 테스트/관측용 — 현재 마커 수. */
export function inflightMarkerCount(db: Database): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM b3os_native_inflight`).get() as { n: number };
  return r.n;
}

/**
 * 부팅 복구 sweep. 오래된 마커(크래시 잔존)를 처리하고 재처리한 건수를 반환.
 * staleSec 인자는 테스트에서 0으로 강제해 즉시 복구 검증용(기본=INFLIGHT_STALE_SEC).
 */
export function recoverB3osNativeInflight(db: Database, staleSec: number = INFLIGHT_STALE_SEC): number {
  const stale = db
    .prepare(
      `SELECT message_id, agent_id, thread_id FROM b3os_native_inflight
       WHERE started_at <= datetime('now', '-' || ? || ' seconds')`,
    )
    .all(staleSec) as { message_id: string; agent_id: string; thread_id: string }[];

  let redispatched = 0;
  for (const m of stale) {
    // ① 이미 답이 게시됐나? (크래시가 post 후~마커삭제 전에 났을 수 있음) — 있으면 재처리 X(멱등).
    const replied = db
      .prepare(`SELECT id FROM message WHERE in_reply_to = ? AND from_agent_id = ? LIMIT 1`)
      .get(m.message_id, m.agent_id) as { id: string } | undefined;

    if (!replied) {
      // ② 답 없음 → 원 메시지를 재wake 대상으로 되돌린다(기존 디스패처가 픽업). dedup이 이중게시 방어.
      const res = db
        .prepare(
          `UPDATE message_recipient
           SET delivery_state = 'pending', claimed_at = NULL, lease_until = NULL
           WHERE message_id = ? AND agent_id = ? AND delivery_state NOT IN ('pending', 'dispatching')`,
        )
        .run(m.message_id, m.agent_id);
      // 실제로 재wake 대상으로 바꾼 행만 카운트(이미 pending/dispatching이면 무변화 — 로그 신뢰성).
      if (res.changes > 0) redispatched++;
    }
    db.prepare(`DELETE FROM b3os_native_inflight WHERE message_id = ? AND agent_id = ?`).run(
      m.message_id,
      m.agent_id,
    );
  }
  return redispatched;
}

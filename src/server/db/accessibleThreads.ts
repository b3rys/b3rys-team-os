/**
 * 에이전트-접근가능 스레드 스코프 헬퍼 (M3a G3 · 크로스런타임 공유).
 *
 * 왜: M3a 읽기도구(read_thread·search_messages)나 memory recall이 "아무 thread_id나" 읽으면
 * 권한 밖 1:1 private DM까지 노출된다(within-team 정보누출, Bill 인프라리뷰 z0i8xcsDuR4l).
 * 이 헬퍼가 "그 에이전트가 실제로 접근 가능한 스레드"만 반환한다.
 *
 * ★스코프 = (a) broadcast/공유 스레드 + (b) 그 에이전트가 발신/수신/참여한 스레드.★
 * ★participants_json 안 씀★ — 생성 시 1회만 세팅되고 이후 미갱신이라 stale(codex D-agent 발견).
 * 대신 message.from/to_agent_id + message_recipient 로 실제 참여를 산출한다.
 *
 * 단일팀 DB(message에 team_id 컬럼 없음)라 team 스코프는 지금 불필요 — public/멀티팀 도입 시
 * team_id AND 참여 2중필터로 확장(M3b/public).
 */
import type { Database } from "bun:sqlite";

/** 그 에이전트가 접근 가능한 thread_id 집합. read_thread/search recall 가 이걸로 스코프한다. */
export function accessibleThreadIds(db: Database, agentId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT m.thread_id AS tid
         FROM message m
         LEFT JOIN message_recipient mr
           ON mr.message_id = m.id AND mr.agent_id = ?
        WHERE m.thread_id IS NOT NULL
          AND ( m.from_agent_id = ?          -- 그 에이전트가 발신
             OR m.to_agent_id   = ?          -- 그 에이전트가 수신(directed)
             OR m.to_agent_id   = 'broadcast'-- 팀 공유(broadcast)
             OR mr.agent_id IS NOT NULL )`, // 마지막 OR = 명시적 recipient(참여)
    )
    .all(agentId, agentId, agentId) as { tid: string }[];
  return new Set(rows.map((r) => r.tid));
}

/**
 * 그 에이전트가 이 스레드에 접근 가능한가(단건 검사 — read_thread 게이트용).
 * ★accessibleThreadIds 에 위임(단일 진실원천)★ — 별도 쿼리 중복 시 미묘한 불일치가 생겨(스코프 누출 위험),
 * 스코프 판정 로직은 한 곳(accessibleThreadIds)만 둔다. read_thread 는 턴당 1회라 전체집합 비용 무시가능.
 */
export function canAccessThread(db: Database, agentId: string, threadId: string): boolean {
  return accessibleThreadIds(db, agentId).has(threadId);
}

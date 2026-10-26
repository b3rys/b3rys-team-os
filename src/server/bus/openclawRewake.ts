/**
 * ★openclaw 깨우기가 만기된 뒤 다시 확인한다.★
 *
 * openclaw wake 가 응답 없이 만기되면(expire_no_retry) 재시도하지 않는다 — 주입이 이미 됐을 수 있어서
 * 원문을 다시 보내면 같은 턴이 두 번 돈다. 그래서 세션 자체가 죽으면 아무도 그 팀원을 다시 깨우지 않는다.
 * 대신 만기 뒤 설정한 시간(분) 동안 그 팀원이 아무것도 보내지 않았으면 ★짧은 알림 하나★만
 * 만기된 메시지의 스레드로 보낸다. 같은 끊김(마지막 발신 이후 구간)에는 한 번만 보낸다.
 *
 * 기본값은 꺼짐. OPENCLAW_REWAKE_AFTER_MIN 에 분(>0)을 넣은 설치만 켜진다.
 */
import type { Database } from "bun:sqlite";
import { insertMessage } from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { getQuotaBlock } from "../lib/runtimeQuota";
import type { AgentRecord } from "../types";

/** 만기 뒤 이만큼 지난 일만 본다. 그보다 오래된 끊김은 이미 사람이 봤다고 본다. */
const LOOKBACK_HOURS = 6;

export function openclawRewakeAfterMin(): number {
  const n = Number(process.env.OPENCLAW_REWAKE_AFTER_MIN ?? "0");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface ExpiryRow {
  at: string;
  message_id: string;
  thread_id: string;
}

/** 보낸 알림 수를 돌려준다. */
export function rewakeAfterOpenclawExpiry(
  db: Database,
  agents: AgentRecord[],
  afterMin: number,
  now = Date.now(),
): number {
  if (!(afterMin > 0)) return 0;
  const nowSec = Math.floor(now / 1000);
  const ids = db
    .prepare(
      `SELECT DISTINCT json_extract(detail_json, '$.agent_id') AS agent_id
         FROM audit_event
        WHERE action = 'openclaw_wake_expired_no_retry'
          AND at >= datetime(?, 'unixepoch', ?)`,
    )
    .all(nowSec, `-${LOOKBACK_HOURS} hours`) as { agent_id: string | null }[];

  let sent = 0;
  for (const { agent_id } of ids) {
    const agent = agents.find((a) => a.id === agent_id);
    if (!agent || agent.runtime !== "openclaw") continue;
    try {
      if (rewakeOne(db, agent.id, afterMin, nowSec, now)) sent++;
    } catch (e) {
      appendAudit(db, "bus_dispatcher", "openclaw_rewake_failed", agent.id, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return sent;
}

function rewakeOne(db: Database, agentId: string, afterMin: number, nowSec: number, now: number): boolean {
  // 한도 상태면 holdForQuotaIfBlocked 가 리셋 뒤에 원문을 전달한다 — 여기서 겹쳐 깨우지 않는다.
  if (getQuotaBlock(db, agentId, now)) return false;

  const last = db
    .prepare(`SELECT id, created_at FROM message WHERE from_agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(agentId) as { id: string; created_at: string } | null;

  // 마지막 발신 뒤의 ★첫★ 만기 — 이 끊김이 시작된 자리다. 그 뒤에 발신이 있으면 살아 있는 것이다.
  const first = db
    .prepare(
      `SELECT a.at, a.target AS message_id, m.thread_id
         FROM audit_event a JOIN message m ON m.id = a.target
        WHERE a.action = 'openclaw_wake_expired_no_retry'
          AND json_extract(a.detail_json, '$.agent_id') = ?
          AND a.at >= datetime(?, 'unixepoch', ?)
          AND (? IS NULL OR a.at > ?)
        ORDER BY a.at ASC, a.id ASC LIMIT 1`,
    )
    .get(agentId, nowSec, `-${LOOKBACK_HOURS} hours`, last?.created_at ?? null, last?.created_at ?? null) as ExpiryRow | null;
  if (!first) return false;

  const due = db
    .prepare(`SELECT ? <= datetime(?, 'unixepoch', ?) AS due`)
    .get(first.at, nowSec, `-${afterMin} minutes`) as { due: number };
  if (!due.due) return false;

  const dedupeKey = `openclaw-rewake:${agentId}:${last?.id ?? "none"}`;
  if (db.prepare(`SELECT 1 FROM message WHERE dedupe_key = ? LIMIT 1`).get(dedupeKey)) return false;

  const msg = insertMessage(db, {
    thread_id: first.thread_id,
    from_agent_id: "system",
    to_agent_id: agentId,
    type: "dm",
    body:
      `[재개 확인] 이 스레드의 메시지(${first.message_id})를 깨우는 요청이 응답 없이 만기됐고, ` +
      `그 뒤 ${afterMin}분 넘게 ${agentId} 의 발신이 없습니다. 세션이 끊겼을 수 있습니다. ` +
      `하던 일이 있으면 받은 메시지를 확인하고 이어서 하세요. 원문은 다시 보내지 않습니다. ` +
      `이미 끝냈거나 할 일이 없으면 답하지 않아도 됩니다.`,
    source: "system",           // 그 팀원이 한 말이 아니다 · pingpong 검사를 안 탄다
    hop_count: 0,
    priority: "high",
    dedupe_key: dedupeKey,      // 같은 끊김에는 한 번만
  } as Parameters<typeof insertMessage>[1]);

  appendAudit(db, "bus_dispatcher", "openclaw_rewake_sent", first.message_id, {
    agent_id: agentId, notice_id: msg.id, expired_at: first.at, last_sent_id: last?.id ?? null,
  });
  return true;
}

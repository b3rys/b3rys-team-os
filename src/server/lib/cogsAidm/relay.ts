/**
 * 팀원끼리 대화(버스) → cogs AI DM 중계. 버스 배달과 무관한 부가 기능이다 — 여기 실패가 버스를 막지 않는다.
 *
 * 무엇을 잇나: cogs 인입으로 시작된 버스 thread 안에서, 둘 다 같은 cogs 서버에 계정이 있는 팀원끼리 주고받은 메시지.
 *   - origin = 그 thread 를 연 cogs 인입(cogsRelay 가 남긴 meta.cogs). 본문·임의 값으로 정하지 않는다.
 *   - 자식 thread 로 넘어간 위임은 잇지 않는다(이름으로 추정하지 않는다).
 *   - hop·자동대화 상한으로 막힌 메시지는 잇지 않는다(정상 전달처럼 보이면 안 된다). 깨우지 않는 메시지는 표시용으로만.
 *   - 버스 hop·부모·source 를 바꾸지 않고 새 버스 메시지를 만들지 않는다.
 *
 * 무유실(48시간 안): 저장 직후 훅이 빠른 길, 주기·시작 대조(NOT EXISTS)가 보장. 창 밖으로 밀린 누락은 skipped(out_of_window)로 남는다.
 * 종료: thread origin 방에 원래 담당의 최종 답이 실제로 올라간 기록(meta.cogs_delivery.state='sent')을 대조가 찾아
 *   같은 트랜잭션에서 앞선 누락을 먼저 채운 뒤 종료 행을 넣는다. 종료는 앞선 메시지 행이 다 끝나야 실행된다.
 */
import type { Database } from "bun:sqlite";
import { checkPingpong } from "../../bus/antiPingpong";
import type { PendingDispatchRow } from "../../bus/types";
import { findCogsMetaForThread } from "../../db/inbox/messages";
import type { CogsMeta } from "../cogsRelay";
import { CogsDeliveryUnknown } from "../cogsRelay";
import { currentWork, enqueue, hasPendingBefore, markRow, openWorks, pendingRows, saveWork, type OutboxRow } from "./store";

export const RECONCILE_WINDOW_MS = 48 * 3600_000;
export const MAX_ATTEMPTS = 5;
const RESERVED = new Set(["broadcast", "user", "system", "moderator"]);

export interface CogsIdentity { apiBase: string; token: string }

/** cogs 봇 API(cogs 서버 AI DM 2단계). 실패는 throw, 응답 유실은 CogsDeliveryUnknown. */
export interface CogsAidmApi {
  botId(id: CogsIdentity): Promise<number>;
  openPair(id: CogsIdentity, peerBotId: number): Promise<string>;
  startWork(id: CogsIdentity, a: { chat_id: string; request_key: string; origin_chat_id: string; origin_message_id: number; title: string }): Promise<number>;
  send(id: CogsIdentity, a: { chat_id: string; work_id: number; client_msg_id: string; text: string; bus_seq: number; no_wake: boolean }): Promise<number>;
  complete(id: CogsIdentity, a: { chat_id: string; work_id: number; last_bus_seq: number; report_message_id: number | null }): Promise<void>;
}

export interface CogsAidmDeps {
  db: Database;
  api: CogsAidmApi;
  /** 그 팀원의 cogs 계정(같은 서버 판정용 apiBase 포함). 없으면 null. */
  identityOf: (agentId: string) => CogsIdentity | null;
  roster: () => ReadonlySet<string>;
  now?: () => number;
  log?: (line: string) => void;
}

interface MsgRow {
  id: string; thread_id: string; from_agent_id: string; to_agent_id: string; body: string; source: string;
  hop_count: number; max_hop: number; in_reply_to: string | null; parent_message_id: string | null;
  meta_json: string | null; created_at: string;
}

const pairKey = (a: string, b: string) => [a, b].sort().join("|");
const meta = (m: MsgRow): Record<string, any> => { try { return JSON.parse(m.meta_json ?? "null") ?? {}; } catch { return {}; } };

/** 메시지 한 건을 잇나. 잇지 않으면 이유(영속 기록용). 이 thread 와 무관하면 null(행을 만들지 않는다). */
export function classifyBusMessage(deps: CogsAidmDeps, m: MsgRow, origin: CogsMeta): { relay: true; noWake: boolean } | { relay: false; reason: string } | null {
  if (m.source !== "agent" || RESERVED.has(m.to_agent_id) || m.from_agent_id === m.to_agent_id) return null;
  const verdict = checkPingpong(deps.db, {
    message_id: m.id, agent_id: m.to_agent_id, delivery_state: "pending", retry_count: 0, last_error: null,
    from_agent_id: m.from_agent_id, to_agent_id: m.to_agent_id, body: m.body, source: m.source, created_by: null,
    max_hop: m.max_hop, hop_count: m.hop_count, in_reply_to: m.in_reply_to, parent_message_id: m.parent_message_id,
  } as unknown as PendingDispatchRow, deps.roster());
  if (!verdict.allowed) return { relay: false, reason: `bus_blocked:${verdict.reason.split(":")[0]}` };
  const a = deps.identityOf(m.from_agent_id);
  const b = deps.identityOf(m.to_agent_id);
  if (!a || !b) return { relay: false, reason: "not_cogs_member" };
  if (a.apiBase !== b.apiBase) return { relay: false, reason: "different_cogs_server" };
  void origin;
  return { relay: true, noWake: meta(m).no_wake === true };
}

/**
 * 한 thread 대조: 버스 메시지 중 outbox 에 없는 것을 (created_at, rowid) 순으로 채운다.
 * created_at 은 초 단위라 같은 초 안의 순서는 rowid(삽입 순서)로 정한다 — 순번 계약이 아니라 같은 초 안의 정렬용이다.
 * 원래 담당의 최종 답 기록이 있으면 그 뒤에 종료 행. 한 트랜잭션 — 누락 채우기가 종료보다 먼저다.
 */
export function reconcileThread(deps: CogsAidmDeps, threadId: string): number {
  const db = deps.db;
  const now = (deps.now ?? Date.now)();
  const origin = findCogsMetaForThread(db, threadId);
  if (!origin) return 0;
  const since = new Date(now - RECONCILE_WINDOW_MS).toISOString().replace("T", " ").slice(0, 19);
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT m.* FROM message m WHERE m.thread_id = ? AND m.source = 'agent'
         AND NOT EXISTS (SELECT 1 FROM cogs_aidm_outbox o WHERE o.dedupe_key = m.id OR o.dedupe_key = 'complete:' || m.id)
       ORDER BY m.created_at, m.rowid`,
    ).all(threadId) as MsgRow[];
    let n = 0;
    for (const m of rows) {
      const inWindow = m.created_at >= since;
      if (m.to_agent_id === "broadcast") {
        // 원래 담당이 그 방에 실제로 올린 답 = 종료 사건.
        if (m.from_agent_id === origin.agent_id && meta(m).cogs_delivery?.state === "sent") {
          n += enqueue(db, { dedupe_key: `complete:${m.id}`, kind: "complete", thread_id: threadId, bus_message_id: m.id }, now) ? 1 : 0;
        }
        continue;
      }
      const c = classifyBusMessage(deps, m, origin);
      if (!c) continue;
      if (!inWindow) { n += enqueue(db, { dedupe_key: m.id, kind: "message", thread_id: threadId, bus_message_id: m.id, from_agent: m.from_agent_id, to_agent: m.to_agent_id, state: "skipped", reason: "out_of_window" }, now) ? 1 : 0; continue; }
      n += enqueue(db, c.relay
        ? { dedupe_key: m.id, kind: "message", thread_id: threadId, bus_message_id: m.id, from_agent: m.from_agent_id, to_agent: m.to_agent_id, no_wake: c.noWake }
        : { dedupe_key: m.id, kind: "message", thread_id: threadId, bus_message_id: m.id, from_agent: m.from_agent_id, to_agent: m.to_agent_id, state: "skipped", reason: c.reason }, now) ? 1 : 0;
    }
    return n;
  })();
}

/** 창 안에서 cogs 인입으로 시작된 thread 전부 대조(주기·시작). */
export function reconcileAll(deps: CogsAidmDeps): number {
  const now = (deps.now ?? Date.now)();
  const since = new Date(now - RECONCILE_WINDOW_MS).toISOString().replace("T", " ").slice(0, 19);
  const threads = deps.db.prepare(
    `SELECT DISTINCT thread_id FROM message WHERE source = 'user' AND json_extract(meta_json, '$.cogs.chat_id') IS NOT NULL AND created_at >= ?`,
  ).all(since) as Array<{ thread_id: string }>;
  let n = 0;
  for (const t of threads) {
    try { n += reconcileThread(deps, t.thread_id); } catch (e) { deps.log?.(`[cogs-aidm] 대조 실패 thread=${t.thread_id}: ${e instanceof Error ? e.message : e}`); }
  }
  return n;
}

/** 저장 직후 훅(빠른 길). 실패해도 대조가 채운다 — 여기서 던지지 않는다. */
export function onBusMessageStored(deps: CogsAidmDeps, threadId: string): void {
  try { reconcileThread(deps, threadId); } catch (e) { deps.log?.(`[cogs-aidm] 훅 대조 실패 thread=${threadId}: ${e instanceof Error ? e.message : e}`); }
}

/**
 * 보낼 것을 순서대로 보낸다. thread 안에서 앞 행이 아직 pending 이면 뒤 행은 이번에 건너뛴다(순서 보존).
 * 한 번에 하나의 drain 만 돈다(부른 쪽이 직렬화).
 */
export async function drain(deps: CogsAidmDeps): Promise<{ sent: number; failed: number }> {
  const db = deps.db;
  const now = () => (deps.now ?? Date.now)();
  const blocked = new Set<string>();
  let sent = 0, failed = 0;
  for (const row of pendingRows(db)) {
    if (blocked.has(row.thread_id)) continue;
    try {
      const ok = row.kind === "message" ? await sendRow(deps, row) : await completeRow(deps, row);
      if (ok === "wait") { blocked.add(row.thread_id); continue; }
      markRow(db, row.seq, { state: ok === "skipped" ? "skipped" : "sent", ...(typeof ok === "object" ? ok : {}) }, now());
      if (ok !== "skipped") sent++;
    } catch (e) {
      const unknown = e instanceof CogsDeliveryUnknown;
      const give = row.attempts + 1 >= MAX_ATTEMPTS;
      // 응답 유실은 같은 client_msg_id 로 다시 보낸다(서버가 같은 메시지를 돌려준다).
      markRow(db, row.seq, { state: give ? "failed" : "pending", reason: unknown ? "delivery_unknown" : `error:${e instanceof Error ? e.message.slice(0, 80) : "x"}`, attemptsDelta: 1 }, now());
      if (give) failed++;
      blocked.add(row.thread_id); // 순서를 지키려고 이 thread 뒤 행은 다음 차례로
    }
  }
  return { sent, failed };
}

async function sendRow(deps: CogsAidmDeps, row: OutboxRow): Promise<"skipped" | { cogs_message_id: number }> {
  const db = deps.db;
  const origin = findCogsMetaForThread(db, row.thread_id);
  const a = row.from_agent ? deps.identityOf(row.from_agent) : null;
  const b = row.to_agent ? deps.identityOf(row.to_agent) : null;
  // 그사이 계정이 사라졌으면(권한 회수·탈퇴) 보내지 않는다.
  if (!origin || !a || !b || a.apiBase !== b.apiBase || !row.bus_message_id) {
    markRow(db, row.seq, { state: "skipped", reason: "identity_or_origin_gone" }, (deps.now ?? Date.now)());
    return "skipped";
  }
  const body = (db.prepare("SELECT body FROM message WHERE id = ?").get(row.bus_message_id) as { body: string } | undefined)?.body;
  if (body === undefined) { markRow(db, row.seq, { state: "skipped", reason: "bus_message_gone" }, (deps.now ?? Date.now)()); return "skipped"; }
  const pk = pairKey(row.from_agent!, row.to_agent!);
  const cur = currentWork(db, row.thread_id, pk);
  let work = cur.open;
  if (!work) {
    const chatId = await deps.api.openPair(a, await deps.api.botId(b));
    const workId = await deps.api.startWork(a, {
      chat_id: chatId, request_key: `${row.thread_id}:${pk}:g${cur.nextGeneration}`,
      origin_chat_id: origin.chat_id, origin_message_id: origin.message_id, title: body.slice(0, 60),
    });
    work = { thread_id: row.thread_id, pair_key: pk, generation: cur.nextGeneration, chat_id: chatId, work_id: workId, state: "open", last_seq: null };
    saveWork(db, work);
  }
  const id = await deps.api.send(a, { chat_id: work.chat_id!, work_id: work.work_id!, client_msg_id: row.bus_message_id, text: body, bus_seq: row.seq, no_wake: row.no_wake === 1 });
  saveWork(db, { ...work, last_seq: row.seq });
  return { cogs_message_id: id };
}

async function completeRow(deps: CogsAidmDeps, row: OutboxRow): Promise<"wait" | "skipped" | Record<string, never>> {
  const db = deps.db;
  if (hasPendingBefore(db, row.thread_id, row.seq)) return "wait";
  // 원래 방에 올라간 최종 답의 cogs 메시지 번호(서버가 그 방의 그 답인지 검증한다).
  const answerMeta = row.bus_message_id
    ? (db.prepare("SELECT meta_json FROM message WHERE id = ?").get(row.bus_message_id) as { meta_json: string | null } | undefined)?.meta_json
    : null;
  let reportId: number | null = null;
  try { const v = JSON.parse(answerMeta ?? "null")?.cogs_delivery?.message_id; reportId = Number.isSafeInteger(v) ? v : null; } catch { reportId = null; }
  const answerBy = row.bus_message_id
    ? (db.prepare("SELECT from_agent_id FROM message WHERE id = ?").get(row.bus_message_id) as { from_agent_id: string } | undefined)?.from_agent_id
    : undefined;
  for (const w of openWorks(db, row.thread_id)) {
    if (w.last_seq === null || w.chat_id === null || w.work_id === null) { saveWork(db, { ...w, state: "completed" }); continue; }
    const [x, y] = w.pair_key.split("|");
    // 답을 쓴 담당이 짝에 있으면 그 토큰(서버가 report 발신자를 호출자와 맞춘다), 없으면 짝 참여자.
    const caller = answerBy && (answerBy === x || answerBy === y) ? answerBy : x!;
    const id = deps.identityOf(caller) ?? deps.identityOf(caller === x ? y! : x!);
    if (!id) { saveWork(db, { ...w, state: "completed" }); continue; }
    await deps.api.complete(id, { chat_id: w.chat_id, work_id: w.work_id, last_bus_seq: w.last_seq, report_message_id: reportId });
    saveWork(db, { ...w, state: "completed" });
  }
  return {};
}

/** 주기 대조 + drain 을 직렬로 도는 작업자. 버스 저장 훅·답 게시가 kick() 으로 깨운다. */
export function startCogsAidmRelay(deps: CogsAidmDeps, intervalMs = 60_000): { kick: (threadId?: string) => void; stop: () => void; idle: () => Promise<void> } {
  let running: Promise<void> = Promise.resolve();
  let queued = false;
  const cycle = (threadId?: string) => {
    if (threadId) onBusMessageStored(deps, threadId);
    if (queued) return;
    queued = true;
    running = running.then(async () => {
      queued = false;
      if (!threadId) { try { reconcileAll(deps); } catch { /* 다음 주기 */ } }
      try { await drain(deps); } catch (e) { deps.log?.(`[cogs-aidm] drain 실패: ${e instanceof Error ? e.message : e}`); }
    });
  };
  cycle();
  const t = setInterval(() => cycle(), intervalMs);
  return { kick: (threadId) => cycle(threadId), stop: () => clearInterval(t), idle: () => running };
}

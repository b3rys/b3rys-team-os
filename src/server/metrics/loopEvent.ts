/**
 * 측정 지표 트랙 W1 — loop_event 계측 기반 (설계 research/metrics-w0-design-v0.2.md).
 *
 * 이 모듈이 하는 일(W1 첫 슬라이스, additive — 라이브 경로 미변경):
 *  ① loop_event 스키마 v0.2 envelope 타입 + event name 상수
 *  ② emitLoopEvent: 기존 audit_event 재사용(별도 테이블 X, Bill 권고). action=event_name(1:1), detail_json에 envelope.
 *  ③ makeEpisodeId: episode 조인 키(Lui 보강① — task/proposal 없으면 request_message_id, '-' 금지)
 *  ④ projectAuditRow: 기존 audit(route_decision 등)을 loop_event로 합성(§7 projection contract)
 *
 * ★라이브 경로 emit 훅(insertMessage/tasks lane-transition)은 다음 슬라이스(이 엔진 Bill 리뷰 후).★
 */
import type { Database } from "bun:sqlite";
import { appendAudit } from "../db/queries";

/** 루프 라이프사이클 event name (설계 §1.2). action ↔ event_name 1:1. */
export const EVENT = {
  request_created: "request.created",
  routing_resolved: "routing.resolved",
  ack_observed: "ack.observed",
  handoff_sent: "handoff.sent",
  handoff_acknowledged: "handoff.acknowledged",
  handoff_rejected: "handoff.rejected",
  task_opened: "task.opened",
  task_closed: "task.closed",
  closure_verified: "closure.verified",
  closure_corrected: "closure.corrected",
  thread_reopened: "thread.reopened",
  rework_requested: "rework.requested",
  policy_violation: "policy.violation",
} as const;

export const LOOP_EVENT_SCHEMA = "loop_event/0.2";
/** verified 판정에 유효한 user-visible surface(설계 §2 핵심③). */
export const VISIBLE_SURFACES = new Set(["telegram_group", "telegram_dm", "slack", "dashboard"]);
const METRICS_EMIT_SETTING_KEY = "metrics_emit_enabled";
const METRICS_EMIT_CACHE_TTL_MS = 5000;

const metricsEmitCache = new WeakMap<Database, { expiresAt: number; enabled: boolean }>();

function parseFlag(raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true") return true;
  if (v === "off" || v === "0" || v === "false") return false;
  return null;
}

/** loop_event envelope v0.2 (실무 서브셋 — 설계 §1.1). */
export interface LoopEvent {
  event_id: string; // 멱등 키(§7 contract)
  event_name: string;
  schema_version: "0.2";
  occurred_at: string; // ISO8601
  // 상관(episode 조인)
  episode_id: string;
  thread_id: string;
  request_message_id?: string;
  message_id?: string;
  task_id?: string;
  proposal_id?: string;
  parent_event_id?: string;
  // 행위자
  actor: string;
  target?: string;
  owner?: string;
  // 컨텍스트(공정성 dimension)
  runtime?: string;
  role_context?: string;
  quiet_hours?: boolean;
  visible_surface?: string;
  metric_scope?: string;
  // 결과
  outcome?: string;
  reason?: string;
  evidence_ref?: string;
  correction_of_event_id?: string;
  // routing projection 고정필드(§7 — routing correctness용)
  method?: string;
  resolved_owner?: string;
  targets?: string[];
  mentioned_set?: string[];
  // 정렬 tiebreak(audit_event.id) — §7 정렬 기준 (occurred_at, seq)
  seq?: number;
}

/**
 * episode_id = thread_id : (task_id | proposal_id | request_message_id) (Lui 보강①).
 * ★'-' 금지: 카드 없는 요청도 request_message_id로 구분해 허수 방지.★ 셋 다 없을 때만 최후 '-'.
 */
export function makeEpisodeId(
  threadId: string,
  ids: { taskId?: string; proposalId?: string; requestMessageId?: string },
): string {
  const key = ids.taskId || ids.proposalId || ids.requestMessageId || "-";
  return `${threadId}:${key}`;
}

/**
 * loop_event를 기존 audit_event에 emit(별도 테이블 X). action=event_name, detail_json=envelope.
 * ★멱등: event_id가 detail에 필수. recompute가 event_id로 dedupe(insert는 dedupe 안 함).★
 */
export function emitLoopEvent(db: Database, ev: LoopEvent): void {
  appendAudit(db, ev.actor, ev.event_name, ev.target ?? null, {
    schema: LOOP_EVENT_SCHEMA,
    ...ev,
  });
}

/**
 * Feature flag (default OFF). env B3OS_METRICS_EMIT = on/1/true | off/0/false (hard override); else setting
 * 'metrics_emit_enabled' = 'on'/'1'/'true' enables. Setting reads are cached briefly so hot emit paths do not
 * hit DB on every call.
 *   Enable live: INSERT INTO setting(key,value) VALUES('metrics_emit_enabled','on')
 *                ON CONFLICT(key) DO UPDATE SET value='on', updated_at=datetime('now');
 */
export function isMetricsEmitEnabled(db: Database): boolean {
  const env = parseFlag(process.env.B3OS_METRICS_EMIT);
  if (env !== null) return env;

  const now = Date.now();
  const cached = metricsEmitCache.get(db);
  if (cached && cached.expiresAt > now) return cached.enabled;

  let enabled = false;
  try {
    const row = db.prepare(`SELECT value FROM setting WHERE key = ?`).get(METRICS_EMIT_SETTING_KEY) as
      | { value?: string }
      | undefined;
    enabled = parseFlag(row?.value) === true;
  } catch {
    enabled = false;
  }
  metricsEmitCache.set(db, { expiresAt: now + METRICS_EMIT_CACHE_TTL_MS, enabled });
  return enabled;
}

/**
 * ★핫패스용 best-effort emit (Bill 리뷰 방향)★: loop_event emit 실패가 ★라이브 전달·기능을 절대 못 깨게★.
 * 계측(측정) < 전달(기능) 원칙 — try/catch로 감싸 실패는 무음 로그만. insertMessage/tasks lane 등 라이브 경로에서 이걸로 부른다.
 */
export function emitLoopEventSafe(db: Database, ev: LoopEvent): void {
  if (!isMetricsEmitEnabled(db)) return;
  try {
    emitLoopEvent(db, ev);
  } catch (e) {
    console.error("[metrics] loop_event emit failed (non-fatal):", e);
  }
}

/** 정규화된 audit 행(DB audit_event 또는 file audit 라인 공통 형태). */
export interface AuditRow {
  id: number; // 정렬 tiebreak
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  at: string; // ISO
}

/**
 * §7 projection: 기존 audit 행 → loop_event 합성.
 *  - native loop_event 행(schema=loop_event/0.2) → 그대로 파싱(occurred_at 없으면 at fallback).
 *  - legacy route_decision → routing.resolved 합성(event_id/episode_id 합성, 고정필드 매핑).
 *  - 그 외 → null(측정 비대상).
 */
export function projectAuditRow(
  row: AuditRow,
  ctx?: { threadId?: string; taskId?: string; requestMessageId?: string; parentEventId?: string },
): LoopEvent | null {
  const d = row.detail ?? {};
  // 이미 emit된 native loop_event
  if (d.schema === LOOP_EVENT_SCHEMA && typeof d.event_id === "string") {
    return {
      ...(d as unknown as LoopEvent),
      seq: row.id,
      occurred_at: (d.occurred_at as string) || row.at,
    };
  }
  // legacy route_decision → routing.resolved
  if (row.action === "route_decision") {
    const targets = Array.isArray(d.targets) ? (d.targets as string[]) : [];
    const via = typeof d.via === "string" ? d.via : undefined;
    const threadId = ctx?.threadId || (typeof d.thread_id === "string" ? d.thread_id : "");
    const resolvedOwner =
      (typeof d.activeAssigneeId === "string" && d.activeAssigneeId) || targets[0] || undefined;
    return {
      event_id: `proj:route:${row.id}`,
      event_name: EVENT.routing_resolved,
      schema_version: "0.2",
      occurred_at: row.at,
      thread_id: threadId,
      request_message_id: ctx?.requestMessageId,
      task_id: ctx?.taskId,
      episode_id: makeEpisodeId(threadId, { taskId: ctx?.taskId, requestMessageId: ctx?.requestMessageId }),
      parent_event_id: ctx?.parentEventId,
      actor: row.actor,
      method: via, // §7 고정필드
      resolved_owner: resolvedOwner,
      targets,
      mentioned_set: via === "mention" ? targets : undefined,
      reason: typeof d.reason === "string" ? d.reason : undefined,
      outcome: typeof d.outcome === "string" ? d.outcome : undefined,
      seq: row.id,
    };
  }
  return null;
}

/** §7 정렬: (occurred_at, seq) 안정 정렬. recompute 전에 항상 이 순서로. */
export function sortEvents(events: LoopEvent[]): LoopEvent[] {
  return [...events].sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? -1 : 1;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });
}

/** event_id 멱등 dedupe(§7 contract — 중복 emit 제거). */
export function dedupeEvents(events: LoopEvent[]): LoopEvent[] {
  const seen = new Set<string>();
  const out: LoopEvent[] = [];
  for (const e of events) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    out.push(e);
  }
  return out;
}

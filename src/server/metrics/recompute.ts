/**
 * 측정 지표 트랙 W1 — 핵심3 + 보조2 재계산 (설계 §2 의사코드 그대로).
 * ★입력 = loop_event 스트림만★ (추가 상태 없음 = replay 가능). 전부 event-only.
 */
import { EVENT, VISIBLE_SURFACES, type LoopEvent } from "./loopEvent";

const ms = (iso: string): number => Date.parse(iso);
const by = (events: LoopEvent[], name: string): LoopEvent[] => events.filter((e) => e.event_name === name);

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? null;
}

export interface AckLatencyResult {
  requests: number;
  acked: number;
  missed: number;
  quietExcluded: number;
  p50Sec: number | null;
  p95Sec: number | null;
}

/**
 * 핵심① ack latency = ack.observed - request.created (parent_event_id 우선 조인, Lui 보강②).
 * quiet_hours=true는 SLA 산출에서 제외(별도 버킷). ack 없으면 miss.
 */
export function ackLatency(events: LoopEvent[]): AckLatencyResult {
  const requests = by(events, EVENT.request_created);
  const acks = by(events, EVENT.ack_observed);
  const lat: number[] = [];
  let acked = 0;
  let missed = 0;
  let quietExcluded = 0;
  for (const r of requests) {
    // 1순위 parent_event_id 직결 → 오염 방지. fallback: episode+owner+시간.
    const a =
      acks.find((e) => e.parent_event_id === r.event_id) ??
      acks.find((e) => e.episode_id === r.episode_id && e.owner === r.owner && ms(e.occurred_at) >= ms(r.occurred_at));
    if (!a) {
      missed++;
      continue;
    }
    acked++;
    if (r.quiet_hours) {
      quietExcluded++;
      continue;
    }
    lat.push((ms(a.occurred_at) - ms(r.occurred_at)) / 1000);
  }
  const sorted = [...lat].sort((x, y) => x - y);
  return {
    requests: requests.length,
    acked,
    missed,
    quietExcluded,
    p50Sec: percentile(sorted, 50),
    p95Sec: percentile(sorted, 95),
  };
}

export interface HandoffLossResult {
  total: number;
  loss: number;
  rate: number;
}

/**
 * 핵심② handoff loss = handoff.sent 인데 window 내 ack/reject 응답 없음.
 * 조인키 = parent_event_id(응답→sent).
 */
export function handoffLoss(events: LoopEvent[], windowSec = 86_400): HandoffLossResult {
  const sent = by(events, EVENT.handoff_sent);
  const resp = [...by(events, EVENT.handoff_acknowledged), ...by(events, EVENT.handoff_rejected)];
  let loss = 0;
  for (const h of sent) {
    const r = resp.find((e) => e.parent_event_id === h.event_id);
    if (!r || (ms(r.occurred_at) - ms(h.occurred_at)) / 1000 > windowSec) loss++;
  }
  return { total: sent.length, loss, rate: sent.length ? loss / sent.length : 0 };
}

export interface VerifiedClosureResult {
  closed: number;
  verified: number;
  rate: number;
  hardPenalty: number;
}

/**
 * 핵심③ verified closure = task.closed 가 closure.verified(evidence+visible surface) 도달 &
 * closure.corrected(사후 reopen 정정) 없음. hard penalty = policy.violation 수.
 *
 * ★semantics(Bill 리뷰 #2, W1 확정 대기)★: closed = ★task.closed "이벤트" raw count★(per-event).
 *   close→reopen→close면 task.closed 2건 → closed=2. "닫힌 카드 수"(per-card)와 다를 수 있음.
 *   W1은 raw event count로 둔다(문서화). per-card 집계·재close 인플레 보정은 후속(OWNER와 semantics 확정 시).
 */
export function verifiedClosure(events: LoopEvent[]): VerifiedClosureResult {
  const closed = by(events, EVENT.task_closed);
  const verified = by(events, EVENT.closure_verified);
  const corrected = by(events, EVENT.closure_corrected);
  let ok = 0;
  for (const c of closed) {
    const v = verified.find(
      (e) => e.episode_id === c.episode_id && !!e.evidence_ref && VISIBLE_SURFACES.has(e.visible_surface || ""),
    );
    if (!v) continue;
    const corr = corrected.find((e) => e.correction_of_event_id === v.event_id);
    if (!corr) ok++;
  }
  const hardPenalty = by(events, EVENT.policy_violation).length;
  return { closed: closed.length, verified: ok, rate: closed.length ? ok / closed.length : 0, hardPenalty };
}

export interface ReopenReworkResult {
  closed: number;
  reopened: number;
  rate: number;
}

/**
 * 보조① reopen/rework rate = (thread.reopened ∪ rework.requested, 72h 내 of close) / task.closed.
 * ★72h 기준 = task.closed.occurred_at 기준(Lui 보강②).★
 */
export function reopenReworkRate(events: LoopEvent[], windowSec = 72 * 3600): ReopenReworkResult {
  const closed = by(events, EVENT.task_closed);
  const signals = [...by(events, EVENT.thread_reopened), ...by(events, EVENT.rework_requested)];
  let n = 0;
  for (const c of closed) {
    const t0 = ms(c.occurred_at);
    const hit = signals.find(
      (e) => e.episode_id === c.episode_id && ms(e.occurred_at) >= t0 && ms(e.occurred_at) <= t0 + windowSec * 1000,
    );
    if (hit) n++;
  }
  return { closed: closed.length, reopened: n, rate: closed.length ? n / closed.length : 0 };
}

export interface RoutingCorrectnessResult {
  total: number;
  withAck: number;
  correct: number;
  rate: number;
}

/**
 * 보조② owner/routing correctness = routing.resolved의 resolved_owner가 실제 응답자(ack.observed.owner)와 일치.
 * mention이면 mentioned_set 포함도 정답(§7 고정필드). ack 없는 라우팅은 분모 제외(withAck 기준).
 */
export function routingCorrectness(events: LoopEvent[]): RoutingCorrectnessResult {
  const routes = by(events, EVENT.routing_resolved);
  const acks = by(events, EVENT.ack_observed);
  let correct = 0;
  let withAck = 0;
  for (const rr of routes) {
    const responder = acks.find((e) => e.episode_id === rr.episode_id)?.owner;
    if (!responder) continue;
    withAck++;
    const ok =
      rr.resolved_owner === responder || (rr.method === "mention" && (rr.mentioned_set || []).includes(responder));
    if (ok) correct++;
  }
  return { total: routes.length, withAck, correct, rate: withAck ? correct / withAck : 0 };
}

export interface Core3Plus2 {
  ackLatency: AckLatencyResult;
  handoffLoss: HandoffLossResult;
  verifiedClosure: VerifiedClosureResult;
  reopenRework: ReopenReworkResult;
  routingCorrectness: RoutingCorrectnessResult;
}

/** 핵심3+보조2 일괄 재계산(설계 §2 완결 — event-only). */
export function recomputeAll(events: LoopEvent[]): Core3Plus2 {
  return {
    ackLatency: ackLatency(events),
    handoffLoss: handoffLoss(events),
    verifiedClosure: verifiedClosure(events),
    reopenRework: reopenReworkRate(events),
    routingCorrectness: routingCorrectness(events),
  };
}

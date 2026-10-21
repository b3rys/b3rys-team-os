/**
 * 승인 대기 — 브리지 프로세스 안에서 "그 요청이 끝났나" 를 기다린다.
 *
 * 진실은 DB 다. 깨우는 것(카드 누름·서버 제어 신호·만료 타이머)은 DB 를 다시 읽는 계기일 뿐이고,
 * 신호에 실린 값으로 결정하지 않는다. 그래서 신호가 늦거나·두 번 오거나·안 와도 결과는 같다:
 *   - 안 오면: expires_at 타이머가 DB 를 보고 만료로 닫는다(새 polling 은 없다).
 *   - 대기 등록 전에 이미 결정됐으면: 등록 직후 한 번 읽어서 바로 끝낸다.
 * 끝났다 = 허용(실행 인계는 부른 쪽이 handOffCogsApproval 로 한 번 더 확인) / 거절 / 만료·무효화.
 */
import type { Database } from "bun:sqlite";
import { getPermissionRequest } from "../permissionGate";
import { ensureCogsPermissionTables, expireDueCogsApprovals, getBinding, invalidateCogsApprovals } from "./approvals";
import type { CogsPermissionEvents } from "./events";

export type CogsWaitOutcome =
  | { kind: "allowed"; status: "allowed_once" | "allowed_always" }
  | { kind: "denied" }
  | { kind: "closed"; reason: string };

export interface CogsDecisionWaiters {
  /** 등록하고 DB 를 바로 한 번 본다. 이 팀원 것이 아니면 바로 닫힘. */
  wait(requestId: string): Promise<CogsWaitOutcome>;
  /** 다시 본다. requestId 가 없으면 대기 전부. */
  poke(requestId?: string): void;
  /** 그 대기 하나를 닫는다(부른 쪽이 더 기다릴 이유가 없을 때 — 예: 카드 전송 실패). */
  cancel(requestId: string, reason: string): void;
  /** 대기 수(시험·상태 표시용). */
  size(): number;
  /** 남은 대기를 모두 닫고 타이머를 치운다. */
  close(reason?: string): void;
}

export interface CogsDecisionWaitersDeps {
  agentId: string;
  /** 읽을 때마다 연다 — 다른 프로세스(서버)가 쓴 것을 본다. 닫기는 이쪽이 한다. */
  openDb: () => Database;
  now?: () => number;
  /** 만료 시각 뒤 여유. 시계 차이로 결정 직전에 닫지 않게. */
  expirySlackMs?: number;
  /** 읽기 오류 뒤 다시 볼 간격(시험용). */
  errorRetryMs?: number;
  events?: CogsPermissionEvents;
  report?: (msg: string) => void;
}

interface Entry {
  resolve: (o: CogsWaitOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** 한 번이라도 읽은 만료 시각. 읽기 오류가 이 기한을 늘리지 못한다. */
  deadlineMs: number | null;
  /** 연속 읽기 오류 수. */
  errors: number;
}

/** 읽기 오류 재시도 간격·상한. 상한을 넘거나 기한이 지나면 닫는다(허용으로 바꾸지 않는다). */
export const WAIT_ERROR_RETRY_MS = 1_000;
export const WAIT_ERROR_LIMIT = 5;

export function createCogsDecisionWaiters(deps: CogsDecisionWaitersDeps): CogsDecisionWaiters {
  const now = deps.now ?? Date.now;
  const slack = deps.expirySlackMs ?? 250;
  const retryMs = deps.errorRetryMs ?? WAIT_ERROR_RETRY_MS;
  const entries = new Map<string, Entry>();
  const report = deps.report ?? ((m: string) => console.warn(m));

  const finish = (id: string, o: CogsWaitOutcome) => {
    const e = entries.get(id);
    if (!e) return;
    entries.delete(id);
    if (e.timer) clearTimeout(e.timer);
    e.resolve(o);
  };

  /** DB 를 읽어 끝났으면 닫는다. 아직이면 만료 타이머를 다시 건다. */
  const check = (id: string) => {
    const e = entries.get(id);
    if (!e) return;
    let outcome: CogsWaitOutcome | null = null;
    let failed = false;
    let db: Database | null = null;
    try {
      db = deps.openDb();
      expireDueCogsApprovals(db, now(), deps.events);
      const b = getBinding(db, id);
      const row = getPermissionRequest(db, id);
      if (!b || !row || b.agent_id !== deps.agentId || row.agent_id !== deps.agentId) outcome = { kind: "closed", reason: "unknown_request" };
      else if (b.invalidation_reason !== null) outcome = { kind: "closed", reason: b.invalidation_reason };
      else if (row.status === "denied") outcome = { kind: "denied" };
      else if (row.status === "expired") outcome = { kind: "closed", reason: "expired" };
      else if (row.status === "allowed_once") outcome = { kind: "allowed", status: "allowed_once" };
      // '항상' 은 원본 저장까지 끝나야 넘긴다. 저장 전이면 계속 기다린다(저장 실패는 무효화로 닫힌다).
      else if (row.status === "allowed_always" && b.always_persisted === 1) outcome = { kind: "allowed", status: "allowed_always" };
      if (b) e.deadlineMs = b.expires_at_ms;
      e.errors = 0;
    } catch (err) {
      // 읽기 실패는 허용으로 바꾸지 않는다. 기한·횟수 안에서만 다시 본다.
      report(`[cogs-permissions] 대기 확인 실패 ${id}: ${err instanceof Error ? err.message : err}`);
      failed = true;
      e.errors++;
    } finally {
      try { db?.close(); } catch { /* best-effort */ }
    }
    if (outcome) return finish(id, outcome);
    if (failed && (e.errors >= WAIT_ERROR_LIMIT || (e.deadlineMs !== null && now() >= e.deadlineMs + slack))) {
      return finish(id, { kind: "closed", reason: "db_unavailable" });
    }
    if (e.timer) clearTimeout(e.timer);
    const nextAt = failed
      ? Math.min(now() + retryMs, e.deadlineMs !== null ? e.deadlineMs + slack : Infinity)
      : (e.deadlineMs ?? now()) + slack;
    e.timer = setTimeout(() => check(id), Math.max(0, nextAt - now()));
  };

  return {
    wait(requestId) {
      const existing = entries.get(requestId);
      if (existing) {
        // 같은 요청을 두 번 기다리지 않는다 — 먼저 기다린 쪽만 결과를 받는다(인계가 두 번 일어나지 않게).
        return Promise.resolve({ kind: "closed", reason: "duplicate_wait" });
      }
      const p = new Promise<CogsWaitOutcome>((resolve) => entries.set(requestId, { resolve, timer: null, deadlineMs: null, errors: 0 }));
      // 등록 뒤에 읽는다 — '읽기와 등록 사이 결정' 을 놓치지 않는다.
      check(requestId);
      return p;
    },
    poke(requestId) {
      if (requestId !== undefined) return check(requestId);
      for (const id of [...entries.keys()]) check(id);
    },
    cancel: (requestId, reason) => finish(requestId, { kind: "closed", reason }),
    size: () => entries.size,
    close(reason = "bridge_closed") {
      for (const id of [...entries.keys()]) finish(id, { kind: "closed", reason });
    },
  };
}

/**
 * 브리지가 새로 떴다 — 이 팀원의 예전 프로세스 세대 요청은 이어받을 대기자가 없다. 실행 인계 전 것을 닫는다.
 * 이전 RPC 를 새 프로세스에 재생하지 않는다. 세션 허용도 세대에 묶여 있어 같이 버린다.
 */
export function closeStaleGenerationApprovals(db: Database, agentId: string, currentGen: string, events?: CogsPermissionEvents): number {
  return invalidateCogsApprovals(db, { agentId, reason: "bridge_restart", notProcessGen: currentGen, events });
}

/**
 * 브리지 한 프로세스의 cogs 승인 상태. b3chat 채널 브리지만 만든다.
 * 만들 때 예전 세대 것을 닫고, 제어 신호·카드 누름이 오면 대기를 다시 보게 한다.
 */
export interface BridgeCogsApprovals {
  processGen: string;
  waiters: CogsDecisionWaiters;
  onControl: (req: { requestId?: string }) => void;
  /** 이 브리지가 카드 누름을 처리한 뒤. 어느 요청인지 몰라도 된다 — 전부 다시 본다. */
  afterCallback: () => void;
  close: () => void;
}

export function createBridgeCogsApprovals(deps: CogsDecisionWaitersDeps & { processGen?: string }): BridgeCogsApprovals {
  const processGen = deps.processGen ?? `${process.pid}:${Date.now().toString(36)}`;
  const report = deps.report ?? ((m: string) => console.warn(m));
  try {
    const db = deps.openDb();
    try {
      ensureCogsPermissionTables(db);
      const n = closeStaleGenerationApprovals(db, deps.agentId, processGen, deps.events);
      if (n) report(`[cogs-permissions] 브리지 재시작 정리: 예전 세대 승인 ${n}건 닫음`);
    } finally { db.close(); }
  } catch (e) {
    report(`[cogs-permissions] 브리지 재시작 정리 실패: ${e instanceof Error ? e.message : e}`);
  }
  const waiters = createCogsDecisionWaiters(deps);
  return {
    processGen,
    waiters,
    onControl: (req) => waiters.poke(req.requestId),
    afterCallback: () => waiters.poke(),
    close: () => waiters.close(),
  };
}

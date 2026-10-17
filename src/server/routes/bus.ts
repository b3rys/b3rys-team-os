import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  busStatusSnapshot,
  busFlowRecent,
  busMemberStatus,
  resolvePendingForAgent,
  auditRecent,
} from "../db/inboxQueries";
import { BUS_DISPATCH_ENABLED, busDispatchAllowlist } from "../bus/wakeDispatcher";

interface BusRouteDeps {
  db: Database;
}

/** 버스 상태는 수신자별 배달 건수와 최근 실패 목록을 읽기 전용으로 제공한다. */
export function createBusRoutes(deps: BusRouteDeps): Hono {
  const r = new Hono();

  r.get("/bus/status", (c) => {
    const snapshot = busStatusSnapshot(deps.db);
    return c.json({
      dispatch_enabled: BUS_DISPATCH_ENABLED,
      allowlist: (() => { const al = busDispatchAllowlist(); return al !== null ? Array.from(al) : null; })(),
      ...snapshot,
    });
  });

  // 최근 메시지와 수신자별 배달 상태를 최신순으로 반환한다.
  r.get("/bus/flow", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "40", 10) || 40, 100);
    return c.json({ messages: busFlowRecent(deps.db, limit) });
  });

  // 미배정 멤버도 0건으로 포함해야 토폴로지 화면에서 누락과 실제 적체를 구분할 수 있다.
  r.get("/bus/members", (c) => {
    return c.json(busMemberStatus(deps.db));
  });

  // 감사 로그의 action은 SQL 매개변수로 바인딩하고 limit은 1~500으로 제한한다.
  r.get("/audit", (c) => {
    const action = c.req.query("action");
    const limit = parseInt(c.req.query("limit") ?? "100", 10) || 100;
    return c.json({ events: auditRecent(deps.db, { action, limit }) });
  });

  // 적체 정리는 유예시간이 지난 pending/deferred만 제한된 건수로 처리하며 진행 중 배달은 건드리지 않는다.
  r.post("/bus/members/:agentId/pending/resolve", async (c) => {
    const agentId = c.req.param("agentId");
    let body: { action?: string; dry_run?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid json body" }, 400);
    }
    if (body.action !== "expire" && body.action !== "complete") {
      return c.json({ ok: false, error: "invalid action" }, 400);
    }
    const result = resolvePendingForAgent(
      deps.db,
      agentId,
      body.action,
      body.dry_run === true,
    );
    return c.json(result);
  });

  return r;
}

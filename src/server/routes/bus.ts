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

/**
 * Team Bus operational routes.
 *
 * GET /api/bus/status — delivery_state counts + recent dead_letter/blocked list (10 items).
 *   For use during shadow → allowlist → full enable progression. No auth required (internal
 *   network only — same as all other /api/ routes).
 *
 * Example response:
 *   {
 *     "dispatch_enabled": false,
 *     "allowlist": ["bill", "codex"],   // null if not set (= all agents)
 *     "counts": {
 *       "pending": 3, "dispatching": 0, "wake_dispatched": 1,
 *       "deferred": 1, "blocked": 0, "dead_letter": 2,
 *       "completed": 47, "agent_ack": 12
 *     },
 *     "recent_terminal_bad": [
 *       { "message_id": "...", "agent_id": "bill", "delivery_state": "dead_letter",
 *         "last_error": "tmux_inject_returned_false", "deferred_count": null,
 *         "updated_at": "2026-05-27T09:12:34+09:00" },
 *       ...
 *     ]
 *   }
 */
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

  // GET /api/bus/flow?limit=40 — recent messages + per-recipient delivery_state,
  // newest first. Powers the dashboard real-time bus flow view.
  r.get("/bus/flow", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "40", 10) || 40, 100);
    return c.json({ messages: busFlowRecent(deps.db, limit) });
  });

  // GET /api/bus/members — read-only per-member delivery-state snapshot.
  // Powers the busviz-v1 topology view: one node per registered agent (zero-filled),
  // with resolvable_pending and in-flight age for the frontend's stuck/zombie hinting.
  r.get("/bus/members", (c) => {
    return c.json(busMemberStatus(deps.db));
  });

  // GET /api/audit?action=&limit= — read-only audit feed (SLG cycle1 B, Audit screen).
  // Same read path/auth as /bus/flow (internal network). `action` is bound as a parameter
  // inside auditRecent (no string-built SQL); `limit` is clamped to [1,500] there.
  // Powers the Audit standard-interface screen — recipient_state_change history with
  // suspicious-close (ack_only/reply_observed) flagged.
  r.get("/audit", (c) => {
    const action = c.req.query("action");
    const limit = parseInt(c.req.query("limit") ?? "100", 10) || 100;
    return c.json({ events: auditRecent(deps.db, { action, limit }) });
  });

  // POST /api/bus/members/:agentId/pending/resolve — safe backlog resolution.
  // Body: { action: "expire" | "complete", dry_run?: boolean }
  // Guarded: only pending/deferred rows older than the grace window, batch-capped,
  // never touches in-flight (dispatching/wake_dispatched). wakeDispatcher untouched.
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

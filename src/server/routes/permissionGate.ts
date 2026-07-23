import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  decidePermissionRequest,
  evaluatePermission,
  getPermissionRequest,
  listPermissionRequests,
  requestPermission,
  type PermissionDecisionInput,
  type PermissionOperation,
  type PermissionRequestRow,
  type PermissionRequestStatus,
} from "../lib/permissionGate";

interface PermissionGateDeps {
  db: Database;
}

export function createPermissionGateRoutes(deps: PermissionGateDeps): Hono {
  const app = new Hono();

  app.get("/permission-gate", (c) => {
    const status = c.req.query("status") as PermissionRequestStatus | undefined;
    return c.json({ requests: listPermissionRequests(deps.db, status).map(rowJson) });
  });

  app.post("/permission-gate/check", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const op = parseOperation(body);
    if (!op) return c.json({ ok: false, error: "runtime and action are required" }, 400);
    const result = requestPermission(deps.db, op);
    return c.json({
      ok: result.decision !== "deny",
      decision: result.decision,
      reasons: result.reasons,
      request: result.request ? rowJson(result.request) : undefined,
      grant: result.grant,
    }, result.decision === "deny" ? 403 : result.decision === "approval_required" ? 202 : 200);
  });

  app.post("/permission-gate/evaluate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const op = parseOperation(body);
    if (!op) return c.json({ ok: false, error: "runtime and action are required" }, 400);
    const result = evaluatePermission(deps.db, op);
    return c.json({ ok: result.decision !== "deny", decision: result.decision, reasons: result.reasons, grant: result.grant });
  });

  app.get("/permission-gate/:id", (c) => {
    const row = getPermissionRequest(deps.db, c.req.param("id"));
    if (!row) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true, request: rowJson(row) });
  });

  app.post("/permission-gate/:id/decide", async (c) => {
    const token = process.env.PERMISSION_GATE_DECIDE_TOKEN;
    const auth = c.req.header("authorization") ?? "";
    if (!token || auth !== `Bearer ${token}`) return c.json({ ok: false, error: "permission decide API disabled" }, 403);
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const decision = body.decision as PermissionDecisionInput;
    if (!["allow_once", "allow_always", "deny"].includes(decision)) return c.json({ ok: false, error: "invalid decision" }, 400);
    const approver = typeof body.approver === "string" && body.approver.trim() ? body.approver.slice(0, 80) : "GD";
    const provenance = typeof body.provenance === "object" && body.provenance !== null && !Array.isArray(body.provenance) ? body.provenance as Record<string, unknown> : {};
    const res = decidePermissionRequest(deps.db, id, decision, { approver, provenance });
    if (!res.ok) return c.json({ ok: false, error: res.error, status: res.status }, 400);
    return c.json({ ok: true, status: res.status });
  });

  return app;
}

function parseOperation(body: any): PermissionOperation | null {
  const runtime = typeof body.runtime === "string" ? body.runtime.trim().slice(0, 64) : "";
  const action = typeof body.action === "string" ? body.action.trim().slice(0, 64) : "";
  if (!runtime || !action) return null;
  return {
    runtime,
    agent_id: typeof body.agent_id === "string" ? body.agent_id.slice(0, 64) : null,
    action,
    command: typeof body.command === "string" ? body.command.slice(0, 2000) : undefined,
    path: typeof body.path === "string" ? body.path.slice(0, 500) : undefined,
    egress_url: typeof body.egress_url === "string" ? body.egress_url.slice(0, 500) : undefined,
    text: typeof body.text === "string" ? body.text.slice(0, 2000) : undefined,
    requested_by: typeof body.requested_by === "string" ? body.requested_by.slice(0, 80) : undefined,
    provenance: typeof body.provenance === "object" && body.provenance !== null && !Array.isArray(body.provenance) ? body.provenance : undefined,
  };
}

function rowJson(row: PermissionRequestRow): Record<string, unknown> {
  return {
    ...row,
    payload: safeParse(row.payload_json),
    provenance: row.provenance_json ? safeParse(row.provenance_json) : {},
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

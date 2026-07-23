import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { openDb, migrate } from "../db/migrate";
import { createSchedulerRoutes } from "./scheduler";

function makeApp(opts: { acceptingJobs?: boolean } = {}) {
  process.env.OP_MESSAGE_TOKEN = "test-token";
  process.env.OP_MESSAGE_TOKEN_BINDINGS = JSON.stringify({ dex: "test-token", bill: "test-token", gd: "test-token" });
  const db = openDb(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('dex','Dex','Codex runtime pilot','codex','codex_cli','/tmp/dex','/tmp/dex/AGENTS.md')`,
  ).run();
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('bill','Bill','Ops','openclaw','openclaw_gateway','/tmp/bill','/tmp/bill/AGENTS.md')`,
  ).run();
  const app = new Hono();
  app.route(
    "/api",
    createSchedulerRoutes({
      db,
      registeredAgentIds: () => new Set(["dex", "bill"]),
      schedulerAcceptingJobs: () => opts.acceptingJobs ?? true,
    }),
  );
  return { app, db };
}

function authHeaders(actor: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-op-token": "test-token",
    "x-actor-id": actor,
  };
}

describe("scheduler routes", () => {
  test("POST /schedules/reminder creates a future one-shot job", async () => {
    const { app, db } = makeApp();
    const res = await app.request("/api/schedules/reminder", {
      method: "POST",
      headers: authHeaders("dex"),
      body: JSON.stringify({
        target_agent_id: "dex",
        body: "[예약 알림] route",
        delay_seconds: 60,
        created_by: "dex",
        direct_to_gd: true,
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean; job: { id: string; target_agent_id: string } };
    expect(json.ok).toBe(true);
    expect(json.job.target_agent_id).toBe("dex");
    const audit = db.prepare(`SELECT action FROM audit_event WHERE target = ?`).get(json.job.id) as { action: string } | undefined;
    expect(audit?.action).toBe("scheduled_reminder_created");
  });

  test("POST /schedules/reminder binds created_by to the authenticated actor", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/schedules/reminder", {
      method: "POST",
      headers: authHeaders("dex"),
      body: JSON.stringify({
        target_agent_id: "dex",
        body: "spoof",
        delay_seconds: 60,
        created_by: "bill",
      }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("created_by_actor_mismatch");
  });

  test("POST /schedules/reminder blocks non-lead actors from targeting another agent", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/schedules/reminder", {
      method: "POST",
      headers: authHeaders("dex"),
      body: JSON.stringify({
        target_agent_id: "bill",
        body: "not mine",
        delay_seconds: 60,
      }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("target_agent_forbidden");
  });

  test("POST /schedules/reminder allows the lead actor to target another agent", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/schedules/reminder", {
      method: "POST",
      headers: authHeaders("gd"),
      body: JSON.stringify({
        target_agent_id: "dex",
        body: "lead scheduled",
        delay_seconds: 60,
        direct_to_gd: true,
      }),
    });
    expect(res.status).toBe(201);
  });

  test("POST /schedules/reminder rate-limits non-lead direct-to-GD jobs", async () => {
    const oldPending = process.env.B3OS_SCHEDULER_DIRECT_TO_GD_PENDING_LIMIT;
    process.env.B3OS_SCHEDULER_DIRECT_TO_GD_PENDING_LIMIT = "1";
    try {
      const { app } = makeApp();
      const first = await app.request("/api/schedules/reminder", {
        method: "POST",
        headers: authHeaders("dex"),
        body: JSON.stringify({
          target_agent_id: "dex",
          body: "first",
          delay_seconds: 60,
          direct_to_gd: true,
        }),
      });
      expect(first.status).toBe(201);
      const second = await app.request("/api/schedules/reminder", {
        method: "POST",
        headers: authHeaders("dex"),
        body: JSON.stringify({
          target_agent_id: "dex",
          body: "second",
          delay_seconds: 120,
          direct_to_gd: true,
        }),
      });
      expect(second.status).toBe(429);
      const json = (await second.json()) as { error: string };
      expect(json.error).toBe("direct_to_gd_pending_limit");
    } finally {
      if (oldPending == null) delete process.env.B3OS_SCHEDULER_DIRECT_TO_GD_PENDING_LIMIT;
      else process.env.B3OS_SCHEDULER_DIRECT_TO_GD_PENDING_LIMIT = oldPending;
    }
  });

  test("POST /schedules/reminder rejects unknown target", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/schedules/reminder", {
      method: "POST",
      headers: authHeaders("dex"),
      body: JSON.stringify({
        target_agent_id: "missing",
        body: "x",
        delay_seconds: 60,
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /schedules/reminder rejects clearly when scheduler is not accepting jobs", async () => {
    const { app } = makeApp({ acceptingJobs: false });
    const res = await app.request("/api/schedules/reminder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_agent_id: "dex",
        body: "x",
        delay_seconds: 60,
      }),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string; hint: string };
    expect(json.error).toBe("scheduler_disabled");
    expect(json.hint).toContain("do not tell the user");
  });

  test("cancel marks a pending job cancelled", async () => {
    const { app } = makeApp();
    const created = await app.request("/api/schedules/reminder", {
      method: "POST",
      headers: authHeaders("dex"),
      body: JSON.stringify({
        target_agent_id: "dex",
        body: "cancel me",
        delay_seconds: 60,
      }),
    });
    const json = (await created.json()) as { job: { id: string } };
    const cancelled = await app.request(`/api/schedules/${json.job.id}/cancel`, {
      method: "POST",
      headers: authHeaders("dex"),
    });
    expect(cancelled.status).toBe(200);
    const fetched = await app.request(`/api/schedules/${json.job.id}`, { headers: authHeaders("dex") });
    const fetchedJson = (await fetched.json()) as { job: { status: string; enabled: number } };
    expect(fetchedJson.job.status).toBe("cancelled");
    expect(fetchedJson.job.enabled).toBe(0);
  });

  test("GET and cancel are limited to owner or lead", async () => {
    const { app } = makeApp();
    const created = await app.request("/api/schedules/reminder", {
      method: "POST",
      headers: authHeaders("dex"),
      body: JSON.stringify({
        target_agent_id: "dex",
        body: "private",
        delay_seconds: 60,
      }),
    });
    const json = (await created.json()) as { job: { id: string } };
    const blockedGet = await app.request(`/api/schedules/${json.job.id}`, { headers: authHeaders("bill") });
    expect(blockedGet.status).toBe(403);
    const leadGet = await app.request(`/api/schedules/${json.job.id}`, { headers: authHeaders("gd") });
    expect(leadGet.status).toBe(200);

    const blockedCancel = await app.request(`/api/schedules/${json.job.id}/cancel`, {
      method: "POST",
      headers: authHeaders("bill"),
    });
    expect(blockedCancel.status).toBe(403);
    const leadCancel = await app.request(`/api/schedules/${json.job.id}/cancel`, {
      method: "POST",
      headers: authHeaders("gd"),
    });
    expect(leadCancel.status).toBe(200);
  });
});

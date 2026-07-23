import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createPermissionGateRoutes } from "./permissionGate";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return createPermissionGateRoutes({ db });
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const postAuthed = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer test-token" },
  body: JSON.stringify(body),
});

describe("permission gate routes", () => {
  test("check denies Tier D without creating pending request", async () => {
    const app = setup();
    const res = await app.request("/permission-gate/check", post({ runtime: "codex", action: "shell", command: "sudo launchctl list" }));
    expect(res.status).toBe(403);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.reasons).toContain("sudo");
    expect(json.reasons).toContain("launchctl");
  });

  test("check creates pending request and decide always makes later evaluate allow", async () => {
    const app = setup();
    const res = await app.request("/permission-gate/check", post({ runtime: "codex", agent_id: "codex", action: "shell", command: "bun test" }));
    expect(res.status).toBe(202);
    const created = await res.json() as any;
    const id = created.request.id;

    const blocked = await app.request(`/permission-gate/${id}/decide`, post({ decision: "allow_always", approver: "GD" }));
    expect(blocked.status).toBe(403);

    process.env.PERMISSION_GATE_DECIDE_TOKEN = "test-token";
    const decided = await app.request(`/permission-gate/${id}/decide`, postAuthed({ decision: "allow_always", approver: "GD", provenance: { source: "test" } }));
    delete process.env.PERMISSION_GATE_DECIDE_TOKEN;
    expect(decided.status).toBe(200);

    const evalRes = await app.request("/permission-gate/evaluate", post({ runtime: "codex", agent_id: "codex", action: "shell", command: "bun test" }));
    expect(evalRes.status).toBe(200);
    expect((await evalRes.json() as any).decision).toBe("allow");
  });
});

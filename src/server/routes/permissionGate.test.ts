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
  // 위험 명령도 202와 pending 요청을 만들어 사람이 승인하도록 넘긴다. 런타임의 별도 차단목록으로 거절하지 않는다.
  test("★check 는 위험 명령도 거절하지 않는다★ — 승인 대기 요청을 만들어 사람에게 넘긴다", async () => {
    const app = setup();
    const res = await app.request("/permission-gate/check", post({ runtime: "codex", action: "shell", command: "sudo launchctl list" }));
    expect(res.status).toBe(202); // 승인 대기 요청 접수로 응답한다.
    const json = await res.json() as any;
    expect(json.ok).toBe(true);   // 실행 허용과 요청 접수를 구분한다.
    expect(json.decision).toBe("approval_required");
    expect(json.reasons).toEqual([]); // 런타임 자체 차단 사유로 거절하지 않는다.
    // 요청 행이 실제로 생성되어야 사람이 승인할 수 있다.
    expect(json.request?.status).toBe("pending");
    expect(json.request?.target).toMatch(/^\[command digest:[a-f0-9]{64}\]$/);
    expect(json.request?.action).toBe("shell");

    // 대조군 — 안전한 명령도 같은 202/pending 을 받는다.
    // 위험 여부와 무관하게 요청을 만들고 최종 실행은 사람의 승인으로 결정한다.
    const safe = await app.request("/permission-gate/check", post({ runtime: "codex", action: "shell", command: "ls /tmp" }));
    expect(safe.status).toBe(202);
    expect((await safe.json() as any).decision).toBe("approval_required");
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

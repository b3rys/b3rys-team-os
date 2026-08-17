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
  // ★계약이 바뀌었다★ (다른 런타임과의 일관성).
  //   예전 이름: "check denies Tier D without creating pending request" — 403 + 요청 행 없음.
  //   우리 코드로 차단목록을 얹은 런타임이 codex 뿐이라(claude·hermes·openclaw·b3osNative 0건) 판정을 뺐다.
  //   이제 위험 명령도 ★202 + 대기 중 요청★ = 사람이 볼 승인창이 만들어진다.
  test("★check 는 위험 명령도 거절하지 않는다★ — 승인 대기 요청을 만들어 사람에게 넘긴다", async () => {
    const app = setup();
    const res = await app.request("/permission-gate/check", post({ runtime: "codex", action: "shell", command: "sudo launchctl list" }));
    expect(res.status).toBe(202); // 예전 403
    const json = await res.json() as any;
    expect(json.ok).toBe(true);   // 예전 false
    expect(json.decision).toBe("approval_required");
    expect(json.reasons).toEqual([]); // 우리 차단 사유로 거절하지 않는다
    // ★요청 행이 생긴다★ — 예전엔 "without creating pending request" 가 이 시험의 요지였다.
    expect(json.request?.status).toBe("pending");
    expect(json.request?.target).toBe("sudo launchctl list");
    expect(json.request?.action).toBe("shell");

    // ★대조군★ — 안전한 명령도 같은 202/pending 을 받는다.
    //   즉 위험 명령이 ★안전 명령과 같은 취급★ 을 받게 된 것이 이 변경의 내용이다.
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

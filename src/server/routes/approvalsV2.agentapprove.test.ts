/**
 * 승인 v2 — 에이전트 승인/거절 엔드포인트 보안 게이팅 (GD 2026-07-08).
 * ★실제 머지(executeApproval)를 트리거하지 않는 경로만 검증★ — 승인 인가 실패(403/400/404)와
 * 거절(머지 실행 없음)에 집중. 유효 승인의 실행경로는 canApproveTier 단위테스트 + executeApproval 재사용으로 커버.
 */
import { afterAll, beforeAll, describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { enqueueApproval } from "../lib/approvals";
import { createApprovalsApp } from "./approvals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// merge_to_main 은 실행 대상(scripts/merge-to-main.sh)이 있어야 큐에 적재된다 — 없으면 제시조차 안 된다.
// 이 스위트는 ★적재 이후의 인가 게이팅★ 을 보는 것이므로, 실행 대상이 갖춰진 상태를 tmp 로 만들어 준다.
// (라이브/clone 어디서 돌리든 같게 — 머신에 그 스크립트가 있든 없든 결과가 흔들리지 않는다.)
let gateRoot: string;
const prevCollabDir = process.env.TEAM_COLLAB_DIR;
beforeAll(() => {
  gateRoot = mkdtempSync(join(tmpdir(), "b3os-mergegate-"));
  mkdirSync(join(gateRoot, "scripts"), { recursive: true });
  writeFileSync(join(gateRoot, "scripts", "merge-to-main.sh"), "#!/usr/bin/env bash\nexit 0\n");
  // deploy_public 도 "merge_to_main 이 아닌 액션" 대조군으로 적재되므로 같이 갖춰 둔다.
  writeFileSync(join(gateRoot, "scripts", "deploy-public.sh"), "#!/usr/bin/env bash\nexit 0\n");
  process.env.TEAM_COLLAB_DIR = gateRoot;
});
afterAll(() => {
  if (prevCollabDir === undefined) delete process.env.TEAM_COLLAB_DIR;
  else process.env.TEAM_COLLAB_DIR = prevCollabDir;
  rmSync(gateRoot, { recursive: true, force: true });
});

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const app = createApprovalsApp({ db });
  return { db, app };
}
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
// merge_to_main 요청 적재(author=steve)
function mkMerge(db: Database, author = "steve") {
  return enqueueApproval(db, { action_key: "merge_to_main", params: { branch: `feat/${author}-x`, author, tier: "normal" }, requested_by: author });
}

describe("agent-approve — 보안 게이팅", () => {
  let db: Database, app: ReturnType<typeof createApprovalsApp>;
  beforeEach(() => { ({ db, app } = setup()); });

  test("self-approve 금지 → 403 (author=steve 가 steve 로 승인)", async () => {
    const r = mkMerge(db, "steve");
    const res = await app.request(`/approvals/${r.id}/agent-approve`, post({ approver: "steve" }));
    expect(res.status).toBe(403);
    expect((db.query("SELECT status FROM approval_request WHERE id=?").get(r.id) as any).status).toBe("pending"); // 변경 없음
  });

  test("풀 밖 승인자 → 403 (ames 는 풀 아님)", async () => {
    const r = mkMerge(db, "steve");
    const res = await app.request(`/approvals/${r.id}/agent-approve`, post({ approver: "ames" }));
    expect(res.status).toBe(403);
  });

  test("approver 누락 → 400", async () => {
    const r = mkMerge(db, "steve");
    expect((await app.request(`/approvals/${r.id}/agent-approve`, post({}))).status).toBe(400);
  });

  test("없는 승인건 → 404", async () => {
    expect((await app.request(`/approvals/nope/agent-approve`, post({ approver: "bill" }))).status).toBe(404);
  });

  test("merge_to_main 아닌 액션 → 400 (일반 승인은 GD 탭 전용)", async () => {
    const r = enqueueApproval(db, { action_key: "deploy_public", requested_by: "steve" });
    expect((await app.request(`/approvals/${r.id}/agent-approve`, post({ approver: "bill" }))).status).toBe(400);
  });

  test("이미 처리된 건 → 400", async () => {
    const r = mkMerge(db, "steve");
    db.prepare("UPDATE approval_request SET status='rejected' WHERE id=?").run(r.id);
    expect((await app.request(`/approvals/${r.id}/agent-approve`, post({ approver: "bill" }))).status).toBe(400);
  });
});

describe("agent-approve/reject — core tier 는 풀 처리 불가 [Devon 리뷰 #1]", () => {
  let db: Database, app: ReturnType<typeof createApprovalsApp>;
  beforeEach(() => { ({ db, app } = setup()); });

  const mkCoreMerge = () =>
    enqueueApproval(db, { action_key: "merge_to_main", params: { branch: "feat/x", author: "steve", tier: "core" }, requested_by: "steve" });

  test("core merge agent-approve → 403 (풀 승인 불가, GD 경로)", async () => {
    const r = mkCoreMerge();
    const res = await app.request(`/approvals/${r.id}/agent-approve`, post({ approver: "bill" }));
    expect(res.status).toBe(403);
    expect((db.query("SELECT status FROM approval_request WHERE id=?").get(r.id) as any).status).toBe("pending");
  });

  test("core merge agent-reject → 403", async () => {
    const r = mkCoreMerge();
    expect((await app.request(`/approvals/${r.id}/agent-reject`, post({ approver: "bill" }))).status).toBe(403);
  });
});

describe("agent-reject — 풀 팀원 거절(머지 실행 없음)", () => {
  let db: Database, app: ReturnType<typeof createApprovalsApp>;
  beforeEach(() => { ({ db, app } = setup()); });

  test("풀 팀원(author 아님) 거절 → 200 + rejected", async () => {
    const r = mkMerge(db, "steve");
    const res = await app.request(`/approvals/${r.id}/agent-reject`, post({ approver: "bill" }));
    expect(res.status).toBe(200);
    expect((db.query("SELECT status FROM approval_request WHERE id=?").get(r.id) as any).status).toBe("rejected");
  });

  test("self-reject 금지 → 403", async () => {
    const r = mkMerge(db, "steve");
    expect((await app.request(`/approvals/${r.id}/agent-reject`, post({ approver: "steve" }))).status).toBe(403);
  });

  test("풀 밖 거절 → 403", async () => {
    const r = mkMerge(db, "steve");
    expect((await app.request(`/approvals/${r.id}/agent-reject`, post({ approver: "ames" }))).status).toBe(403);
  });
});

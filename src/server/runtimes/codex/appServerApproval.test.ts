/**
 * M3 승인판정 테스트 — 승인요청을 게이트로 라우팅하면 Tier-D(rm-rf/sudo)가 실효함을 검증.
 */
import { test, expect } from "bun:test";
import { judgeApproval, resolveWithoutPopup, terminalGuidance, actionGuidance } from "./appServerApproval";
import type { PermissionAgent } from "../../lib/permissionGate";

const agent: PermissionAgent = { id: "dex", workspace_path: "/Users/you/Development/your-workspace" };

test("Tier-D 셸 명령(rm -rf)은 denied — 승인으로도 못 뚫음", () => {
  const j = judgeApproval(agent, { method: "execCommandApproval", params: { command: ["bash", "-lc", "rm -rf /tmp/x"], cwd: "/tmp" } });
  expect(j.decision).toBe("denied");
  expect(j.needsApproval).toBe(false);
  expect(j.check.tier).toBe("deny");
});

test("Tier-D sudo도 denied", () => {
  const j = judgeApproval(agent, { method: "execCommandApproval", params: { command: ["sudo", "launchctl", "list"], cwd: "/tmp" } });
  expect(j.decision).toBe("denied");
});

test("★F1★ 셸 escalation은 Tier-D 아니어도 ask(자동허용 금지) — bun test도 승인필요", () => {
  const j = judgeApproval(agent, { method: "execCommandApproval", params: { command: ["bun", "test"], cwd: "/Users/you/Development/your-workspace" } });
  expect(j.check.tier).toBe("ask");
  expect(j.needsApproval).toBe(true);
  expect(resolveWithoutPopup(j)).toBe("denied"); // 팝업 전 fail-closed
});

test("★F1★ Tier-D 정규식 우회 시도(rm -r -f 플래그분리·git reset --hard)도 ask로 막힘", () => {
  const split = judgeApproval(agent, { method: "execCommandApproval", params: { command: ["rm", "-r", "-f", "/tmp/x"], cwd: "/tmp" } });
  expect(split.check.tier).not.toBe("allow"); // 예전엔 allow로 샜음
  expect(resolveWithoutPopup(split)).toBe("denied");
  const reset = judgeApproval(agent, { method: "execCommandApproval", params: { command: ["git", "reset", "--hard", "origin/main"], cwd: "/tmp" } });
  expect(resolveWithoutPopup(reset)).toBe("denied");
});

test("워크스페이스 밖 쓰기(applyPatch)는 deny", () => {
  const j = judgeApproval(agent, { method: "applyPatchApproval", params: { fileChanges: { "/etc/hosts": {} } }, });
  expect(j.check.tier).toBe("deny");
  expect(j.decision).toBe("denied");
});

const wsCtx = { workspaceRoot: "/Users/you/Development/your-workspace" };
test("★F5★ 워크스페이스 안 patch도 auto-allow 아님 — escalation이라 ask(자동거절)", () => {
  const j = judgeApproval(agent, { method: "applyPatchApproval", params: { fileChanges: { "/Users/you/Development/your-workspace/src/x.ts": {} } } }, wsCtx);
  expect(j.check.tier).toBe("ask");
  expect(resolveWithoutPopup(j)).toBe("denied");
});

test("★F5★ 실행체/시크릿 경로(.git/hooks·.env)는 특히 ask로 승인 필요(백도어 방지)", () => {
  const hook = judgeApproval(agent, { method: "applyPatchApproval", params: { fileChanges: { "/Users/you/Development/your-workspace/.git/hooks/pre-commit": {} } } }, wsCtx);
  expect(hook.check.tier).toBe("ask");
  expect(hook.check.reason).toContain("sensitive");
  const env = judgeApproval(agent, { method: "applyPatchApproval", params: { fileChanges: { "/Users/you/Development/your-workspace/.env": {} } } }, wsCtx);
  expect(resolveWithoutPopup(env)).toBe("denied");
});

test("매핑 안 된 승인요청은 ask → needsApproval(팝업 필요), 팝업 전엔 fail-closed denied", () => {
  const j = judgeApproval(agent, { method: "item/permissions/requestApproval", params: { reason: "wants extra access" } });
  expect(j.needsApproval).toBe(true);
  expect(j.decision).toBeNull();
  expect(resolveWithoutPopup(j)).toBe("denied"); // 팝업 배선(M5) 전 안전 기본
});

test("차단된 명령은 터미널 안내 문구 생성(막다른 차단 대신, GD UX)", () => {
  const req = { method: "execCommandApproval", params: { command: ["bash", "-lc", "rm -rf /tmp/x"], cwd: "/tmp/proj" } };
  const g = terminalGuidance(req);
  expect(g).toContain("cd /tmp/proj");
  expect(g).toContain("rm -rf /tmp/x");
  expect(g).toContain("터미널");
});

test("★GD msg838★ 안내는 작업 종류별 — patch는 파일 안내(터미널 아님)", () => {
  const g = actionGuidance({ method: "applyPatchApproval", params: { fileChanges: { "/proj/src/x.ts": {}, "/proj/.env": {} } } });
  expect(g).toContain("파일");
  expect(g).toContain("/proj/src/x.ts");
  expect(g).not.toContain("cd ");
});

test("★GD msg838★ 명령/파일 아닌 차단(외부전송·권한)은 요약 안내", () => {
  const g = actionGuidance({ method: "item/permissions/requestApproval", params: { reason: "send data to external endpoint" } });
  expect(g).toContain("안전상");
  expect(g).toContain("send data to external endpoint");
});

// ── ★codex 설정이 정하게 한다★ (팀 리드 2026-08-11) ──
//
// startThread 에 sandbox·approvalPolicy 를 넘기면 ★CODEX_HOME 의 config.toml 을 덮어쓴다.★
// runtimeWorkspaceRoots 는 ★experimentalApi capability 를 요구해서 turn 이 시작도 못 했다★ (실측 2/2).
//
// ★소스에 그 줄이 없는지가 아니라 startThread 가 실제로 무엇을 받는지를 잰다.★

import { runViaAppServer } from "./appServerRunner";

function fakeClient(seen: Record<string, unknown>[]) {
  return () =>
    ({
      currentThreadId: "th_1",
      async start() {},
      async startThread(o: Record<string, unknown>) { seen.push(o); return "th_1"; },
      async runTurn() { return { status: "completed", finalText: "ok", turnId: "t1", detail: "" }; },
      close() {},
    }) as unknown as import("./appServerClient").CodexAppServerClient;
}
const startArgs = async (opts: Record<string, unknown>) => {
  const seen: Record<string, unknown>[] = [];
  await runViaAppServer({ prompt: "p", ...opts } as never, undefined, fakeClient(seen));
  return seen[0] ?? {};
};

test("★sandbox 를 넘기지 않는다★ — 넘기면 config.toml 의 권한 프로필이 무력화된다", async () => {
  const a = await startArgs({ cwd: "/tmp/ws", sandbox: "workspace-write" });
  expect("sandbox" in a).toBe(false);
});

test("★approvalPolicy 도 넘기지 않는다★ — 승인 레벨도 codex 설정이 정한다", async () => {
  const a = await startArgs({ cwd: "/tmp/ws" });
  expect("approvalPolicy" in a).toBe(false);
});

test("★runtimeWorkspaceRoots 를 넘기지 않는다★ — experimentalApi 를 요구해 turn 이 죽던 원인", async () => {
  const a = await startArgs({ cwd: "/tmp/ws", writableRoots: ["/tmp/ws"] });
  expect("runtimeWorkspaceRoots" in a).toBe(false);
});

test("★대조군 — 넘겨야 하는 것은 그대로 간다★ (cwd · model · resume)", async () => {
  const a = await startArgs({ cwd: "/tmp/ws", model: "gpt-x", resumeSessionId: "th_prev" });
  expect({ cwd: a.cwd, model: a.model, resume: a.resumeThreadId }).toEqual({ cwd: "/tmp/ws", model: "gpt-x", resume: "th_prev" });
});

// ── ★승인 판정은 우리가 하지 않는다★ (팀 리드 2026-08-12) ──
//
// 전에는 여기서 다시 판정하고 ask 면 ★op 방★ 에 팝업을 띄웠다. 두 가지가 동시에 망가졌다:
//   ① 팀원 승인이 op 방에 떴다 — op 방은 시스템 알림 자리다.
//      실측: permission_request 를 만든 팀원은 codex 런타임뿐(dex 5 · codex 4). 다른 팀원 0건.
//   ② 아무도 안 누르면 턴이 안 끝나 ★팀원이 답을 못 했다.★
// hermes·openclaw 는 b3os 에 승인 배선이 아예 없다. 경계는 각자 런타임 설정이 친다.
//
// ★이 시험은 runViaAppServer 가 승인 요청을 받았을 때 실제로 무엇을 하는지 잰다★
// (팝업을 안 만든다 · 사람을 안 기다린다 · fail-closed 로 거절한다).

import { Database as ApprDb } from "bun:sqlite";
import { migrate as apprMigrate } from "../../db/migrate";
import { runViaAppServer as runApprServer } from "./appServerRunner";

/**
 * codex 가 승인 요청을 올리는 상황을 흉내내는 클라이언트.
 * ★돌려받은 결정을 seen 에 적어둔다★ — 안 적으면 결정값을 무엇으로 바꿔도 시험이 통과한다(뮤턴트 생존).
 */
function approvalRaisingClient(seen: string[] = []) {
  return () =>
    ({
      currentThreadId: "th_1",
      async start() {},
      async startThread() { return "th_1"; },
      async runTurn(_p: string, handlers: { onApproval?: (r: unknown) => Promise<string> }) {
        const d = await handlers.onApproval?.({
          method: "item/commandExecution/requestApproval",
          params: { command: "/bin/zsh -lc 'echo hi'", threadId: "th_1", turnId: "t1" },
        });
        if (d !== undefined) seen.push(d);
        return { status: "completed", finalText: "ok", turnId: "t1", detail: "" };
      },
      close() {},
    }) as unknown as import("./appServerClient").CodexAppServerClient;
}

/**
 * ★codex 가 승인을 물어와도 우리는 사람을 부르지 않는다.★
 *
 * 전에는 여기서 permission_request 를 만들고 사람이 누를 때까지 폴링했다(TTL 1시간). 그 결과:
 *   ① 그 팝업이 ★op 방★ 에 떴다 — op 방은 시스템 알림 자리다(팀 리드 2026-08-12).
 *   ② 아무도 안 누르면 턴이 안 끝나 ★팀원이 답을 못 했다.★
 * hermes·openclaw 는 b3os 에 승인 배선이 아예 없다. codex 도 같은 모양으로 맞췄다.
 * 경계는 config.toml 의 permission 프로파일이 친다(launcher.renderLockedDownCodexConfig).
 */
/**
 * ★결정을 기다리지 않는다★ — 팝업은 사람이 누를 때까지 폴링한다(기본 TTL 1시간).
 * 행이 생기는 즉시 읽고 거절로 마감해 턴을 풀어준다. (그냥 await 하면 시험이 타임아웃까지 매달린다.)
 */
const popupOf = async (agentId: string) => {
  const db = new ApprDb(":memory:");
  apprMigrate(db);
  const decisions: string[] = [];
  const turn = runApprServer({ prompt: "p", cwd: "/tmp/ws", agentId } as never, db, approvalRaisingClient(decisions));
  let row: { id: string; agent_id: string } | undefined;
  for (let i = 0; i < 300 && !row; i++) {
    row = db.query("select id, agent_id from permission_request order by created_at desc limit 1").get() as never;
    if (!row) await new Promise((r) => setTimeout(r, 10));
  }
  if (row) db.run("update permission_request set status='denied' where id=?", [row.id]); // 턴을 풀어준다
  await turn.catch(() => {});
  db.close();
  return { agentId: row?.agent_id, decisions };
};

test("★codex 가 물으면 승인 요청을 만든다★ — 무조건 거절하면 옮겨온 게 아니라 기능을 뺀 것이다", async () => {
  // 터미널에서 codex 를 쓰면 경계 밖은 물어보고 사람이 누른다. 그 물음을 팀원 방으로 옮기는 게 우리 일.
  expect((await popupOf("dex")).agentId).toBe("dex");
}, 20000);

test("★목적지는 이 턴의 주인이다★ — 상수로 박으면 남의 방으로 간다", async () => {
  // 전에 id 가 "codex" 로 박혀 있어 permission_request.agent_id 가 전부 "codex" 였다.
  // 그리고 "codex" 는 실재하는 다른 팀원의 id 다(명부에 codex(openclaw)와 dex(codex 런타임)가 따로 있다).
  expect((await popupOf("cody")).agentId).toBe("cody");
}, 20000);

test("사람이 누른 결정이 codex 에게 그대로 간다", async () => {
  expect((await popupOf("dex")).decisions).toEqual(["denied"]); // 위에서 거절로 마감했다
}, 20000);

// ── ★자식 app-server 가 그 팀원의 설정을 읽는가★ (2026-08-12) ──
//
// 안 넘기면 자식이 ★호스트 ~/.codex★ 를 읽는다. 그러면 그 팀원 config 의 승인정책도 권한 프로파일도
// ★하나도 안 걸린다.★ 라이브에서 실제로 그랬고, 나는 그걸 보고 "app-server 가 설정을 무시한다" 고
// ★잘못 결론냈다★ — 무시한 게 아니라 다른 파일을 읽고 있었다.
// exec 경로(runner.ts)는 원래 CODEX_HOME 을 넘긴다. app-server 경로만 빠져 있었다.

import { appServerSpawnEnv } from "./appServerClient";
import { defaultAppServerClientFactory } from "./appServerRunner";

test("★CODEX_HOME 이 자식 env 로 간다★ — 없으면 그 팀원 설정이 통째로 안 걸린다", () => {
  const env = appServerSpawnEnv("/home/dex/.codex-agents/dex", { PATH: "/usr/bin" });
  expect(env.CODEX_HOME).toBe("/home/dex/.codex-agents/dex");
  expect(env.PATH).toBe("/usr/bin"); // 나머지 환경은 그대로 물려준다
});

test("대조군 — codexHome 이 없으면 CODEX_HOME 을 새로 박지 않는다(호스트 기본값 그대로)", () => {
  expect(appServerSpawnEnv(undefined, { PATH: "/usr/bin" }).CODEX_HOME).toBeUndefined();
});

test("★기본 팩토리가 그 턴 주인의 codexHome 을 실어 준다★ — 배선이 끊기면 위 함수가 맞아도 소용없다", () => {
  const c = defaultAppServerClientFactory({ prompt: "p", agentId: "dex", codexHome: "/x/dex" } as never);
  expect(c.codexHome).toBe("/x/dex");
});

// ── ★팝업이 그 팀원 방으로 간다★ (팀 리드 2026-08-12: "팀원방에 그냥 띄우면 되잖아") ──

import { sendApprovalToMemberRoom, approvalSummary } from "./appServerPopup";

test("★그 팀원 봇으로, 버튼 3개를 붙여 보낸다★", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;

  const ok = await sendApprovalToMemberRoom(
    "dex", "prm_abc123",
    { method: "item/commandExecution/requestApproval", params: { command: "rm -rf /tmp/x" } },
    { token: "TKN", chatId: "555", fetchFn },
  );
  expect(ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toContain("/botTKN/sendMessage"); // ★그 팀원 봇★ — 다른 봇이면 남의 방에 뜬다
  expect(calls[0]!.body.chat_id).toBe("555");
  const kb = (calls[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
  expect(kb.map((b) => b.callback_data)).toEqual(["pg1:prm_abc123", "pga:prm_abc123", "pgd:prm_abc123"]);
});

test("토큰이나 방을 모르면 보내지 않는다(조용히 성공했다고 하지 않는다)", async () => {
  const fetchFn = (async () => ({ ok: true } as Response)) as unknown as typeof fetch;
  expect(await sendApprovalToMemberRoom("dex", "prm_a", { method: "m", params: {} }, { token: "T", chatId: "", fetchFn })).toBe(false);
});

test("팝업 문구는 무엇을 하려는지 + 대상으로 갈라진다", () => {
  expect(approvalSummary({ method: "m", params: { command: ["ls", "-la"] } })).toEqual({ title: "명령을 실행할까요?", detail: "ls -la" });
  const f = approvalSummary({ method: "m", params: { fileChanges: { "/a.ts": {}, "/b.ts": {} } } });
  expect(f.title).toBe("파일 2개를 고칠까요?");
});

// ── ★무응답 만료(5분)★ (팀 리드 2026-08-12) ──

import { pollDecision, expirePermissionRequest } from "./appServerPopup";
import { requestPermission as expReq, getPermissionRequest as expGet } from "../../lib/permissionGate";

test("★만료되면 행도 닫힌다★ — pending 으로 남으면 한참 뒤 탭이 끝난 턴을 승인한다", async () => {
  const db = new ApprDb(":memory:"); apprMigrate(db);
  const id = expReq(db, { agent: { id: "dex", workspace_path: "/tmp/ws" }, agent_id: "dex", runtime: "codex", action: "shell", command: "echo hi", cwd: "/tmp/ws" } as never).request!.id;
  const decision = await pollDecision(db, id, 20, 5); // 20ms 만료
  expect(decision).toBe("denied");
  expect(expGet(db, id)?.status).toBe("expired"); // ★행이 닫혀야 나중 탭이 '만료' 로 답한다★
  db.close();
});

test("이미 결정된 요청은 만료가 덮어쓰지 않는다", () => {
  const db = new ApprDb(":memory:"); apprMigrate(db);
  const id = expReq(db, { agent: { id: "dex", workspace_path: "/tmp/ws" }, agent_id: "dex", runtime: "codex", action: "shell", command: "echo hi", cwd: "/tmp/ws" } as never).request!.id;
  db.run("update permission_request set status='allowed_once' where id=?", [id]);
  expirePermissionRequest(db, id);
  expect(expGet(db, id)?.status).toBe("allowed_once");
  db.close();
});

// ── ★목적지는 인가 목록이 아니다★ (빌 리뷰 2026-08-12) ──
//
// allowFrom = "누가 이 봇에 말 걸 수 있나" 인가 목록이고 [팀리드 DM, 팀 그룹] 순서다.
// 그걸 목적지로 쓰면 ★팀 리드 DM 이 비었을 때 첫 항목이 팀 그룹★ 이 되어
// ★보안 질문이 단체방에 뜬다.★ 목적지는 팀 리드 DM 이고, 모르면 보내지 않는다.

test("★인가 목록이 아니라 팀 리드 DM 으로 간다★ — 두 값을 다르게 놓고 가른다", async () => {
  // ★이 기계에서는 allowFrom[0] 과 팀 리드 DM 이 우연히 같다.★ 그래서 기대값을 피험 함수에서
  // 뽑으면 옛 버그 코드(allowFrom[0])로 되돌려도 초록이다 — 실제로 그랬다(스티브 지적).
  // 두 값을 ★서로 다르게★ 놓아야 어느 쪽을 쓰는지 갈린다.
  const sent: Record<string, unknown>[] = [];
  const fetchFn = (async (_u: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return { ok: true } as Response; }) as unknown as typeof fetch;
  const OWNER_DM = "111111111"; // 팀 리드 DM (정답)
  const ok = await sendApprovalToMemberRoom("dex", "prm_x1", { method: "m", params: { command: "ls" } },
    { token: "T", fetchFn, resolveDestination: () => OWNER_DM });
  expect(ok).toBe(true);
  expect(String(sent[0]!.chat_id)).toBe(OWNER_DM); // allowFrom[0] 를 쓰면 이 값이 안 나온다
});

test("★목적지를 모르면 보내지 않는다★ (fail-closed) — 아무 방에나 띄우는 것보다 안 뜨는 게 낫다", async () => {
  const sent: unknown[] = [];
  const fetchFn = (async () => { sent.push(1); return { ok: true } as Response; }) as unknown as typeof fetch;
  const ok = await sendApprovalToMemberRoom("dex", "prm_x2", { method: "m", params: { command: "ls" } },
    { token: "T", fetchFn, resolveDestination: () => null });
  expect(ok).toBe(false);
  expect(sent).toHaveLength(0);
});
test("★재시작해도 만료가 유효하다★ — 만료가 대기 프로세스 메모리에만 있으면 행이 영원히 pending", async () => {
  // 빌 리뷰: 서버가 대기 중 재시작하면 아무도 그 행을 안 닫는다. 행이 스스로 말해야 한다.
  const db = new ApprDb(":memory:"); apprMigrate(db);
  const id = expReq(db, { agent: { id: "dex", workspace_path: "/tmp/ws" }, agent_id: "dex", runtime: "codex", action: "shell", command: "echo hi", cwd: "/tmp/ws" } as never).request!.id;
  db.run("update permission_request set expires_at = datetime('now','-1 second') where id=?", [id]);
  // ttl 을 길게 줘도(=이 프로세스는 아직 안 기다렸다) ★행의 만료가 이긴다★
  const decision = await pollDecision(db, id, 60_000, 5);
  expect(decision).toBe("denied");
  expect(expGet(db, id)?.status).toBe("expired");
  db.close();
});

test("대조군 — 만료 전이면 계속 기다린다(아무거나 만료로 읽으면 승인이 죽는다)", async () => {
  const db = new ApprDb(":memory:"); apprMigrate(db);
  const id = expReq(db, { agent: { id: "dex", workspace_path: "/tmp/ws" }, agent_id: "dex", runtime: "codex", action: "shell", command: "echo hi", cwd: "/tmp/ws" } as never).request!.id;
  db.run("update permission_request set expires_at = datetime('now','+60 seconds') where id=?", [id]);
  setTimeout(() => db.run("update permission_request set status='allowed_once' where id=?", [id]), 20);
  expect(await pollDecision(db, id, 5_000, 5)).toBe("approved");
  db.close();
});

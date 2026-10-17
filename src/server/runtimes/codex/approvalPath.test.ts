/** 요청 생성·팝업 목적지·결정 반환·자식 설정을 연결해 검증한다.
 * 현재 never 실행 모드에서는 팝업 경로에 도달하지 않으며 이 시험은 on-request 복원 시 계약을 지킨다. 시험 통과를 운영 중 호출 증거로 보지 않는다. */
import { test, expect } from "bun:test";

// startThread에 전달하는 sandbox·approvalPolicy는 CODEX_HOME 설정을 덮어쓴다. runtimeWorkspaceRoots는 experimentalApi가 필요하므로 실제 전달 인자로 배선을 검증한다.

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

test("★실행 모드를 프로토콜로 명시한다★ — 안 넘기면 readOnly 로 잠겨 턴이 아무것도 못 한다", async () => {
  const a = await startArgs({ cwd: "/tmp/ws" });
  expect({ approvalPolicy: a.approvalPolicy, sandbox: a.sandbox, approvalsReviewer: a.approvalsReviewer })
    .toEqual({ approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" });
});

// 이 시험은 전에 정반대를 못박고 있었다("on-request 여야 한다 — never 면 승인 릴레이가 죽는다").
// 요구사항이 바뀌었다: 이 런타임을 다른 팀원과 동일하게 둔다. 승인 릴레이가 죽는 것은
// 부작용이 아니라 의도한 결과 다. 값과 함께 이유도 바꿔 적는다.
test("approvalPolicy 는 never 다 — 다른 팀원과 같은 값이고, 사람이 실행을 승인하는 단계가 없다", async () => {
  const a = await startArgs({ cwd: "/tmp/ws" });
  expect(a.approvalPolicy).toBe("never");
  // on-request 로 돌아가면 사람이 안 누를 때 턴이 300초 뒤 끊긴다 — 실측으로 겪은 형태다.
  expect(a.approvalPolicy).not.toBe("on-request");
});

test("★호출자 opts 가 실행 모드를 덮지 못한다★ — 경계는 한 곳에서만 정해진다", async () => {
  const a = await startArgs({ cwd: "/tmp/ws", sandbox: "workspace-write", approvalPolicy: "on-request" });
  expect({ sandbox: a.sandbox, approvalPolicy: a.approvalPolicy })
    .toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
});

test("★runtimeWorkspaceRoots 를 넘기지 않는다★ — experimentalApi 를 요구해 turn 이 죽던 원인", async () => {
  const a = await startArgs({ cwd: "/tmp/ws", writableRoots: ["/tmp/ws"] });
  expect("runtimeWorkspaceRoots" in a).toBe(false);
});

test("★대조군 — 넘겨야 하는 것은 그대로 간다★ (cwd · model · resume)", async () => {
  const a = await startArgs({ cwd: "/tmp/ws", model: "gpt-x", resumeSessionId: "th_prev" });
  expect({ cwd: a.cwd, model: a.model, resume: a.resumeThreadId }).toEqual({ cwd: "/tmp/ws", model: "gpt-x", resume: "th_prev" });
});

// Codex 승인 요청을 받았을 때 실제 러너의 팝업 생성·대기·거절 동작을 검사한다. 다른 런타임처럼 실행 경계는 자체 설정이 정한다.

import { Database as ApprDb } from "bun:sqlite";
import { migrate as apprMigrate } from "../../db/migrate";
import { runViaAppServer as runApprServer } from "./appServerRunner";

/**
 * codex 가 승인 요청을 올리는 상황을 흉내내는 클라이언트.
 * 돌려받은 결정을 seen 에 적어둔다 — 안 적으면 결정값을 무엇으로 바꿔도 시험이 통과한다(뮤턴트 생존).
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

/** Codex 요청에 별도 사람 승인 대기를 추가하지 않는다. 공용 방 팝업이 처리되지 않아 턴이 멈추지 않도록 실제 거절 경로를 검증한다. */
/**
 * 결정을 기다리지 않는다 — 팝업은 사람이 누를 때까지 폴링한다(기본 TTL 1시간).
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
  // 아래는 지금 도달하지 않는 경로다 — 실행 모드가 approvalPolicy "never" 라 codex 가
  // 승인 요청을 보내지 않는다. 이 시험들은 "on-request" 로 되돌렸을 때의 계약을 지킨다.
  // 통과한다는 것이 그 경로가 라이브에서 돈다는 뜻은 아니다.
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

// 자식에 팀원 CODEX_HOME을 전달해야 호스트 설정 대신 해당 팀원의 승인정책·권한 프로파일이 적용된다.

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

//  팝업이 그 팀원 방으로 간다

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
  expect(calls[0]!.url).toContain("/botTKN/sendMessage"); // 그 팀원 봇 — 다른 봇이면 남의 방에 뜬다
  expect(calls[0]!.body.chat_id).toBe("555");
  const kb = (calls[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
  // 이 세션 선택은 allow_session·decision_scope=session·acceptForSession까지 이어져야 한다.
  expect(kb.map((b) => b.callback_data)).toEqual([
    "pg1:prm_abc123", "pgs:prm_abc123", "pga:prm_abc123", "pgd:prm_abc123",
  ]);
});

test("★위험 표시가 카드에 실린다 — 우리가 안 막으면 사람이 판단할 근거는 줘야 한다★", async () => {
  // 위험 명령과 일반 명령이 같은 카드로 보이지 않도록 위험 표시를 검증한다.
  const calls: { body: Record<string, unknown> }[] = [];
  const fetchFn = (async (_u: string, init: { body: string }) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;

  await sendApprovalToMemberRoom(
    "dex", "prm_risk",
    { method: "item/commandExecution/requestApproval", params: { command: "sudo rm -rf /tmp/x" } },
    { token: "T", chatId: "9", fetchFn, risks: ["sudo", "rm_rf"] },
  );
  const text = String(calls[0]!.body.text);
  expect(text, "★위험 사유가 본문에 있어야 한다★").toContain("위험 표시");
  expect(text).toContain("sudo");
  expect(text).toContain("rm_rf");

  // 위험 건에는 '항상 허용' 을 주지 않는다 — 막는 게 아니라 무인 반복 을 막는 것이다.
  //   '이 세션'(pgs) 은 위험 건에도 준다 — 지속되는 허가를 남기지 않고 codex 세션과 함께 사라진다.
  //   그래서 무인 반복이 생기지 않는다. codex 자신이 위험한 것을 기억하는 단위도 이것이다.
  const kb = (calls[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
  expect(kb.map((b) => b.callback_data)).toEqual(["pg1:prm_risk", "pgs:prm_risk", "pgd:prm_risk"]);
  expect(kb.map((b) => b.callback_data), "위험 건에 항상 허용은 없다").not.toContain("pga:prm_risk");
});

test("위험 표시가 없으면 네 갈래를 다 준다 — 한번·이 세션·항상·거절", async () => {
  const calls: { body: Record<string, unknown> }[] = [];
  const fetchFn = (async (_u: string, init: { body: string }) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;

  await sendApprovalToMemberRoom(
    "dex", "prm_safe",
    { method: "item/commandExecution/requestApproval", params: { command: "ls /tmp" } },
    { token: "T", chatId: "9", fetchFn, risks: [] },
  );
  const text = String(calls[0]!.body.text);
  expect(text, "안전한 건에는 위험 줄이 붙지 않는다").not.toContain("위험 표시");
  const kb = (calls[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
  expect(kb.map((b) => b.callback_data)).toEqual([
    "pg1:prm_safe", "pgs:prm_safe", "pga:prm_safe", "pgd:prm_safe",
  ]);
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

//  무응답 만료(5분)

import { pollDecision, expirePermissionRequest } from "./appServerPopup";
import { requestPermission as expReq, getPermissionRequest as expGet } from "../../lib/permissionGate";

test("★만료되면 행도 닫힌다★ — pending 으로 남으면 한참 뒤 탭이 끝난 턴을 승인한다", async () => {
  const db = new ApprDb(":memory:"); apprMigrate(db);
  const id = expReq(db, { agent: { id: "dex", workspace_path: "/tmp/ws" }, agent_id: "dex", runtime: "codex", action: "shell", command: "echo hi", cwd: "/tmp/ws" } as never).request!.id;
  const decision = await pollDecision(db, id, 20, 5); // 20ms 만료
  expect(decision).toBe("denied");
  expect(expGet(db, id)?.status).toBe("expired"); // 행이 닫혀야 나중 탭이 '만료' 로 답한다
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

// allowFrom은 인가 목록이라 DM이 없으면 그룹이 첫 항목일 수 있다. 보안 질문은 오너 DM으로만 보내고 모르면 발송하지 않는다.

test("★인가 목록이 아니라 팀 리드 DM 으로 간다★ — 두 값을 다르게 놓고 가른다", async () => {
  // 인가 목록과 오너 DM을 다른 값으로 두어 목적지 선택 오류를 구분한다. 실제 기기의 우연히 같은 값으로는 잘못된 구현도 통과한다.
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
  // 재시작 후 대기 행의 처리 여부를 알 수 있도록 행 자체에 상태를 기록해야 한다.
  const db = new ApprDb(":memory:"); apprMigrate(db);
  const id = expReq(db, { agent: { id: "dex", workspace_path: "/tmp/ws" }, agent_id: "dex", runtime: "codex", action: "shell", command: "echo hi", cwd: "/tmp/ws" } as never).request!.id;
  db.run("update permission_request set expires_at = datetime('now','-1 second') where id=?", [id]);
  // ttl 을 길게 줘도(=이 프로세스는 아직 안 기다렸다) 행의 만료가 이긴다
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

// 메모리 DB 격리만으로 외부 발신은 막히지 않는다. deps 없는 시험도 실제 토큰·방으로 승인 팝업을 보내지 않아야 한다.

test("★시험 중에는 실제 전송을 하지 않는다★ — 픽스처가 팀 리드 방에 뜨면 안 된다", async () => {
  // fetchFn 을 안 주면 = 진짜로 보내려는 것. 시험 중에는 무조건 막는다.
  const ok = await sendApprovalToMemberRoom("dex", "prm_guard", { method: "m", params: { command: "echo hi" } });
  expect(ok).toBe(false);
});

test("대조군 — fetchFn 을 준 시험은 그 가짜로 정상 검증된다(가드가 과잉이 아니다)", async () => {
  const sent: unknown[] = [];
  const fetchFn = (async () => { sent.push(1); return { ok: true } as Response; }) as unknown as typeof fetch;
  const ok = await sendApprovalToMemberRoom("dex", "prm_guard2", { method: "m", params: { command: "echo hi" } },
    { token: "T", chatId: "1", fetchFn });
  expect(ok).toBe(true);
  expect(sent).toHaveLength(1);
});

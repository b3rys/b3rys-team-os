/**
 * cogs 코덱스 정책 → 실행 설정. 순수 판정과, 그 값이 thread/start·turn/start·풀·exec 까지 그대로 가는지를 잰다.
 * 정책이 없는 팀원(absent)·cogs 가 아닌 경로는 지금 payload 와 똑같아야 한다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readPolicy } from "../../lib/cogsPermissions/policy";
import { runViaAppServer, runModeFor } from "./appServerRunner";
import { turnSandboxPolicy } from "./appServerClient";
import { acquireClient, dropAllClients } from "./clientPool";
import { resolveCogsCodexRun, type CogsCodexRun } from "./cogsRunPolicy";
import { runCodexTurn } from "./runner";
import { handleMessage } from "./bridge";

const codex = (over: Record<string, unknown> = {}) =>
  readPolicy({ runtime: "codex", schema_version: 1, revision: 1, full: false, network: true, writable_roots: [], ...over }, "codex");

describe("정책 → 실행 설정(순수)", () => {
  test("absent = legacy(지금 그대로)", () => {
    expect(resolveCogsCodexRun(readPolicy(undefined, "codex"), "/w")).toEqual({ mode: "legacy" });
  });
  test("깨진 정책 = 막음(넓혀서 돌지 않는다)", () => {
    expect(resolveCogsCodexRun(readPolicy({ runtime: "codex", schema_version: 9 }, "codex"), "/w")).toEqual({ mode: "blocked", reason: "schema_version" });
  });
  test("전체 허용 = 승인 없이 전체", () => {
    const r = resolveCogsCodexRun(codex({ full: true }), "/w");
    expect(r).toMatchObject({ mode: "enforced", approvalPolicy: "never", sandbox: "danger-full-access", writableRoots: [] });
  });
  test("세부 = 승인 카드 + 작업 폴더 쓰기 + 정확한 추가 경로 + 인터넷 값", () => {
    const r = resolveCogsCodexRun(codex({ network: false, writable_roots: ["/data/a", "/w"] }), "/w");
    expect(r).toMatchObject({ mode: "enforced", approvalPolicy: "on-request", sandbox: "workspace-write", networkAccess: false, writableRoots: ["/w", "/data/a"] });
  });
  test("작업 폴더가 없으면 지어내지 않는다", () => {
    const r = resolveCogsCodexRun(codex({ writable_roots: ["/data/a"] }), undefined);
    expect(r).toMatchObject({ writableRoots: ["/data/a"] });
  });
  test("내용이 바뀌면 도장이 바뀐다(풀 재사용 열쇠)", () => {
    const a = resolveCogsCodexRun(codex({ network: true }), "/w") as Extract<CogsCodexRun, { mode: "enforced" }>;
    const b = resolveCogsCodexRun(codex({ network: false }), "/w") as Extract<CogsCodexRun, { mode: "enforced" }>;
    expect(a.stamp).not.toBe(b.stamp);
  });
});

describe("turn/start sandboxPolicy 모양", () => {
  test("workspace-write 는 범위를 싣는다", () => {
    expect(turnSandboxPolicy({ sandbox: "workspace-write", writableRoots: ["/w"], networkAccess: false })).toEqual({ type: "workspaceWrite", writableRoots: ["/w"], networkAccess: false });
  });
  test("danger-full-access 는 지금 모양 그대로(type 만)", () => {
    expect(turnSandboxPolicy({ sandbox: "danger-full-access", writableRoots: ["/w"], networkAccess: true })).toEqual({ type: "dangerFullAccess" });
  });
  test("범위를 안 주면 칸을 만들지 않는다", () => {
    expect(turnSandboxPolicy({ sandbox: "workspace-write" })).toEqual({ type: "workspaceWrite" });
  });
});

function fakeClient(seen: Record<string, unknown>[], approvals: Array<(h: any) => Promise<unknown>> = []) {
  return () =>
    ({
      currentThreadId: "th_1",
      async start() {},
      async startThread(o: Record<string, unknown>) { seen.push(o); return "th_1"; },
      async runTurn(_p: string, handlers: any) {
        for (const a of approvals) seen.push({ approval: await a(handlers) });
        return { status: "completed", finalText: "ok", turnId: "t1", detail: "" };
      },
      close() {},
    }) as unknown as import("./appServerClient").CodexAppServerClient;
}

describe("app-server 러너가 실제로 넘기는 것", () => {
  test("cogsRun 없음 = 지금 payload 그대로(범위 칸 없음)", async () => {
    const seen: Record<string, unknown>[] = [];
    await runViaAppServer({ prompt: "p", agentId: "flo", cwd: "/w", writableRoots: ["/w"] } as never, undefined, fakeClient(seen));
    expect(seen[0]).toEqual({ cwd: "/w", model: undefined, resumeThreadId: undefined, approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" });
  });
  test("legacy 도 지금 그대로", async () => {
    const seen: Record<string, unknown>[] = [];
    await runViaAppServer({ prompt: "p", agentId: "flo", cwd: "/w", cogsRun: { mode: "legacy" } } as never, undefined, fakeClient(seen));
    expect(seen[0]).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect("writableRoots" in seen[0]!).toBe(false);
  });
  test("세부 정책 = on-request + workspace-write + 범위", async () => {
    const seen: Record<string, unknown>[] = [];
    const run = resolveCogsCodexRun(codex({ network: false, writable_roots: ["/data/a"] }), "/w");
    await runViaAppServer({ prompt: "p", agentId: "flo", cwd: "/w", cogsRun: run } as never, undefined, fakeClient(seen));
    expect(seen[0]).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write", writableRoots: ["/w", "/data/a"], networkAccess: false });
  });
  test("막힌 정책 = app-server 를 띄우지 않고 실패", async () => {
    let made = 0;
    const r = await runViaAppServer({ prompt: "p", agentId: "flo", cogsRun: { mode: "blocked", reason: "schema_version" } } as never, undefined, () => { made++; return fakeClient([])(); });
    expect(made).toBe(0);
    expect(r).toMatchObject({ ok: false, detail: "cogs_policy_blocked: schema_version" });
  });
  test("정책 팀원 승인 요청: 처리기 없으면 거절, 있으면 그 결과, 던지면 거절 — 텔레그램 팝업 경로로 가지 않는다", async () => {
    const run = resolveCogsCodexRun(codex(), "/w");
    const ask = (h: any) => h.onApproval({ method: "item/commandExecution/requestApproval", params: {} });
    const none: Record<string, unknown>[] = [];
    await runViaAppServer({ prompt: "p", agentId: "flo", cogsRun: run } as never, undefined, fakeClient(none, [ask]));
    expect(none[1]).toEqual({ approval: "denied" });
    const ok: Record<string, unknown>[] = [];
    await runViaAppServer({ prompt: "p", agentId: "flo", cogsRun: run, onCogsApproval: async () => "approved" } as never, undefined, fakeClient(ok, [ask]));
    expect(ok[1]).toEqual({ approval: "approved" });
    const boom: Record<string, unknown>[] = [];
    await runViaAppServer({ prompt: "p", agentId: "flo", cogsRun: run, onCogsApproval: async () => { throw new Error("x"); } } as never, undefined, fakeClient(boom, [ask]));
    expect(boom[1]).toEqual({ approval: "denied" });
  });
  test("runModeFor: 도장이 풀 열쇠, legacy 는 열쇠 없음", () => {
    const run = resolveCogsCodexRun(codex(), "/w") as Extract<CogsCodexRun, { mode: "enforced" }>;
    expect(runModeFor({ cogsRun: run }).poolKey).toBe(`cogs:${run.stamp}`);
    expect(runModeFor({}).poolKey).toBeUndefined();
  });
});

describe("풀 — 권한이 바뀌면 예전 app-server 를 다시 쓰지 않는다", () => {
  afterEach(() => dropAllClients());
  const mk = () => { const c = { isClosed: false, closed: 0, close() { this.isClosed = true; this.closed++; } }; return c; };
  test("같은 열쇠 = 재사용, 다른 열쇠 = 예전 것 닫고 새로", () => {
    const a = acquireClient("flo", mk, "cogs:1");
    expect(acquireClient("flo", mk, "cogs:1")).toEqual({ client: a.client, reused: true });
    const b = acquireClient("flo", mk, "cogs:2");
    expect(b.reused).toBe(false);
    expect(a.client.closed).toBe(1);
  });
  test("정책이 막힘이 되면 예전 권한으로 띄운 app-server 를 닫고, 다음 턴은 새로 띄운다", async () => {
    const old = acquireClient("flo", mk, "cogs:1");
    const r = await runViaAppServer({ prompt: "p", agentId: "flo", cogsRun: { mode: "blocked", reason: "schema_version" } } as never);
    expect(r).toMatchObject({ ok: false, detail: "cogs_policy_blocked: schema_version" });
    expect(old.client.closed).toBe(1);
    expect(acquireClient("flo", mk, "cogs:1").reused).toBe(false);
  });
  test("열쇠 없는 기존 호출은 지금처럼 재사용", () => {
    const a = acquireClient("dex", mk);
    expect(acquireClient("dex", mk).reused).toBe(true);
    expect(a.client.closed).toBe(0);
  });
});

test("exec 경로는 cogs 정책을 집행하지 못하므로 거절한다", async () => {
  const r = await runCodexTurn({ prompt: "p", agentId: "flo", cogsRun: { mode: "enforced", stamp: "s", approvalPolicy: "on-request", sandbox: "workspace-write", writableRoots: [] } } as never);
  expect(r).toMatchObject({ ok: false, detail: "cogs_policy_requires_app_server" });
});

describe("브리지 턴 진입점이 정책을 싣는다", () => {
  const capture = () => {
    const seen: any[] = [];
    const deps: any = {
      runTurn: async (o: any) => { seen.push(o); return { ok: true, reply: "ok", sessionId: "th", elapsedMs: 1 }; },
      sendMessage: async () => 1, editMessage: async () => true, reactMessage: async () => true, agentId: "flo",
    };
    return { seen, deps };
  };
  test("cogsRunFor 없음(텔레그램 등) = cogsRun 칸 없음", async () => {
    const { seen, deps } = capture();
    await handleMessage(1, "hi", 5, deps);
    expect("cogsRun" in seen[0]).toBe(false);
  });
  test("cogsRunFor 가 턴마다 불리고 결과가 실린다", async () => {
    const { seen, deps } = capture();
    let calls = 0;
    deps.cogsRunFor = () => { calls++; return { mode: "legacy" }; };
    await handleMessage(1, "a", 5, deps);
    await handleMessage(1, "b", 6, deps);
    expect(calls).toBe(2);
    expect(seen.map((o) => o.cogsRun)).toEqual([{ mode: "legacy" }, { mode: "legacy" }]);
  });
  test("정책 읽기가 던지면 막음으로 싣는다(넓히지 않는다)", async () => {
    const { seen, deps } = capture();
    deps.cogsRunFor = () => { throw new Error("EACCES"); };
    await handleMessage(1, "a", 5, deps);
    expect(seen[0].cogsRun).toEqual({ mode: "blocked", reason: "policy_read_failed: EACCES" });
  });
});

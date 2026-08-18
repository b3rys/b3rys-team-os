/**
 * app-server 러너가 codex 에 넘기는 ★실행 모드★ 를 잰다.
 *
 * 소스에 그 줄이 있는지가 아니라 `thread/start` 가 실제로 무엇을 받는지를 본다 —
 * 호출부가 값을 덮거나 빼면 소스 grep 은 통과하지만 이 시험은 실패한다.
 */
import { test, expect } from "bun:test";
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

// ★실행 모드를 명시하지 않으면 열리는 게 아니라 잠긴다.★
//   실측: 빈 CODEX_HOME · config 없음으로 codex 0.147.0 을 띄우고 thread/start 에 cwd·model 만 보내면
//     approvalPolicy "on-request" · sandbox { type: "readOnly" } · activePermissionProfile ":read-only"
//   그래서 열린 sandbox 를 프로토콜에 명시한다. approvalPolicy 는 openclaw 의 "never" 가 아니라
//   "on-request" 다 — never 면 codex 가 승인을 묻지 않아 채널 승인 배선이 호출되지 않는다.

test("★sandbox 를 열린 값으로 명시한다★ — 안 넘기면 read-only 로 잠긴다", async () => {
  const a = await startArgs({ cwd: "/tmp/ws" });
  expect(a.sandbox).toBe("danger-full-access");
});

test("★approvalPolicy·reviewer 도 명시한다★", async () => {
  const a = await startArgs({ cwd: "/tmp/ws" });
  expect(a.approvalPolicy).toBe("on-request");
  expect(a.approvalsReviewer).toBe("user");
});

test("★runtimeWorkspaceRoots 는 넘기지 않는다★ — experimentalApi 를 요구해 턴이 시작도 못 하던 원인", async () => {
  const a = await startArgs({ cwd: "/tmp/ws", writableRoots: ["/tmp/ws"] });
  expect("runtimeWorkspaceRoots" in a).toBe(false);
});

test("★대조군 — 넘겨야 하는 것은 그대로 간다★ (cwd · model · resume)", async () => {
  const a = await startArgs({ cwd: "/tmp/ws", model: "gpt-x", resumeSessionId: "th_prev" });
  expect({ cwd: a.cwd, model: a.model, resume: a.resumeThreadId }).toEqual({ cwd: "/tmp/ws", model: "gpt-x", resume: "th_prev" });
});

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

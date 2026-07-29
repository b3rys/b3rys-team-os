/**
 * app-server 클라이언트 실동작 smoke (실 codex 필요 → env-gated, 기본 CI 미실행).
 * 실행: B3OS_APPSERVER_SMOKE=1 CODEX_BIN=/opt/homebrew/bin/codex bun test appServerClient.smoke
 * 검증: turn 실행(응답)·steer(중간 다르게)·interrupt(중간 멈춤).
 */
import { test, expect } from "bun:test";
import { CodexAppServerClient } from "./appServerClient";

const RUN = process.env.B3OS_APPSERVER_SMOKE === "1";
const it = RUN ? test : test.skip;

it("turn 실행: 모델이 지시대로 응답", async () => {
  const c = new CodexAppServerClient();
  await c.start();
  await c.startThread({});
  const r = await c.runTurn("Reply with EXACTLY this and nothing else: HELLO-SMOKE");
  c.close();
  expect(r.status).toBe("completed");
  expect(r.finalText).toContain("HELLO-SMOKE");
}, 60000);

it("steer: 진행 중 턴을 중간에 다르게", async () => {
  const c = new CodexAppServerClient();
  await c.start();
  await c.startThread({});
  const p = c.runTurn("Write a slow, thorough 400-word essay about oceans. Start now.", {
    onTurnStarted: () => {
      // 3.5s 뒤 steer
      setTimeout(() => { c.steer("Stop the essay. Reply EXACTLY: STEERED-SMOKE").catch(() => {}); }, 3500);
    },
  });
  const r = await p;
  c.close();
  expect(r.finalText).toContain("STEERED-SMOKE");
}, 90000);

it("interrupt: 진행 중 턴을 완전 멈춤", async () => {
  const c = new CodexAppServerClient();
  await c.start();
  await c.startThread({});
  const p = c.runTurn("Count slowly from 1 to 100, one per line with a comment. Go.", {
    onTurnStarted: () => { setTimeout(() => { c.interrupt().catch(() => {}); }, 3500); },
  });
  const r = await p;
  c.close();
  expect(r.status).toBe("interrupted");
}, 90000);

/**
 * ★S2 배선 실증 — 알림 색인이 ★실제 클라이언트 코드 경로★ 에서 승인 요청에 붙는가.★
 *
 * 단위시험은 색인과 해석을 각각 검증하지만, ★둘을 잇는 세 줄(observe·beginTurn·lookup)★ 은
 * 검증하지 못한다. 오늘 팀에서 배운 게 정확히 그거다 — ★"판정 로직만 파고 켤 수 있나를 아무도 안 물었다".★
 * 그래서 진짜 codex 를 띄워 파일 수정을 시키고, onApproval 이 ★내용을 실제로 받는지★ 를 본다.
 * ★승인은 무조건 거절★ 하므로 파일은 바뀌지 않는다(읽기전용 샌드박스 + denied).
 */
it("S2: 파일변경 승인요청에 observedItem 이 실려 온다(실물)", async () => {
  const c = new CodexAppServerClient();
  await c.start();
  await c.startThread({ cwd: process.cwd(), approvalPolicy: "on-request", sandbox: "read-only" });
  const seen: Array<{ method: string; hasItem: boolean; paths: string[]; itemIdMatches: boolean }> = [];
  await c.runTurn(
    "Create a file named s2_wiring_probe.txt containing HELLO in the current directory. Use apply_patch only. Do not run shell commands.",
    {
      onApproval: (req) => {
        seen.push({
          method: req.method,
          hasItem: !!req.observedItem,
          paths: req.observedItem?.changes.map((ch) => ch.path) ?? [],
          itemIdMatches: req.observedItem?.itemId === (req.params as any)?.itemId,
        });
        return "denied"; // ★항상 거절 — 실제로 아무것도 쓰지 않는다★
      },
    },
    90_000,
  );
  c.close();
  const fileAsk = seen.find((s) => s.method === "item/fileChange/requestApproval");
  expect(fileAsk).toBeDefined();
  expect(fileAsk!.hasItem).toBe(true);           // ★짝짓기가 실물에서 성립★
  expect(fileAsk!.itemIdMatches).toBe(true);
  expect(fileAsk!.paths.some((p) => p.endsWith("s2_wiring_probe.txt"))).toBe(true);
}, 120000);

// M6 caller end-to-end (flag-on 경로 실증)
import { runCodexTurnViaAppServer } from "./appServerRunner";
it("M6 caller: runCodexTurnViaAppServer 무해 턴 → ok+reply", async () => {
  const r = await runCodexTurnViaAppServer({
    cwd: process.cwd(), prompt: "Reply with EXACTLY: CALLER-OK", sandbox: "read-only",
    writableRoots: [], networkAccess: false,
  } as any);
  expect(r.ok).toBe(true);
  expect(r.reply).toContain("CALLER-OK");
  expect(r.detail).toContain("appserver");
}, 60000);

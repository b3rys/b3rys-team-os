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

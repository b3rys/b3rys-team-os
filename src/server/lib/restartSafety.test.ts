// ★불변식: 되살릴 수 없으면 죽이지 마라.★
//
// restartAgent(claude_channel) 의 공개-설치본 폴백은 tmux 세션을 죽이고 기동 스크립트로 다시 띄운다.
// 순서가 뒤집히면(먼저 kill → 그제서야 기동 스크립트 없음을 발견) 멀쩡히 돌던 멤버를 죽여놓고 못 살린다.
// = '재시작이 실패한다'(원래 버그)보다 나쁜 '멤버 영구 다운'. Bill 리뷰 blocker(2026-07-12).
//
// 소스 순서를 직접 검증한다(실제 tmux 를 죽이지 않고 회귀를 고정하는 가장 확실한 방법).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "agentControl.ts"), "utf-8");

// claude_channel 재시작 블록만 잘라낸다.
function claudeRestartBlock(): string {
  const start = SRC.indexOf('if (runtime === "claude_channel")', SRC.indexOf("export async function restartAgent"));
  expect(start).toBeGreaterThan(0);
  const end = SRC.indexOf('if (runtime === "openclaw")', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("restartAgent(claude_channel) — 되살릴 수 없으면 죽이지 않는다", () => {
  test("★기동 스크립트 존재 확인이 tmux kill-session 보다 먼저다★", () => {
    const block = claudeRestartBlock();
    const guardIdx = block.indexOf("existsSync(starter)");
    const killIdx = block.indexOf("kill-session");
    expect(guardIdx).toBeGreaterThan(-1); // 가드가 존재해야 하고
    expect(killIdx).toBeGreaterThan(-1); // kill 도 존재하며
    // 가드가 kill 보다 앞서야 한다. 뒤집히면 멤버를 죽여놓고 못 살린다.
    expect(guardIdx).toBeLessThan(killIdx);
  });

  test("기동 스크립트가 없으면 아무것도 건드리지 않고 실패를 반환한다(세션 유지)", () => {
    const block = claudeRestartBlock();
    const guardIdx = block.indexOf("if (!existsSync(starter))");
    expect(guardIdx).toBeGreaterThan(-1);
    // 가드 if-블록 본문만 잘라낸다(여는 { → 닫는 }).
    const open = block.indexOf("{", guardIdx);
    const close = block.indexOf("}", open);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const guardBody = block.slice(open, close);
    // 되살릴 수단이 없을 때: 즉시 실패 반환만 하고,
    expect(guardBody).toContain("return");
    expect(guardBody).toContain("ok: false");
    // ★그 안에서 세션을 죽이면 안 된다★(죽여놓고 못 살리는 경로가 생긴다).
    expect(guardBody).not.toContain("kill-session");
  });

  test("내부 ops 스크립트가 있으면 그 경로를 쓴다(기존 동작 회귀 없음)", () => {
    const block = claudeRestartBlock();
    expect(block).toContain("restart-agent.sh");
    expect(block).toContain("existsSync(opsScript)");
  });

  test("cwd 가 아니라 REPO_ROOT 기준으로 경로를 잡는다", () => {
    const block = claudeRestartBlock();
    expect(block).toContain("REPO_ROOT");
    expect(block).not.toContain("process.cwd()");
  });
});

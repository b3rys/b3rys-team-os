import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { handleMessage, resetChatThreads, type BridgeDeps } from "./bridge";
import type { CodexTurnResult } from "./runner";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * ★턴이 실패한 것과 세션이 죽은 것은 다르다.★ (팀장님 관측 2026-08-19)
 *
 * 전에는 턴이 실패하면 저장된 세션을 ★무조건 지웠다.★ 그런데 `appserver_timeout` 은
 * 세션이 멀쩡한데 ★턴만 오래 걸린 것★ 이다. 지우고 나면 바로 직전에 한 얘기까지 통째로 잊는다:
 *   "방금 니가 보낸 메시지에 있는 말이야??? 왜 본인이 방금 말한걸 기억을 못하지?"
 * 게다가 그 sessionId 를 ★저장한 직후★ 지우고 있었다.
 */
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.B3OS_FIRST_CONTACT_DIR;
  process.env.B3OS_FIRST_CONTACT_DIR = mkdtempSync(join(tmpdir(), "b3os-surv-"));
  resetChatThreads();
});
afterEach(() => {
  if (prev === undefined) delete process.env.B3OS_FIRST_CONTACT_DIR;
  else process.env.B3OS_FIRST_CONTACT_DIR = prev;
});

function harness(result: CodexTurnResult) {
  const store = new Map<number, string>();
  const deps: BridgeDeps = {
    reactMessage: async () => true,
    sendMessage: async () => 1,
    editMessage: async () => true,
    sandbox: "read-only",
    runTurn: async () => result,
    dmSessions: {
      get: (c: number) => store.get(c),
      save: (c: number, s: string) => { store.set(c, s); },
      clear: (c: number) => { store.delete(c); },
    } as never,
  };
  return { deps, store };
}

describe("대화 기억이 살아남나", () => {
  test("★타임아웃이어도 세션은 남는다★ — thread 가 살아 있으면 이어받을 수 있다", async () => {
    const { deps, store } = harness({ ok: false, reply: "", sessionId: "th-1", detail: "appserver_timeout", elapsedMs: 1 });
    await handleMessage(7, "보고서 써줘", 1, deps);
    expect(store.get(7), "타임아웃은 세션이 죽은 게 아니다").toBe("th-1");
  });

  test("★답이 비어도 thread 가 있으면 남긴다★ — 다음 턴이 앞 얘기를 이어받는다", async () => {
    const { deps, store } = harness({ ok: true, reply: "", sessionId: "th-2", detail: "empty", elapsedMs: 1 });
    await handleMessage(7, "x", 1, deps);
    expect(store.get(7)).toBe("th-2");
  });

  test("★대조군 — thread 를 못 얻었으면 지운다★ (그 세션은 정말 못 쓴다)", async () => {
    const { deps, store } = harness({ ok: true, reply: "첫 답", sessionId: "th-old", detail: "ok", elapsedMs: 1 });
    await handleMessage(7, "첫 말", 1, deps);
    expect(store.get(7)).toBe("th-old");

    const dead = harness({ ok: false, reply: "", detail: "appserver_error", elapsedMs: 1 });
    dead.store.set(7, "th-old");
    await handleMessage(7, "다음 말", 2, dead.deps);
    expect(dead.store.get(7), "쓸 수 있는 thread 가 없으면 스스로 낫도록 지운다").toBeUndefined();
  });

  test("정상 턴은 지금까지대로 저장한다", async () => {
    const { deps, store } = harness({ ok: true, reply: "답", sessionId: "th-3", detail: "ok", elapsedMs: 1 });
    await handleMessage(7, "안녕", 1, deps);
    expect(store.get(7)).toBe("th-3");
  });
});

/* ★재시작에는 자동복구가 없었다★ (2026-07-27 GD 지적, "매우 중요한 기능").
 * 영입(activation)에는 poller 확인 + auto-reconnect 가 있었는데 재시작(agentControl)에는 ★아예 없었다★ —
 * 기동 스크립트만 돌리고 붙었는지 확인조차 안 했다. 그래서 재시작 후 안 붙으면 아무도 안 고쳤고,
 * 팀원은 ★프로세스는 살아 있는데 메시지만 안 들어오는★ 상태로 방치됐다(오류도 안 남).
 *
 * 여기서는 ensureClaudePollerUp 의 계약을 고정한다. tmux·HOME 을 건드리지 않도록 wait/reconnect 를 주입한다. */
import { describe, expect, test } from "bun:test";
import { ensureClaudePollerUp } from "./pollerHealth";

/** 호출 n번째까지 false, 그 뒤 true 를 주는 wait 스텁 + 호출 기록. */
function stubs(opts: { upAfterReconnects: number | null; sessionAlive?: boolean }) {
  const calls = { wait: [] as number[], reconnect: 0 };
  let reconnects = 0;
  return {
    calls,
    wait: async (_id: string, ms: number) => {
      calls.wait.push(ms);
      if (opts.upAfterReconnects === null) return false;      // 영영 안 붙는 경우
      return reconnects >= opts.upAfterReconnects;
    },
    reconnect: (_id: string) => {
      if (opts.sessionAlive === false) return false;          // tmux 세션 부재 = 살릴 수단 없음
      reconnects++; calls.reconnect++; return true;
    },
  };
}

describe("ensureClaudePollerUp — 재시작 뒤 poller 자동복구", () => {
  test("이미 붙어 있으면 reconnect 를 쏘지 않는다 (멀쩡한 세션에 슬래시 명령 주입 금지)", async () => {
    const s = stubs({ upAfterReconnects: 0 });
    const r = await ensureClaudePollerUp("bill", { waitMs: 100, wait: s.wait, reconnect: s.reconnect });
    expect(r.ok).toBe(true);
    expect(r.recovered).toBe(false);
    expect(s.calls.reconnect).toBe(0);      // ★중요★ — 정상 세션에 명령을 던지면 그게 사고다
    expect(r.detail).toContain("기동 확인");
  });

  test("★안 붙어 있으면 reconnect 를 주입해 살린다★ (이 기능의 존재 이유)", async () => {
    const s = stubs({ upAfterReconnects: 1 });
    const r = await ensureClaudePollerUp("bill", { waitMs: 100, recheckMs: 10, wait: s.wait, reconnect: s.reconnect });
    expect(r.ok).toBe(true);
    expect(r.recovered).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.detail).toContain("복구");
  });

  test("한 번으로 안 되면 다시 시도한다 (기본 2회)", async () => {
    const s = stubs({ upAfterReconnects: 2 });
    const r = await ensureClaudePollerUp("bill", { waitMs: 100, recheckMs: 10, wait: s.wait, reconnect: s.reconnect });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  test("★무한 재시도하지 않는다★ — 한도를 넘으면 멈추고 실패를 말한다", async () => {
    const s = stubs({ upAfterReconnects: null });
    const r = await ensureClaudePollerUp("bill", { waitMs: 100, recheckMs: 10, wait: s.wait, reconnect: s.reconnect });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);                 // 기본 한도에서 멈춘다
    expect(s.calls.reconnect).toBe(2);
    // ★조용히 성공이라고 말하지 않는다★ — 오늘 하루 계속 나온 '있는데 작동 안 하는' 형태를 막는 부분
    expect(r.detail).toContain("미기동");
  });

  test("★tmux 세션이 없으면 즉시 멈춘다★ (살릴 수단이 없는데 헛돌면 재시작이 30초씩 늘어진다)", async () => {
    const s = stubs({ upAfterReconnects: null, sessionAlive: false });
    const r = await ensureClaudePollerUp("bill", { waitMs: 100, recheckMs: 10, wait: s.wait, reconnect: s.reconnect });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(0);
    expect(s.calls.wait.length).toBe(1);        // 첫 확인 1회로 끝 — 재확인 대기를 반복하지 않는다
  });

  test("첫 대기와 재확인 대기는 서로 다른 값을 쓴다 (재확인은 짧게)", async () => {
    const s = stubs({ upAfterReconnects: 1 });
    await ensureClaudePollerUp("bill", { waitMs: 777, recheckMs: 11, wait: s.wait, reconnect: s.reconnect });
    expect(s.calls.wait[0]).toBe(777);
    expect(s.calls.wait[1]).toBe(11);
  });
});

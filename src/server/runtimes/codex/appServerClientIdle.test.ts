/**
 * ★턴 상한이 재는 것은 '일한 시간' 이 아니라 '조용한 시간' 이다.★ (2026-08-20)
 *
 * 라이브에서 벌어진 것: dex 가 보고서를 만드는 동안 진행 신호가 ★137번★ 찍혔는데도 5분에 잘렸다
 * (`codex_turn_failed:appserver_timeout` 3건, 전부 보고서 작업). 타이머를 턴 시작에 한 번 걸고
 * ★진행 이벤트로 다시 걸지 않았기 때문★ 이다. 그래서 오래 걸리는 일은 ★매번★ 잘렸다.
 *
 * 팀장님 지시: "작업을 하는데 왜 시간으로 컷을 하지?" · 빌 경고: 승인 대기 중에는 타이머를
 * 일부러 꺼두므로(ref-count) ★진행 신호로 무조건 재무장하면 Ames 가 잡았던 조기 재개 사고가 돌아온다.★
 * 그 상황을 세 번째 시험이 지킨다.
 */
import { describe, expect, test } from "bun:test";
import { CodexAppServerClient } from "./appServerClient";

/** 프로세스 없이 턴만 돌리는 최소 세팅 — 실제 IO(notify/interrupt)는 대신 세운다. */
function makeClient() {
  const c = new CodexAppServerClient();
  const calls = { interrupts: 0 };
  (c as any).threadId = "th-test";
  (c as any).notify = async () => {};                       // turn/start 를 실제로 보내지 않는다
  (c as any).interrupt = async () => { calls.interrupts++; }; // 끊었는지만 센다
  return { c, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 진행 신호 1건 — 실제 스트림이 지나는 그 입구로 넣는다. */
const activity = (c: CodexAppServerClient) => (c as any).handleNotification("thread/item.updated", {});

describe("무응답 상한(idle) — 일하는 턴은 안 끊는다", () => {
  test("★진행 신호가 계속 오면 상한을 훨씬 넘겨도 안 끊긴다★ (라이브에서 잘린 그 상황)", async () => {
    const { c, calls } = makeClient();
    const started = Date.now();
    const p = c.runTurn("긴 작업", {}, 200); // 무응답 200ms 면 끊는다
    // 상한의 4배 넘게 '일한다' — 80ms 마다 진행 신호
    for (let i = 0; i < 10; i++) { await sleep(80); activity(c); }
    expect(calls.interrupts, "★일하는 중인데 끊었다 — 이게 라이브에서 난 일이다★").toBe(0);
    const r = await p;                       // 신호를 멈추면 그때부터 200ms 뒤 종료
    expect(r.status).toBe("timeout");
    expect(Date.now() - started, "★상한(200ms)이 아니라 마지막 신호 기준으로 끊겨야 한다★").toBeGreaterThan(800);
    expect(calls.interrupts).toBe(1);
  });

  test("★대조군 — 아무 소식이 없으면 상한에서 끊긴다★ (상한을 없앤 게 아니다)", async () => {
    const { c, calls } = makeClient();
    const started = Date.now();
    const r = await c.runTurn("멈춘 작업", {}, 200);
    expect(r.status).toBe("timeout");
    expect(calls.interrupts).toBe(1);
    expect(Date.now() - started, "조용한 턴은 상한 근처에서 끊긴다").toBeLessThan(1000);
  });

  test("★승인 팝업 대기 중에는 진행 신호가 와도 시계를 켜지 않는다★ (빌 경고 · Ames 조기재개 회귀)", async () => {
    const { c, calls } = makeClient();
    const p = c.runTurn("승인 대기 턴", {}, 150);
    (c as any).pauseTurnTimer();   // 승인 팝업 대기 시작 → 타이머 꺼짐
    for (let i = 0; i < 6; i++) { await sleep(60); activity(c); } // 사람이 보는 동안 진행 신호가 온다
    expect(
      (c as any).turnTimer,
      "★승인 대기 중인데 진행 신호가 시계를 되살렸다★ — 사람이 팝업 보는 중에 턴이 끊긴다",
    ).toBeNull();
    expect(calls.interrupts).toBe(0);
    (c as any).resumeTurnTimer();  // 승인 응답 → 여기서만 재무장한다
    const r = await p;
    expect(r.status).toBe("timeout");
    expect(calls.interrupts).toBe(1);
  });

  test("★왜 끊었는지 사유에 남긴다★ — '오래 걸려서' 와 '조용해서' 는 다른 사건이다", async () => {
    const { c } = makeClient();
    const p = c.runTurn("신호 몇 개 뒤 멈춘 작업", {}, 200);
    activity(c); await sleep(50); activity(c);
    const r = await p;
    expect(String(r.detail)).toContain("idle");
    expect(String(r.detail), "그때까지 몇 건이나 진행했는지도 남는다").toContain("진행신호 2건");
  });
});

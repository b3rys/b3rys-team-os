/** 턴 시간 제한은 전체 작업 시간이 아닌 무응답 시간을 잰다. 진행 신호는 연장하되 승인 대기 중 타이머를 다시 켜지 않는지 함께 검증한다. */
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
const activity = (c: CodexAppServerClient) => (c as any).handleNotification("item/started", {});

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

  // 이 대기 상태는 지금 라이브에서 안 생긴다 — 실행 정책이 "never" 라 승인 팝업이 없다.
  //   여기서 지키는 것은 타이머 계약이고, "on-request" 로 되돌리면 그대로 다시 쓰인다.
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

  test("★진행과 무관한 알림은 시계를 되돌리지 않는다★ (주기 알림 하나로 상한이 무력화되면 안 된다)", async () => {
    const { c, calls } = makeClient();
    const started = Date.now();
    let resolvedAt = 0;
    const p = c.runTurn("계정 알림만 오는 멈춘 턴", {}, 200).then((r) => { resolvedAt = Date.now(); return r; });
    // 상한(200ms)보다 오래 계정 알림만 계속 보낸다 — 이걸 진행으로 세면 그 동안 안 끊긴다
    for (let i = 0; i < 8; i++) { await sleep(120); (c as any).handleNotification("account/rateLimits/updated", {}); }
    const r = await p;
    expect(r.status).toBe("timeout");
    expect(calls.interrupts).toBe(1);
    // 언제 끊겼는지를 잰다 — 총 경과가 아니라. 총 경과로 재면 두 동작이 같은 값을 낸다(이 시험이 그래서 한 번 헛돌았다)
    expect(
      resolvedAt - started,
      "★계정 알림이 시계를 되돌렸다 — 멈춘 턴이 알림 도는 동안 영영 안 끊긴다★",
    ).toBeLessThan(600);
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

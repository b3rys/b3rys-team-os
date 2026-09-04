import { test, expect } from "bun:test";
import { createSerialTurnQueue } from "./serialTurnQueue";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("★enqueue 는 기다리지 않고 즉시 돌아온다★ — 이게 없으면 폴링이 턴에 막힌다(교착)", () => {
  const q = createSerialTurnQueue();
  const t0 = Date.now();
  q.enqueue(async () => { await tick(50); });
  expect(Date.now() - t0).toBeLessThan(20);
});

test("★두 턴이 절대 겹치지 않는다★ — app-server 클라이언트가 팀원 단위 공유라 겹치면 첫 턴이 죽는다", async () => {
  const q = createSerialTurnQueue();
  let running = 0;
  let maxConcurrent = 0;
  const task = async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await tick(20);
    running -= 1;
  };
  // 서로 다른 대화에서 온 것처럼 여러 개를 한꺼번에 넣는다.
  q.enqueue(task); q.enqueue(task); q.enqueue(task);
  await q.drain();
  expect(maxConcurrent).toBe(1);
});

test("★넣은 순서대로 돈다★ — 답이 뒤섞이면 안 된다", async () => {
  const q = createSerialTurnQueue();
  const order: string[] = [];
  q.enqueue(async () => { await tick(30); order.push("첫째"); });
  q.enqueue(async () => { await tick(1); order.push("둘째"); });
  q.enqueue(async () => { order.push("셋째"); });
  await q.drain();
  expect(order).toEqual(["첫째", "둘째", "셋째"]);
});

test("★앞 턴이 터져도 다음 턴은 돈다★ — 예외 하나가 대기열을 영구히 막지 않는다", async () => {
  const errs: unknown[] = [];
  const q = createSerialTurnQueue((e) => errs.push(e));
  const order: string[] = [];
  q.enqueue(async () => { throw new Error("터짐"); });
  q.enqueue(async () => { order.push("다음"); });
  await q.drain();
  expect(order).toEqual(["다음"]);
  expect(errs.length).toBe(1);
});

test("★보고 함수가 터져도 다음 턴은 돈다★ — 오류 보고가 대기열을 막으면 안 된다", async () => {
  const q = createSerialTurnQueue(() => { throw new Error("보고까지 터짐"); });
  const order: string[] = [];
  q.enqueue(async () => { throw new Error("턴 터짐"); });
  q.enqueue(async () => { order.push("다음"); });
  await q.drain();
  expect(order).toEqual(["다음"]);
});

test("사슬이 끝나면 비었다고 보고한다 — 진단용", async () => {
  const q = createSerialTurnQueue();
  q.enqueue(async () => { await tick(1); });
  expect(q.idle()).toBe(false);
  await q.drain();
  expect(q.idle()).toBe(true);
});

// ★종료할 때 남은 턴을 세려면 개수를 물어볼 수 있어야 한다★ —
//   bridge window 는 202(접수)까지만 답하므로, 접수된 채 사라진 턴은 이 값 없이는 기록조차 안 남는다.
test("pendingCount — 접수된 채 아직 안 끝난 턴 수를 준다", async () => {
  const q = createSerialTurnQueue();
  expect(q.pendingCount()).toBe(0);
  let release: (() => void) | null = null;
  q.enqueue(() => new Promise<void>((r) => { release = r; }));
  q.enqueue(async () => {});
  expect(q.pendingCount()).toBe(2);
  // 사슬은 마이크로태스크로 돈다 — 첫 턴이 실제로 시작할 틈을 준다.
  await new Promise((r) => setTimeout(r, 0));
  release!();
  await q.drain();
  expect(q.pendingCount()).toBe(0);
});

/** 폴링은 턴을 기다리지 않아야 실행 중 입력·콜백을 계속 받는다. 큐는 팀원별 공유 클라이언트의 resolve·타이머 덮어쓰기를 막도록 한 번에 한 턴만 실행한다.
 * 실패 시 프로세스 폐기도 팀원 단위라 대화 간 간섭이 생길 수 있다. 대화별 병렬은 클라이언트를 분리하거나 runTurn 동시 진입 가드를 추가한 뒤에만 가능하다. */

export interface SerialTurnQueue {
  /** 사슬 뒤에 붙여 실행한다. 즉시 반환한다(기다리지 않는다). */
  enqueue: (run: () => Promise<void>) => void;
  /** 사슬이 비어 있나(시험·진단용). */
  idle: () => boolean;
  /** 아직 안 끝난 턴 수. 종료할 때 남은 것을 세어 기록하는 데 쓴다. */
  pendingCount: () => number;
  /** 지금 사슬이 끝날 때까지(시험용). */
  drain: () => Promise<void>;
}

export function createSerialTurnQueue(onError?: (err: unknown) => void): SerialTurnQueue {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;

  // 보고가 터져도 사슬은 이어져야 한다 — 그러지 않으면 이 catch 자체가 대기열을 막는다.
  const report = (err: unknown): void => {
    try { onError?.(err); } catch { /* 보고 실패가 대기열을 막지 않는다 */ }
  };

  const enqueue = (run: () => Promise<void>): void => {
    pending += 1;
    // 실패를 사슬에 흘리지 않는다 — 한 턴의 예외가 뒤의 모든 턴을 막으면 안 된다.
    chain = chain
      .then(() => run().catch(report))
      .then(() => { pending -= 1; });
  };

  return {
    enqueue,
    idle: () => pending === 0,
    pendingCount: () => pending,
    drain: async () => { await chain; },
  };
}

/**
 * 턴 직렬 대기열 — ★받는 창구를 막지 않으면서, 턴은 한 번에 하나만★ 돌린다.
 *
 * 왜 필요한가(교착): 폴링 루프가 턴을 그 자리에서 기다리면 그동안 getUpdates 를 다시 부르지 못한다.
 * 그런데 ★승인 팝업은 턴이 도는 중에만 뜬다.★ 그래서 사람이 버튼을 눌러도 그 입력은 턴이 끝날
 * 때까지 가져와지지 않고, 턴은 승인을 기다리다 제한시간에 죽는다.
 * 실측(2026-08-18, codex_approval_correlation 전수 21건):
 *   · 2026-08-13 11:35 ~ 2026-08-18 11:18 구간의 ★8건이 전부 expired★ (delivered 0건).
 *     그중 6건이 300~302초 — 턴 하드 타임아웃 300초와 같다.
 *   · ★사람이 누른 기록은 있었다★ — permission_request 에 approver 가 찍혔는데 codex 로 전달되지
 *     않은 건이 ★6건★ 이다(expired 5 + orphaned 1). 즉 없던 것은 클릭이 아니라
 *     ★그 결정이 codex 로 전달되는 것★ 이었다.
 *     (세는 기준은 state != 'delivered' 다. expired 만 세면 5건이 되어 orphaned 를 놓친다.)
 *   · 2026-08-18 12:29 prm_93e07c50a14b4eb989 — 7초 만에 delivered. 그 구간 이후 첫 전달이다.
 *
 * 왜 ★직렬★ 인가: 교착을 푸는 데 필요한 것은 "루프가 턴을 기다리지 않는 것" 이지 "턴을 겹쳐
 * 돌리는 것" 이 아니다. app-server 클라이언트는 ★팀원 단위★ 로 공유되고(clientPool.acquireClient),
 * `CodexAppServerClient.runTurn` 에는 ★동시 진입 가드가 없다★ — 두 번째 턴이 첫 턴의 resolve 와
 * 타이머를 덮어써 첫 턴이 끝나지 않는다. 턴 실패 시 dropClient 도 팀원 단위라 한 대화의 실패가
 * 다른 대화의 프로세스를 닫는다. ★지금까지 그 가정을 지켜준 것이 폴링 루프의 인라인 await 였다.★
 * 그 잠금을 걷어내는 대신 여기로 옮긴다.
 *
 * 대화별 병렬은 클라이언트를 대화별로 만들거나 runTurn 에 가드를 넣은 다음의 일이다.
 */

export interface SerialTurnQueue {
  /** 사슬 뒤에 붙여 실행한다. 즉시 반환한다(기다리지 않는다). */
  enqueue: (run: () => Promise<void>) => void;
  /** 사슬이 비어 있나(시험·진단용). */
  idle: () => boolean;
  /** ★아직 안 끝난 턴 수.★ 종료할 때 남은 것을 세어 기록하는 데 쓴다. */
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
    // ★실패를 사슬에 흘리지 않는다★ — 한 턴의 예외가 뒤의 모든 턴을 막으면 안 된다.
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

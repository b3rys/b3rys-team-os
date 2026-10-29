/** 서브에이전트 결과는 턴 종료 후에도 돌아오므로 팀원별 app-server를 턴보다 오래 보존한다.
 * 팀원 단위 잠금이 같은 풀 항목의 동시 턴 사용을 막는 전제이며 이 잠금을 제거하면 클라이언트 공유를 재검토해야 한다. */
import type { CodexAppServerClient } from "./appServerClient";

/** 살아있는지 밖에서 물어볼 수 있는 최소 계약(시험에서 가짜를 세울 수 있게). */
export interface PoolableClient {
  readonly isClosed: boolean;
  close(): void;
}

const pool = new Map<string, PoolableClient>();
/** 그 클라이언트를 띄운 실행 권한 열쇠(cogs 정책 도장). 다르면 다시 쓰지 않는다 — 예전 권한의 app-server·서브 작업이 다음 턴에 남지 않게. */
const keys = new Map<string, string | undefined>();
const generations = new Map<string, number>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelCleanup(agentId: string): void {
  const timer = cleanupTimers.get(agentId);
  if (timer) clearTimeout(timer);
  cleanupTimers.delete(agentId);
}

/**
 * 그 팀원의 살아있는 클라이언트를 준다. 없거나 죽었으면 새로 만든다.
 * 죽은 것을 그대로 돌려주면 그 턴이 통째로 실패한다 — 프로세스는 크래시·재시작으로 언제든 죽는다.
 */
export function acquireClient<T extends PoolableClient>(agentId: string, create: () => T, policyKey?: string): { client: T; reused: boolean } {
  cancelCleanup(agentId);
  generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
  const existing = pool.get(agentId) as T | undefined;
  if (existing && !existing.isClosed && keys.get(agentId) === policyKey) return { client: existing, reused: true };
  if (existing && !existing.isClosed) dropClient(agentId); // 권한이 바뀌었다 — 닫는다(살아 있는 서브 작업도 같이 끝난다)
  else if (existing) pool.delete(agentId); // 죽은 것 치운다
  const client = create();
  pool.set(agentId, client);
  keys.set(agentId, policyKey);
  return { client, reused: false };
}

/** 그 팀원 것을 닫고 치운다(턴 실패·재시작 정리용). 없으면 아무 일도 없다. */
export function dropClient(agentId: string): void {
  cancelCleanup(agentId);
  const c = pool.get(agentId);
  pool.delete(agentId);
  keys.delete(agentId);
  try { c?.close(); } catch { /* 정리 실패가 상위를 막지 않는다 */ }
}

/** 턴 종료 후에도 하위 작업이 있으면 보존한다. 모두 유휴가 되면 app-server와 그 MCP를 함께 닫는다.
 * 조회 중 새 턴이 같은 client를 얻었으면 세대가 달라져 예전 정리 결과로 닫지 않는다. */
export async function releaseIdleClient(
  agentId: string,
  client: PoolableClient & { isIdle(): Promise<boolean> },
  retryMs = 10_000,
): Promise<void> {
  const generation = generations.get(agentId);
  const current = () => pool.get(agentId) === client && generations.get(agentId) === generation && !client.isClosed;
  const check = async () => {
    if (!current()) return;
    let idle = false;
    try { idle = await client.isIdle(); } catch { /* 상태를 못 읽으면 진행 중일 수 있으므로 보존한다 */ }
    if (!current()) return;
    if (idle) { dropClient(agentId); return; }
    cancelCleanup(agentId);
    const timer = setTimeout(() => { cleanupTimers.delete(agentId); void check(); }, retryMs);
    timer.unref?.();
    cleanupTimers.set(agentId, timer);
  };
  await check();
}

/** 전부 정리(서버 종료). 남겨두면 좀비 프로세스가 쌓인다. */
export function dropAllClients(): void {
  for (const id of [...pool.keys()]) dropClient(id);
}

/** 지금 살아있는 팀원 목록(진단·시험용). */
export function pooledAgents(): string[] {
  return [...pool.keys()];
}

export type { CodexAppServerClient };

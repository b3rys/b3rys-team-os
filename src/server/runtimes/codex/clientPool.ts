/**
 * ★팀원별 app-server 를 살려둔다.★
 *
 * 왜 — 실측 2026-08-12:
 *   codex 0.147 의 서브에이전트(`spawn_agent`)는 ★비동기★ 다. 띄우면 agent_id 만 즉시 돌려주고
 *   결과는 나중에 회수한다. 그런데 우리는 ★턴이 끝나면 프로세스를 닫고 있었다.★
 *   서브는 그 프로세스 안에서 도니까 ★같이 죽었다★ — 서브 4개 중 3개가 완료 기록 없이 잘렸고,
 *   메인의 마지막 말은 "서브 결과를 회수합니다" 였다. 회수 직전에 우리가 끊은 것이다.
 *
 * 그래서 프로세스를 ★턴보다 오래★ 살린다. 턴은 대화의 단위이지 프로세스의 단위가 아니다.
 *
 * 동시성 — 한 팀원당 한 턴만 돈다(adapter 의 inFlight 잠금). 그래서 풀의 항목 하나를
 * 두 턴이 동시에 쓰는 일은 없다. 그 잠금이 사라지면 이 가정도 깨진다.
 */
import type { CodexAppServerClient } from "./appServerClient";

/** 살아있는지 밖에서 물어볼 수 있는 최소 계약(시험에서 가짜를 세울 수 있게). */
export interface PoolableClient {
  readonly isClosed: boolean;
  close(): void;
}

const pool = new Map<string, PoolableClient>();

/**
 * 그 팀원의 살아있는 클라이언트를 준다. 없거나 ★죽었으면 새로 만든다.★
 * 죽은 것을 그대로 돌려주면 그 턴이 통째로 실패한다 — 프로세스는 크래시·재시작으로 언제든 죽는다.
 */
export function acquireClient<T extends PoolableClient>(agentId: string, create: () => T): { client: T; reused: boolean } {
  const existing = pool.get(agentId) as T | undefined;
  if (existing && !existing.isClosed) return { client: existing, reused: true };
  if (existing) pool.delete(agentId); // 죽은 것 치운다
  const client = create();
  pool.set(agentId, client);
  return { client, reused: false };
}

/** 그 팀원 것을 닫고 치운다(턴 실패·재시작 정리용). 없으면 아무 일도 없다. */
export function dropClient(agentId: string): void {
  const c = pool.get(agentId);
  pool.delete(agentId);
  try { c?.close(); } catch { /* 정리 실패가 상위를 막지 않는다 */ }
}

/** 전부 정리(서버 종료). ★남겨두면 좀비 프로세스가 쌓인다.★ */
export function dropAllClients(): void {
  for (const id of [...pool.keys()]) dropClient(id);
}

/** 지금 살아있는 팀원 목록(진단·시험용). */
export function pooledAgents(): string[] {
  return [...pool.keys()];
}

export type { CodexAppServerClient };

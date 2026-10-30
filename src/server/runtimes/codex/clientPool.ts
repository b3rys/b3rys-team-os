/** Each member owns one usable app-server. Retirement transfers ownership to a
 * separate cleanup set before any signal, so a dying process cannot accept a new turn. */
import type { CodexAppServerClient } from "./appServerClient";

export interface PoolableClient {
  readonly isClosed: boolean;
  readonly isTerminated?: boolean;
  close(): void;
  retireIfIdle?(commit: () => boolean): Promise<boolean>;
}
const pool = new Map<string, PoolableClient>();
const keys = new Map<string, string | undefined>();
const generations = new Map<string, number>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retired = new Map<PoolableClient, { accepted: boolean; timer?: ReturnType<typeof setTimeout> }>();

function cancelCleanup(agentId: string): void {
  clearTimeout(cleanupTimers.get(agentId));
  cleanupTimers.delete(agentId);
}

/** Failed signals stay owned here. Successful TERM is monitored until exit;
 * the client escalates only its captured retired process, never a pool replacement. */
function closeRetired(client: PoolableClient): void {
  const state = retired.get(client);
  if (!state) return;
  clearTimeout(state.timer);
  if (client.isTerminated ?? (state.accepted && client.isClosed)) { retired.delete(client); return; }
  if (!state.accepted) {
    try { client.close(); state.accepted = true; }
    catch { console.warn("[codex] retired app-server termination failed; retained for retry"); }
  }
  if (client.isTerminated ?? (state.accepted && client.isClosed)) { retired.delete(client); return; }
  state.timer = setTimeout(() => closeRetired(client), 1000);
  state.timer.unref?.();
}

/** No await between checking ownership, removing the entry and recording retirement. */
function retire(agentId: string, client: PoolableClient): void {
  cancelCleanup(agentId);
  pool.delete(agentId);
  keys.delete(agentId);
  generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
  retired.set(client, { accepted: false });
}

export function acquireClient<T extends PoolableClient>(agentId: string, create: () => T, policyKey?: string): { client: T; reused: boolean } {
  cancelCleanup(agentId);
  generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
  const existing = pool.get(agentId) as T | undefined;
  if (existing && !existing.isClosed && keys.get(agentId) === policyKey) return { client: existing, reused: true };
  if (existing) dropClient(agentId);
  const client = create();
  if (client.isClosed) throw new Error("cannot pool a closed or retired app-server");
  pool.set(agentId, client);
  keys.set(agentId, policyKey);
  return { client, reused: false };
}

/** Explicit drop also retires first. Cleanup failure cannot make it usable again. */
export function dropClient(agentId: string): void {
  const client = pool.get(agentId);
  cancelCleanup(agentId);
  if (!client) return;
  retire(agentId, client);
  closeRetired(client);
}

export async function releaseIdleClient(agentId: string, client: PoolableClient & { isIdle(): Promise<boolean> }, retryMs = 10_000): Promise<void> {
  const generation = generations.get(agentId);
  const current = () => pool.get(agentId) === client && generations.get(agentId) === generation;
  const commit = () => { if (!current()) return false; retire(agentId, client); return true; };
  const check = async () => {
    if (!current()) return;
    if (client.isClosed) { dropClient(agentId); return; }
    let committed = false;
    try {
      // Production client checks notification activity immediately before commit.
      committed = client.retireIfIdle ? await client.retireIfIdle(commit) : await client.isIdle() && commit();
    } catch { /* Unknown status preserves the usable client. */ }
    if (committed) { closeRetired(client); return; }
    if (!current()) return;
    cancelCleanup(agentId);
    const timer = setTimeout(() => { cleanupTimers.delete(agentId); void check(); }, retryMs);
    timer.unref?.(); cleanupTimers.set(agentId, timer);
  };
  await check();
}

export function dropAllClients(): void {
  for (const id of [...pool.keys()]) dropClient(id);
  for (const client of [...retired.keys()]) closeRetired(client);
}
export function pooledAgents(): string[] { return [...pool.keys()]; }
export function retiredClientCount(): number { return retired.size; }
export type { CodexAppServerClient };

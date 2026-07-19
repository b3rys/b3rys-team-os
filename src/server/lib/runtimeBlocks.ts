export interface RuntimeBlock {
  agentId: string;
  line: string;
  recordedAtMs: number;
}

const RUNTIME_BLOCK_TTL_MS = Number(process.env.HEALTH_RUNTIME_FAILURE_TTL_MS ?? 6 * 60 * 60_000);
const RUNTIME_TIMEOUT_BLOCK_TTL_MS = Number(process.env.HEALTH_RUNTIME_TIMEOUT_TTL_MS ?? 10 * 60_000);
const blocks = new Map<string, RuntimeBlock>();

function ttlFor(line: string): number {
  return /openclaw response timeout/i.test(line) ? RUNTIME_TIMEOUT_BLOCK_TTL_MS : RUNTIME_BLOCK_TTL_MS;
}

export function recordRuntimeBlock(agentId: string, line: string, now = Date.now()): void {
  blocks.set(agentId, { agentId, line, recordedAtMs: now });
}

export function clearRuntimeBlock(agentId: string): void {
  blocks.delete(agentId);
}

export function getRuntimeBlock(agentId: string, now = Date.now()): RuntimeBlock | null {
  const block = blocks.get(agentId);
  if (!block) return null;
  if (now - block.recordedAtMs > ttlFor(block.line)) {
    blocks.delete(agentId);
    return null;
  }
  return block;
}

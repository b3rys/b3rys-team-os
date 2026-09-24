// 런타임 한도(quota) 소진 상태 — 팀원별로 기록해 대시보드 health 와 발신자 안내에 쓴다.
//
// 왜 따로 두나: 대시보드 health 는 멤버의 마지막 로그 줄(agent_status.last_log_line)만 본다.
// hermes·openclaw 멤버는 한도 소진 문구가 그 줄에 오지 않고 wake 실패 결과에만 남는다.
// 그래서 같은 계정의 한도가 바닥나도 codex 브리지 멤버만 '한도' 로 뜨고 나머지는 '응답 없음' 만기만 쌓였다.
//
// 기록 경로 두 가지:
//   · wake 실패 문구가 한도 소진이면(hermes 등) — isQuotaExhaustedDetail
//   · openclaw 가 응답 창 안에 답하지 않으면 — `openclaw models status` 의 "usage … % left" 줄을 한 번 본다.
//     cooldown 줄은 판정에 쓰지 않는다: 한도가 풀린 뒤에도 남는 경우가 있다. 0% 일 때만 한도로 본다.
// 해제: 그 멤버의 다음 wake 성공, 또는 유효 시각(reset_at) 경과.
import type { Database } from "bun:sqlite";

/**
 * 한도 소진을 뜻하는 문구만 좁게 본다.
 * 넓은 판정(runtimeSubscription.isSubscriptionNeededDetail)은 '429·rate limit·credit·billing·subscription'
 * 까지 잡는다. wake 실패 문구에 그대로 쓰면 일시적 429 나 문장 속 단어 하나로 한도가 뜬다.
 */
const QUOTA_EXHAUSTED_RE =
  /quota exhaust|insufficient_quota|usage[_ ]limit|used 100% of your|monthly spend limit|wait for limit to reset/i;

export function isQuotaExhaustedDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return QUOTA_EXHAUSTED_RE.test(detail);
}

/** 원인이 남지 않는 openclaw 무응답 만기 — 이때만 사용량을 조회한다. */
export function isOpenclawNoResponseDetail(detail: string | null | undefined): boolean {
  return Boolean(detail && /no_response_in_window/.test(detail));
}

/** 한도 기록이 스스로 풀리는 기본 시간. 리셋 시각을 모를 때 쓰고, 같은 실패가 다시 오면 연장된다. */
export const QUOTA_DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface OpenclawUsage {
  percentLeft: number;
  /** "1d 10h" 처럼 남은 시간 원문. 없으면 null. */
  resetIn: string | null;
  resetInMs: number | null;
}

/** "1d 10h", "34h", "12m", "2d" → ms. 알아볼 수 없으면 null. */
export function parseDurationMs(text: string | null | undefined): number | null {
  if (!text) return null;
  let total = 0;
  let matched = false;
  for (const m of text.matchAll(/(\d+)\s*([dhm])/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "d" ? n * 86_400_000 : m[2] === "h" ? n * 3_600_000 : n * 60_000;
  }
  return matched ? total : null;
}

/**
 * `openclaw models status` 텍스트에서 "openai usage: 168h 0% left ⏱1d 10h" 줄만 읽는다.
 * 원문은 계정 식별자를 담고 있어 이 함수 밖으로 내보내지 않는다 — 숫자 두 개만 돌려준다.
 */
export function parseOpenclawUsage(text: string): OpenclawUsage | null {
  const m = /usage:\s*\S+\s+(\d+)%\s*left(?:\s*⏱\s*([0-9dhm ]+))?/i.exec(text);
  if (!m) return null;
  const resetIn = m[2]?.trim() || null;
  return { percentLeft: Number(m[1]), resetIn, resetInMs: parseDurationMs(resetIn) };
}

export type UsageRunner = () => Promise<string | null>;

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CACHE_MS = 5 * 60 * 1000;
let probeCache: { at: number; value: OpenclawUsage | null } | null = null;
let probeInFlight: Promise<OpenclawUsage | null> | null = null;

async function defaultUsageRunner(): Promise<string | null> {
  const { resolveOpenclawBin } = await import("./openclawBridge");
  const proc = Bun.spawn([resolveOpenclawBin(), "models", "status"], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
  try {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * openclaw 사용량 조회. 5분 캐시 + 동시 호출 1개로 묶는다(만기가 몰려도 CLI 는 한 번).
 * 실패·시간초과·줄 없음은 모두 null — "한도 아님" 이 아니라 "모름" 이다.
 */
export async function probeOpenclawUsage(run: UsageRunner = defaultUsageRunner, now = Date.now()): Promise<OpenclawUsage | null> {
  if (probeCache && now - probeCache.at < PROBE_CACHE_MS) return probeCache.value;
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async () => {
    try {
      const text = await run();
      const value = text ? parseOpenclawUsage(text) : null;
      probeCache = { at: now, value };
      return value;
    } catch {
      return null;
    } finally {
      probeInFlight = null;
    }
  })();
  return probeInFlight;
}

export function resetOpenclawUsageCacheForTest(): void {
  probeCache = null;
  probeInFlight = null;
}

export interface QuotaBlock {
  agentId: string;
  source: "wake_error" | "openclaw_usage";
  since: number;
  resetAt: number;
  resetHint: string | null;
}

/** 새로 막혔으면 true(이미 막혀 있던 경우는 유효 시각만 갱신하고 false). */
export function markQuotaBlocked(
  db: Database,
  agentId: string,
  source: QuotaBlock["source"],
  opts: { resetInMs?: number | null; resetHint?: string | null; now?: number } = {},
): boolean {
  const now = opts.now ?? Date.now();
  const resetAt = now + (opts.resetInMs ?? QUOTA_DEFAULT_TTL_MS);
  const existing = getQuotaBlock(db, agentId, now);
  db.prepare(
    `INSERT INTO agent_quota_block (agent_id, source, since_ms, reset_at_ms, reset_hint)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       source = excluded.source,
       reset_at_ms = excluded.reset_at_ms,
       reset_hint = excluded.reset_hint,
       since_ms = CASE WHEN agent_quota_block.reset_at_ms <= ? THEN excluded.since_ms ELSE agent_quota_block.since_ms END`,
  ).run(agentId, source, now, resetAt, opts.resetHint ?? null, now);
  return existing == null;
}

/** 해제했으면 true. */
export function clearQuotaBlocked(db: Database, agentId: string): boolean {
  return db.prepare(`DELETE FROM agent_quota_block WHERE agent_id = ?`).run(agentId).changes > 0;
}

type Row = { agent_id: string; source: QuotaBlock["source"]; since_ms: number; reset_at_ms: number; reset_hint: string | null };
const toBlock = (r: Row): QuotaBlock => ({
  agentId: r.agent_id,
  source: r.source,
  since: r.since_ms,
  resetAt: r.reset_at_ms,
  resetHint: r.reset_hint,
});

export function getQuotaBlock(db: Database, agentId: string, now = Date.now()): QuotaBlock | null {
  const r = db.prepare(
    `SELECT agent_id, source, since_ms, reset_at_ms, reset_hint FROM agent_quota_block WHERE agent_id = ? AND reset_at_ms > ?`,
  ).get(agentId, now) as Row | undefined;
  return r ? toBlock(r) : null;
}

/** 지금 유효한 한도 기록 전부. 유효 시각이 지난 행은 보지 않는다(자동 해제). */
export function quotaBlockMap(db: Database, now = Date.now()): Map<string, QuotaBlock> {
  try {
    const rows = db.prepare(
      `SELECT agent_id, source, since_ms, reset_at_ms, reset_hint FROM agent_quota_block WHERE reset_at_ms > ?`,
    ).all(now) as Row[];
    return new Map(rows.map((r) => [r.agent_id, toBlock(r)]));
  } catch {
    return new Map(); // 표가 없는 옛 DB — 한도 정보 없이 기존 판정만
  }
}

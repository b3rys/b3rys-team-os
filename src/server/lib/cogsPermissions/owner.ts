/** Ownership snapshots are checks at a boundary, not locks on later actions. */
export interface CogsOwner {
  instance: string;
  botId: number;
  userId: number;
  generation: number;
}
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
export function validCogsOwner(v: unknown): v is CogsOwner {
  if (!v || typeof v !== "object") return false;
  const o = v as CogsOwner;
  return typeof o.instance === "string" && o.instance.length > 0
    && positive(o.botId) && positive(o.userId) && positive(o.generation);
}
export function decodeCogsOwner(value: string | null | undefined): CogsOwner | null {
  try { const v = JSON.parse(value ?? "null"); return validCogsOwner(v) ? v : null; } catch { return null; }
}
export function sameCogsOwner(a: unknown, b: unknown): boolean {
  return validCogsOwner(a) && validCogsOwner(b) && a.instance === b.instance
    && a.botId === b.botId && a.userId === b.userId && a.generation === b.generation;
}

export async function fetchCogsOwner(
  apiBase: string, token: string, expected?: CogsOwner | null,
  doFetch: typeof fetch = fetch,
): Promise<CogsOwner | null> {
  if (expected !== undefined && !validCogsOwner(expected)) return null;
  try {
    const base = new URL(apiBase);
    if (base.username || base.password || base.search || base.hash || !["http:", "https:"].includes(base.protocol)) return null;
    const instance = base.toString().replace(/\/$/, "");
    if (expected && expected.instance !== instance) return null;
    const response = await doFetch(`${instance}/bot${token}/getMe`, {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify(expected ? {expected_owner_generation: expected.generation} : {}),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = await response.json() as any;
    const owner = {instance, botId: body.result?.id, userId: body.result?.owner_user_id, generation: body.result?.owner_generation};
    if (body.ok !== true || !validCogsOwner(owner) || (expected && !sameCogsOwner(owner, expected))) return null;
    return owner;
  } catch { return null; }
}

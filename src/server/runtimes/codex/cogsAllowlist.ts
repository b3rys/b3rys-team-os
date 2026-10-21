import { readMemberChannel, type MemberChannel } from "../../lib/memberChannel";
/** Telegram keeps its launcher seed. cogs reads the registry before consuming
 * updates so new rooms work without restart; missing or replaced channels deny. */
export function currentCogsAllowlist(channel: MemberChannel, seed: Set<number>, agentId: string, registryPath?: string): Set<number> {
    if (channel.kind !== "b3chat")
        return seed;
    const current = readMemberChannel(agentId, registryPath);
    if (current.kind !== "b3chat" || current.error || current.apiBase !== channel.apiBase)
        return new Set();
    // Omitted lists retain the launcher fallback; an explicit [] revokes all rooms.
    if (current.allowFrom === null)
        return seed;
    return new Set(current.allowFrom.map(Number).filter(n => Number.isSafeInteger(n) && n > 0));
}

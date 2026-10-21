/** Authenticated room enrollment. The registry supplies the API origin and bot
 * identity; request data cannot choose an outbound URL or credentials. */
import { Hono, type Context } from "hono";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { linkGuard } from "../lib/b3chatLink";
import { parseMemberChannel } from "../lib/memberChannel";
import { withRegistryLock } from "../lib/registryLock";
import { writeRegistrySafely } from "../lib/registrySafety";
import { defaultRemoteAddress } from "./b3chatTeammate";
interface Binding {
    room_id: number;
    user_id: number;
    owner_user_id: number;
    agent_id: string;
}
interface Deps {
    registryPath: string;
    linkKeyPath?: string;
    remoteAddress?: (c: Context) => string | null;
    onRegistryChanged?: () => void;
    fetch?: typeof fetch;
}
function positive(v: unknown): v is number { return Number.isSafeInteger(v) && (v as number) > 0; }
export function createB3chatRoomLinkRoutes(d: Deps): Hono {
    const app = new Hono();
    const path = "/members/b3chat/member/:memberId/rooms";
    app.use(path, linkGuard({ keyPath: d.linkKeyPath ?? join(dirname(d.registryPath), "var/secrets/b3chat-link.key"), remote: d.remoteAddress ?? defaultRemoteAddress }));
    const read = (): any[] => { const data = JSON.parse(readFileSync(d.registryPath, "utf8")); if (!Array.isArray(data))
        throw Error("registry_unreadable"); return data; };
    app.post(path, async (c) => {
        const fail = (status: 400 | 403 | 404 | 503, code: string) => c.json({ ok: false, code }, status);
        const id = c.req.param("memberId");
        if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id))
            return fail(400, "bad_request");
        const b = await c.req.json<Binding>().catch(() => null);
        if (!b || !positive(b.room_id) || !positive(b.user_id) || !positive(b.owner_user_id) || b.agent_id !== id)
            return fail(400, "bad_request");
        try {
            const initial = read().find(a => a.id === id);
            if (!initial)
                return fail(404, "not_found");
            const channel = parseMemberChannel(initial.channel);
            if (channel.kind !== "b3chat" || channel.error || initial.enabled === false)
                return fail(403, "forbidden");
            const token = readFileSync(join(dirname(d.registryPath), "var/secrets", `${id}.bot-token`), "utf8").trim();
            if (!token || /\s/.test(token) || Number(token.split(":")[0]) !== b.user_id)
                return fail(403, "forbidden");
            const response = await (d.fetch ?? fetch)(`${channel.apiBase}/bot${encodeURIComponent(token)}/getRoomLink`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: b.room_id }), signal: AbortSignal.timeout(8000) });
            if (response.status === 403 || response.status === 401)
                return fail(403, "forbidden");
            if (!response.ok)
                return fail(503, "verification_unavailable");
            const proof = await response.json() as {
                ok?: boolean;
                result?: Binding;
            };
            if (proof.ok !== true || !proof.result || proof.result.room_id !== b.room_id || proof.result.user_id !== b.user_id || proof.result.owner_user_id !== b.owner_user_id || proof.result.agent_id !== id)
                return fail(403, "forbidden");
            const result = withRegistryLock(d.registryPath, () => {
                const list = read();
                const member = list.find(a => a.id === id);
                // An offboarding/channel replacement during verification invalidates proof.
                if (!member || member.enabled === false || parseMemberChannel(member.channel).kind !== "b3chat" || parseMemberChannel(member.channel).apiBase !== channel.apiBase || parseMemberChannel(member.channel).ownerChat !== channel.ownerChat)
                    return "changed";
                const current = parseMemberChannel(member.channel);
                const allow = current.allowFrom ?? [];
                if (!allow.includes(String(b.room_id))) {
                    member.channel = { ...member.channel, allow_from: [...allow, String(b.room_id)] };
                    writeRegistrySafely(d.registryPath, list);
                }
                return "linked";
            });
            if (result !== "linked")
                return fail(503, result === "busy" ? "busy" : "binding_changed");
            d.onRegistryChanged?.();
            return c.json({ ok: true, state: "linked" });
        }
        catch {
            return fail(503, "room_link_unavailable");
        }
    });
    return app;
}

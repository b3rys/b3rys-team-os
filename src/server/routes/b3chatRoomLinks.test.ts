import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createB3chatRoomLinkRoutes } from "./b3chatRoomLinks";
import { currentCogsAllowlist } from "../runtimes/codex/cogsAllowlist";
import { parseMemberChannel, DEFAULT_CHANNEL } from "../lib/memberChannel";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true }); });
const KEY = "test-only-room-link-key-0000000000000000";
const binding = { room_id: 22, user_id: 42, owner_user_id: 7, agent_id: "mate" };
function setup(remote = "127.0.0.1", proof: any = binding) {
    const dir = mkdtempSync(join(tmpdir(), "room-link-"));
    dirs.push(dir);
    const registryPath = join(dir, "agents.json");
    const original: any[] = [{ id: "mate", runtime: "codex", enabled: true, channel: { kind: "b3chat", api_base: "http://127.0.0.1:8740", allow_from: ["10"], owner_chat: "10", extra: "preserved" }, extra: "keep" }, { id: "other", display_name: "Other" }];
    const write = (list: any) => writeFileSync(registryPath, JSON.stringify(list));
    write(original);
    mkdirSync(join(dir, "var/secrets"), { recursive: true });
    writeFileSync(join(dir, "var/secrets/mate.bot-token"), "42:test-only-not-a-real-token");
    const keyPath = join(dir, "link.key");
    writeFileSync(keyPath, KEY);
    let calls = 0;
    let beforeProof: () => void = () => { };
    const app = createB3chatRoomLinkRoutes({ registryPath, resolveAllowFrom: () => "10", linkKeyPath: keyPath, remoteAddress: () => remote, fetch: (async (_url: any, init: any) => { calls++; beforeProof(); const result = proof === binding ? { ...binding, room_id: JSON.parse(init.body).chat_id } : proof; return Response.json({ ok: true, result }); }) as typeof fetch });
    const request = (body: any = binding, headers: Record<string, string> = { "x-b3chat-link": KEY }) => app.request("/members/b3chat/member/mate/rooms", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { request, registryPath, original, write, read: () => JSON.parse(readFileSync(registryPath, "utf8")), calls: () => calls, setBefore: (fn: () => void) => { beforeProof = fn; } };
}
test("link authentication rejects missing key, remote and forwarded requests without writing", async () => {
    for (const which of ["key", "remote", "proxy"]) {
        const s = setup(which === "remote" ? "10.0.0.1" : "127.0.0.1");
        const headers: Record<string, string> = which === "key" ? {} : which === "proxy" ? { "x-b3chat-link": KEY, "x-forwarded-for": "127.0.0.1" } : { "x-b3chat-link": KEY };
        expect((await s.request(binding, headers)).status).toBe(403);
        expect(s.calls()).toBe(0);
        expect(s.read()).toEqual(s.original);
    }
});
test("trusted membership and owner proof must match every binding field", async () => {
    for (const proof of [{ ...binding, owner_user_id: 8 }, { ...binding, user_id: 99 }, { ...binding, room_id: 99 }, { ...binding, agent_id: "other" }, null]) {
        const s = setup("127.0.0.1", proof);
        expect((await s.request()).status).toBe(403);
        expect(s.read()).toEqual(s.original);
    }
});
test("link is idempotent and preserves channel, policy and unrelated members", async () => {
    const s = setup();
    expect((await s.request()).status).toBe(200);
    expect((await s.request()).status).toBe(200);
    const expected = structuredClone(s.original);
    expected[0].channel!.allow_from.push("22");
    expect(s.read()).toEqual(expected);
});
test("concurrent registry edits during verification are preserved; channel replacement fails closed", async () => {
    const s = setup();
    s.setBefore(() => { const list = s.read(); list[1].display_name = "Changed"; s.write(list); });
    expect((await s.request()).status).toBe(200);
    expect(s.read()[1].display_name).toBe("Changed");
    s.setBefore(() => { const list = s.read(); list[0].channel.api_base = "http://127.0.0.1:9999"; s.write(list); });
    expect((await s.request({ ...binding, room_id: 23 })).status).toBe(503);
});
test("two concurrent room updates eventually retain both additions", async () => {
    const s = setup();
    const results = await Promise.all([s.request(), s.request({ ...binding, room_id: 23 })]);
    expect(results.map(r => r.status).every(n => n === 200 || n === 503)).toBe(true);
    expect((await s.request()).status).toBe(200);
    expect(s.read()[0].channel.allow_from).toEqual(["10", "22", "23"]);
});
test("running cogs bridge observes additions and revocations without restarting; Telegram seed unchanged", async () => {
    const s = setup();
    const channel = parseMemberChannel(s.original[0].channel);
    const seed = new Set([10]);
    expect(currentCogsAllowlist(channel, seed, "mate", s.registryPath).has(22)).toBe(false);
    expect((await s.request()).status).toBe(200);
    expect(currentCogsAllowlist(channel, seed, "mate", s.registryPath).has(22)).toBe(true);
    s.write([{ ...s.original[0], channel: { ...s.original[0].channel, allow_from: ["22"] } }]);
    expect(currentCogsAllowlist(channel, seed, "mate", s.registryPath).has(10)).toBe(false);
    s.write([]);
    expect(currentCogsAllowlist(channel, seed, "mate", s.registryPath).size).toBe(0);
    expect(currentCogsAllowlist(DEFAULT_CHANNEL, seed, "mate", s.registryPath)).toBe(seed);
});

test("omitted cogs allowlist preserves launcher seed, explicit empty list denies", () => {
    const s = setup();
    const member = structuredClone(s.original[0]);
    delete member.channel.allow_from;
    s.write([member]);
    const channel = parseMemberChannel(member.channel);
    const seed = new Set([10]);
    expect(currentCogsAllowlist(channel, seed, "mate", s.registryPath)).toBe(seed);
    member.channel.allow_from = [];
    s.write([member]);
    expect([...currentCogsAllowlist(channel, seed, "mate", s.registryPath)]).toEqual([]);
});

test("credential rotation during verification requires fresh proof before enrollment", async () => {
    for (const replacement of ["99:test-only-replacement", "42:test-only-rotated-same-bot"]) {
        const s = setup();
        const tokenPath = join(s.registryPath, "..", "var/secrets/mate.bot-token");
        s.setBefore(() => writeFileSync(tokenPath, replacement));
        const response = await s.request();
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: "binding_changed" });
        expect(s.read()).toEqual(s.original);
        // Even same-bot rotation must make a new verification request before storing.
        if (replacement.startsWith("42:")) {
            s.setBefore(() => {});
            expect((await s.request()).status).toBe(200);
            expect(s.calls()).toBe(2);
            expect(s.read()[0].channel.allow_from).toEqual(["10", "22"]);
        }
    }
});

// A member can keep using their DM after connecting the first group room.
test("first room link preserves omitted launcher seed without restoring revoked rooms", async () => {
    for (const policy of [undefined, [], ["11"]]) {
        const s = setup();
        const member = structuredClone(s.original[0]);
        if (policy === undefined) delete member.channel.allow_from;
        else member.channel.allow_from = policy;
        s.write([member]);
        const channel = parseMemberChannel(member.channel);
        const seed = new Set([10]);
        const before = policy === undefined ? [10] : policy.map(Number);
        expect([...currentCogsAllowlist(channel, seed, "mate", s.registryPath)]).toEqual(before);
        expect((await s.request()).status).toBe(200);
        expect(s.read()[0].channel.allow_from).toEqual([...before.map(String), "22"]);
        expect([...currentCogsAllowlist(channel, seed, "mate", s.registryPath)]).toEqual([...before, 22]);
        expect((await s.request()).status).toBe(200);
        expect(s.read()[0].channel.allow_from).toEqual([...before.map(String), "22"]);
    }
});

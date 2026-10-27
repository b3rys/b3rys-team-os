import { beforeEach, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { createCogsPoller } from "./cogsPoll";
import { cogsInbox } from "../lib/cogsRelay";
import { createInboxRoutes } from "../routes/inbox";
import { buildTmuxInjectionPrompt, type InjectPromptOptions } from "../lib/tmuxInject";
import { loadRegistry } from "../lib/registry";
import { findCogsMetaForThread } from "../db/inboxQueries";
import type { AgentRecord } from "../types";

let dir: string, db: Database, server: ReturnType<typeof Bun.serve>, agents: AgentRecord[];
let updates: any[], calls: { method: string; body: any }[], injected: InjectPromptOptions[];
let events: unknown[];
let sendMode: "normal" | "malformed" | "hold";
let releaseSend: (() => void) | undefined;
let fail: boolean, injectOk: boolean, stop: (() => void) | undefined;
let oldEnv: Record<string, string | undefined>;
const TOKEN = "fixture-cogs-secret-no-production-value";
const KEYS = ["TEAM_AGENT_REGISTRY", "B3OS_AUDIT_LOG_DIR", "TEAMOS_AGENT_OFF_FILE", "TEAM_COLLAB_ROOT"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cogs-relay-"));
  oldEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.TEAM_AGENT_REGISTRY = join(dir, "agents.json");
  process.env.B3OS_AUDIT_LOG_DIR = join(dir, "audit");
  process.env.TEAMOS_AGENT_OFF_FILE = join(dir, "off.txt");
  process.env.TEAM_COLLAB_ROOT = dir;
  writeFileSync(join(dir, "token"), TOKEN, { mode: 0o600 });
  updates = []; calls = []; injected = []; events = []; fail = false; injectOk = true; sendMode = "normal"; releaseSend = undefined;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const method = new URL(req.url).pathname.split("/").at(-1)!;
    const body = await req.json();
    calls.push({ method, body });
    // Match cogs botValues: only scalar JSON parameters are accepted.
    if (Object.values(body as object).some((v) => v !== null && typeof v === "object")) return Response.json({ ok: false }, { status: 400 });
    if (fail) return Response.json({ ok: false, description: `${TOKEN} ${req.url}` }, { status: 500 });
    if (method === "getUpdates") return Response.json({ ok: true, result: updates.filter((u) => u.update_id >= (body as any).offset) });
    if (sendMode === "malformed") return new Response("lost acknowledgement");
    if (sendMode === "hold") await new Promise<void>((resolve) => { releaseSend = resolve; });
    return Response.json({ ok: true, result: { message_id: 99 } });
  }});
  agents = [{ id: "lisa", display_name: "Lisa", runtime: "claude_channel", tmux_session: "claude-lisa",
    cogs_inbox: { api_base: `http://127.0.0.1:${server.port}`, token_file: join(dir, "token"), allow_from: ["71", "72", "90"], allow_senders: ["8"] },
  } as AgentRecord];
  writeFileSync(process.env.TEAM_AGENT_REGISTRY!, JSON.stringify(agents));
  db = new Database(join(dir, "team.db")); migrate(db);
  db.run(`INSERT INTO agent (id,display_name,role,runtime,status_provider,workspace_path,persona_file)
    VALUES ('lisa','Lisa','dev','claude_channel','claude_tmux','/tmp','p.md')`);
});
afterEach(() => {
  releaseSend?.();
  stop?.(); stop = undefined; server.stop(true); db.close();
  for (const key of KEYS) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
  rmSync(dir, { recursive: true, force: true });
});
function update(id = 10, chat = 71, text = "질문입니다") {
  return { update_id: id, message: { message_id: id + 100, chat: { id: chat, type: "private" }, from: { id: 8, first_name: "GD", is_bot: false }, text } };
}
function poller() {
  const p = createCogsPoller({ db, agents: () => agents, broadcast: (event) => { events.push(event); }, inject: async (opts) => { injected.push(opts); return { ok: injectOk }; } });
  stop = p.stop; return p;
}
function route() { return createInboxRoutes({ db, agents: () => agents, registeredAgentIds: () => new Set(["lisa"]), broadcast: (event) => { events.push(event); } }); }
async function reply(extra = {}) {
  const p = injected.at(-1)!;
  return route().request("/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    source: "agent", from_agent_id: "lisa", to_agent_id: "broadcast", body: "답변입니다", in_reply_to: p.messageId, thread_id: p.threadId, ...extra,
  }) });
}
function rowCount() { return (db.query("SELECT count(*) AS n FROM message").get() as { n: number }).n; }

// Real use: a lead's private cogs message enters the existing tmux session.
test("incoming message persists sender and room and injects kind cogs", async () => {
  updates = [update()]; const p = poller(); await p.pollOnce();
  expect(injected).toHaveLength(1);
  expect(injected[0]!).toMatchObject({ session: "claude-lisa", source: "cogs", kind: "cogs", fromLabel: "cogs:8" });
  expect(injected[0]!.body).toContain("chat_id=71, sender_id=8");
  expect(findCogsMetaForThread(db, injected[0]!.threadId)).toEqual({ agent_id: "lisa", chat_id: "71", message_id: 110, from: { id: "8", name: "GD" } });
  const prompt = buildTmuxInjectionPrompt(injected[0]!);
  expect(prompt).toContain('source="cogs" kind="cogs"'); expect(prompt).toContain("--to broadcast");
  const states = db.query("SELECT delivery_state AS state FROM message_recipient").all() as { state: string }[];
  expect(states.every((s) => s.state === "completed")).toBe(true); // dispatcher must not inject a second time
  await p.pollOnce(); expect(injected).toHaveLength(1); expect(rowCount()).toBe(1);
});
test("offset survives a poller restart", async () => {
  updates = [update()]; await poller().pollOnce(); stop?.(); await poller().pollOnce(); expect(injected).toHaveLength(1);
});
test("clean injection failure retries without another message row", async () => {
  updates = [update()]; const p = poller(); injectOk = false; await p.pollOnce();
  injectOk = true; await p.pollOnce(); expect(injected).toHaveLength(2); expect(rowCount()).toBe(1);
});
test("only allowed private human text reaches the session", async () => {
  delete (agents[0]!.cogs_inbox as { allow_senders?: unknown }).allow_senders; // 단체방 허용 사람 없음
  const bot = update(11); bot.message.from.is_bot = true;
  const group = update(12); group.message.chat.type = "group";
  updates = [update(10, 999), bot, group, update(13, 71, " ")];
  await poller().pollOnce(); expect(injected).toHaveLength(0); expect(rowCount()).toBe(0);
});
test("registry loads only the opt-in without changing primary channel loading", () => {
  agents[0]!.channel = { kind: "telegram" };
  writeFileSync(process.env.TEAM_AGENT_REGISTRY!, JSON.stringify(agents));
  expect(loadRegistry(process.env.TEAM_AGENT_REGISTRY!)[0]?.cogs_inbox).toEqual(agents[0]!.cogs_inbox);
});
test("absent opt-in, disabled member and intentional off make no API requests", async () => {
  const config = agents[0]!.cogs_inbox; delete agents[0]!.cogs_inbox; await poller().pollOnce();
  agents[0]!.cogs_inbox = config; agents[0]!.enabled = false; await poller().pollOnce();
  agents[0]!.enabled = true; writeFileSync(process.env.TEAMOS_AGENT_OFF_FILE!, "lisa\n"); await poller().pollOnce();
  expect(calls).toHaveLength(0);
});
test("b3chat bridge conflict is rejected before polling", async () => {
  agents[0]!.channel = { kind: "b3chat", api_base: agents[0]!.cogs_inbox!.api_base };
  expect(() => cogsInbox(agents[0]!)).toThrow("cogs_bridge_polling_conflict");
  // Registry loading deliberately leaves primary channel behavior unchanged.
  writeFileSync(process.env.TEAM_AGENT_REGISTRY!, JSON.stringify(agents));
  agents = loadRegistry(process.env.TEAM_AGENT_REGISTRY!);
  await poller().pollOnce(); expect(calls).toHaveLength(0);
});
test("duplicate bot is polled only once per cycle", async () => {
  agents.push({ ...agents[0]!, id: "other", tmux_session: "claude-other" });
  await poller().pollOnce(); expect(calls.filter((c) => c.method === "getUpdates")).toHaveLength(1);
});
test("invalid api address, empty allowlist and missing token fail closed", async () => {
  const config = agents[0]!.cogs_inbox!;
  config.api_base = "http://example.com"; await poller().pollOnce();
  config.api_base = `http://127.0.0.1:${server.port}`; config.allow_from = []; await poller().pollOnce();
  config.allow_from = [71]; config.token_file = join(dir, "absent"); await poller().pollOnce();
  expect(calls).toHaveLength(0);
});
// Real use: the explicit bus reply posts only to the original private cogs room.
test("outgoing reply selects the exact original room and waits for successful posting", async () => {
  updates = [update(10, 71), update(11, 72)]; await poller().pollOnce();
  const res = await reply(); expect(res.status).toBe(201); expect((await res.json()).posted).toBe(true);
  expect(calls.filter((c) => c.method === "sendMessage")).toEqual([{ method: "sendMessage", body: { chat_id: "72", text: "답변입니다", reply_to_message_id: 111 } }]);
});
test("reply's parent address overrides a different bus thread", async () => {
  updates = [update(10, 71), update(11, 72)]; await poller().pollOnce();
  expect((await reply({ in_reply_to: injected[0]!.messageId })).status).toBe(201);
  expect(calls.at(-1)?.body.chat_id).toBe("71");
});
test("posting failure returns 502 without a Telegram fallback", async () => {
  updates = [update()]; await poller().pollOnce(); fail = true;
  const res = await reply(); expect(res.status).toBe(502); expect((await res.json()).posted).toBe(false);
  expect(calls.at(-1)?.method).toBe("sendMessage");
});
test("direct_to_gd in a cogs thread fails before reaching Telegram", async () => {
  updates = [update()]; await poller().pollOnce();
  expect((await reply({ to_agent_id: "user", meta: { reply_mode: "direct_to_gd" } })).status).toBe(400);
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
});
test("another member cannot reply with their bot to this member's room", async () => {
  updates = [update()]; await poller().pollOnce();
  agents[0]!.id = "other"; expect((await reply()).status).toBe(502);
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
});
test("turning off cogs prevents replies instead of using Telegram", async () => {
  updates = [update()]; await poller().pollOnce(); delete agents[0]!.cogs_inbox;
  expect((await reply()).status).toBe(502);
});
// Real use: a remote server returns an error containing the bot URL; no local output may retain it.
test("token is absent from DB, response, events, injection and audit files, including remote failures", async () => {
  const logs: unknown[] = [];
  const previous = { log: console.log, warn: console.warn, error: console.error };
  let response = "";
  try {
    console.log = console.warn = console.error = (...args: unknown[]) => { logs.push(args); };
    updates = [update()]; await poller().pollOnce(); fail = true;
    const res = await reply(); response = await res.text(); await poller().pollOnce();
  } finally { Object.assign(console, previous); }
  expect(JSON.stringify(logs).includes(TOKEN)).toBe(false);
  for (const table of ["message", "audit_event", "setting"]) {
    const exists = db.query("SELECT name FROM sqlite_master WHERE name=?").get(table);
    expect(exists).not.toBeNull();
    expect(JSON.stringify(db.query(`SELECT * FROM ${table}`).all()).includes(TOKEN)).toBe(false);
  }
  expect(JSON.stringify(events).includes(TOKEN)).toBe(false);
  expect(response.includes(TOKEN)).toBe(false); expect(JSON.stringify(injected).includes(TOKEN)).toBe(false);
  const scan = (path: string): string => readdirSync(path, { withFileTypes: true }).map((e) => e.isDirectory() ? scan(join(path, e.name)) : readFileSync(join(path, e.name), "utf8")).join("");
  expect(scan(join(dir, "audit")).includes(TOKEN)).toBe(false);
});
test("stopping the poller cancels future requests", async () => {
  const p = poller(); p.stop(); await p.pollOnce(); expect(calls).toHaveLength(0);
});
for (const ok of [true, false]) {
  test(`send.sh ${ok ? "confirms cogs posting" : "exits nonzero on cogs failure"}`, async () => {
    updates = [update()]; await poller().pollOnce(); fail = !ok;
    const routes = route();
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => routes.fetch(new Request(req.url.replace("/api/inbox", "/inbox"), req)) });
    try {
      const p = Bun.spawn(["bash", "skills/b3os-team-inbox/scripts/send.sh", "--to", "broadcast", "--thread", injected[0]!.threadId,
        "--in-reply-to", injected[0]!.messageId, "--body", "CLI answer", "--confirm", "1"], {
        cwd: join(import.meta.dir, "../../.."), env: { ...process.env, TEAM_DB_PATH: join(dir, "team.db"), GD_AGENT_ID: "lisa", TEAM_BASE: `http://127.0.0.1:${api.port}` }, stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(code, `${out}\n${err}`).toBe(ok ? 0 : 1);
      expect((out + err).includes(TOKEN)).toBe(false);
      if (ok) { expect(err).toContain("cogs 게시 완료"); expect(err).not.toContain("멘션이 없습니다"); }
      else expect(err).toContain("cogs_relay_failed");
      expect(calls.at(-1)?.body.chat_id).toBe("71");
    } finally { api.stop(true); }
  });
}

test("cogs replies cannot fan out as an all-hands team broadcast", async () => {
  updates = [update()]; await poller().pollOnce();
  expect((await reply({ all_hands: "whole team" })).status).toBe(400);
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
});

test("identical answers to different private rooms both post", async () => {
  updates = [update(10, 71), update(11, 72)]; await poller().pollOnce();
  expect((await reply({ in_reply_to: injected[0]!.messageId, thread_id: injected[0]!.threadId })).status).toBe(201);
  expect((await reply({ in_reply_to: injected[1]!.messageId, thread_id: injected[1]!.threadId })).status).toBe(201);
  expect(calls.filter((c) => c.method === "sendMessage").map((c) => c.body.chat_id)).toEqual(["71", "72"]);
});
test("an explicit failed post retries immediately after service recovery", async () => {
  updates = [update()]; await poller().pollOnce(); fail = true;
  const first = await reply(); expect(first.status).toBe(502);
  const failed = await first.json(); expect(failed.message.meta.cogs_delivery.state).toBe("failed");
  fail = false;
  const retry = await reply(); expect(retry.status).toBe(201);
  expect((await retry.json()).message.meta.cogs_delivery.state).toBe("sent");
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(2);
});
test("identical answers to distinct original messages in the same room both post", async () => {
  updates = [update(10, 71), update(11, 71)]; await poller().pollOnce();
  expect((await reply({ in_reply_to: injected[0]!.messageId })).status).toBe(201);
  expect((await reply({ in_reply_to: injected[1]!.messageId })).status).toBe(201);
  expect(calls.filter((c) => c.method === "sendMessage").map((c) => c.body.reply_to_message_id)).toEqual([110, 111]);
});
test("a confirmed reply is not posted twice even with a different caller dedupe key", async () => {
  updates = [update()]; await poller().pollOnce();
  expect((await reply()).status).toBe(201);
  expect((await reply({ dedupe_key: "bypass-attempt" })).status).toBe(409);
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
});
test("a lost acknowledgement blocks identical retries beyond the 60-second window", async () => {
  updates = [update()]; await poller().pollOnce(); sendMode = "malformed";
  const first = await reply(); expect(first.status).toBe(502);
  const body = await first.json(); expect(body.error).toBe("cogs_delivery_unknown");
  expect(body.message.meta.cogs_delivery.state).toBe("unknown");
  db.query("UPDATE message SET created_at = datetime('now', '-120 seconds') WHERE id = ?").run(body.message.id);
  sendMode = "normal";
  const retry = await reply(); expect(retry.status).toBe(409);
  expect((await retry.json()).error).toBe("cogs_delivery_unknown");
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
});
test("a concurrent retry is blocked while the first post awaits its acknowledgement", async () => {
  updates = [update()]; await poller().pollOnce(); sendMode = "hold";
  const first = reply();
  for (let i = 0; i < 100 && !releaseSend; i++) await Bun.sleep(5);
  try {
    expect(releaseSend).toBeDefined();
    const second = await reply(); expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("cogs_delivery_pending");
  } finally { releaseSend?.(); }
  expect((await first).status).toBe(201);
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
});

// Real use: the lead talks to Lisa in a cogs group room (the Telegram team room replacement).
function groupUpdate(id: number, chat = 90, sender = 8, text = "리사, 정리해줘", replyTo?: string) {
  return { update_id: id, message: { message_id: id + 100, chat: { id: chat, type: "group" }, from: { id: sender, first_name: sender === 8 ? "GD" : "Guest", is_bot: false }, text,
    ...(replyTo ? { reply_to_message: { message_id: 5, from: { id: 3, first_name: replyTo, is_bot: true } } } : {}) } };
}
test("group: the lead's message in an allowed group room is injected, marked as group", async () => {
  updates = [groupUpdate(20, 90, 8, "리사, 정리해줘", "Jane")]; await poller().pollOnce();
  expect(injected).toHaveLength(1);
  expect(injected[0]!.body).toContain("[cogs group chat_id=90, sender_id=8, reply_to=Jane]");
  expect(findCogsMetaForThread(db, injected[0]!.threadId)).toMatchObject({ chat_id: "90", message_id: 120, chat_type: "group" });
});
test("group: other people, unlisted rooms, AI DM rooms and bots are not injected", async () => {
  const bot = groupUpdate(23); bot.message.from.is_bot = true;
  const aidm = groupUpdate(24); (aidm.message.chat as { type: string }).type = "ai_dm";
  updates = [groupUpdate(21, 90, 99), groupUpdate(22, 999, 8), bot, aidm];
  await poller().pollOnce(); expect(injected).toHaveLength(0); expect(rowCount()).toBe(0);
});
test("group: without allow_senders the group is not accepted (private still works)", async () => {
  delete (agents[0]!.cogs_inbox as { allow_senders?: unknown }).allow_senders;
  updates = [groupUpdate(25), update(26, 71)]; await poller().pollOnce();
  expect(injected.map((i) => i.body.split("]")[0])).toEqual(["[cogs chat_id=71, sender_id=8"]);
});
test("group: invalid allow_senders fails closed", async () => {
  (agents[0]!.cogs_inbox as { allow_senders?: unknown }).allow_senders = ["GD"];
  updates = [groupUpdate(27), update(28, 71)]; await poller().pollOnce();
  expect(calls).toHaveLength(0);
});
test("group: a reply must name the group original; then it posts to that room and message", async () => {
  updates = [groupUpdate(30), groupUpdate(31, 90, 8, "두 번째")]; await poller().pollOnce();
  expect((await reply({ in_reply_to: undefined, thread_id: injected[0]!.threadId })).status).toBe(400);
  const ok = await reply({ in_reply_to: injected[1]!.messageId, thread_id: injected[1]!.threadId });
  expect(ok.status).toBe(201);
  expect(calls.filter((c) => c.method === "sendMessage").map((c) => [c.body.chat_id, c.body.reply_to_message_id])).toEqual([["90", 131]]);
});
test("group: an in_reply_to from another room's thread is refused", async () => {
  updates = [groupUpdate(32), update(33, 71)]; await poller().pollOnce();
  const groupInj = injected.find((i) => i.body.includes("group"))!;
  const privInj = injected.find((i) => !i.body.includes("group"))!;
  expect((await reply({ thread_id: groupInj.threadId, in_reply_to: privInj.messageId })).status).toBe(400);
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
});
test("group: a message without from.id is refused; private is unaffected by allow_senders", async () => {
  const noFrom = groupUpdate(40); delete (noFrom.message as { from?: unknown }).from;
  (agents[0]!.cogs_inbox as { allow_senders?: unknown }).allow_senders = [];
  updates = [noFrom, groupUpdate(41), update(42, 71)]; await poller().pollOnce();
  expect(injected.map((i) => i.body.split("]")[0])).toEqual(["[cogs chat_id=71, sender_id=8"]);
});
test("group: another member cannot answer this member's group original", async () => {
  updates = [groupUpdate(43)]; await poller().pollOnce();
  agents.push({ ...agents[0]!, id: "other", tmux_session: "claude-other" });
  const both = createInboxRoutes({ db, agents: () => agents, registeredAgentIds: () => new Set(["lisa", "other"]), broadcast: (event) => { events.push(event); } });
  const res = await both.request("/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    source: "agent", from_agent_id: "other", to_agent_id: "broadcast", body: "남의 방", in_reply_to: injected[0]!.messageId, thread_id: injected[0]!.threadId }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("cogs_reply_needs_in_reply_to");
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
});
test("group: a Slack original from another thread cannot redirect a group-thread reply", async () => {
  updates = [groupUpdate(44)]; await poller().pollOnce();
  db.run(`INSERT INTO thread (id, title, kind, participants_json, opened_by, last_message_at) VALUES ('slack-t','s','dm','[]','user',datetime('now'))`);
  db.run(`INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, meta_json) VALUES ('slackmsg','slack-t','user','lisa','dm','슬랙','user','{"slack":{"channel":"CFAKE","thread_ts":"1.1"}}')`);
  const res = await reply({ thread_id: injected[0]!.threadId, in_reply_to: "slackmsg" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("cogs_reply_needs_in_reply_to");
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
});
for (const [label, extra] of [
  ["direct_to_gd", { to_agent_id: "user", meta: { reply_mode: "direct_to_gd" } }],
  ["to user", { to_agent_id: "user" }],
  ["all-hands", { all_hands: "whole team" }],
] as const) {
  for (const kind of ["group", "private"] as const) {
    test(`${kind}: a Slack original from another thread cannot turn a cogs-thread answer into ${label}`, async () => {
      updates = [kind === "group" ? groupUpdate(50) : update(50, 71)]; await poller().pollOnce();
      db.run(`INSERT OR IGNORE INTO thread (id, title, kind, participants_json, opened_by, last_message_at) VALUES ('slack-t2','s','dm','[]','user',datetime('now'))`);
      db.run(`INSERT OR IGNORE INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, meta_json) VALUES ('slackmsg2','slack-t2','user','lisa','dm','슬랙','user','{"slack":{"channel":"CFAKE","thread_ts":"1.1"}}')`);
      const res = await reply({ thread_id: injected[0]!.threadId, in_reply_to: "slackmsg2", ...extra });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("cogs_reply_mode_invalid");
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    });
  }
}
// cogs drops the oldest updates when a bot queue overflows and reports the range once as cogs_gap.
test("overflow gap is recorded once with its range and the next message still arrives", async () => {
  updates = [{ update_id: 100, cogs_gap: { from_update_id: 1, to_update_id: 100, reason: "overflow" } }, update(101)];
  const p = poller(); await p.pollOnce(); await p.pollOnce();
  const rows = db.query("SELECT detail_json AS d FROM audit_event WHERE action='cogs_updates_lost'").all() as { d: string }[];
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]!.d)).toEqual({ agent_id: "lisa", from_update_id: 1, to_update_id: 100, lost: 100, reason: "overflow" });
  expect(injected).toHaveLength(1); expect(rowCount()).toBe(1);
});
test("malformed gap values are ignored without an audit row", async () => {
  updates = [{ update_id: 5, cogs_gap: { from_update_id: 9, to_update_id: 3 } }, { update_id: 6, cogs_gap: "x" }];
  await poller().pollOnce();
  expect(db.query("SELECT count(*) AS n FROM audit_event WHERE action='cogs_updates_lost'").get()).toEqual({ n: 0 });
});
test("a remote gap reason is never stored or logged as given", async () => {
  const warned: string[] = []; const warn = console.warn; console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    updates = [{ update_id: 7, cogs_gap: { from_update_id: 1, to_update_id: 7, reason: `${TOKEN} 비밀 본문` } }];
    await poller().pollOnce();
  } finally { console.warn = warn; }
  const row = db.query("SELECT detail_json AS d FROM audit_event WHERE action='cogs_updates_lost'").get() as { d: string };
  expect(JSON.parse(row.d).reason).toBe("unknown");
  expect(row.d.includes(TOKEN)).toBe(false); expect(warned.join("\n").includes(TOKEN)).toBe(false);
});

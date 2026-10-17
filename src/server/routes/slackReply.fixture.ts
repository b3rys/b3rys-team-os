import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { acceptInbound } from "../db/inboxQueries";
import { createInboxRoutes } from "./inbox";
import { channelRegistry } from "../channels/registry";
import type { SendRequest, SendResult } from "../channels/types";

let db: Database;
let dir: string;
let sent: SendRequest[];
let result: SendResult;
let throws: boolean;
let release: (() => void) | undefined;
const originalSlack = channelRegistry.get("slack")!;
const originalTelegram = channelRegistry.get("telegram")!;
let oldTokens: string | undefined;
let oldAudit: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slack-reply-"));
  oldAudit = process.env.B3OS_AUDIT_LOG_DIR;
  process.env.B3OS_AUDIT_LOG_DIR = join(dir, "audit");
  oldTokens = process.env.SLACK_TOKENS_DIR;
  process.env.SLACK_TOKENS_DIR = dir;
  writeFileSync(join(dir, "bill.env"), "SLACK_BOT_TOKEN=mock-only\n");
  db = new Database(join(dir, "team.db"));
  migrate(db);
  db.run(`INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
    VALUES ('bill','Bill','dev','claude_channel','claude_tmux','/tmp','p.md')`);
  sent = [];
  throws = false;
  release = undefined;
  result = { ok: true, ts: "123.456" };
  channelRegistry.set("slack", { ...originalSlack, async send(req) {
    sent.push(req);
    if (throws) throw new Error("mock_network_failure");
    return result;
  }});
  channelRegistry.set("telegram", { ...originalTelegram, async send() {
    throw new Error("Slack replies must not reach Telegram");
  }});
});
afterEach(() => {
  release?.();
  channelRegistry.set("slack", originalSlack);
  channelRegistry.set("telegram", originalTelegram);
  if (oldTokens === undefined) delete process.env.SLACK_TOKENS_DIR;
  else process.env.SLACK_TOKENS_DIR = oldTokens;
  if (oldAudit === undefined) delete process.env.B3OS_AUDIT_LOG_DIR;
  else process.env.B3OS_AUDIT_LOG_DIR = oldAudit;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function parent(thread = "origin", channel = "C_ORIGIN", ts = "111.222") {
  const r = acceptInbound(db, { from_agent_id: "user", to_agent_id: "bill", source: "user",
    type: "dm", hop_count: 0, priority: "normal", body: `question ${thread}`, thread_id: thread,
    meta: { slack: { channel, thread_ts: ts, slack_user_id: "U456" } } }, { dedupeWindowSec: 60 });
  if (!r.ok) throw new Error("seed duplicate");
  return r.stored.id;
}
function app() {
  return createInboxRoutes({ db, broadcast: () => {}, registeredAgentIds: () => new Set(["bill"]),
    agents: () => [{ id: "bill", display_name: "Bill" } as never] });
}
function reply(id: string, extra = {}) {
  return { from_agent_id: "bill", to_agent_id: "broadcast", source: "agent", type: "dm",
    body: "answer", in_reply_to: id, ...extra };
}
function post(body: unknown) {
  return Promise.resolve(app().request("/inbox", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) }));
}

test("Slack reply waits for posting and persists the returned ts", async () => {
  const res = await post(reply(parent(), { meta: { slack_mentions: ["U123"] } }));
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.posted).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ target: "C_ORIGIN", threadRef: "111.222", text: "<@U456> <@U123>\nanswer" });
  expect(body.message.meta.slack_ts).toBe("123.456");
  const row = db.query("SELECT meta_json FROM message WHERE id=?").get(body.message.id) as { meta_json: string };
  expect(JSON.parse(row.meta_json)).toMatchObject({ slack_ts: "123.456", slack_mentions: ["U123"] });
});

test("in_reply_to Slack destination takes precedence over a different bus thread", async () => {
  const id = parent();
  parent("other", "C_OTHER", "999.000");
  expect((await post(reply(id, { thread_id: "other" }))).status).toBe(201);
  expect(sent[0]).toMatchObject({ target: "C_ORIGIN", threadRef: "111.222" });
});

test("automatic author mention works without --mention", async () => {
  const res = await post(reply(parent()));
  expect(res.status).toBe(201);
  expect(sent[0]?.text).toBe("<@U456>\nanswer");
  const body = await res.json();
  expect(body.message.body).toBe("answer");
});

for (const alreadyInBody of [false, true]) {
  test(`automatic mention is deduplicated (body=${alreadyInBody})`, async () => {
    await post(reply(parent(), { body: alreadyInBody ? "<@U456> answer" : "answer",
      meta: { slack_mentions: ["U456", "U456"] } }));
    expect(sent[0]?.text.match(/<@U456>/g)).toHaveLength(1);
  });
}

test("only the referenced Slack author is mentioned in mixed Slack threads", async () => {
  parent();
  const id = parent("other", "C_OTHER", "999.000");
  const row = db.query("SELECT meta_json FROM message WHERE id=?").get(id) as { meta_json: string };
  const meta = JSON.parse(row.meta_json);
  meta.slack.slack_user_id = "U789";
  db.run("UPDATE message SET meta_json=? WHERE id=?", [JSON.stringify(meta), id]);
  await post(reply(id, { thread_id: "origin" }));
  expect(sent[0]).toMatchObject({ target: "C_OTHER", threadRef: "999.000", text: "<@U789>\nanswer" });
});

test("reply chains retain the original Slack thread", async () => {
  const first = await (await post(reply(parent()))).json();
  const second = await post(reply(first.message.id, { body: "followup" }));
  expect(second.status).toBe(201);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ target: "C_ORIGIN", threadRef: "111.222" });
});

test("posting completion is required before HTTP success", async () => {
  const id = parent();
  let done = false;
  channelRegistry.set("slack", { ...originalSlack, async send() {
    await new Promise<void>((resolve) => { release = resolve; });
    return result;
  }});
  const pending = post(reply(id)).then((r) => { done = true; return r; });
  for (let i = 0; i < 100 && !release; i++) await Bun.sleep(1);
  expect(release).toBeDefined();
  expect(done).toBe(false);
  release!();
  expect((await pending).status).toBe(201);
});

for (const mode of ["api_error", "missing_creds", "exception", "missing_ts"] as const) {
  test(`Slack ${mode} returns failure with a reason`, async () => {
    if (mode === "api_error") result = { ok: false, error: "channel_not_found" };
    if (mode === "missing_creds") rmSync(join(dir, "bill.env"));
    if (mode === "exception") throws = true;
    if (mode === "missing_ts") result = { ok: true };
    const res = await post(reply(parent()));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.posted).toBe(false);
    expect(body.error).toBe("slack_relay_failed");
    expect(body.detail).toBeTruthy();
    const row = db.query("SELECT detail_json FROM audit_event WHERE action='slack_relay_failed'").get() as { detail_json: string };
    expect(JSON.parse(row.detail_json).error).toBeTruthy();
  });
}

for (const ok of [true, false]) {
  test(`send.sh ${ok ? "succeeds after posting" : "fails when posting fails"}`, async () => {
    const id = parent();
    if (!ok) result = { ok: false, error: "channel_not_found" };
    const routes = app();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => routes.fetch(new Request(req.url.replace("/api/inbox", "/inbox"), req)) });
    try {
      const p = Bun.spawn(["bash", "skills/b3os-team-inbox/scripts/send.sh", "--to", "broadcast",
        "--in-reply-to", id, "--body", "CLI answer", "--confirm", "1"], {
        cwd: join(import.meta.dir, "../../.."),
        env: { ...process.env, TEAM_DB_PATH: join(dir, "team.db"), GD_AGENT_ID: "bill",
          TEAM_BASE: `http://127.0.0.1:${server.port}`, SLACK_MEMBERS_FILE: join(dir, "none") },
        stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(code, `${out}\n${err}`).toBe(ok ? 0 : 1);
      expect(sent).toHaveLength(1);
      if (!ok) expect(err).toContain("channel_not_found");
      else {
        expect(err).toContain("Slack 게시 완료");
        expect(err).not.toContain("멘션이 없습니다");
        expect(err).not.toContain("수신자가 붙지 않았습니다");
      }
    } finally { server.stop(true); }
  });
}


test("explicit direct_to_gd report keeps its DM destination", async () => {
  db.run("INSERT INTO setting (key, value) VALUES ('owner_chat_id', 'mock-owner-dm')");
  const telegram: SendRequest[] = [];
  channelRegistry.set("telegram", { ...originalTelegram, async send(req) {
    telegram.push(req);
    return { ok: true };
  }});
  const res = await post(reply(parent(), { meta: { reply_mode: "direct_to_gd" } }));
  expect(res.status).toBe(201);
  expect(sent).toHaveLength(0);
  expect(telegram).toHaveLength(1);
  expect(telegram[0]?.target).toBe("mock-owner-dm");
});


test("private bus reply referencing Slack is not publicly posted", async () => {
  const res = await post(reply(parent(), { to_agent_id: "user", thread_id: "private-bus" }));
  expect(res.status).toBe(201);
  expect(sent).toHaveLength(0);
});

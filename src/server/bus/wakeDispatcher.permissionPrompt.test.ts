/**
 * 권한 창이 열려 있어 injectPrompt 가 아무것도 넣지 않았을 때(reason permission_prompt) 버스 wake 가 글을 잃지 않는지 본다.
 * 어댑터는 진짜 makeCludeAdapter 이고 tmux 주입만 가짜로 갈아 끼운다.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { insertMessage } from "../db/inboxQueries";
import { dispatchRow, makeCludeAdapter, PERMISSION_PROMPT_DEFER_MAX } from "./wakeDispatcher";
import type { PendingDispatchRow, WakeAdapter } from "./types";
import type { InjectPromptOptions, InjectResult } from "../lib/tmuxInject";

const PREV = { en: process.env.BUS_DISPATCH_ENABLED, ag: process.env.BUS_DISPATCH_AGENTS, ex: process.env.TEAMOS_BUS_WAKE_EXTRA_FILE, au: process.env.B3OS_AUDIT_LOG_DIR };
const auditDir = mkdtempSync(join(tmpdir(), "wake-pp-audit-"));
process.env.TEAMOS_BUS_WAKE_EXTRA_FILE = "/tmp/.teamos-bus-wake-extra-pp-noexist";
process.env.B3OS_AUDIT_LOG_DIR = auditDir;
afterAll(() => {
  for (const [k, v] of [["BUS_DISPATCH_ENABLED", PREV.en], ["BUS_DISPATCH_AGENTS", PREV.ag], ["TEAMOS_BUS_WAKE_EXTRA_FILE", PREV.ex], ["B3OS_AUDIT_LOG_DIR", PREV.au]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(auditDir, { recursive: true, force: true });
});

const noop: WakeAdapter = { async wake() { return { ok: false, detail: "noop_should_not_be_called" }; } };
let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.exec(`
    INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file) VALUES
      ('bill','Bill','dev','claude_channel','claude_tmux','/dev/null','/dev/null'),
      ('steve','Steve','dev','claude_channel','claude_tmux','/dev/null','/dev/null');
    UPDATE agent SET tmux_session='claude-bill' WHERE id='bill';
    INSERT INTO thread (id,title,kind,participants_json,opened_by) VALUES ('t1','t','dm','["steve","bill"]','steve');
  `);
  process.env.BUS_DISPATCH_ENABLED = "true";
  delete process.env.BUS_DISPATCH_AGENTS;
});

const agentsOf = () => db.prepare(`SELECT id, display_name, role, runtime, status_provider, tmux_session, telegram_bot_username, workspace_path, persona_file FROM agent`).all() as never[];
function pendingRow(): PendingDispatchRow {
  const env = insertMessage(db, { thread_id: "t1", from_agent_id: "steve", to_agent_id: "bill", body: "ping", source: "agent", type: "dm" } as never);
  return db.prepare(
    `SELECT mr.message_id, mr.agent_id, mr.delivery_state, mr.retry_count, mr.last_error, m.from_agent_id, m.to_agent_id, m.body, m.source,
            COALESCE(m.created_by,m.from_agent_id) AS created_by, COALESCE(m.max_hop,5) AS max_hop, m.hop_count, m.in_reply_to, m.parent_message_id,
            COALESCE(m.sync,'none') AS sync, m.thread_id, m.type, m.created_at, COALESCE(m.priority,'normal') AS priority, m.meta_json
     FROM message_recipient mr JOIN message m ON m.id=mr.message_id WHERE mr.message_id=? AND mr.agent_id='bill'`,
  ).get(env.id) as PendingDispatchRow;
}
const rcpt = (id: string) => db.prepare(`SELECT delivery_state, retry_count, deferred_count, last_error, prompt_hold_count FROM message_recipient WHERE message_id=? AND agent_id='bill'`).get(id) as
  { delivery_state: string; retry_count: number; deferred_count: number; last_error: string | null };
const auditActions = () => readdirSync(auditDir).flatMap((f) => readFileSync(join(auditDir, f), "utf8").trim().split("\n")).map((l) => JSON.parse(l).action as string);

function world(result: () => InjectResult) {
  const w = { pasted: 0, attempts: 0 };
  const adapter = makeCludeAdapter(db, {
    sessionExists: async () => true,
    inject: (async (_o: InjectPromptOptions) => { w.attempts++; const r = result(); if (r.ok) w.pasted++; return r; }) as never,
  });
  return { w, adapter };
}
const dispatch = (row: PendingDispatchRow, adapter: WakeAdapter) => dispatchRow(db, row, agentsOf(), adapter, noop, noop, noop, noop, null);

describe("bus wake — 권한 창이 열려 있을 때", () => {
  test("prompt open: nothing pasted, stays pending and retry_count is not consumed — even past the normal retry/defer budgets", async () => {
    const row = pendingRow();
    const { w, adapter } = world(() => ({ ok: false, reason: "permission_prompt" }));
    for (let i = 0; i < 25; i++) await dispatch(row, adapter); // 일반 재시도 3회·기본 defer 상한 20회를 넘는다
    expect(w.pasted).toBe(0);
    expect(rcpt(row.message_id)).toMatchObject({ delivery_state: "pending", retry_count: 0, deferred_count: 0, prompt_hold_count: 25 });
    expect(auditActions()).toContain("tmux_inject_deferred_permission_prompt");
  });
  test("prompt closes later: delivered exactly once", async () => {
    const row = pendingRow();
    let open = true;
    const { w, adapter } = world(() => (open ? { ok: false, reason: "permission_prompt" } : { ok: true }));
    for (let i = 0; i < 5; i++) await dispatch(row, adapter);
    expect(w.pasted).toBe(0);
    open = false;
    await dispatch(row, adapter);
    expect(w.pasted).toBe(1);
    expect(rcpt(row.message_id)).toMatchObject({ delivery_state: "wake_dispatched", retry_count: 0 });
  });
  test("a prompt that stays open past the fast-check count is kept pending (not dropped), still without retry_count", async () => {
    const row = pendingRow();
    const { adapter } = world(() => ({ ok: false, reason: "permission_prompt" }));
    for (let i = 0; i < PERMISSION_PROMPT_DEFER_MAX + 5; i++) await dispatch(row, adapter);
    expect(rcpt(row.message_id)).toMatchObject({ delivery_state: "pending", retry_count: 0, deferred_count: 0, prompt_hold_count: PERMISSION_PROMPT_DEFER_MAX + 5 });
  });
  test("capture_failed is deferred the same way", async () => {
    const row = pendingRow();
    const { adapter } = world(() => ({ ok: false, reason: "capture_failed" }));
    await dispatch(row, adapter);
    expect(rcpt(row.message_id)).toMatchObject({ delivery_state: "pending", retry_count: 0, deferred_count: 0, prompt_hold_count: 1 });
    expect(auditActions()).toContain("tmux_inject_deferred_capture_failed");
  });
  test("a long prompt hold does not spend the lock-busy budget: one lock-busy afterwards keeps the message pending", async () => {
    const row = pendingRow();
    const { adapter } = world(() => ({ ok: false, reason: "permission_prompt" }));
    for (let i = 0; i < 40; i++) await dispatch(row, adapter);
    db.run("INSERT INTO runtime_lock (key,holder_agent_id,acquired_at,expires_at) VALUES ('bus_claude_wake','bus:other',datetime('now'),datetime('now','+35 seconds'))");
    await dispatch(row, adapter);
    expect(rcpt(row.message_id)).toMatchObject({ delivery_state: "pending", deferred_count: 1, prompt_hold_count: 40 });
  });
  test("a held message older than 24h is closed before injection even if the prompt has just closed, and the sender is told once", async () => {
    const row = pendingRow();
    const { adapter } = world(() => ({ ok: false, reason: "permission_prompt" }));
    await dispatch(row, adapter);
    const old = { ...row, created_at: new Date(Date.now() - 25 * 3600000).toISOString() };
    const closed = world(() => ({ ok: true }));
    await dispatch(old, closed.adapter);
    expect(closed.w.attempts).toBe(0);
    expect(rcpt(row.message_id)).toMatchObject({ delivery_state: "blocked", last_error: "prompt_hold_expired" });
    const n = db.prepare("SELECT COUNT(*) AS n FROM message WHERE to_agent_id='steve' AND dedupe_key LIKE 'prompt-hold-end:%'").get() as { n: number };
    expect(n.n).toBe(1);
  });
  test("hold history survives an ordinary failure: held once, then a clean failure, then 25h old with the prompt closed -> closed, not injected", async () => {
    const row = pendingRow();
    await dispatch(row, world(() => ({ ok: false, reason: "permission_prompt" })).adapter);
    await dispatch(row, world(() => ({ ok: false })).adapter);
    expect(rcpt(row.message_id)).toMatchObject({ retry_count: 1, prompt_hold_count: 1 });
    expect(rcpt(row.message_id).last_error).not.toBe("prompt_hold");
    const old = { ...row, created_at: new Date(Date.now() - 25 * 3600000).toISOString() };
    const closed = world(() => ({ ok: true }));
    await dispatch(old, closed.adapter);
    expect(closed.w.attempts).toBe(0);
    expect(rcpt(row.message_id)).toMatchObject({ delivery_state: "blocked", last_error: "prompt_hold_expired" });
    const n = db.prepare("SELECT COUNT(*) AS n FROM message WHERE to_agent_id='steve' AND dedupe_key LIKE 'prompt-hold-end:%'").get() as { n: number };
    expect(n.n).toBe(1);
  });
  test("an old message that was never held by a prompt is not closed by the prompt-hold age check", async () => {
    const row = pendingRow();
    const old = { ...row, created_at: new Date(Date.now() - 25 * 3600000).toISOString() };
    const { w, adapter } = world(() => ({ ok: true }));
    await dispatch(old, adapter);
    expect(w.pasted).toBe(1);
  });
  test("an ordinary clean failure still consumes retry_count (unchanged)", async () => {
    const row = pendingRow();
    const { adapter } = world(() => ({ ok: false }));
    await dispatch(row, adapter);
    expect(rcpt(row.message_id)).toMatchObject({ delivery_state: "pending", retry_count: 1, deferred_count: 0 });
  });
});

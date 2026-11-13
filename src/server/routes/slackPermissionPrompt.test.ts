import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { handleAppMention } from "./slack";
import type { AgentRecord } from "../types";
import type { InjectPromptOptions, InjectResult } from "../lib/tmuxInject";

let db: Database, dir: string, oldAudit: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slack-pp-"));
  oldAudit = process.env.B3OS_AUDIT_LOG_DIR;
  process.env.B3OS_AUDIT_LOG_DIR = join(dir, "audit");
  db = new Database(join(dir, "team.db"));
  migrate(db);
  db.run(`INSERT INTO agent (id, display_name, role, runtime, status_provider, tmux_session, workspace_path, persona_file)
    VALUES ('bill','Bill','dev','claude_channel','claude_tmux','claude-bill','/tmp','p.md')`);
});
afterEach(() => {
  if (oldAudit === undefined) delete process.env.B3OS_AUDIT_LOG_DIR; else process.env.B3OS_AUDIT_LOG_DIR = oldAudit;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const bill = { id: "bill", display_name: "Bill", role: "dev", runtime: "claude_channel", status_provider: "claude_tmux", tmux_session: "claude-bill", slack_bot_user_id: "UBILL", workspace_path: "/tmp", persona_file: "p.md" } as unknown as AgentRecord;
const mention = { type: "app_mention", user: "UGD", text: "<@UBILL> 이거 봐줘", channel: "C1", ts: "111.222" };
const audits = () => (db.query("SELECT action FROM audit_event ORDER BY rowid").all() as { action: string }[]).map((r) => r.action);

test("Slack mention while a permission prompt is open: nothing pasted, held; delivered exactly once after it closes", async () => {
  let open = true;
  const pasted: InjectPromptOptions[] = [];
  let settledResolve!: () => void; const settled = new Promise<void>((r) => (settledResolve = r));
  const inject = (async (o: InjectPromptOptions): Promise<InjectResult> => {
    if (open) return { ok: false, reason: "permission_prompt" };
    pasted.push(o); settledResolve(); return { ok: true };
  }) as never;
  await handleAppMention({ db, broadcast: () => {}, agents: [bill], inject: { inject, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), retryMs: 1 } }, mention);
  await Bun.sleep(10);
  expect(pasted).toHaveLength(0);
  expect(audits()).toContain("tmux_inject_deferred_permission_prompt");
  expect(audits()).not.toContain("tmux_inject_failed");
  open = false;
  await settled;
  await Bun.sleep(10);
  expect(pasted).toHaveLength(1);
  expect(pasted[0]).toMatchObject({ source: "slack", kind: "slack", agentId: "bill" });
  expect(audits().filter((a) => a === "tmux_inject_ok")).toHaveLength(1);
});

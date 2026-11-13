/**
 * 받는 세션에 권한 창이 열려 있어 못 넣은 글 — 버리지 않고, 보낸 사람에게 알린다.
 * 실제 스키마 DB 에 글·수신 행을 만들고 dispatcher 의 결과 기록 함수를 직접 부른다.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { insertMessage } from "../db/inboxQueries";
import {
  PERMISSION_PROMPT_DEFER_MAX,
  PROMPT_HOLD_NOTICE_AFTER,
  PROMPT_HOLD_SLOW_SEC,
  recordDispatchOutcomeForTest as record,
} from "./wakeDispatcher";
import type { PendingDispatchRow } from "./types";
import type { AgentRecord } from "../types";

const AGENTS = [
  { id: "bill", display_name: "Bill" },
  { id: "codex", display_name: "Codex" },
  { id: "steve", display_name: "Steve" },
] as unknown as AgentRecord[];
const STEVE = AGENTS[2] as AgentRecord;
const PROMPT = { result: { ok: false, deferred: true, detail: "tmux_inject_deferred_permission_prompt", deferBackoffSec: 10, deferMaxCount: PERMISSION_PROMPT_DEFER_MAX } };
const LOCK = { result: { ok: false, deferred: true, detail: "claude_wake_lock_busy" } };

function freshDb(): Database {
  const d = new Database(":memory:");
  migrate(d);
  for (const id of ["bill", "codex", "steve"]) {
    d.run(`INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file) VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'persona.md')`, [id, id]);
  }
  d.run(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','[]','bill')`);
  return d;
}

function send(db: Database, from: string, source: "agent" | "system" = "agent"): PendingDispatchRow {
  const m = insertMessage(db, {
    thread_id: "t1", from_agent_id: from, to_agent_id: "steve", type: "dm", body: "x",
    source, hop_count: 0, priority: "normal",
  } as Parameters<typeof insertMessage>[1]);
  db.run(`INSERT OR IGNORE INTO message_recipient (message_id, agent_id, delivery_state) VALUES (?, 'steve', 'pending')`, [m.id]);
  const created = (db.prepare(`SELECT created_at FROM message WHERE id = ?`).get(m.id) as { created_at: string }).created_at;
  return {
    message_id: m.id, agent_id: "steve", delivery_state: "pending", retry_count: 0, last_error: null,
    from_agent_id: from, to_agent_id: "steve", body: "x", source, created_by: null,
    max_hop: 16, hop_count: 0, in_reply_to: null, parent_message_id: null, sync: "none",
    thread_id: "t1", type: "dm", created_at: created, priority: "normal",
  } as unknown as PendingDispatchRow;
}

const state = (db: Database, id: string) =>
  db.prepare(`SELECT delivery_state AS s, prompt_hold_count AS n, CAST(strftime('%s', lease_until) AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) AS wait FROM message_recipient WHERE message_id = ? AND agent_id = 'steve'`)
    .get(id) as { s: string; n: number; wait: number };
const notices = (db: Database, to: string, prefix: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM message WHERE to_agent_id = ? AND source = 'system' AND dedupe_key LIKE ?`).get(to, prefix + "%") as { c: number }).c;

describe("권한 창 때문에 못 넣은 글", () => {
  test("빠른 확인 횟수를 넘겨도 blocked 가 되지 않고 pending 으로 남는다", () => {
    const db = freshDb();
    const r = send(db, "codex");
    for (let i = 0; i < PERMISSION_PROMPT_DEFER_MAX + 20; i++) record(db, r, STEVE, PROMPT, null, AGENTS);
    const s = state(db, r.message_id);
    expect(s.s).toBe("pending");
    expect(s.n).toBe(PERMISSION_PROMPT_DEFER_MAX + 20);
    // 빠른 구간 뒤에는 느린 간격으로 본다.
    expect(s.wait).toBeGreaterThan(PROMPT_HOLD_SLOW_SEC - 5);
  });

  test("약 1분 미뤄지면 보낸 사람에게 한 번 알리고, 같은 쌍의 다른 글로는 다시 알리지 않는다", () => {
    const db = freshDb();
    const a = send(db, "codex");
    for (let i = 0; i < PROMPT_HOLD_NOTICE_AFTER - 1; i++) record(db, a, STEVE, PROMPT, null, AGENTS);
    expect(notices(db, "codex", "prompt-hold:")).toBe(0);
    for (let i = 0; i < 30; i++) record(db, a, STEVE, PROMPT, null, AGENTS);
    expect(notices(db, "codex", "prompt-hold:")).toBe(1);
    const b = send(db, "codex");
    for (let i = 0; i < 30; i++) record(db, b, STEVE, PROMPT, null, AGENTS);
    expect(notices(db, "codex", "prompt-hold:")).toBe(1);
    // 다른 보낸 사람은 따로 알린다.
    const c = send(db, "bill");
    for (let i = 0; i < 30; i++) record(db, c, STEVE, PROMPT, null, AGENTS);
    expect(notices(db, "bill", "prompt-hold:")).toBe(1);
    const body = (db.prepare(`SELECT body, in_reply_to, hop_count FROM message WHERE to_agent_id='codex' AND source='system'`).get()) as { body: string; in_reply_to: string | null; hop_count: number };
    expect(body.body).toContain(a.message_id);
    expect(body.body).toContain("steve");
    expect(body.in_reply_to).toBeNull();
    expect(body.hop_count).toBe(0);
  });

  test("시스템이 보낸 글에는 알리지 않는다", () => {
    const db = freshDb();
    const r = send(db, "system", "system");
    for (let i = 0; i < 30; i++) record(db, r, STEVE, PROMPT, null, AGENTS);
    expect(notices(db, "system", "prompt-hold")).toBe(0);
    expect(state(db, r.message_id).s).toBe("pending");
  });

  test("24시간이 지난 글은 blocked 로 닫고 보낸 사람에게 한 번 알린다", () => {
    const db = freshDb();
    const r = send(db, "codex");
    const old = { ...r, created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") } as PendingDispatchRow;
    record(db, old, STEVE, PROMPT, null, AGENTS);
    record(db, old, STEVE, PROMPT, null, AGENTS);
    expect(state(db, r.message_id).s).toBe("blocked");
    expect(notices(db, "codex", "prompt-hold-end:")).toBe(1);
  });

  test("lock-busy 미루기는 그대로 횟수 상한에서 blocked 가 되고 이 알림을 내지 않는다", () => {
    const db = freshDb();
    const r = send(db, "codex");
    for (let i = 0; i < 400; i++) record(db, r, STEVE, LOCK, null, AGENTS);
    expect(state(db, r.message_id).s).toBe("blocked");
    expect(notices(db, "codex", "prompt-hold")).toBe(0);
  });
});

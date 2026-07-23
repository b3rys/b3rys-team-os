/**
 * Characterization tests for inboxQueries — locks in CURRENT behavior before the
 * planned barrel split (messages / dispatch / stats / lifecycle).
 *
 * Scope (Stage ③, GD-approved 2026-06-06): golden path + edges
 *   - ensureThread (create/reuse, kind detection, participant dedup)
 *   - insertMessage (directed + broadcast fan-out, user-vs-agent recipient state, reply→directed redirect)
 *   - inboxFor / markRead (direct + per-recipient broadcast read tracking)
 *   - findRecentDuplicate (dedupe window)
 *   - dispatch state machine: markDispatching / markFailed / markDeferred (hard cap) / recoverStaleClaims
 *   - toIso (UTC→KST display conversion — regression guard for the 2026-05-25 raw-UTC leak)
 *
 * Pure DB functions over an in-memory sqlite; no live bus / no service touched.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { directedRecipientRowBackfill, migrate } from "./migrate";
import {
  ensureThread,
  insertMessage,
  inboxFor,
  markRead,
  findRecentDuplicate,
  markDispatching,
  markFailed,
  markDeferred,
  recoverStaleClaims,
  toIso,
} from "./inboxQueries";

function addAgent(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'persona.md')`,
  ).run(id, id);
}

function setup(agents: string[] = ["bill", "steve", "demis"]): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of agents) addAgent(db, a);
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1', 'test', 'dm', '["bill","steve"]', 'bill')`,
  ).run();
  return db;
}

const baseEnv = (over: Record<string, unknown>) => ({
  thread_id: "t1",
  from_agent_id: "bill",
  to_agent_id: "steve",
  body: "hello",
  source: "agent" as const,
  type: "dm",
  ...over,
});

const recipient = (db: Database, messageId: string, agentId: string) =>
  db
    .prepare(`SELECT * FROM message_recipient WHERE message_id = ? AND agent_id = ?`)
    .get(messageId, agentId) as Record<string, unknown> | undefined;

// ─── ensureThread ────────────────────────────────────────────────────────────
describe("ensureThread", () => {
  test("existing thread_id → reused (created=false)", () => {
    const db = setup();
    const r = ensureThread(db, { thread_id: "t1", from_agent_id: "bill", to_agent_id: "steve", type: "dm", body: "x" });
    expect(r).toEqual({ thread_id: "t1", created: false });
  });

  test("no thread_id → new thread created with 8-char id", () => {
    const db = setup();
    const r = ensureThread(db, { from_agent_id: "bill", to_agent_id: "steve", type: "dm", body: "design discussion" });
    expect(r.created).toBe(true);
    expect(r.thread_id).toHaveLength(8);
    const row = db.prepare(`SELECT title, kind, participants_json FROM thread WHERE id = ?`).get(r.thread_id) as {
      title: string;
      kind: string;
      participants_json: string;
    };
    expect(row.title).toBe("design discussion");
    expect(row.kind).toBe("dm");
    expect(JSON.parse(row.participants_json).sort()).toEqual(["bill", "steve"]);
  });

  test("kind detection: broadcast / meeting / dm", () => {
    const db = setup();
    const bc = ensureThread(db, { from_agent_id: "bill", to_agent_id: "broadcast", type: "broadcast", body: "notice" });
    expect((db.prepare(`SELECT kind FROM thread WHERE id=?`).get(bc.thread_id) as { kind: string }).kind).toBe("broadcast");
    const mt = ensureThread(db, { from_agent_id: "bill", to_agent_id: "steve", type: "meeting_round", body: "sync" });
    expect((db.prepare(`SELECT kind FROM thread WHERE id=?`).get(mt.thread_id) as { kind: string }).kind).toBe("meeting");
  });

  test("participants exclude broadcast/system and dedup", () => {
    const db = setup();
    const r = ensureThread(db, { from_agent_id: "bill", to_agent_id: "broadcast", type: "dm", body: "x" });
    const parts = JSON.parse(
      (db.prepare(`SELECT participants_json FROM thread WHERE id=?`).get(r.thread_id) as { participants_json: string }).participants_json,
    );
    expect(parts).toEqual(["bill"]); // broadcast filtered out
  });
});

// ─── insertMessage ───────────────────────────────────────────────────────────
describe("insertMessage", () => {
  test("directed agent message → message row + pending recipient + KST created_at", () => {
    const db = setup();
    const env = insertMessage(db, baseEnv({}) as never);
    expect(env.id).toHaveLength(12);
    expect(env.to_agent_id).toBe("steve");
    expect(env.created_at).toMatch(/\+09:00$/); // toIso KST display
    const rc = recipient(db, env.id, "steve");
    expect(rc?.delivery_state).toBe("pending"); // agent msg waits for dispatcher
  });

  test("directed USER message → recipient completed-on-insert (not dispatched)", () => {
    const db = setup();
    const env = insertMessage(db, baseEnv({ source: "user", from_agent_id: "user" }) as never);
    expect(recipient(db, env.id, "steve")?.delivery_state).toBe("completed");
  });

  test("directed to RESERVED target (no agent row) → no recipient row", () => {
    const db = setup();
    const env = insertMessage(db, baseEnv({ to_agent_id: "user" }) as never);
    expect(recipient(db, env.id, "user")).toBeNull(); // bun:sqlite .get() → null when absent
  });

  test("broadcast fan-out → one recipient per agent except sender", () => {
    const db = setup(["bill", "steve", "demis"]);
    const env = insertMessage(db, baseEnv({ to_agent_id: "broadcast", type: "broadcast" }) as never);
    const rows = db.prepare(`SELECT agent_id, delivery_state FROM message_recipient WHERE message_id=?`).all(env.id) as Array<{
      agent_id: string;
      delivery_state: string;
    }>;
    expect(rows.map((r) => r.agent_id).sort()).toEqual(["demis", "steve"]); // bill (sender) excluded
    expect(rows.every((r) => r.delivery_state === "pending")).toBe(true);
  });

  test("broadcast with explicit_recipients → only those (minus sender)", () => {
    const db = setup(["bill", "steve", "demis"]);
    const env = insertMessage(
      db,
      baseEnv({ to_agent_id: "broadcast", type: "broadcast", explicit_recipients: ["steve", "bill"] }) as never,
    );
    const ids = (db.prepare(`SELECT agent_id FROM message_recipient WHERE message_id=?`).all(env.id) as Array<{ agent_id: string }>).map(
      (r) => r.agent_id,
    );
    expect(ids).toEqual(["steve"]); // bill (sender) filtered, demis not listed
  });

  // ★서버는 팀원이 쓴 주소를 고치지 않는다★ (GD 2026-07-14: "보정을 하면 안된다니깐.. 근본이 아니잖아")
  //   예전엔 여기서 broadcast → 원 요청자(bill) 로 ★몰래 바꿔치기★ 했다. 30일 98건, ★로그 0줄.★
  //   그래서 진짜 원인(주입문이 "팀장께 답하라")이 6주간 살아 있었다.
  //   ★이제 안 고친다.★ 팀원이 broadcast 라 썼으면 broadcast 다 — 방에 떠서 ★보인다.★
  //   대신 reply_address_wrong 을 기록하고 ★그 런타임의 주입문★ 을 고친다. (replyAddressAudit.test.ts)
  test("★주소가 틀려도 서버가 고치지 않는다★ (보낸 것만 말한 것이다)", () => {
    const db = setup();
    const req = insertMessage(db, baseEnv({ from_agent_id: "bill", to_agent_id: "steve", body: "정리해줘" }) as never);
    const reply = insertMessage(
      db,
      baseEnv({ from_agent_id: "steve", to_agent_id: "broadcast", type: "broadcast", in_reply_to: req.id, body: "done" }) as never,
    );
    const stored = db.prepare(`SELECT to_agent_id, type FROM message WHERE id=?`).get(reply.id) as { to_agent_id: string; type: string };
    expect(stored.to_agent_id).toBe("broadcast"); // ★바꿔치기 없음★
    expect(stored.type).toBe("broadcast");
  });

  test("parent_message_id derived from in_reply_to when not explicit", () => {
    const db = setup();
    const req = insertMessage(db, baseEnv({ body: "q" }) as never);
    const reply = insertMessage(db, baseEnv({ from_agent_id: "steve", to_agent_id: "bill", in_reply_to: req.id, body: "a" }) as never);
    const pm = db.prepare(`SELECT parent_message_id FROM message WHERE id=?`).get(reply.id) as { parent_message_id: string | null };
    expect(pm.parent_message_id).toBe(req.id);
  });
});

// ─── inboxFor / markRead ─────────────────────────────────────────────────────
describe("inboxFor + markRead", () => {
  test("directed(1:1) inbox membership is recipient-only (N=1); markRead leaves inbox", () => {
    const db = setup();
    const env = insertMessage(db, baseEnv({ to_agent_id: "steve" }) as never);
    // 받는이-단일화(2026-06-13 GD): directed(1:1) 메시지도 받는이 행 1개(N=1)로 inbox 에 뜨고,
    // 그 행의 read_at 으로만 판정한다(message-level 분기 제거). ack → 받는이 read_at 닫힘 → 사라짐.
    expect(inboxFor(db, "steve").some((m) => m.id === env.id)).toBe(true);
    expect(markRead(db, env.id, "steve")).toBe(true);
    expect(inboxFor(db, "steve").some((m) => m.id === env.id)).toBe(false);
  });

  test("backfill: legacy directed message (no recipient row) gets one, read_at preserved", () => {
    const db = setup();
    const unread = insertMessage(db, baseEnv({ to_agent_id: "steve" }) as never);
    const read = insertMessage(db, baseEnv({ to_agent_id: "steve" }) as never);
    // 레거시 모사: 받는이 행 제거(Team Bus v1 이전엔 1:1 에 받는이 행이 없었음) + read 쪽은
    // message-level read_at 만 있던 상태로 만든다.
    db.prepare(`DELETE FROM message_recipient WHERE message_id IN (?, ?)`).run(unread.id, read.id);
    db.prepare(`UPDATE message SET read_at = datetime('now') WHERE id = ?`).run(read.id);
    expect(recipient(db, unread.id, "steve")).toBeNull();

    directedRecipientRowBackfill(db);

    const ru = recipient(db, unread.id, "steve") as { read_at: string | null } | undefined;
    const rr = recipient(db, read.id, "steve") as { read_at: string | null } | undefined;
    expect(ru?.read_at ?? null).toBeNull(); // 안읽음 보존 → inbox 에 떠야
    expect(rr?.read_at).toBeTruthy(); // 읽음 보존 → inbox 에 안 떠야
    expect(inboxFor(db, "steve").some((m) => m.id === unread.id)).toBe(true);
    expect(inboxFor(db, "steve").some((m) => m.id === read.id)).toBe(false);
    // 멱등: 다시 호출해도 중복/변경 없음
    directedRecipientRowBackfill(db);
    expect(recipient(db, unread.id, "steve")).toBeDefined();
  });

  test("broadcast reaches recipient inbox; per-agent read is independent", () => {
    const db = setup(["bill", "steve", "demis"]);
    const env = insertMessage(db, baseEnv({ to_agent_id: "broadcast", type: "broadcast" }) as never);
    expect(inboxFor(db, "steve").some((m) => m.id === env.id)).toBe(true);
    expect(inboxFor(db, "demis").some((m) => m.id === env.id)).toBe(true);
    markRead(db, env.id, "steve");
    expect(inboxFor(db, "steve").some((m) => m.id === env.id)).toBe(false);
    expect(inboxFor(db, "demis").some((m) => m.id === env.id)).toBe(true); // demis still unread
  });

  test("markRead returns false when nothing to mark", () => {
    const db = setup();
    expect(markRead(db, "nonexistent", "steve")).toBe(false);
  });
});

// ─── findRecentDuplicate ─────────────────────────────────────────────────────
describe("findRecentDuplicate", () => {
  test("same dedupe_key within window → returns existing id", () => {
    const db = setup();
    const env = insertMessage(db, baseEnv({ dedupe_key: "k1" }) as never);
    expect(findRecentDuplicate(db, "k1")).toBe(env.id);
  });

  test("null dedupe_key → null (never dedups)", () => {
    const db = setup();
    expect(findRecentDuplicate(db, null)).toBeNull();
  });

  test("unknown key → null", () => {
    const db = setup();
    insertMessage(db, baseEnv({ dedupe_key: "k1" }) as never);
    expect(findRecentDuplicate(db, "k2")).toBeNull();
  });
});

// ─── dispatch state machine ──────────────────────────────────────────────────
describe("dispatch claim / retry / defer / recovery", () => {
  function pendingRecipient(db: Database): { id: string } {
    const env = insertMessage(db, baseEnv({ to_agent_id: "steve" }) as never);
    return { id: env.id };
  }

  test("markDispatching: first claim wins, second on same row fails", () => {
    const db = setup();
    const { id } = pendingRecipient(db);
    expect(markDispatching(db, id, "steve")).toBe(true);
    expect(markDispatching(db, id, "steve")).toBe(false); // no longer 'pending'
    expect(recipient(db, id, "steve")?.delivery_state).toBe("dispatching");
  });

  test("markFailed: increments retry, dead_letters at maxRetries", () => {
    const db = setup();
    const { id } = pendingRecipient(db);
    expect(markFailed(db, id, "steve", "err", 3)).toBe("pending"); // retry 1
    expect(markFailed(db, id, "steve", "err", 3)).toBe("pending"); // retry 2
    expect(markFailed(db, id, "steve", "err", 3)).toBe("dead_letter"); // retry 3 → terminal
    const rc = recipient(db, id, "steve");
    expect(rc?.delivery_state).toBe("dead_letter");
    expect(rc?.retry_count).toBe(3);
  });

  test("markDeferred: stays pending below cap, hard-caps to blocked at BUS_MAX_DEFER (default 20)", () => {
    const db = setup();
    const { id } = pendingRecipient(db);
    let state: "pending" | "blocked" = "pending";
    for (let i = 1; i <= 19; i++) {
      state = markDeferred(db, id, "steve");
      expect(state).toBe("pending");
    }
    state = markDeferred(db, id, "steve"); // 20th → cap
    expect(state).toBe("blocked");
    const rc = recipient(db, id, "steve");
    expect(rc?.delivery_state).toBe("blocked");
    expect(rc?.deferred_count).toBe(20);
    expect(String(rc?.last_error)).toContain("deferred_cap_exceeded");
  });

  test("recoverStaleClaims: expired-lease dispatching → pending; live lease untouched", () => {
    const db = setup();
    const stale = pendingRecipient(db);
    const live = pendingRecipient(db);
    // stale: dispatching with an expired lease
    db.prepare(
      `UPDATE message_recipient SET delivery_state='dispatching', lease_until=datetime('now','-10 seconds') WHERE message_id=? AND agent_id='steve'`,
    ).run(stale.id);
    // live: dispatching with a future lease
    db.prepare(
      `UPDATE message_recipient SET delivery_state='dispatching', lease_until=datetime('now','+60 seconds') WHERE message_id=? AND agent_id='steve'`,
    ).run(live.id);
    const recovered = recoverStaleClaims(db);
    expect(recovered).toBe(1);
    expect(recipient(db, stale.id, "steve")?.delivery_state).toBe("pending");
    expect(recipient(db, live.id, "steve")?.delivery_state).toBe("dispatching");
  });
});

// ─── toIso (KST display conversion) ──────────────────────────────────────────
describe("toIso — UTC→KST display (regression guard, 2026-05-25)", () => {
  test("SQLite UTC 'YYYY-MM-DD HH:MM:SS' → +09:00 ISO at +9h", () => {
    expect(toIso("2026-01-01 12:00:00")).toBe("2026-01-01T21:00:00+09:00");
  });

  test("date rollover across midnight", () => {
    expect(toIso("2026-01-01 20:00:00")).toBe("2026-01-02T05:00:00+09:00");
  });

  test("null/undefined → null", () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });

  test("already-offset / non-matching string → passthrough", () => {
    expect(toIso("2026-01-01T21:00:00+09:00")).toBe("2026-01-01T21:00:00+09:00");
  });

  test("invalid date → 'T'+'Z' fallback (no crash)", () => {
    expect(toIso("9999-99-99 99:99:99")).toBe("9999-99-99T99:99:99Z");
  });
});

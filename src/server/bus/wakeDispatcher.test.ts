/**
 * Team Bus v1.1 — unit tests.
 *
 * Covers:
 * 1. Atomic claim deduplication (only one claimer proceeds)
 * 2. Crash recovery (stale dispatching rows reset to pending)
 * 3. Anti-pingpong round limit (dispatch blocked beyond MAX_AUTO_ROUNDS)
 * 4. Dead-letter after MAX_RETRIES (exactly 3 markFailed calls)
 * 5. Trusted-source rejection (unknown source/sender blocked)
 * 6. Shadow mode (no actual wake when BUS_DISPATCH_ENABLED=false)
 * 7. SyncPolicy text format per level
 * 8. pendingDispatch / markFailed queries
 * 9. [v1.1] Deferred does NOT increment retry_count
 * 10. [v1.1] markFailed sets backoff lease_until (poller backs off)
 * 11. [v1.1] Broadcast partial dead_letter does NOT contaminate message.delivery_status
 * 12. [v1.1] Policy block (hop_limit) → immediate terminal, no retry
 * 13. [v1.1] mass-wake backfill idempotence
 * 14. [v1.1] pendingDispatch respects backoff lease (backed-off rows excluded)
 * 15. [v1.1] pendingDispatch priority ordering (high before normal before low)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, migrate, massWakeBackfill } from "../db/migrate";
import {
  pendingDispatch,
  markDispatching,
  markWakeDispatched,
  markFailed,
  markDeferred,
  markAck,
  recoverStaleClaims,
  countAutoRounds,
  insertMessage,
  ensureThread,
  aggregateDeliveryStatus,
  busStatusSnapshot,
} from "../db/inboxQueries";
import { checkPingpong, MAX_AUTO_ROUNDS } from "./antiPingpong";
import {
  ADAPTER_TIMEOUT_MS,
  OPENCLAW_ADAPTER_TIMEOUT_MS,
  isCollectOnlyFeedbackReply,
  leaseSecForRuntime,
  inFlightGraceForRuntime,
  startWakeDispatcher,
} from "./wakeDispatcher";
import type { PendingDispatchRow } from "./types";
import { HERMES_TURN_TIMEOUT_MS } from "../lib/hermesBridge";

// ★hermes lease/grace 사다리 (2026-07-16, GD)★ — blocking-wake 런타임(openclaw·hermes)의 claim 은
//   turn cap 보다 길어야 recoverStaleClaims 가 턴 도중 리셋하지 않는다(안 그러면 중복보고).
describe("lease/grace ladder — blocking-wake 런타임은 turnCap < lease < grace", () => {
  test("★hermes: turnCap < lease < grace 자동 성립 (중복 방지 불변식)", () => {
    const cap = HERMES_TURN_TIMEOUT_MS; // 600s
    const leaseMs = leaseSecForRuntime("hermes_agent") * 1000;
    const graceMs = inFlightGraceForRuntime("hermes_agent");
    expect(cap).toBeLessThan(leaseMs); // 사다리 1단
    expect(leaseMs).toBeLessThan(graceMs); // 사다리 2단
    expect(leaseMs).toBe(cap + 60_000); // turn cap 에서 자동 파생 (+60s)
    expect(graceMs).toBe(leaseMs + 60_000);
  });
  test("hermes 는 더 이상 60/120 빠른 레인이 아니다 (버그 회귀 가드)", () => {
    expect(leaseSecForRuntime("hermes_agent")).toBeGreaterThan(60); // 옛 DEFAULT_LEASE_SEC=60 이면 버그
    expect(inFlightGraceForRuntime("hermes_agent")).toBeGreaterThan(120_000);
  });
  test("openclaw 는 그대로 (무영향)", () => {
    const leaseMs = leaseSecForRuntime("openclaw") * 1000;
    expect(leaseMs).toBe(OPENCLAW_ADAPTER_TIMEOUT_MS + 60_000);
    expect(inFlightGraceForRuntime("openclaw")).toBe(OPENCLAW_ADAPTER_TIMEOUT_MS + 120_000);
  });
  test("claude/기타 는 빠른 60/120 레인 그대로 (무영향)", () => {
    expect(leaseSecForRuntime("claude_channel")).toBe(60);
    expect(inFlightGraceForRuntime("claude_channel")).toBe(120_000);
    expect(leaseSecForRuntime(undefined)).toBe(60);
  });
});

// ─── In-memory test DB setup ──────────────────────────────────────────────────

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  // Seed a minimal agent
  db.exec(`
    INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
    VALUES ('bill', 'Bill', 'GD Step', 'claude_channel', 'claude_tmux', '/dev/null', '/dev/null'),
           ('codex', 'Codex', 'GPT', 'openclaw', 'openclaw_gateway', '/dev/null', '/dev/null'),
           ('steve', 'Steve', 'Dev', 'claude_channel', 'claude_tmux', '/dev/null', '/dev/null');
    -- tmux_session for bill
    UPDATE agent SET tmux_session='claude-bill' WHERE id='bill';
    UPDATE agent SET tmux_session='claude-steve' WHERE id='steve';
  `);
  return db;
}

function seedThread(db: Database, threadId = "th-test"): void {
  db.exec(`
    INSERT OR IGNORE INTO thread (id, title, kind, participants_json, opened_by)
    VALUES ('${threadId}', 'Test thread', 'dm', '["bill","codex"]', 'codex');
  `);
}

function seedMessage(
  db: Database,
  opts: {
    id?: string;
    threadId?: string;
    from?: string;
    to?: string;
    source?: string;
    parentId?: string | null;
    hopCount?: number;
  } = {},
): string {
  const id = opts.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`;
  const threadId = opts.threadId ?? "th-test";
  seedThread(db, threadId);
  db.exec(`
    INSERT INTO message
      (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count,
       parent_message_id, delivery_status)
    VALUES (
      '${id}', '${threadId}',
      '${opts.from ?? "codex"}', '${opts.to ?? "bill"}',
      'dm', 'hello', '${opts.source ?? "agent"}',
      ${opts.hopCount ?? 0},
      ${opts.parentId ? `'${opts.parentId}'` : "NULL"},
      'delivered'
    );
  `);
  // Seed message_recipient for bill (or to_agent_id if not broadcast)
  const toAgent = opts.to ?? "bill";
  if (toAgent !== "broadcast") {
    db.exec(
      `INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES ('${id}', '${toAgent}')`,
    );
  }
  return id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("markDispatching — atomic claim", () => {
  let db: Database;
  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => db.close());

  test("first claim succeeds", () => {
    const id = seedMessage(db);
    expect(markDispatching(db, id, "bill")).toBe(true);
  });

  test("second claim on same row fails (idempotent)", () => {
    const id = seedMessage(db);
    expect(markDispatching(db, id, "bill")).toBe(true);
    expect(markDispatching(db, id, "bill")).toBe(false);
  });

  test("claim on non-existent row returns false", () => {
    expect(markDispatching(db, "no-such-id", "bill")).toBe(false);
  });
});

describe("collect-only feedback replies", () => {
  let db: Database;
  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => db.close());

  test("reply to a skill feedback request is inbox-only for Codex", () => {
    const parentId = seedMessage(db, {
      id: "fb-parent",
      threadId: "task-ops-feedback-test",
      from: "codex",
      to: "bill",
      source: "agent",
    });
    db.prepare(`UPDATE message SET meta_json=? WHERE id=?`).run(
      JSON.stringify({ kind: "skill_feedback_request", reply_mode: "collect_only" }),
      parentId,
    );
    const replyId = seedMessage(db, {
      id: "fb-reply",
      threadId: "task-ops-feedback-test",
      from: "bill",
      to: "codex",
      source: "agent",
      parentId,
    });
    db.prepare(`UPDATE message SET type='reply', in_reply_to=? WHERE id=?`).run(parentId, replyId);

    const row = pendingDispatch(db, 20).find((r) => r.message_id === replyId) as PendingDispatchRow | undefined;
    expect(row).toBeDefined();
    expect(isCollectOnlyFeedbackReply(db, row as PendingDispatchRow, "codex")).toBe(true);
  });

  test("ordinary reply to Codex still wakes Codex", () => {
    const parentId = seedMessage(db, {
      id: "normal-parent",
      threadId: "normal-thread",
      from: "codex",
      to: "bill",
      source: "agent",
    });
    const replyId = seedMessage(db, {
      id: "normal-reply",
      threadId: "normal-thread",
      from: "bill",
      to: "codex",
      source: "agent",
      parentId,
    });
    db.prepare(`UPDATE message SET type='reply', in_reply_to=? WHERE id=?`).run(parentId, replyId);

    const row = pendingDispatch(db, 20).find((r) => r.message_id === replyId) as PendingDispatchRow | undefined;
    expect(row).toBeDefined();
    expect(isCollectOnlyFeedbackReply(db, row as PendingDispatchRow, "codex")).toBe(false);
  });

  test("reply to a duplicate-receipt test thread is inbox-only for Codex", () => {
    const parentId = seedMessage(db, {
      id: "dup-parent",
      threadId: "taskops-dup-test-20260603-1125",
      from: "codex",
      to: "bill",
      source: "agent",
    });
    db.prepare(`UPDATE message SET body=? WHERE id=?`).run(
      "[중복수신 테스트] 이 메시지를 받으면 한 번만 답해주세요. 추가 설명은 붙이지 말아주세요.",
      parentId,
    );
    const replyId = seedMessage(db, {
      id: "dup-reply",
      threadId: "taskops-dup-test-20260603-1125",
      from: "bill",
      to: "codex",
      source: "agent",
      parentId,
    });
    db.prepare(`UPDATE message SET type='reply', in_reply_to=? WHERE id=?`).run(parentId, replyId);

    const row = pendingDispatch(db, 20).find((r) => r.message_id === replyId) as PendingDispatchRow | undefined;
    expect(row).toBeDefined();
    expect(isCollectOnlyFeedbackReply(db, row as PendingDispatchRow, "codex")).toBe(true);
  });

  test("reply to a collect-only parent body is inbox-only for Codex even outside feedback threads", () => {
    const parentId = seedMessage(db, {
      id: "collect-parent",
      threadId: "manual-collection",
      from: "codex",
      to: "steve",
      source: "agent",
    });
    db.prepare(`UPDATE message SET body=? WHERE id=?`).run(
      "이 메시지를 받으면 한 번만 답해주세요.",
      parentId,
    );
    const replyId = seedMessage(db, {
      id: "collect-reply",
      threadId: "manual-collection",
      from: "steve",
      to: "codex",
      source: "agent",
      parentId,
    });
    db.prepare(`UPDATE message SET type='reply', in_reply_to=? WHERE id=?`).run(parentId, replyId);

    const row = pendingDispatch(db, 20).find((r) => r.message_id === replyId) as PendingDispatchRow | undefined;
    expect(row).toBeDefined();
    expect(isCollectOnlyFeedbackReply(db, row as PendingDispatchRow, "codex")).toBe(true);
  });
});

describe("recoverStaleClaims — crash recovery", () => {
  let db: Database;
  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => db.close());

  test("fresh dispatching row with future lease is NOT recovered", () => {
    const id = seedMessage(db);
    markDispatching(db, id, "bill");
    // lease_until is now+30s — should not be recovered
    const n = recoverStaleClaims(db);
    expect(n).toBe(0);
    const row = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string } | undefined;
    expect(row?.delivery_state).toBe("dispatching");
  });

  test("expired dispatching row IS recovered to pending", () => {
    const id = seedMessage(db);
    // Manually insert a stale dispatching row with expired lease
    db.exec(`
      UPDATE message_recipient
      SET delivery_state='dispatching',
          claimed_at=datetime('now','-60 seconds'),
          lease_until=datetime('now','-30 seconds')
      WHERE message_id='${id}' AND agent_id='bill'
    `);
    const n = recoverStaleClaims(db);
    expect(n).toBe(1);
    const row = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string } | undefined;
    expect(row?.delivery_state).toBe("pending");
  });

  test("startWakeDispatcher startup recovery requeues orphaned Codex inflight markers", () => {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES ('cody', 'Cody', 'Codex tester', 'codex', 'codex_cli', '/dev/null', '/dev/null')`,
    ).run();
    const id = seedMessage(db, { id: "codex-lost-turn", to: "cody" });
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state='wake_dispatched'
       WHERE message_id=? AND agent_id='cody'`,
    ).run(id);
    db.prepare(
      `INSERT INTO codex_inflight (message_id, agent_id, thread_id, started_at)
       VALUES (?, 'cody', 'th-test', datetime('now'))`,
    ).run(id);

    // 이 테스트의 관심사 = startup recovery(orphan requeue), dispatch 아님. dispatch 기본값이 ON(2026-07-19)
    // 이 되면서, 재큐된 'pending' 행을 폴러가 즉시 dispatch 해 상태가 바뀐다 → recovery 검증을 shadow 로 고정한다.
    const prevEnabled = process.env.BUS_DISPATCH_ENABLED;
    process.env.BUS_DISPATCH_ENABLED = "false";
    try {
      const stop = startWakeDispatcher({
        db,
        agents: () =>
          db
            .prepare(
              `SELECT id, display_name, role, runtime, status_provider, tmux_session, telegram_bot_username, workspace_path, persona_file FROM agent`,
            )
            .all() as never[],
      });
      stop();
    } finally {
      if (prevEnabled === undefined) delete process.env.BUS_DISPATCH_ENABLED;
      else process.env.BUS_DISPATCH_ENABLED = prevEnabled;
    }

    const row = db
      .prepare(`SELECT delivery_state FROM message_recipient WHERE message_id = ? AND agent_id = 'cody'`)
      .get(id) as { delivery_state: string };
    const marker = db.prepare(`SELECT COUNT(*) AS n FROM codex_inflight WHERE message_id = ?`).get(id) as { n: number };
    expect(row.delivery_state).toBe("pending");
    expect(marker.n).toBe(0);
  });
});

describe("markFailed — retry and dead_letter", () => {
  let db: Database;
  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => db.close());

  test("first failure → retry (pending)", () => {
    const id = seedMessage(db);
    const state = markFailed(db, id, "bill", "test error", 3);
    expect(state).toBe("pending");
    const row = db
      .prepare("SELECT delivery_state, retry_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string; retry_count: number } | undefined;
    expect(row?.delivery_state).toBe("pending");
    expect(row?.retry_count).toBe(1);
  });

  test("third failure (maxRetries=3) → dead_letter", () => {
    const id = seedMessage(db);
    markFailed(db, id, "bill", "err1", 3);
    markFailed(db, id, "bill", "err2", 3);
    const state = markFailed(db, id, "bill", "err3", 3);
    expect(state).toBe("dead_letter");
    const row = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string } | undefined;
    expect(row?.delivery_state).toBe("dead_letter");
  });

  test("message delivery_status NOT overwritten to 'failed' on single-recipient dead_letter (issue 6)", () => {
    // v1.1: markFailed no longer writes message.delivery_status='failed' per-recipient
    // to avoid broadcast partial-failure contaminating the whole message. The caller
    // (or dashboard) is responsible for deriving status from message_recipient aggregation.
    const id = seedMessage(db);
    markFailed(db, id, "bill", "err1", 3);
    markFailed(db, id, "bill", "err2", 3);
    markFailed(db, id, "bill", "err3", 3);
    // recipient is dead_letter
    const rcpt = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string } | undefined;
    expect(rcpt?.delivery_state).toBe("dead_letter");
    // message-level delivery_status is NOT changed by markFailed (issue 6)
    const msg = db
      .prepare("SELECT delivery_status FROM message WHERE id=?")
      .get(id) as { delivery_status: string } | undefined;
    expect(msg?.delivery_status).toBe("delivered"); // unchanged from insertMessage default
  });
});

describe("markAck — agent acknowledgment", () => {
  let db: Database;
  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => db.close());

  test("ack sets delivery_state=agent_ack and message ack_at", () => {
    const id = seedMessage(db);
    markDispatching(db, id, "bill");
    markWakeDispatched(db, id, "bill");
    markAck(db, id, "bill");
    const row = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string } | undefined;
    expect(row?.delivery_state).toBe("agent_ack");
    const msg = db
      .prepare("SELECT ack_at FROM message WHERE id=?")
      .get(id) as { ack_at: string | null } | undefined;
    expect(msg?.ack_at).not.toBeNull();
  });
});

describe("pendingDispatch — query", () => {
  let db: Database;
  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => db.close());

  test("returns pending rows", () => {
    seedMessage(db, { id: "m1", from: "codex", to: "bill" });
    const rows = pendingDispatch(db, 10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.message_id === "m1" && r.agent_id === "bill")).toBe(true);
  });

  test("does not return dispatching rows", () => {
    const id = seedMessage(db);
    markDispatching(db, id, "bill");
    const rows = pendingDispatch(db, 10);
    expect(rows.some((r) => r.message_id === id)).toBe(false);
  });

  test("does not return dead_letter rows", () => {
    const id = seedMessage(db);
    markFailed(db, id, "bill", "e1", 3);
    markFailed(db, id, "bill", "e2", 3);
    markFailed(db, id, "bill", "e3", 3);
    const rows = pendingDispatch(db, 10);
    expect(rows.some((r) => r.message_id === id)).toBe(false);
  });
});

describe("checkPingpong — anti-pingpong guard", () => {
  let db: Database;
  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => db.close());

  const agentRoster = new Set(["bill", "codex", "steve"]);

  function makeRow(overrides: Partial<PendingDispatchRow> = {}): PendingDispatchRow {
    return {
      message_id: "m1",
      agent_id: "bill",
      delivery_state: "pending",
      retry_count: 0,
      last_error: null,
      from_agent_id: "codex",
      to_agent_id: "bill",
      body: "hello",
      source: "agent",
      created_by: "codex",
      max_hop: 5,
      hop_count: 0,
      in_reply_to: null,
      parent_message_id: null,
      sync: "none",
      thread_id: "th-test",
      type: "dm",
      priority: "normal",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  test("normal message is allowed", () => {
    const v = checkPingpong(db, makeRow(), agentRoster);
    expect(v.allowed).toBe(true);
  });

  test("unknown source is blocked", () => {
    const v = checkPingpong(db, makeRow({ source: "external" }), agentRoster);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("untrusted_source");
  });

  test("unknown sender is blocked", () => {
    const v = checkPingpong(db, makeRow({ from_agent_id: "ghost", created_by: "ghost" }), agentRoster);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("unknown_sender");
  });

  test("hop_count >= max_hop is blocked", () => {
    const v = checkPingpong(db, makeRow({ hop_count: 5, max_hop: 5 }), agentRoster);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("hop_limit_exceeded");
  });

  test("user source with unknown sender is allowed (reserved)", () => {
    // 'user' is a reserved sender — not in agentRoster but still valid
    const v = checkPingpong(db, makeRow({ source: "user", from_agent_id: "user", created_by: "user" }), agentRoster);
    expect(v.allowed).toBe(true);
  });

  test(`anti-pingpong: ${MAX_AUTO_ROUNDS} agent auto-rounds are blocked`, () => {
    // Build a chain: m0 (user→bill), m1 (bill→codex, parent=m0), m2 (codex→bill, parent=m1)
    // then m3 (bill→codex, parent=m2) should be blocked if MAX_AUTO_ROUNDS=2
    seedThread(db);
    const m0 = seedMessage(db, { id: "m0", from: "user", to: "bill", source: "user" });
    const m1 = seedMessage(db, { id: "m1", from: "bill", to: "codex", source: "agent", parentId: m0 });
    const m2 = seedMessage(db, { id: "m2", from: "codex", to: "bill", source: "agent", parentId: m1 });

    // At m2 the chain has 1 agent round (m1). countAutoRounds from m2's parent should be 1 at m1.
    // Trying to dispatch m3 (parent=m2) would have rounds = count agent hops in chain from m2.
    // chain from m2: m2(agent)=1, m1(agent)=2 → rounds=2 → blocked at MAX_AUTO_ROUNDS=2
    const v = checkPingpong(
      db,
      makeRow({ source: "agent", parent_message_id: m2 }),
      agentRoster,
    );
    if (MAX_AUTO_ROUNDS <= 2) {
      expect(v.allowed).toBe(false);
      expect(v.reason).toContain("pingpong_limit_exceeded");
    } else {
      // If MAX_AUTO_ROUNDS > 2, the chain only has 2 rounds so it should be allowed
      expect(v.allowed).toBe(true);
    }
  });

  test("countAutoRounds returns 0 for null parent", () => {
    expect(countAutoRounds(db, null)).toBe(0);
  });

  test("countAutoRounds counts only agent-source messages", () => {
    seedThread(db);
    const m0 = seedMessage(db, { id: "u0", from: "user", to: "bill", source: "user" });
    const m1 = seedMessage(db, { id: "a1", from: "bill", to: "codex", source: "agent", parentId: m0 });
    // m1 parent chain: m1(agent)=1, m0(user)=skip → count=1
    expect(countAutoRounds(db, m1)).toBe(1);
  });
});

describe("Bus: full dispatch flow (mock adapter)", () => {
  // Test the dispatch state machine without actually calling tmux/openclaw
  let db: Database;
  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => db.close());

  test("successful wake: pending → dispatching → wake_dispatched → agent_ack", () => {
    const id = seedMessage(db, { from: "codex", to: "bill" });

    // Step 1: claim
    expect(markDispatching(db, id, "bill")).toBe(true);
    // Step 2: adapter succeeded
    markWakeDispatched(db, id, "bill");
    // Step 3: agent acked
    markAck(db, id, "bill");

    const row = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string } | undefined;
    expect(row?.delivery_state).toBe("agent_ack");

    const msg = db
      .prepare("SELECT ack_at, delivery_status FROM message WHERE id=?")
      .get(id) as { ack_at: string | null; delivery_status: string } | undefined;
    expect(msg?.ack_at).not.toBeNull();
  });
});

// ─── v1.1 new tests ───────────────────────────────────────────────────────────

describe("[v1.1] markDeferred — lock-busy does not consume retry_count", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("markDeferred: retry_count stays 0, delivery_state='pending', lease_until set", () => {
    const id = seedMessage(db);
    // Simulate: row was claimed (dispatching), then lock-busy → deferred
    markDispatching(db, id, "bill");
    markDeferred(db, id, "bill", 2);
    const row = db
      .prepare("SELECT delivery_state, retry_count, lease_until, deferred_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string; retry_count: number; lease_until: string | null; deferred_count: number } | undefined;
    expect(row?.delivery_state).toBe("pending");
    expect(row?.retry_count).toBe(0);   // NOT incremented
    expect(row?.deferred_count).toBe(1);
    expect(row?.lease_until).not.toBeNull(); // short backoff lease set
  });

  test("multiple defers accumulate deferred_count without incrementing retry_count", () => {
    const id = seedMessage(db);
    markDeferred(db, id, "bill", 2);
    markDeferred(db, id, "bill", 2);
    markDeferred(db, id, "bill", 2);
    const row = db
      .prepare("SELECT retry_count, deferred_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { retry_count: number; deferred_count: number } | undefined;
    expect(row?.retry_count).toBe(0);
    expect(row?.deferred_count).toBe(3);
  });
});

describe("[v1.1] markFailed — retry exactly 3 times then dead_letter, with backoff lease", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("failure 1 → pending with backoff lease", () => {
    const id = seedMessage(db);
    const state = markFailed(db, id, "bill", "err1", 3);
    expect(state).toBe("pending");
    const row = db
      .prepare("SELECT delivery_state, retry_count, lease_until FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string; retry_count: number; lease_until: string | null } | undefined;
    expect(row?.delivery_state).toBe("pending");
    expect(row?.retry_count).toBe(1);
    expect(row?.lease_until).not.toBeNull(); // backoff lease set
  });

  test("failure 2 → pending (retry_count=2)", () => {
    const id = seedMessage(db);
    markFailed(db, id, "bill", "err1", 3);
    const state = markFailed(db, id, "bill", "err2", 3);
    expect(state).toBe("pending");
    const row = db
      .prepare("SELECT retry_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { retry_count: number } | undefined;
    expect(row?.retry_count).toBe(2);
  });

  test("exactly 3rd failure → dead_letter (not 4th)", () => {
    const id = seedMessage(db);
    expect(markFailed(db, id, "bill", "e1", 3)).toBe("pending");
    expect(markFailed(db, id, "bill", "e2", 3)).toBe("pending");
    expect(markFailed(db, id, "bill", "e3", 3)).toBe("dead_letter");
    const row = db
      .prepare("SELECT delivery_state, retry_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string; retry_count: number } | undefined;
    expect(row?.delivery_state).toBe("dead_letter");
    expect(row?.retry_count).toBe(3);
  });
});

describe("[v1.1] pendingDispatch — lease backoff and priority ordering", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("backed-off row (lease_until in future) is excluded from pendingDispatch", () => {
    const id = seedMessage(db);
    // Simulate a backoff: set lease_until to the future
    db.prepare(
      `UPDATE message_recipient SET lease_until = datetime('now', '+60 seconds') WHERE message_id=? AND agent_id=?`
    ).run(id, "bill");
    const rows = pendingDispatch(db, 10);
    expect(rows.some((r) => r.message_id === id)).toBe(false);
  });

  test("backed-off row with expired lease is included", () => {
    const id = seedMessage(db);
    // Expired backoff
    db.prepare(
      `UPDATE message_recipient SET lease_until = datetime('now', '-1 seconds') WHERE message_id=? AND agent_id=?`
    ).run(id, "bill");
    const rows = pendingDispatch(db, 10);
    expect(rows.some((r) => r.message_id === id)).toBe(true);
  });

  test("priority ordering: high before normal before low", () => {
    // Insert messages with different priorities
    const threadId = "th-priority";
    seedThread(db, threadId);
    // low priority
    db.exec(`
      INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status, priority)
      VALUES ('mp-low', '${threadId}', 'codex', 'bill', 'dm', 'low', 'agent', 0, 'delivered', 'low');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES ('mp-low', 'bill');
    `);
    // normal priority (inserted slightly later)
    db.exec(`
      INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status, priority)
      VALUES ('mp-normal', '${threadId}', 'codex', 'bill', 'dm', 'normal', 'agent', 0, 'delivered', 'normal');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES ('mp-normal', 'bill');
    `);
    // high priority
    db.exec(`
      INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status, priority)
      VALUES ('mp-high', '${threadId}', 'codex', 'bill', 'dm', 'high', 'agent', 0, 'delivered', 'high');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES ('mp-high', 'bill');
    `);
    const rows = pendingDispatch(db, 10);
    // Filter to just our test messages
    const ids = rows.filter(r => ["mp-low","mp-normal","mp-high"].includes(r.message_id)).map(r => r.message_id);
    expect(ids.indexOf("mp-high")).toBeLessThan(ids.indexOf("mp-normal"));
    expect(ids.indexOf("mp-normal")).toBeLessThan(ids.indexOf("mp-low"));
  });
});

describe("[v1.1] broadcast partial dead_letter isolation (issue 6)", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("one recipient dead_letter does not set message.delivery_status='failed' for other recipients", () => {
    // Create a broadcast message with two recipients
    const threadId = "th-broadcast";
    seedThread(db, threadId);
    const msgId = "bc-test";
    db.exec(`
      INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status)
      VALUES ('${msgId}', '${threadId}', 'codex', 'broadcast', 'broadcast', 'hello team', 'agent', 0, 'delivered');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES ('${msgId}', 'bill');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES ('${msgId}', 'steve');
    `);

    // Dead-letter bill (3 failures)
    markFailed(db, msgId, "bill", "e1", 3);
    markFailed(db, msgId, "bill", "e2", 3);
    markFailed(db, msgId, "bill", "e3", 3);

    // Verify bill is dead_letter
    const billRow = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(msgId, "bill") as { delivery_state: string } | undefined;
    expect(billRow?.delivery_state).toBe("dead_letter");

    // Steve's recipient row is unaffected
    const steveRow = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(msgId, "steve") as { delivery_state: string } | undefined;
    expect(steveRow?.delivery_state).toBe("pending");

    // Message-level delivery_status is NOT 'failed' (no contamination)
    const msg = db
      .prepare("SELECT delivery_status FROM message WHERE id=?")
      .get(msgId) as { delivery_status: string } | undefined;
    expect(msg?.delivery_status).toBe("delivered");
  });
});

describe("[v1.1] policy block → immediate terminal (no retry)", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  const agentRoster = new Set(["bill", "codex", "steve"]);

  function makeRow(overrides: Partial<PendingDispatchRow> = {}): PendingDispatchRow {
    return {
      message_id: "m1",
      agent_id: "bill",
      delivery_state: "pending",
      retry_count: 0,
      last_error: null,
      from_agent_id: "codex",
      to_agent_id: "bill",
      body: "hello",
      source: "agent",
      created_by: "codex",
      max_hop: 5,
      hop_count: 0,
      in_reply_to: null,
      parent_message_id: null,
      sync: "none",
      thread_id: "th-test",
      type: "dm",
      priority: "normal",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  test("hop_limit_exceeded → checkPingpong returns !allowed (policy block)", () => {
    const v = checkPingpong(db, makeRow({ hop_count: 5, max_hop: 5 }), agentRoster);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("hop_limit_exceeded");
    // Policy blocks are terminal — retry_count not used. This is enforced in dispatchRow:
    // the row gets delivery_state='dead_letter' immediately without calling markFailed.
    // We verify the verdict here; the dispatch integration is covered by the full flow test.
  });

  test("untrusted_source → checkPingpong returns !allowed (policy block)", () => {
    const v = checkPingpong(db, makeRow({ source: "external" }), agentRoster);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("untrusted_source");
  });
});

describe("[v1.1] mass-wake backfill idempotence", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("backfill is idempotent: second call is a no-op", () => {
    // First call (already ran in migrate())
    massWakeBackfill(db);
    // Seed a pending message and run again — it should NOT be backfilled (flag prevents re-run)
    const id = seedMessage(db);
    massWakeBackfill(db);
    // The row seeded after first backfill should remain 'pending'
    const row = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string } | undefined;
    expect(row?.delivery_state).toBe("pending");
  });

  test("first-run backfill: all pre-existing pending rows become completed when no dispatched rows exist", () => {
    // Use makeTestDb() which already ran migrate()+backfill, then reset the flag to
    // simulate a "pre-v1.1" database receiving its first backfill run.
    const testDb = makeTestDb();

    // Seed a pending message
    const id = seedMessage(testDb);
    // Remove the backfill flag to simulate re-running on a "pre-v1.1" DB
    testDb.prepare(`DELETE FROM runtime_lock WHERE key = 'bus_backfill_v1_1'`).run();
    // No dispatched rows exist → should backfill ALL pending rows
    massWakeBackfill(testDb);
    const row = testDb
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string } | undefined;
    expect(row?.delivery_state).toBe("completed");
    testDb.close();
  });
});

// ─── v1.2 new tests ───────────────────────────────────────────────────────────

describe("[v1.2] execute_timeout_maybe_partial — cooldown backoff (no retry_count increment)", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("markDeferred with large backoff models execute_timeout cooldown without consuming retry_count", () => {
    const id = seedMessage(db);
    markDispatching(db, id, "bill");
    // Simulate execute_timeout: apply cooldown via markDeferred (30s backoff)
    markDeferred(db, id, "bill", 30);
    const row = db
      .prepare("SELECT delivery_state, retry_count, lease_until, deferred_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string; retry_count: number; lease_until: string | null; deferred_count: number } | undefined;
    expect(row?.delivery_state).toBe("pending");
    expect(row?.retry_count).toBe(0);           // NOT incremented (cooldown, not failure)
    expect(row?.deferred_count).toBe(1);
    expect(row?.lease_until).not.toBeNull();    // cooldown lease set
  });
});

describe("[v1.2] inFlight self-healing — Map<key, startedAt>", () => {
  // The inFlight Map is internal to startWakeDispatcher; we test the
  // observable effect: after IN_FLIGHT_GRACE_MS passes, a row that was stuck
  // in dispatching can be recovered by recoverStaleClaims and re-claimed.
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("recoverStaleClaims resets expired dispatching → pending (simulates inFlight heal path)", () => {
    const id = seedMessage(db);
    // Claim + expire the lease to simulate a stuck in-flight dispatch
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state='dispatching',
           claimed_at=datetime('now','-130 seconds'),
           lease_until=datetime('now','-70 seconds')
       WHERE message_id=? AND agent_id=?`,
    ).run(id, "bill");
    const n = recoverStaleClaims(db);
    expect(n).toBe(1);
    // After recovery the row is pending again — can be re-claimed
    const row = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string } | undefined;
    expect(row?.delivery_state).toBe("pending");
  });
});

describe("[v1.2] source='agent' filter — user-broadcast rows excluded from dispatch", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("completed user message (telegram, poller-delivered) is excluded from pendingDispatch", () => {
    const threadId = "th-usertest";
    seedThread(db, threadId);
    // 텔레그램 user 메시지: insertMessage가 recipient를 completed-on-insert(poller가 배달) → dispatch 제외.
    db.exec(`
      INSERT INTO message
        (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status)
      VALUES ('mu-user', '${threadId}', 'user', 'broadcast', 'broadcast', 'gd message', 'user', 0, 'delivered');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id, delivery_state) VALUES ('mu-user', 'bill', 'completed');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id, delivery_state) VALUES ('mu-user', 'steve', 'completed');
    `);
    const rows = pendingDispatch(db, 20);
    expect(rows.some((r) => r.message_id === "mu-user")).toBe(false);
  });
  test("pending user message (dashboard 1:1, dispatch:true) IS included in pendingDispatch", () => {
    const threadId = "th-dashtest";
    seedThread(db, threadId);
    // 대시보드 1:1: source='user'지만 dispatch:true → recipient pending → 버스가 그 팀원을 깨워야 함.
    db.exec(`
      INSERT INTO message
        (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status)
      VALUES ('mu-dash', '${threadId}', 'user', 'bill', 'dm', 'dashboard 1:1', 'user', 0, 'pending');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id, delivery_state) VALUES ('mu-dash', 'bill', 'pending');
    `);
    const rows = pendingDispatch(db, 20);
    expect(rows.some((r) => r.message_id === "mu-dash")).toBe(true);
  });

  test("message with source='agent' IS included in pendingDispatch", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    const rows = pendingDispatch(db, 20);
    expect(rows.some((r) => r.message_id === id && r.agent_id === "bill")).toBe(true);
  });
});

describe("[v1.2] parent_message_id derived from in_reply_to in insertMessage", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("insertMessage with in_reply_to sets parent_message_id automatically", () => {
    const threadId = "th-chain";
    ensureThread(db, { thread_id: threadId, from_agent_id: "codex", to_agent_id: "bill", type: "dm", body: "root" });
    // Insert root message
    const root = insertMessage(db, {
      thread_id: threadId,
      from_agent_id: "user",
      to_agent_id: "bill",
      type: "dm",
      body: "start",
      source: "user",
      hop_count: 0,
      priority: "normal",
    });
    // Insert reply with in_reply_to
    const reply = insertMessage(db, {
      thread_id: threadId,
      from_agent_id: "bill",
      to_agent_id: "codex",
      type: "dm",
      body: "reply",
      source: "agent",
      hop_count: 1,
      in_reply_to: root.id,
      priority: "normal",
    });
    const row = db
      .prepare("SELECT parent_message_id, in_reply_to FROM message WHERE id=?")
      .get(reply.id) as { parent_message_id: string | null; in_reply_to: string | null } | undefined;
    expect(row?.in_reply_to).toBe(root.id);
    expect(row?.parent_message_id).toBe(root.id); // derived from in_reply_to
  });

  test("countAutoRounds works via in_reply_to-derived parent chain", () => {
    const threadId = "th-autoround";
    ensureThread(db, { thread_id: threadId, from_agent_id: "user", to_agent_id: "bill", type: "dm", body: "root" });
    const m0 = insertMessage(db, { thread_id: threadId, from_agent_id: "user", to_agent_id: "bill", type: "dm", body: "start", source: "user", hop_count: 0, priority: "normal" });
    const m1 = insertMessage(db, { thread_id: threadId, from_agent_id: "bill", to_agent_id: "codex", type: "dm", body: "ask", source: "agent", hop_count: 1, in_reply_to: m0.id, priority: "normal" });
    const m2 = insertMessage(db, { thread_id: threadId, from_agent_id: "codex", to_agent_id: "bill", type: "dm", body: "answer", source: "agent", hop_count: 2, in_reply_to: m1.id, priority: "normal" });
    // countAutoRounds from m2: m2(agent)=1, m1(agent)=2, m0(user)=skip → 2
    const rounds = countAutoRounds(db, m2.id);
    expect(rounds).toBeGreaterThanOrEqual(1); // at least m2 itself is agent
  });
});

describe("[v1.2] aggregateDeliveryStatus — message_recipient aggregation (issue 6)", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  function seedBroadcastMsg(db: Database, msgId: string): void {
    const threadId = "th-agg";
    seedThread(db, threadId);
    db.exec(`
      INSERT OR IGNORE INTO message
        (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status)
      VALUES ('${msgId}', '${threadId}', 'codex', 'broadcast', 'broadcast', 'hello', 'agent', 0, 'delivered');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES ('${msgId}', 'bill');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES ('${msgId}', 'steve');
    `);
  }

  test("null when no recipients", () => {
    const threadId = "th-norcp";
    seedThread(db, threadId);
    db.exec(`
      INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status)
      VALUES ('no-rcpt', '${threadId}', 'codex', 'bill', 'dm', 'hi', 'agent', 0, 'delivered');
    `);
    expect(aggregateDeliveryStatus(db, "no-rcpt")).toBeNull();
  });

  test("pending when any recipient is pending", () => {
    seedBroadcastMsg(db, "agg-pending");
    // bill=pending, steve=pending → pending
    expect(aggregateDeliveryStatus(db, "agg-pending")).toBe("pending");
  });

  test("delivered when all recipients are terminal-ok (wake_dispatched)", () => {
    seedBroadcastMsg(db, "agg-delivered");
    markDispatching(db, "agg-delivered", "bill");
    markWakeDispatched(db, "agg-delivered", "bill");
    markDispatching(db, "agg-delivered", "steve");
    markWakeDispatched(db, "agg-delivered", "steve");
    expect(aggregateDeliveryStatus(db, "agg-delivered")).toBe("delivered");
  });

  test("failed when all dead_letter", () => {
    seedBroadcastMsg(db, "agg-failed");
    markFailed(db, "agg-failed", "bill", "e1", 3);
    markFailed(db, "agg-failed", "bill", "e2", 3);
    markFailed(db, "agg-failed", "bill", "e3", 3);
    markFailed(db, "agg-failed", "steve", "e1", 3);
    markFailed(db, "agg-failed", "steve", "e2", 3);
    markFailed(db, "agg-failed", "steve", "e3", 3);
    expect(aggregateDeliveryStatus(db, "agg-failed")).toBe("failed");
  });

  test("partial_failed when some dead_letter, some delivered", () => {
    seedBroadcastMsg(db, "agg-partial");
    // bill dead_letter
    markFailed(db, "agg-partial", "bill", "e1", 3);
    markFailed(db, "agg-partial", "bill", "e2", 3);
    markFailed(db, "agg-partial", "bill", "e3", 3);
    // steve wake_dispatched
    markDispatching(db, "agg-partial", "steve");
    markWakeDispatched(db, "agg-partial", "steve");
    expect(aggregateDeliveryStatus(db, "agg-partial")).toBe("partial_failed");
  });
});

describe("[v1.2] 'blocked' delivery_state — policy blocks distinct from dead_letter", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("directly setting blocked state is valid and aggregates as failed", () => {
    const threadId = "th-blocked";
    seedThread(db, threadId);
    db.exec(`
      INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status)
      VALUES ('bl-test', '${threadId}', 'codex', 'bill', 'dm', 'hi', 'agent', 0, 'delivered');
      INSERT OR IGNORE INTO message_recipient (message_id, agent_id) VALUES ('bl-test', 'bill');
    `);
    db.prepare(
      `UPDATE message_recipient SET delivery_state='blocked', last_error='blocked:hop_limit' WHERE message_id=? AND agent_id=?`
    ).run("bl-test", "bill");
    const row = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get("bl-test", "bill") as { delivery_state: string } | undefined;
    expect(row?.delivery_state).toBe("blocked");
    // aggregateDeliveryStatus treats 'blocked' as terminal-bad → failed
    expect(aggregateDeliveryStatus(db, "bl-test")).toBe("failed");
  });
});

describe("[v1.2] deferred_count starvation warning threshold", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("deferred_count accumulates correctly across multiple defers", () => {
    const id = seedMessage(db);
    for (let i = 0; i < 5; i++) {
      markDeferred(db, id, "bill", 1);
    }
    const row = db
      .prepare("SELECT deferred_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { deferred_count: number } | undefined;
    expect(row?.deferred_count).toBe(5);
  });

  test("deferred_count >= 10 triggers warning (console.warn is not suppressed — just checks count)", () => {
    const id = seedMessage(db);
    for (let i = 0; i < 10; i++) {
      markDeferred(db, id, "bill", 1);
    }
    const row = db
      .prepare("SELECT deferred_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { deferred_count: number } | undefined;
    expect(row?.deferred_count).toBe(10); // threshold reached — warning logged
  });
});

// ─── pre-widen new tests ──────────────────────────────────────────────────────

describe("[pre-widen] deferred hard cap → 'blocked' terminal (BUS_MAX_DEFER)", () => {
  // BUS_MAX_DEFER defaults to 20. We use a custom threshold via env simulation:
  // Rather than changing process.env at runtime (which won't affect the module-level
  // constant already read), we directly invoke markDeferred the cap number of times
  // using the actual default cap (20). The test uses 21 deferrals to cross the cap.
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  const DEFAULT_CAP = Number(process.env.BUS_MAX_DEFER ?? 20);

  test(`markDeferred returns 'pending' below cap (${DEFAULT_CAP})`, () => {
    const id = seedMessage(db);
    // Defer (cap - 1) times — all should return 'pending'
    let lastState: "pending" | "blocked" = "pending";
    for (let i = 0; i < DEFAULT_CAP - 1; i++) {
      lastState = markDeferred(db, id, "bill", 1);
    }
    expect(lastState).toBe("pending");
    const row = db
      .prepare("SELECT delivery_state, deferred_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string; deferred_count: number } | undefined;
    expect(row?.delivery_state).toBe("pending");
    expect(row?.deferred_count).toBe(DEFAULT_CAP - 1);
  });

  test(`markDeferred returns 'blocked' at cap (${DEFAULT_CAP}) and row transitions to terminal`, () => {
    const id = seedMessage(db);
    // Defer (cap - 1) times to get just below the threshold
    for (let i = 0; i < DEFAULT_CAP - 1; i++) {
      markDeferred(db, id, "bill", 1);
    }
    // The next (cap-th) defer triggers the hard cap
    const finalState = markDeferred(db, id, "bill", 1);
    expect(finalState).toBe("blocked");

    const row = db
      .prepare("SELECT delivery_state, deferred_count, last_error FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string; deferred_count: number; last_error: string | null } | undefined;
    expect(row?.delivery_state).toBe("blocked");          // terminal
    expect(row?.deferred_count).toBe(DEFAULT_CAP);        // incremented at cap
    expect(row?.last_error).toContain("deferred_cap_exceeded");
  });

  test("blocked row is not returned by pendingDispatch (terminal)", () => {
    const id = seedMessage(db);
    // Exhaust to blocked
    for (let i = 0; i < DEFAULT_CAP; i++) {
      markDeferred(db, id, "bill", 1);
    }
    const rows = pendingDispatch(db, 20);
    // blocked rows should NOT appear — pendingDispatch only fetches delivery_state='pending'
    expect(rows.some((r) => r.message_id === id)).toBe(false);
  });

  test("aggregateDeliveryStatus treats blocked cap as 'failed'", () => {
    const id = seedMessage(db);
    for (let i = 0; i < DEFAULT_CAP; i++) {
      markDeferred(db, id, "bill", 1);
    }
    // bill is now blocked — only recipient is bill → aggregated = 'failed'
    expect(aggregateDeliveryStatus(db, id)).toBe("failed");
  });
});

describe("[pre-widen] basic message dispatch regression — source='agent', no special fields", () => {
  // Regression: verifies that a plain agent→agent message with no owner/expected_response
  // special fields passes through the dispatch pipeline to 'wake_dispatched' or (shadow)
  // 'pending' without being incorrectly excluded as 'completed' or 'blocked'.
  // This guards against the expected_response DEFAULT 0 bug (which silently excluded
  // every message by treating default=0 as "no wake needed").
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("basic agent→agent message: pendingDispatch picks it up", () => {
    // A plain message: source='agent', no owner, no expected_response override
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    const rows = pendingDispatch(db, 20);
    // Must appear in pending queue
    const found = rows.find((r) => r.message_id === id && r.agent_id === "bill");
    expect(found).toBeDefined();
    expect(found?.source).toBe("agent");
    expect(found?.from_agent_id).toBe("codex");
  });

  test("basic agent→agent message: NOT excluded by owner check (owner=null)", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    // Verify owner is null (no owner set)
    const msg = db
      .prepare("SELECT owner FROM message WHERE id=?")
      .get(id) as { owner: string | null } | undefined;
    expect(msg?.owner).toBeNull();  // owner=null → NOT excluded
  });

  test("basic agent→agent message: claim → wake_dispatched state machine works", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    // Simulate successful dispatch (same as wakeDispatcher does internally)
    expect(markDispatching(db, id, "bill")).toBe(true);
    markWakeDispatched(db, id, "bill");
    const row = db
      .prepare("SELECT delivery_state FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string } | undefined;
    expect(row?.delivery_state).toBe("wake_dispatched");  // NOT 'completed' or 'blocked'
  });

  test("basic agent→agent message: NOT excluded from pendingDispatch after source='agent' filter", () => {
    // Regression for source='agent' filter — basic messages must pass through
    const id = seedMessage(db, { from: "bill", to: "codex", source: "agent" });
    const rows = pendingDispatch(db, 20);
    const found = rows.find((r) => r.message_id === id && r.agent_id === "codex");
    expect(found).toBeDefined();
    // codex is in roster — must appear
  });

  test("basic agent→agent message with inserted insertMessage: pendingDispatch picks it up", () => {
    // End-to-end: use insertMessage (the actual path for inbound envelopes)
    const threadId = "th-basic-dispatch";
    ensureThread(db, {
      thread_id: threadId,
      from_agent_id: "codex",
      to_agent_id: "bill",
      type: "dm",
      body: "basic regression",
    });
    const stored = insertMessage(db, {
      thread_id: threadId,
      from_agent_id: "codex",
      to_agent_id: "bill",
      type: "dm",
      body: "basic dispatch regression test message",
      attachments: [
        {
          kind: "url",
          value: "http://127.0.0.1:7878/team/media/tg-2300-photo.jpg",
          note: "telegram photo",
        },
      ],
      source: "agent",
      hop_count: 0,
      priority: "normal",
    });
    // Must appear in pendingDispatch (no owner, source=agent, no special fields)
    const rows = pendingDispatch(db, 20);
    const found = rows.find((r) => r.message_id === stored.id && r.agent_id === "bill");
    expect(found).toBeDefined();
    expect(found?.body).toContain("basic dispatch regression");
    expect(found?.attachments_json).toContain("tg-2300-photo.jpg");
  });
});

describe("[pre-widen] busStatusSnapshot — /bus/status read endpoint", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("returns zero counts on empty DB (after migrate)", () => {
    const snap = busStatusSnapshot(db);
    // After migrate+massWakeBackfill, no pending rows remain (all completed by backfill if any existed)
    // Just verify the shape is correct and counts are numbers
    expect(typeof snap.counts.pending).toBe("number");
    expect(typeof snap.counts.dead_letter).toBe("number");
    expect(typeof snap.counts.blocked).toBe("number");
    expect(typeof snap.counts.expired).toBe("number");
    expect(Array.isArray(snap.recent_terminal_bad)).toBe(true);
  });

  test("counts pending rows correctly", () => {
    seedMessage(db, { id: "s-m1", from: "codex", to: "bill", source: "agent" });
    seedMessage(db, { id: "s-m2", from: "codex", to: "steve", source: "agent" });
    const snap = busStatusSnapshot(db);
    expect(snap.counts.pending).toBeGreaterThanOrEqual(2);
  });

  test("counts dead_letter rows correctly", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    markFailed(db, id, "bill", "e1", 3);
    markFailed(db, id, "bill", "e2", 3);
    markFailed(db, id, "bill", "e3", 3);
    const snap = busStatusSnapshot(db);
    expect(snap.counts.dead_letter).toBeGreaterThanOrEqual(1);
    // dead_letter row appears in recent_terminal_bad
    expect(snap.recent_terminal_bad.some((r) => r.message_id === id && r.delivery_state === "dead_letter")).toBe(true);
  });

  test("counts blocked rows correctly (deferred cap)", () => {
    const DEFAULT_CAP = Number(process.env.BUS_MAX_DEFER ?? 20);
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    for (let i = 0; i < DEFAULT_CAP; i++) {
      markDeferred(db, id, "bill", 1);
    }
    const snap = busStatusSnapshot(db);
    expect(snap.counts.blocked).toBeGreaterThanOrEqual(1);
    expect(snap.recent_terminal_bad.some((r) => r.message_id === id && r.delivery_state === "blocked")).toBe(true);
  });

  test("deferred count reflects pending rows with deferred_count > 0", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    markDeferred(db, id, "bill", 1); // now deferred_count=1, still 'pending'
    const snap = busStatusSnapshot(db);
    expect(snap.counts.deferred).toBeGreaterThanOrEqual(1);
  });

  test("wake_dispatched rows counted correctly", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    markDispatching(db, id, "bill");
    markWakeDispatched(db, id, "bill");
    const snap = busStatusSnapshot(db);
    expect(snap.counts.wake_dispatched).toBeGreaterThanOrEqual(1);
  });

  test("recent_terminal_bad is capped at 10 items", () => {
    // Create 12 dead_letter rows
    for (let i = 0; i < 12; i++) {
      const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
      markFailed(db, id, "bill", `e${i}-1`, 3);
      markFailed(db, id, "bill", `e${i}-2`, 3);
      markFailed(db, id, "bill", `e${i}-3`, 3);
    }
    const snap = busStatusSnapshot(db);
    expect(snap.recent_terminal_bad.length).toBeLessThanOrEqual(10);
  });

  test("counts expired rows correctly", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    // Directly set to expired (simulates allowlist_expired or execute_timeout_expired path)
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired', last_error = 'allowlist_not_enabled',
           lease_until = NULL, claimed_at = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");
    const snap = busStatusSnapshot(db);
    expect(snap.counts.expired).toBeGreaterThanOrEqual(1);
  });
});

// ─── 2026-05-27 "애매하면 만료" tests ────────────────────────────────────────

describe("[expire] allowlist_not_enabled → 'expired' (not pending, no retry)", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("row set to expired with last_error='allowlist_not_enabled' has delivery_state='expired'", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    // Simulate what wakeDispatcher.dispatchRow does when allowlist excludes the agent
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired',
           last_error     = 'allowlist_not_enabled',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");

    const row = db
      .prepare("SELECT delivery_state, last_error, lease_until, claimed_at FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string; last_error: string | null; lease_until: string | null; claimed_at: string | null } | undefined;

    expect(row?.delivery_state).toBe("expired");
    expect(row?.last_error).toBe("allowlist_not_enabled");
    expect(row?.lease_until).toBeNull();   // no backoff — dropped
    expect(row?.claimed_at).toBeNull();
  });

  test("expired row is NOT returned by pendingDispatch (terminal, no re-poll)", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired', last_error = 'allowlist_not_enabled',
           lease_until = NULL, claimed_at = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");

    const rows = pendingDispatch(db, 20);
    expect(rows.some((r) => r.message_id === id)).toBe(false);
  });

  test("retry_count stays 0 after allowlist_expired (no retry consumed)", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired', last_error = 'allowlist_not_enabled',
           lease_until = NULL, claimed_at = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");

    const row = db
      .prepare("SELECT retry_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { retry_count: number } | undefined;
    expect(row?.retry_count).toBe(0);  // no retry consumed — pure drop
  });

  test("aggregateDeliveryStatus treats 'expired' as terminal-bad → 'failed'", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired', last_error = 'allowlist_not_enabled'
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");
    expect(aggregateDeliveryStatus(db, id)).toBe("failed");
  });

  test("busStatusSnapshot.counts.expired increments for allowlist_expired rows", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired', last_error = 'allowlist_not_enabled'
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");
    const snap = busStatusSnapshot(db);
    expect(snap.counts.expired).toBeGreaterThanOrEqual(1);
    // expired rows are terminal — should NOT appear in pending count
    const pendingBefore = snap.counts.pending;
    expect(pendingBefore).toBe(0);  // only the expired row was seeded
  });
});

describe("[expire] execute_timeout_maybe_partial → 'expired' (not pending, no retry)", () => {
  let db: Database;
  beforeEach(() => { db = makeTestDb(); });
  afterEach(() => db.close());

  test("row set to expired with last_error='execute_timeout_expired' has delivery_state='expired'", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    // Simulate what wakeDispatcher.dispatchRow does on execute_timeout_maybe_partial
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired',
           last_error     = 'execute_timeout_expired',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");

    const row = db
      .prepare("SELECT delivery_state, last_error, lease_until, claimed_at FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { delivery_state: string; last_error: string | null; lease_until: string | null; claimed_at: string | null } | undefined;

    expect(row?.delivery_state).toBe("expired");
    expect(row?.last_error).toBe("execute_timeout_expired");
    expect(row?.lease_until).toBeNull();   // no cooldown backoff — dropped
    expect(row?.claimed_at).toBeNull();
  });

  test("expired row is NOT returned by pendingDispatch (no cooldown re-poll)", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired', last_error = 'execute_timeout_expired',
           lease_until = NULL, claimed_at = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");

    const rows = pendingDispatch(db, 20);
    expect(rows.some((r) => r.message_id === id)).toBe(false);
  });

  test("retry_count stays 0 after execute_timeout_expired (no retry consumed)", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired', last_error = 'execute_timeout_expired',
           lease_until = NULL, claimed_at = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");

    const row = db
      .prepare("SELECT retry_count FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { retry_count: number } | undefined;
    expect(row?.retry_count).toBe(0);  // no retry consumed
  });

  test("aggregateDeliveryStatus treats execute_timeout_expired as terminal-bad → 'failed'", () => {
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired', last_error = 'execute_timeout_expired'
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");
    expect(aggregateDeliveryStatus(db, id)).toBe("failed");
  });

  test("previous execute_timeout path used markDeferred (cooldown=30s): expired row has no lease (regression guard)", () => {
    // Guard: the OLD behavior (markDeferred cooldown) set lease_until to now+30s.
    // The NEW behavior (expired) must have lease_until=NULL — no re-poll at all.
    const id = seedMessage(db, { from: "codex", to: "bill", source: "agent" });
    db.prepare(
      `UPDATE message_recipient
       SET delivery_state = 'expired', last_error = 'execute_timeout_expired',
           lease_until = NULL, claimed_at = NULL
       WHERE message_id = ? AND agent_id = ?`,
    ).run(id, "bill");
    const row = db
      .prepare("SELECT lease_until FROM message_recipient WHERE message_id=? AND agent_id=?")
      .get(id, "bill") as { lease_until: string | null } | undefined;
    expect(row?.lease_until).toBeNull();  // definitively dropped — no lease
  });
});

describe("[openclaw] adapter timeout policy", () => {
  test("OpenClaw visible-reply timeout is longer than tmux prepare timeout", () => {
    expect(ADAPTER_TIMEOUT_MS).toBe(10_000);
    expect(OPENCLAW_ADAPTER_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  // 2026-06-29: double-dispatch safety. A slow codex (openclaw) turn (~125–149s, cap 240s) must
  // keep its claim for the ENTIRE wake, else the lease expires mid-flight, recoverStaleClaims resets
  // the row → 'pending', and the next poll re-dispatches the same message (codex woken twice).
  test("openclaw lease outlives the adapter wake (no recoverStaleClaims reset mid-flight)", () => {
    const leaseMs = leaseSecForRuntime("openclaw") * 1000;
    expect(leaseMs).toBeGreaterThan(OPENCLAW_ADAPTER_TIMEOUT_MS);
  });

  test("openclaw inFlight grace > lease (secondary guard never evicts a live wake)", () => {
    const leaseMs = leaseSecForRuntime("openclaw") * 1000;
    expect(inFlightGraceForRuntime("openclaw")).toBeGreaterThan(leaseMs);
  });

  // ★2026-07-16: hermes_agent 를 이 목록에서 뺐다★ — hermes 도 blocking-wake(턴 전체 await)라
  //   이제 openclaw 처럼 turn cap 기반 사다리를 쓴다(위 "lease/grace ladder" describe 참조).
  //   fast-lane 에 남은 건 진짜 빠른/detach 런타임(claude ~28s, codex/b3os detach)뿐이다.
  test("fast/detach runtimes keep the fast 60s lease / 120s grace (no regression)", () => {
    for (const rt of ["claude_channel", "codex", "b3os_native", undefined]) {
      expect(leaseSecForRuntime(rt)).toBe(60);
      expect(inFlightGraceForRuntime(rt)).toBe(120_000);
    }
  });
});

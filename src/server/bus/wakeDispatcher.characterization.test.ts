/**
 * Characterization tests for wakeDispatcher.dispatchRow — Stage ③, locks in CURRENT behavior
 * before the planned ④ split (dispatchRow → claim → plan → invoke → record).
 *
 * Scope = the GAP left by wakeDispatcher.test.ts (which covers DB-level dispatch funcs +
 * antiPingpong, but NOT dispatchRow's own plan/invoke/record branching):
 *   - resolveDirectToGd  (export, 0 prior direct tests)
 *   - dispatchRow PLAN early-returns: unknown agent, owner-set, broadcast-no-marker, unsupported runtime
 *   - dispatchRow INVOKE+RECORD: ok→wake_dispatched, deferred→markDeferred, claude fail→retry,
 *     openclaw fail→expired(no-retry), unknown-side-effect→expired, exception(claude vs openclaw)
 *
 * Boundary mock (Devon guidance): adapters are INJECTED into dispatchRow — no real tmux/openclaw/
 * hermes is ever called. claim itself stays in the worker/tick (NOT exercised here).
 *
 * NOTE: dispatchRow only reaches invoke/record when dispatch is enabled. As of ④ that gate is read
 * at CALL TIME (isDispatchEnabled() → process.env), so beforeEach sets BUS_DISPATCH_ENABLED=true and
 * every branch runs under a plain `bun test` (no isolation / describe.skip needed). Env is restored
 * in afterAll. shadow(enabled=false) behavior is out of scope here (left to existing tests).
 */
import { describe, test, expect, beforeEach, afterAll, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { insertMessage } from "../db/inboxQueries";
import { dispatchRow, resolveDirectToGd, isCollectOnlyFeedbackReply } from "./wakeDispatcher";
import type { PendingDispatchRow, WakeAdapter, WakeResult } from "./types";

type DB = InstanceType<typeof Database>;

// dispatchRow reads the dispatch-enable gate at CALL TIME (isDispatchEnabled() → process.env), so
// setting BUS_DISPATCH_ENABLED in beforeEach makes the post-shadow branches (allowlist/broadcast/
// adapter/invoke/record) run regardless of module load order — no dynamic import / describe.skip
// needed. BUS_DISPATCH_AGENTS unset → allowlist=null (allowlist branch passes through).
// Env is restored after this file to avoid leaking into other suites.
const PREV_ENABLED = process.env.BUS_DISPATCH_ENABLED;
const PREV_AGENTS = process.env.BUS_DISPATCH_AGENTS;
// ★테스트 격리: 실 운영 allowlist(process.cwd()/var/bus-wake-extra.txt, 내용=lui/devon/…)를 읽으면
//   fixture(bill/codex/steve)가 제외돼 allowlist_not_enabled로 9fail. 존재하지 않는 경로로 override → extra=[] → allowlist=null(pass-through). Codex 진단, GD 2026-07-01.
const PREV_WAKE_EXTRA = process.env.TEAMOS_BUS_WAKE_EXTRA_FILE;
process.env.TEAMOS_BUS_WAKE_EXTRA_FILE = "/tmp/.teamos-bus-wake-extra-characterization-noexist";
afterAll(() => {
  if (PREV_ENABLED === undefined) delete process.env.BUS_DISPATCH_ENABLED;
  else process.env.BUS_DISPATCH_ENABLED = PREV_ENABLED;
  if (PREV_AGENTS === undefined) delete process.env.BUS_DISPATCH_AGENTS;
  else process.env.BUS_DISPATCH_AGENTS = PREV_AGENTS;
  if (PREV_WAKE_EXTRA === undefined) delete process.env.TEAMOS_BUS_WAKE_EXTRA_FILE;
  else process.env.TEAMOS_BUS_WAKE_EXTRA_FILE = PREV_WAKE_EXTRA;
});

const noopAdapter: WakeAdapter = { async wake(): Promise<WakeResult> { return { ok: false, detail: "noop_should_not_be_called" }; } };
const spyAdapter = (impl: () => Promise<WakeResult> | WakeResult) => {
  let calls = 0;
  return {
    adapter: { async wake() { calls++; return impl(); } } as WakeAdapter,
    get calls() { return calls; },
  };
};

function setup(): DB {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.exec(`
    INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file) VALUES
      ('bill','Bill','dev','claude_channel','claude_tmux','/dev/null','/dev/null'),
      ('codex','Codex','step','openclaw','openclaw_gateway','/dev/null','/dev/null'),
      ('steve','Steve','dev','claude_channel','claude_tmux','/dev/null','/dev/null');
    UPDATE agent SET tmux_session='claude-bill' WHERE id='bill';
    UPDATE agent SET tmux_session='claude-steve' WHERE id='steve';
    INSERT INTO thread (id,title,kind,participants_json,opened_by) VALUES ('t1','t','dm','["steve","bill"]','steve');
  `);
  return db;
}

const agentsOf = (db: DB) =>
  db.prepare(`SELECT id, display_name, role, runtime, status_provider, tmux_session, telegram_bot_username, workspace_path, persona_file FROM agent`).all() as never[];

// build a PendingDispatchRow (message_recipient ⨝ message) for a given message+recipient
function rowOf(db: DB, messageId: string, agentId: string): PendingDispatchRow {
  return db.prepare(
    `SELECT mr.message_id, mr.agent_id, mr.delivery_state, mr.retry_count, mr.last_error,
            m.from_agent_id, m.to_agent_id, m.body, m.source,
            COALESCE(m.created_by,m.from_agent_id) AS created_by, COALESCE(m.max_hop,5) AS max_hop,
            m.hop_count, m.in_reply_to, m.parent_message_id, COALESCE(m.sync,'none') AS sync,
            m.thread_id, m.type, m.created_at, COALESCE(m.priority,'normal') AS priority, m.meta_json
     FROM message_recipient mr JOIN message m ON m.id=mr.message_id
     WHERE mr.message_id=? AND mr.agent_id=?`,
  ).get(messageId, agentId) as PendingDispatchRow;
}

// insert a directed agent→target message and return its claimed PendingDispatchRow
function pendingRowFor(db: DB, target: string, over: Record<string, unknown> = {}): PendingDispatchRow {
  const env = insertMessage(db, { thread_id: "t1", from_agent_id: "steve", to_agent_id: target, body: "ping", source: "agent", type: "dm", ...over } as never);
  return rowOf(db, env.id, target);
}

const rcpt = (db: DB, mid: string, aid: string) =>
  db.prepare(`SELECT delivery_state, last_error, retry_count, deferred_count FROM message_recipient WHERE message_id=? AND agent_id=?`).get(mid, aid) as
    { delivery_state: string; last_error: string | null; retry_count: number; deferred_count: number } | undefined;

const dispatch = (db: DB, row: PendingDispatchRow, a: Partial<{ claude: WakeAdapter; openclaw: WakeAdapter; hermes: WakeAdapter; b3osNative: WakeAdapter; codex: WakeAdapter }>) =>
  dispatchRow(db, row, agentsOf(db), a.claude ?? noopAdapter, a.openclaw ?? noopAdapter, a.hermes ?? noopAdapter, a.b3osNative ?? noopAdapter, a.codex ?? noopAdapter, null);

let db: DB;
beforeEach(() => {
  db = setup();
  process.env.BUS_DISPATCH_ENABLED = "true"; // call-time gate → invoke/record branches run
  delete process.env.BUS_DISPATCH_AGENTS; // allowlist=null
});

// ─── resolveDirectToGd (pure) ────────────────────────────────────────────────
describe("resolveDirectToGd", () => {
  const row = (over: Record<string, unknown>): PendingDispatchRow => ({ thread_id: "abc123", meta_json: null, ...over } as PendingDispatchRow);

  // 2026-07-08 GD: direct_to_gd 타겟 = GD 1:1 DM(ownerChatId). 그룹 아님. source_thread_id 무시.
  test("direct_to_gd meta + ownerChatId → GD DM {threadId, groupId}", () => {
    const r = row({ meta_json: JSON.stringify({ reply_mode: "direct_to_gd", source_thread_id: "tg-12345" }) });
    expect(resolveDirectToGd(r, "1000000001")).toEqual({ threadId: "dm-1000000001", groupId: "1000000001" });
  });
  test("direct_to_gd 인데 ownerChatId 없음 → null", () => {
    expect(resolveDirectToGd(row({ meta_json: JSON.stringify({ reply_mode: "direct_to_gd", source_thread_id: "tg-1" }) }))).toBeNull();
  });
  test("thread already on tg- telegram path → null", () => {
    expect(resolveDirectToGd(row({ thread_id: "tg-999", meta_json: JSON.stringify({ reply_mode: "direct_to_gd", source_thread_id: "tg-1" }) }), "1000000001")).toBeNull();
  });
  test("no meta_json → null", () => {
    expect(resolveDirectToGd(row({}), "1000000001")).toBeNull();
  });
  test("wrong reply_mode → null", () => {
    expect(resolveDirectToGd(row({ meta_json: JSON.stringify({ reply_mode: "normal", source_thread_id: "tg-1" }) }), "1000000001")).toBeNull();
  });
  test("source_thread_id 무관 — ownerChatId 있으면 DM 반환", () => {
    expect(resolveDirectToGd(row({ meta_json: JSON.stringify({ reply_mode: "direct_to_gd", source_thread_id: "x1" }) }), "1000000001")?.groupId).toBe("1000000001");
  });
});

// ─── 3c: wake 경계 (팀 커뮤니케이션 재사용 comm 테스트, GD 2026-07-09) ──────────────
// 설계문서 team-comm-ingress-owner-gate-design §3c/§4: 이 경계를 테스트로 고정(회귀방지).
// Codex 적대리뷰 확인: directed→requester wake / broadcast no-marker→no-wake.
describe("3c wake 경계 — comm 매트릭스", () => {
  test("directed 메시지 → 수신자 wake (adapter 호출됨)", async () => {
    const row = pendingRowFor(db, "codex"); // steve→codex directed dm
    const spy = spyAdapter(() => ({ ok: true, detail: "woke" }));
    await dispatch(db, row, { openclaw: spy.adapter });
    expect(spy.calls).toBe(1); // directed = 항상 wake (wakeDispatcher:816)
  });

  test("broadcast(no @all/@b3rys/@group 마커) → no-wake (inbox-only)", async () => {
    const row = pendingRowFor(db, "codex", { to_agent_id: "broadcast", type: "broadcast", body: "팀 참고만" });
    const spy = spyAdapter(() => ({ ok: true }));
    await dispatch(db, row, { openclaw: spy.adapter });
    expect(spy.calls).toBe(0); // 마커 없는 broadcast = inbox-only, no wake
    expect(rcpt(db, row.message_id, "codex")?.last_error).toBe("broadcast_inbox_only_no_wake_marker");
  });

  test("broadcast + @all 마커 → wake (마커 있으면 깨움)", async () => {
    const row = pendingRowFor(db, "codex", { to_agent_id: "broadcast", type: "broadcast", body: "@all 다들 확인" });
    const spy = spyAdapter(() => ({ ok: true }));
    await dispatch(db, row, { openclaw: spy.adapter });
    expect(spy.calls).toBe(1); // @all 마커 = wake
  });

  // collect_only 경계 (Codex 적대리뷰 §3c): 수집형 위임 응답은 coordinator wake 억제, 일반 directed Q&A는 wake.
  const cRow = (over: Record<string, unknown>): PendingDispatchRow =>
    ({ agent_id: "bill", to_agent_id: "bill", type: "reply", thread_id: "t1", in_reply_to: null, parent_message_id: null, meta_json: null, ...over } as PendingDispatchRow);
  test("collect_only: coordinator에게 reply + feedback thread → no-wake(true)", () => {
    expect(isCollectOnlyFeedbackReply(db, cRow({ thread_id: "feedback-abc" }), "bill")).toBe(true);
  });
  test("collect_only: 일반 directed(non-coordinator) → wake(false)", () => {
    expect(isCollectOnlyFeedbackReply(db, cRow({ agent_id: "codex", to_agent_id: "codex", type: "dm" }), "bill")).toBe(false);
  });
  test("collect_only: coordinator라도 type!=reply → wake(false)", () => {
    expect(isCollectOnlyFeedbackReply(db, cRow({ type: "dm", thread_id: "feedback-x" }), "bill")).toBe(false);
  });
});

// ─── dispatchRow: PLAN early-returns (enabled-independent — run before shadow gate) ──────────
describe("dispatchRow — plan early-returns (enabled-independent)", () => {
  test("unknown agent (not in roster) → dead_letter, adapter NOT called", async () => {
    const base = pendingRowFor(db, "bill");
    const ghost = { ...base, agent_id: "ghost" };
    const claude = spyAdapter(() => ({ ok: true }));
    await dispatch(db, ghost, { claude: claude.adapter });
    expect(claude.calls).toBe(0);
    // ghost has no recipient row; behavior recorded against message_id+ghost (none) — assert no crash + bill row untouched-pending
    expect(rcpt(db, base.message_id, "bill")?.delivery_state).toBe("pending");
  });

  test("owner-designated message (owner set) → completed, no auto-wake", async () => {
    const row = pendingRowFor(db, "bill");
    db.prepare(`UPDATE message SET owner='bill' WHERE id=?`).run(row.message_id);
    const claude = spyAdapter(() => ({ ok: true }));
    await dispatch(db, row, { claude: claude.adapter });
    expect(claude.calls).toBe(0);
    const r = rcpt(db, row.message_id, "bill");
    expect(r?.delivery_state).toBe("completed");
    expect(r?.last_error).toBe("no_auto_wake:owner_set");
  });
});

// ─── dispatchRow: PLAN branches AFTER the shadow gate (need BUS_DISPATCH_ENABLED=true) ───────
describe("dispatchRow — plan (needs dispatch enabled)", () => {
  test("broadcast without @all marker → completed (inbox-only), no wake", async () => {
    // broadcast fans out to real members (recipient agent_id != 'broadcast'); pick one.
    const env = insertMessage(db, { thread_id: "t1", from_agent_id: "steve", to_agent_id: "broadcast", type: "broadcast", body: "팀 공지인데 마커 없음", source: "agent" } as never);
    const target = (db.prepare(`SELECT agent_id FROM message_recipient WHERE message_id=? LIMIT 1`).get(env.id) as { agent_id: string }).agent_id;
    const row = rowOf(db, env.id, target);
    const claude = spyAdapter(() => ({ ok: true }));
    await dispatch(db, row, { claude: claude.adapter });
    expect(claude.calls).toBe(0);
    const r = rcpt(db, env.id, target);
    expect(r?.delivery_state).toBe("completed");
    expect(r?.last_error).toBe("broadcast_inbox_only_no_wake_marker");
  });

  test("unsupported runtime → dead_letter, adapter NOT called", async () => {
    // agent.runtime is CHECK-constrained to claude_channel/openclaw/hermes_agent in the DB, so an
    // unsupported runtime can't exist as a real row. Inject a tampered roster to exercise the guard.
    const row = pendingRowFor(db, "bill");
    const roster = (agentsOf(db) as Array<{ id: string; runtime: string }>).map((a) =>
      a.id === "bill" ? { ...a, runtime: "weird_runtime" } : a,
    );
    const claude = spyAdapter(() => ({ ok: true }));
    await dispatchRow(db, row, roster as never[], claude.adapter, noopAdapter, noopAdapter, noopAdapter, noopAdapter, null);
    expect(claude.calls).toBe(0);
    const r = rcpt(db, row.message_id, "bill");
    expect(r?.delivery_state).toBe("dead_letter");
    expect(r?.last_error).toBe("unsupported_runtime");
  });
});

// ─── dispatchRow: INVOKE + RECORD (need BUS_DISPATCH_ENABLED=true) ────────────
describe("dispatchRow — invoke + record", () => {
  test("adapter ok → wake_dispatched", async () => {
    const row = pendingRowFor(db, "bill");
    const claude = spyAdapter(() => ({ ok: true, detail: "mock" }));
    await dispatch(db, row, { claude: claude.adapter });
    expect(claude.calls).toBe(1);
    expect(rcpt(db, row.message_id, "bill")?.delivery_state).toBe("wake_dispatched");
  });

  test("adapter deferred → markDeferred (pending, deferred_count++, retry_count stays 0)", async () => {
    const row = pendingRowFor(db, "bill");
    await dispatch(db, row, { claude: { async wake() { return { ok: false, deferred: true, detail: "lock_busy" }; } } });
    const r = rcpt(db, row.message_id, "bill");
    expect(r?.delivery_state).toBe("pending");
    expect(r?.deferred_count).toBe(1);
    expect(r?.retry_count).toBe(0);
  });

  test("claude adapter returns false → markFailed (retry, pending)", async () => {
    const row = pendingRowFor(db, "bill");
    await dispatch(db, row, { claude: { async wake() { return { ok: false, detail: "tmux_inject_returned_false" }; } } });
    const r = rcpt(db, row.message_id, "bill");
    expect(r?.delivery_state).toBe("pending");
    expect(r?.retry_count).toBe(1);
  });

  test("unknown-side-effect (execute_timeout_maybe_partial) → expired, no retry", async () => {
    const row = pendingRowFor(db, "bill");
    await dispatch(db, row, { claude: { async wake() { return { ok: false, detail: "execute_timeout_maybe_partial" }; } } });
    const r = rcpt(db, row.message_id, "bill");
    expect(r?.delivery_state).toBe("expired");
    expect(r?.last_error).toBe("execute_timeout_expired");
  });

  test("openclaw adapter returns false → expired (no-retry), NOT markFailed", async () => {
    const row = pendingRowFor(db, "codex");
    await dispatch(db, row, { openclaw: { async wake() { return { ok: false, detail: "gateway_500" }; } } });
    const r = rcpt(db, row.message_id, "codex");
    expect(r?.delivery_state).toBe("expired");
    expect(String(r?.last_error)).toContain("openclaw_no_retry");
    expect(r?.retry_count).toBe(0); // no retry consumed
  });

  test("claude adapter throws → markFailed (retry)", async () => {
    const row = pendingRowFor(db, "bill");
    await dispatch(db, row, { claude: { async wake() { throw new Error("boom"); } } });
    const r = rcpt(db, row.message_id, "bill");
    expect(r?.delivery_state).toBe("pending");
    expect(r?.retry_count).toBe(1);
  });

  test("openclaw adapter throws → expired (no-retry exception)", async () => {
    const row = pendingRowFor(db, "codex");
    await dispatch(db, row, { openclaw: { async wake() { throw new Error("kaboom"); } } });
    const r = rcpt(db, row.message_id, "codex");
    expect(r?.delivery_state).toBe("expired");
    expect(String(r?.last_error)).toContain("openclaw_no_retry_exception");
  });
});

// ─── ack-only wake-gate: bare ack reply 는 상대를 깨우지 않는다(왕복/토큰 축소, GD 2026-07-09) ───
describe("dispatchRow — ack_only wake-gate (team-comm 왕복 축소)", () => {
  // bill 이 steve 의 요청에 짧은 ack 로 답 → steve 를 full wake 하지 않고 inbox-only.
  function replyFromBillToSteve(body: string): PendingDispatchRow {
    const parent = insertMessage(db, { thread_id: "t1", from_agent_id: "steve", to_agent_id: "bill", body: "X 해줘", source: "agent", type: "dm" } as never);
    return pendingRowFor(db, "steve", { from_agent_id: "bill", type: "reply", in_reply_to: parent.id, body });
  }

  test("ack-only reply ('네 확인했습니다') → completed inbox-only, adapter NOT called", async () => {
    const reply = replyFromBillToSteve("네 확인했습니다");
    const claude = spyAdapter(() => ({ ok: true }));
    await dispatch(db, reply, { claude: claude.adapter });
    expect(claude.calls).toBe(0); // steve 안 깨움 → ack 핑퐁 제거
    const r = rcpt(db, reply.message_id, "steve");
    expect(r?.delivery_state).toBe("completed");
    expect(r?.last_error).toBe("ack_only_reply_no_wake");
  });

  test("pure emoji ack ('👍') → completed inbox-only, no wake", async () => {
    const reply = replyFromBillToSteve("👍");
    const claude = spyAdapter(() => ({ ok: true }));
    await dispatch(db, reply, { claude: claude.adapter });
    expect(claude.calls).toBe(0);
    expect(rcpt(db, reply.message_id, "steve")?.last_error).toBe("ack_only_reply_no_wake");
  });

  test("substantive reply → still wakes (actionable, 정보 있음)", async () => {
    const reply = replyFromBillToSteve("분석해보니 원인은 A 라서 B 로 처리하는 게 맞을 것 같아 의견 줘");
    const claude = spyAdapter(() => ({ ok: true }));
    await dispatch(db, reply, { claude: claude.adapter });
    expect(claude.calls).toBe(1); // substantive → steve 깨움
    expect(rcpt(db, reply.message_id, "steve")?.delivery_state).toBe("wake_dispatched");
  });

  test("explicit_done reply ('완료했습니다') → still wakes (완료는 상대가 알아야 함)", async () => {
    const reply = replyFromBillToSteve("완료했습니다");
    const claude = spyAdapter(() => ({ ok: true }));
    await dispatch(db, reply, { claude: claude.adapter });
    expect(claude.calls).toBe(1);
    expect(rcpt(db, reply.message_id, "steve")?.delivery_state).toBe("wake_dispatched");
  });

  test("신규 task(type dm), reply 아님 → 짧아도 wake (gate 는 reply 에만)", async () => {
    const row = pendingRowFor(db, "bill", { body: "네" }); // 짧지만 type=dm
    const claude = spyAdapter(() => ({ ok: true }));
    await dispatch(db, row, { claude: claude.adapter });
    expect(claude.calls).toBe(1); // reply 아님 → gate 미적용, 정상 wake
    expect(rcpt(db, row.message_id, "bill")?.delivery_state).toBe("wake_dispatched");
  });
});

// ─── ack-loop guard (deterministic (thread,from→to) pair 카운트, GD 2026-07-09) ───
describe("dispatchRow — ack_loop guard (deterministic)", () => {
  afterEach(() => { delete process.env.ACK_LOOP_GUARD; delete process.env.ACK_LOOP_GUARD_SHADOW; });
  const steveToBill = (body: string): PendingDispatchRow => {
    const env = insertMessage(db, { thread_id: "t1", from_agent_id: "steve", to_agent_id: "bill", body, source: "agent", type: "dm" } as never);
    return rowOf(db, env.id, "bill");
  };

  test("enforce(CAP=1): 같은 (thread,steve→bill) 2번째부터 inbox-only, 1st 만 wake", async () => {
    process.env.ACK_LOOP_GUARD = "true";
    const r1 = steveToBill("첫 요청 — 실제 내용");
    const r2 = steveToBill("동의합니다 맞장구"); // prior=1 → 차단
    const r3 = steveToBill("확인했습니다 재정리"); // prior=2 → 차단
    const claude = spyAdapter(() => ({ ok: true }));
    await dispatch(db, r1, { claude: claude.adapter });
    await dispatch(db, r2, { claude: claude.adapter });
    await dispatch(db, r3, { claude: claude.adapter });
    expect(claude.calls).toBe(1); // 첫 것만 wake (위임/첫답/종합)
    expect(rcpt(db, r2.message_id, "bill")?.last_error).toBe("ack_loop_guard_no_wake");
    expect(rcpt(db, r3.message_id, "bill")?.last_error).toBe("ack_loop_guard_no_wake");
  });

  test("shadow: 3번째도 실제 wake(안 막음), audit 만 — 검증용", async () => {
    process.env.ACK_LOOP_GUARD_SHADOW = "true";
    const rows = [steveToBill("a 내용"), steveToBill("b 내용"), steveToBill("c 내용")];
    const claude = spyAdapter(() => ({ ok: true }));
    for (const r of rows) await dispatch(db, r, { claude: claude.adapter });
    expect(claude.calls).toBe(3); // shadow 는 실제로 막지 않음 (전달 유지 증명)
  });

  test("다른 recipient(steve→codex)는 별개 카운트 — 크로스 영향 없음", async () => {
    process.env.ACK_LOOP_GUARD = "true";
    // steve→bill 2 (통과) + steve→codex 1 (bill 카운트와 무관 → 통과)
    await dispatch(db, steveToBill("x"), { claude: spyAdapter(() => ({ ok: true })).adapter });
    await dispatch(db, steveToBill("y"), { claude: spyAdapter(() => ({ ok: true })).adapter });
    const cEnv = insertMessage(db, { thread_id: "t1", from_agent_id: "steve", to_agent_id: "codex", body: "z", source: "agent", type: "dm" } as never);
    const cRow = rowOf(db, cEnv.id, "codex");
    const oc = spyAdapter(() => ({ ok: true })); // codex 에이전트 runtime=openclaw → openclaw 어댑터
    await dispatch(db, cRow, { openclaw: oc.adapter });
    expect(oc.calls).toBe(1); // steve→codex 첫 발신 → wake (bill 쌍과 별개)
  });

  test("flag off → 가드 미작동 (기존 동작)", async () => {
    const rows = [steveToBill("p"), steveToBill("q"), steveToBill("r")];
    const claude = spyAdapter(() => ({ ok: true }));
    for (const r of rows) await dispatch(db, r, { claude: claude.adapter });
    expect(claude.calls).toBe(3); // flag 없으면 다 wake
  });
});

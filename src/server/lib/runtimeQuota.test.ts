import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb, migrate } from "../db/migrate";
import { ensureThread } from "../db/inbox/messages";
import { classifyAll, classifyHealth, QUOTA_REASON } from "./health";
import {
  clearQuotaBlocked,
  getQuotaBlock,
  isQuotaExhaustedDetail,
  markQuotaBlocked,
  parseOpenclawUsage,
  probeOpenclawUsage,
  quotaBlockMap,
  QUOTA_DEFAULT_TTL_MS,
  resetOpenclawUsageCacheForTest,
} from "./runtimeQuota";
import { notifySenderOfQuota, observeQuotaForTest } from "../bus/wakeDispatcher";
import type { AgentRecord, AgentStatus } from "../types";
import type { PendingDispatchRow } from "../bus/types";

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  resetOpenclawUsageCacheForTest();
});

describe("isQuotaExhaustedDetail — 한도 소진만 좁게", () => {
  const table: Array<[string, boolean]> = [
    ["hermes_error:hermes_exit_1:hermes -z: agent failed: Codex provider quota exhausted", true],
    ["You've reached your Codex subscription usage limit. Next reset Sep 19 5:19 PM", true],
    ["error code insufficient_quota", true],
    ["You have used 100% of your session limit", true],
    ["HTTP 429 Too Many Requests", false],
    ["rate limit hit, retrying in 2s", false],
    ["added credit card to billing page", false],
    ["subscription renewed", false],
    ["openclaw_directed_no_response_in_window", false],
    ["", false],
  ];
  for (const [detail, want] of table) {
    test(`${want ? "한도" : "한도 아님"}: ${detail || "(빈 문자열)"}`, () => {
      expect(isQuotaExhaustedDetail(detail)).toBe(want);
    });
  }
});

describe("parseOpenclawUsage — usage % 줄만 읽는다", () => {
  test("0% left + 리셋까지 시간", () => {
    const u = parseOpenclawUsage("- openai:x cooldown (34h)\n- openai usage: 168h 0% left ⏱1d 10h\n");
    expect(u).toEqual({ percentLeft: 0, resetIn: "1d 10h", resetInMs: 34 * 3_600_000 });
  });
  test("남아 있으면 그 %", () => {
    expect(parseOpenclawUsage("- openai usage: 168h 99% left")?.percentLeft).toBe(99);
  });
  test("cooldown 줄만 있고 usage 줄이 없으면 모름(null)", () => {
    expect(parseOpenclawUsage("- openai:x (openai) cooldown (34h) — Wait for cooldown")).toBeNull();
  });
});

describe("probeOpenclawUsage — 캐시·실패", () => {
  test("5분 안에는 CLI 를 한 번만 부른다", async () => {
    let calls = 0;
    const run = async () => { calls++; return "openai usage: 168h 0% left ⏱2h"; };
    const t0 = 1_000_000;
    await probeOpenclawUsage(run, t0);
    await probeOpenclawUsage(run, t0 + 60_000);
    expect(calls).toBe(1);
    await probeOpenclawUsage(run, t0 + 6 * 60_000);
    expect(calls).toBe(2);
  });
  test("실행 실패는 null(한도 아님이 아니라 모름)", async () => {
    expect(await probeOpenclawUsage(async () => { throw new Error("boom"); })).toBeNull();
    resetOpenclawUsageCacheForTest();
    expect(await probeOpenclawUsage(async () => null)).toBeNull();
  });
});

describe("기록·해제", () => {
  test("기록 → 조회 → 해제", () => {
    expect(markQuotaBlocked(db, "devon", "wake_error", { now: 1000 })).toBe(true);
    expect(getQuotaBlock(db, "devon", 2000)?.source).toBe("wake_error");
    expect(clearQuotaBlocked(db, "devon")).toBe(true);
    expect(getQuotaBlock(db, "devon", 2000)).toBeNull();
    expect(clearQuotaBlocked(db, "devon")).toBe(false);
  });
  test("유효 시각이 지나면 스스로 풀린다", () => {
    markQuotaBlocked(db, "ames", "wake_error", { now: 0 });
    expect(quotaBlockMap(db, QUOTA_DEFAULT_TTL_MS - 1).has("ames")).toBe(true);
    expect(quotaBlockMap(db, QUOTA_DEFAULT_TTL_MS + 1).has("ames")).toBe(false);
  });
  test("유효한 동안 다시 걸리면 since 는 그대로, 유효 시각만 연장", () => {
    expect(markQuotaBlocked(db, "forin", "wake_error", { now: 1000 })).toBe(true);
    expect(markQuotaBlocked(db, "forin", "wake_error", { now: 5000 })).toBe(false);
    const b = getQuotaBlock(db, "forin", 5000)!;
    expect(b.since).toBe(1000);
    expect(b.resetAt).toBe(5000 + QUOTA_DEFAULT_TTL_MS);
  });
  test("만료 뒤 다시 걸리면 새 구간(since 갱신)", () => {
    markQuotaBlocked(db, "forin", "wake_error", { now: 0 });
    const later = QUOTA_DEFAULT_TTL_MS + 10;
    expect(markQuotaBlocked(db, "forin", "wake_error", { now: later })).toBe(true);
    expect(getQuotaBlock(db, "forin", later)!.since).toBe(later);
  });
});

const status = (id: string, line: string | null = null): AgentStatus => ({
  agent_id: id, state: "idle", last_activity_at: null, last_log_line: line,
  tmux_pid: null, ctx_percent: null, probed_at: new Date().toISOString(),
});

describe("health — 한도 기록이 대시보드 danger 로", () => {
  test("기록이 있으면 danger + 리셋 힌트", () => {
    const now = Date.now();
    markQuotaBlocked(db, "devon", "openclaw_usage", { now, resetInMs: 3_600_000, resetHint: "1h" });
    const v = classifyHealth(status("devon"), undefined, now, getQuotaBlock(db, "devon", now));
    expect(v.level).toBe("danger");
    expect(v.reasons).toContain(`${QUOTA_REASON} · 리셋까지 1h`);
  });
  test("기록이 없으면 그대로 ok", () => {
    expect(classifyHealth(status("devon")).level).toBe("ok");
  });
  test("유효 시각이 지난 기록은 무시", () => {
    const v = classifyHealth(status("devon"), undefined, 10, { agentId: "devon", source: "wake_error", since: 0, resetAt: 5, resetHint: null });
    expect(v.level).toBe("ok");
  });
  test("로그 줄이 이미 한도를 말하면 사유를 두 번 적지 않는다", () => {
    const v = classifyHealth(status("dex", "Codex usage limit reached"), undefined, 10,
      { agentId: "dex", source: "wake_error", since: 0, resetAt: 100, resetHint: null });
    expect(v.reasons.filter((r) => r.startsWith(QUOTA_REASON)).length).toBe(1);
  });
  test("classifyAll 이 map 을 멤버별로 넘긴다", () => {
    const now = Date.now();
    markQuotaBlocked(db, "hermes", "wake_error", { now });
    const agents = [{ id: "hermes", runtime: "hermes_agent" }, { id: "lui", runtime: "claude_channel" }] as unknown as AgentRecord[];
    const vs = classifyAll([status("hermes"), { ...status("lui"), tmux_pid: 1 }], agents, now, quotaBlockMap(db, now));
    expect(vs.find((v) => v.agentId === "hermes")?.level).toBe("danger");
    expect(vs.find((v) => v.agentId === "lui")?.level).toBe("ok");
  });
});

const row = (over: Partial<PendingDispatchRow> = {}): PendingDispatchRow => ({
  message_id: "m1", agent_id: "devon", delivery_state: "dispatching", retry_count: 0, last_error: null,
  from_agent_id: "steve", to_agent_id: "devon", body: "hi", source: "agent", created_by: null, max_hop: 8,
  hop_count: 1, in_reply_to: null, parent_message_id: null, sync: "none", thread_id: "t1", type: "dm",
  created_at: "2026-09-25 00:00:00", priority: "normal", ...over,
});
const oc = { id: "devon", runtime: "openclaw" } as unknown as AgentRecord;
const hermes = { id: "ames", runtime: "hermes_agent" } as unknown as AgentRecord;

describe("dispatcher — wake 결과로 기록·해제", () => {
  test("실패 문구가 한도면 기록(조회 안 함)", async () => {
    let probed = 0;
    await observeQuotaForTest(db, row({ agent_id: "ames" }), hermes,
      { result: { ok: false, detail: "hermes -z: agent failed: Codex provider quota exhausted" } },
      async () => { probed++; return null; });
    expect(getQuotaBlock(db, "ames")?.source).toBe("wake_error");
    expect(probed).toBe(0);
  });
  test("openclaw 무응답 + 사용량 0% → 기록(리셋 힌트 포함)", async () => {
    await observeQuotaForTest(db, row(), oc, { result: { ok: false, detail: "openclaw_directed_no_response_in_window" } },
      async () => ({ percentLeft: 0, resetIn: "1d 10h", resetInMs: 34 * 3_600_000 }));
    expect(getQuotaBlock(db, "devon")?.resetHint).toBe("1d 10h");
  });
  test("openclaw 무응답 + 사용량 남음 → 기록 안 함", async () => {
    await observeQuotaForTest(db, row(), oc, { result: { ok: false, detail: "openclaw_directed_no_response_in_window" } },
      async () => ({ percentLeft: 42, resetIn: null, resetInMs: null }));
    expect(getQuotaBlock(db, "devon")).toBeNull();
  });
  test("openclaw 무응답 + 조회 실패 → 기록 안 함", async () => {
    await observeQuotaForTest(db, row(), oc, { result: { ok: false, detail: "openclaw_directed_no_response_in_window" } },
      async () => null);
    expect(getQuotaBlock(db, "devon")).toBeNull();
  });
  test("hermes 무응답은 openclaw 조회를 하지 않는다", async () => {
    let probed = 0;
    await observeQuotaForTest(db, row({ agent_id: "ames" }), hermes,
      { result: { ok: false, detail: "openclaw_directed_no_response_in_window" } },
      async () => { probed++; return { percentLeft: 0, resetIn: null, resetInMs: null }; });
    expect(probed).toBe(0);
  });
  test("일시적 429 는 기록하지 않는다", async () => {
    await observeQuotaForTest(db, row({ agent_id: "ames" }), hermes, { exception: "HTTP 429 Too Many Requests" }, async () => null);
    expect(getQuotaBlock(db, "ames")).toBeNull();
  });
  test("다음 wake 성공이 기록을 지운다", async () => {
    markQuotaBlocked(db, "devon", "openclaw_usage");
    await observeQuotaForTest(db, row(), oc, { result: { ok: true } }, async () => null);
    expect(getQuotaBlock(db, "devon")).toBeNull();
  });
  test("deferred(잠금 대기)는 기록도 해제도 안 한다", async () => {
    markQuotaBlocked(db, "devon", "openclaw_usage");
    await observeQuotaForTest(db, row(), oc, { result: { ok: false, deferred: true } }, async () => null);
    expect(getQuotaBlock(db, "devon")).not.toBeNull();
  });
});

describe("발신자 안내 — 막지 않고 한 구간에 한 번", () => {
  const agents = [{ id: "steve" }, { id: "devon" }, { id: "lui" }] as unknown as AgentRecord[];
  const notices = () =>
    (db.prepare(`SELECT to_agent_id, body FROM message WHERE dedupe_key LIKE 'quota-notice:%'`).all() as Array<{ to_agent_id: string; body: string }>);
  beforeEach(() => {
    ensureThread(db, { thread_id: "t1", from_agent_id: "steve", to_agent_id: "devon", type: "dm", body: "hi" });
  });
  test("한도 상태면 보낸 사람에게 한 번 알린다", () => {
    markQuotaBlocked(db, "devon", "openclaw_usage", { resetHint: "1d 10h", resetInMs: 3_600_000 });
    notifySenderOfQuota(db, row(), agents);
    notifySenderOfQuota(db, row({ message_id: "m2" }), agents);
    const n = notices();
    expect(n.length).toBe(1);
    expect(n[0]!.to_agent_id).toBe("steve");
    expect(n[0]!.body).toContain("그대로 전달");
    expect(n[0]!.body).toContain("1d 10h");
  });
  test("다른 발신자는 따로 한 번", () => {
    markQuotaBlocked(db, "devon", "openclaw_usage");
    notifySenderOfQuota(db, row(), agents);
    notifySenderOfQuota(db, row({ from_agent_id: "lui" }), agents);
    expect(notices().length).toBe(2);
  });
  test("한도 기록이 없으면 알리지 않는다", () => {
    notifySenderOfQuota(db, row(), agents);
    expect(notices().length).toBe(0);
  });
  test("시스템·사람 발신은 알리지 않는다", () => {
    markQuotaBlocked(db, "devon", "openclaw_usage");
    notifySenderOfQuota(db, row({ source: "system", from_agent_id: "system" }), agents);
    notifySenderOfQuota(db, row({ source: "user", from_agent_id: "gd" }), agents);
    expect(notices().length).toBe(0);
  });
});

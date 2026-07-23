// b3os_native M2c — 팀원별 두뇌 라우팅 + 1단계 fallback.
// resolveCallerChain(체인 구성·회귀0) · isRetryableError(에러 분류) · runCallerChain(fallback 로직) · runTurn(audit via_caller/fallback_used).
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { insertMessage } from "../../db/inboxQueries";
import { runTurn } from "./adapter";
import {
  resolveCallerChain,
  isRetryableError,
  runCallerChain,
  callClaude,
  callOpenAICompatible,
  OPENAI_COMPAT_FLAG,
  FALLBACK_FLAG,
  type CallerLink,
  type LlmTurn,
  type LlmCaller,
} from "./runner";
import type { AgentRecord } from "../../types";
import type { PendingDispatchRow } from "../../bus/types";

const TURN: LlmTurn = { provider: "anthropic", model: "m", system: "s", prompt: "p" };

afterEach(() => {
  delete process.env[FALLBACK_FLAG];
  delete process.env[OPENAI_COMPAT_FLAG];
});

describe("resolveCallerChain (M2c 라우팅·회귀0)", () => {
  test("플래그 off → 체인 길이 1(primary=callClaude) = 기존 동작 불변", () => {
    const chain = resolveCallerChain("anthropic");
    expect(chain.length).toBe(1);
    expect(chain[0]!.caller).toBe(callClaude);
    expect(chain[0]!.label).toBe("anthropic");
  });

  test("주입 caller → 체인 길이 1(injected) = 회귀0", () => {
    const fake: LlmCaller = async () => "x";
    const chain = resolveCallerChain("anthropic", fake);
    expect(chain.length).toBe(1);
    expect(chain[0]!.caller).toBe(fake);
    expect(chain[0]!.label).toBe("injected");
  });

  test("FALLBACK on + anthropic → [anthropic, openai_compatible]", () => {
    process.env[FALLBACK_FLAG] = "1";
    const chain = resolveCallerChain("anthropic");
    expect(chain.map((c) => c.label)).toEqual(["anthropic", "openai_compatible"]);
  });

  test("FALLBACK on + ollama(주=openai_compat) → [openai_compatible, anthropic]", () => {
    process.env[FALLBACK_FLAG] = "1";
    process.env[OPENAI_COMPAT_FLAG] = "1"; // resolveCaller가 ollama→openai_compat 되게
    const chain = resolveCallerChain("ollama");
    expect(chain[0]!.caller).toBe(callOpenAICompatible);
    expect(chain.map((c) => c.label)).toEqual(["openai_compatible", "anthropic"]);
  });
});

describe("isRetryableError (에러 분류)", () => {
  test("api key 없음 = 비재시도", () => {
    expect(isRetryableError(new Error("missing_anthropic_api_key"))).toBe(false);
  });
  test("4xx auth = 비재시도", () => {
    expect(isRetryableError(new Error("anthropic_api_401:unauthorized"))).toBe(false);
    expect(isRetryableError(new Error("openai_compat_api_400:bad"))).toBe(false);
  });
  test("429/408/5xx = 재시도", () => {
    expect(isRetryableError(new Error("anthropic_api_429:rate"))).toBe(true);
    expect(isRetryableError(new Error("openai_compat_api_408:timeout"))).toBe(true);
    expect(isRetryableError(new Error("anthropic_api_503:down"))).toBe(true);
  });
  test("empty/네트워크/abort = 재시도", () => {
    expect(isRetryableError(new Error("anthropic_empty_response"))).toBe(true);
    expect(isRetryableError(new Error("The operation was aborted"))).toBe(true);
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
  });
});

describe("runCallerChain (fallback 로직)", () => {
  test("단일 성공 → fallbackUsed=false, viaCaller=primary", async () => {
    const chain: CallerLink[] = [{ caller: async () => "ok", label: "anthropic" }];
    const r = await runCallerChain(chain, TURN);
    expect(r).toEqual({ reply: "ok", viaCaller: "anthropic", fallbackUsed: false });
  });

  test("primary 재시도에러 → 대체 성공(fallbackUsed=true, onFallback 1회)", async () => {
    const hops: string[] = [];
    const chain: CallerLink[] = [
      { caller: async () => { throw new Error("anthropic_api_503:down"); }, label: "anthropic" },
      { caller: async () => "from-alt", label: "openai_compatible" },
    ];
    const r = await runCallerChain(chain, TURN, (from, to) => hops.push(`${from}->${to}`));
    expect(r.reply).toBe("from-alt");
    expect(r.viaCaller).toBe("openai_compatible");
    expect(r.fallbackUsed).toBe(true);
    expect(hops).toEqual(["anthropic->openai_compatible"]);
  });

  test("primary 비재시도에러 → 즉시 throw, 대체 caller 호출 안 함", async () => {
    let altCalled = false;
    const chain: CallerLink[] = [
      { caller: async () => { throw new Error("missing_anthropic_api_key"); }, label: "anthropic" },
      { caller: async () => { altCalled = true; return "x"; }, label: "openai_compatible" },
    ];
    await expect(runCallerChain(chain, TURN)).rejects.toThrow("missing_anthropic_api_key");
    expect(altCalled).toBe(false); // 무의미 재시도 안 함
  });

  test("전부 재시도에러 → 마지막 에러 throw(대체도 실패)", async () => {
    const chain: CallerLink[] = [
      { caller: async () => { throw new Error("anthropic_api_500:a"); }, label: "anthropic" },
      { caller: async () => { throw new Error("openai_compat_api_500:b"); }, label: "openai_compatible" },
    ];
    await expect(runCallerChain(chain, TURN)).rejects.toThrow("openai_compat_api_500");
  });
});

// ── runTurn 통합: audit via_caller/fallback_used + 회귀(주입 caller=길이1) ──
function setupDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('nova','nova','r','b3os_native','b3os_native_runner','/tmp','p.md')`,
  ).run();
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','["nova","bill"]','bill')`,
  ).run();
  return db;
}
function agentRec(): AgentRecord {
  return { id: "nova", display_name: "nova", role: "r", runtime: "b3os_native", persona_file: "p.md" } as unknown as AgentRecord;
}
function inbound(db: Database): PendingDispatchRow {
  const m = insertMessage(db, {
    thread_id: "t1", from_agent_id: "bill", to_agent_id: "nova", type: "dm",
    body: "봐줘", source: "agent", hop_count: 0, priority: "normal",
  });
  return { message_id: m.id, thread_id: "t1", from_agent_id: "bill", body: "봐줘", hop_count: 0 } as unknown as PendingDispatchRow;
}

describe("runTurn 통합 (M2c audit)", () => {
  test("주입 caller 성공 → 답 게시 + audit via_caller=injected·fallback_used=false", async () => {
    const db = setupDb();
    const row = inbound(db);
    await runTurn(db, () => [agentRec()], agentRec(), row, "", async () => "답변입니다");
    const sent = db.prepare(`SELECT body FROM message WHERE from_agent_id='nova' AND in_reply_to=?`).get(row.message_id) as { body: string } | undefined;
    expect(sent?.body).toBe("답변입니다");
    const audit = db.prepare(`SELECT detail_json FROM audit_event WHERE actor='nova' AND action='message_sent'`).get() as { detail_json: string } | undefined;
    expect(audit).toBeTruthy();
    const detail = JSON.parse(audit!.detail_json);
    expect(detail.via_caller).toBe("injected");
    expect(detail.fallback_used).toBe(false);
  });
});

// b3os_native M2d — 실배정 검증. preflight 체크 + adapter wake-contract 통합(주입 caller, 라이브 배정 없음).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../db/migrate";
import { insertMessage } from "../../db/inboxQueries";
import { makeB3osNativeAdapter, inFlightCount } from "./adapter";
import { checkB3osNativePreflight, isB3osNativeRunnable } from "./preflight";
import { OPENAI_COMPAT_FLAG } from "./runner";
import type { AgentRecord } from "../../types";
import type { PendingDispatchRow } from "../../bus/types";

/** 전역 격리(preload)가 세팅한 값 — afterAll 에서 ★지우지 말고 되돌린다.★ */
const PREV_AUDIT_DIR = process.env.B3OS_AUDIT_LOG_DIR;

const REAL_PERSONA = __dirname + "/preflight.ts"; // 존재하는 실제 파일(persona 존재 검사용)

function agent(p: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "nova", display_name: "nova", role: "researcher", runtime: "b3os_native",
    persona_file: REAL_PERSONA, model_provider: "anthropic", model_id: "claude-sonnet-4-6",
    ...p,
  } as unknown as AgentRecord;
}

// ★테스트 격리(Bill 리뷰 #2): 통합테스트가 appendAuditFile로 라이브 logs/를 오염하지 않게
//   audit 로그 디렉토리를 temp로 리다이렉트. (팀 하드레슨 — bun test는 실 FS 안 건드림.)
let TMP_LOG_DIR: string;
beforeAll(() => {
  TMP_LOG_DIR = mkdtempSync(join(tmpdir(), "b3os-m2d-audit-"));
  process.env.B3OS_AUDIT_LOG_DIR = TMP_LOG_DIR;
});
afterAll(() => {
  // ★지우면 안 된다 — 되돌려야 한다.★ (2026-07-14)
  //   전역 preload(src/test/audit-isolation.ts)가 B3OS_AUDIT_LOG_DIR 을 temp 로 세팅해 ★모든★ 테스트를
  //   라이브 logs/ 에서 격리한다. 여기서 delete 하면 ★그 격리가 통째로 풀리고★, 같은 프로세스에서
  //   ★뒤에 도는 모든 테스트가 라이브 감사로그에 쓴다.★
  //   실측: 라이브 로그에 테스트 이벤트 ★1619건★ (actor='nova', thread='t1' — 존재하지 않는 팀원/스레드).
  //   ★계기판이 첫날부터 가짜 데이터로 못 쓰게 됐다.★ (팀 하드레슨: bun test 는 라이브를 안 건드린다)
  if (PREV_AUDIT_DIR === undefined) delete process.env.B3OS_AUDIT_LOG_DIR;
  else process.env.B3OS_AUDIT_LOG_DIR = PREV_AUDIT_DIR;
  try { rmSync(TMP_LOG_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

afterEach(() => {
  delete process.env[OPENAI_COMPAT_FLAG];
});

describe("checkB3osNativePreflight (배정 전 검사)", () => {
  test("persona 존재·model 명시·anthropic 키 있음 → ready(ok)", () => {
    const r = checkB3osNativePreflight(agent(), { ANTHROPIC_API_KEY: "x" });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  test("anthropic 키 없음 → 탐지(blocking)", () => {
    const r = checkB3osNativePreflight(agent(), {});
    expect(r.ok).toBe(false);
    expect(r.issues).toContain("anthropic_api_key_missing");
    expect(isB3osNativeRunnable(r)).toBe(false);
  });

  test("persona 못 읽음 → 이슈 탐지되나 runnable(loadSystem이 이름·역할로 fallback)", () => {
    const r = checkB3osNativePreflight(agent({ persona_file: "/no/such/persona.md" }), { ANTHROPIC_API_KEY: "x" });
    expect(r.issues).toContain("persona_file_unreadable");
    expect(isB3osNativeRunnable(r)).toBe(true); // persona는 fallback되므로 blocking 아님(#3)
  });

  test("runtime 불일치 → 탐지", () => {
    const r = checkB3osNativePreflight(agent({ runtime: "claude_tmux" as unknown as AgentRecord["runtime"] }), { ANTHROPIC_API_KEY: "x" });
    expect(r.issues.some((i) => i.startsWith("runtime_not_b3os_native"))).toBe(true);
  });

  test("model 미명시 → 경고(defaulted, 비blocking)이지만 runnable", () => {
    const r = checkB3osNativePreflight(agent({ model_provider: null, model_id: null }), { ANTHROPIC_API_KEY: "x" });
    expect(r.issues).toContain("model_provider_unset_defaulted");
    expect(isB3osNativeRunnable(r)).toBe(true); // 키·persona·runtime OK면 defaulted는 돌 수 있음
  });

  test("로컬 ollama(localhost)는 키 불요 → ready", () => {
    const r = checkB3osNativePreflight(
      agent({ model_provider: "ollama", model_id: "gemma3:27b-it-qat" }),
      { B3OS_NATIVE_OPENAI_BASE_URL: "http://localhost:11434/v1" },
    );
    expect(r.ok).toBe(true);
  });

  test("원격 openai_compatible + 키 없음 → 탐지", () => {
    const r = checkB3osNativePreflight(
      agent({ model_provider: "openai_compatible" }),
      { B3OS_NATIVE_OPENAI_BASE_URL: "https://api.example.com/v1" },
    );
    expect(r.issues).toContain("openai_api_key_missing_for_remote");
  });
});

describe("adapter wake-contract 통합 (디스패처가 부르는 wake 경로, 주입 caller)", () => {
  function setup(): { db: Database; row: PendingDispatchRow } {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES ('nova','nova','r','b3os_native','b3os_native_runner','/tmp','p.md')`,
    ).run();
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES ('bill','bill','r','claude_channel','claude_tmux','/tmp','p.md')`,
    ).run();
    db.prepare(
      `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','["nova","bill"]','bill')`,
    ).run();
    const m = insertMessage(db, {
      thread_id: "t1", from_agent_id: "bill", to_agent_id: "nova", type: "dm",
      body: "이 로그 분석해줘", source: "agent", hop_count: 0, priority: "normal",
    });
    const row = { message_id: m.id, thread_id: "t1", from_agent_id: "bill", body: "이 로그 분석해줘", hop_count: 0 } as unknown as PendingDispatchRow;
    return { db, row };
  }
  const agents = (db: Database) => () => db.prepare(`SELECT * FROM agent`).all() as unknown as AgentRecord[];

  async function drain(): Promise<void> {
    for (let i = 0; i < 100 && inFlightCount() > 0; i++) await new Promise((r) => setTimeout(r, 5));
  }

  test("배정된 b3os_native 팀원: wake → 턴 → 답 게시 → audit(message_sent + via_caller)", async () => {
    const { db, row } = setup();
    const adapter = makeB3osNativeAdapter(db, agents(db), { callLlm: async () => "분석 결과입니다" });
    const res = await adapter.wake("nova", row, "팀 컨텍스트");
    expect(res.ok).toBe(true);
    await drain();
    // 답 게시(원 요청자 bill에게 directed)
    const sent = db.prepare(`SELECT body,to_agent_id FROM message WHERE from_agent_id='nova' AND in_reply_to=?`).get(row.message_id) as { body: string; to_agent_id: string } | undefined;
    expect(sent?.body).toBe("분석 결과입니다");
    expect(sent?.to_agent_id).toBe("bill");
    // audit: message_sent + M2c via_caller
    const audit = db.prepare(`SELECT detail_json FROM audit_event WHERE actor='nova' AND action='message_sent'`).get() as { detail_json: string } | undefined;
    const detail = JSON.parse(audit!.detail_json);
    expect(detail.via).toBe("b3os_native");
    expect(detail.via_caller).toBe("injected");
    expect(detail.fallback_used).toBe(false);
  });

  test("in-flight 잠금: 같은 message_id 재wake는 deferred(중복 턴 방지)", async () => {
    const { db, row } = setup();
    let resolve!: (v: string) => void;
    const adapter = makeB3osNativeAdapter(db, agents(db), { callLlm: () => new Promise((r) => { resolve = r; }) });
    await adapter.wake("nova", row, "");
    const second = await adapter.wake("nova", row, ""); // 아직 첫 턴 진행중
    expect(second.deferred).toBe(true);
    resolve("done");
    await drain();
  });
});

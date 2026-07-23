// b3os_native 어댑터 characterization 테스트 (M1 핵심 정확성 핀).
// in-memory sqlite, 라이브 무관. 가짜 LlmCaller 주입(진짜 API 호출 X).
// 핀: ①at-most-once 최종답 1회 ②in-flight 잠금(중복 launch X) ③directed/broadcast ④에러 무음 아님 ⑤lease-safe(즉시 반환).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { insertMessage } from "../../db/inboxQueries";
import { makeB3osNativeAdapter, runTurn } from "./adapter";
import type { LlmCaller } from "./runner";
import type { AgentRecord } from "../../types";
import type { PendingDispatchRow } from "../../bus/types";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  const ins = (id: string, runtime: string, sp: string) =>
    db
      .prepare(
        `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
         VALUES (?, ?, 'role', ?, ?, '/tmp', 'persona.md')`,
      )
      .run(id, id, runtime, sp);
  ins("nova", "b3os_native", "b3os_native_runner");
  ins("bill", "claude_channel", "claude_tmux");
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','test','dm','["nova","bill"]','bill')`,
  ).run();
  return db;
}

const agentsOf = (db: Database) => (): AgentRecord[] =>
  (db.prepare(`SELECT * FROM agent`).all() as Record<string, unknown>[]).map(
    (r) => ({ ...r, moderator_eligible: !!r.moderator_eligible }) as never,
  );

const novaOf = (db: Database): AgentRecord => agentsOf(db)().find((a) => a.id === "nova")!;

const row = (over: Partial<PendingDispatchRow> = {}): PendingDispatchRow => ({
  message_id: "m1",
  agent_id: "nova",
  delivery_state: "dispatching",
  retry_count: 0,
  last_error: null,
  from_agent_id: "bill",
  to_agent_id: "nova",
  body: "안녕 도와줘",
  source: "agent",
  created_by: null,
  max_hop: 6,
  hop_count: 0,
  in_reply_to: null,
  parent_message_id: null,
  sync: "none",
  thread_id: "t1",
  type: "dm",
  created_at: new Date().toISOString(),
  priority: "normal",
  ...over,
});

const repliesFrom = (db: Database, from: string) =>
  db.prepare(`SELECT * FROM message WHERE from_agent_id=? ORDER BY created_at DESC`).all(from) as Record<
    string,
    unknown
  >[];

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe("b3os_native adapter (M1) — 핵심 정확성", () => {
  test("①at-most-once: LLM 답을 최종 1회 게시, directed to 요청자(에이전트)", async () => {
    const db = setup();
    const fake: LlmCaller = async () => "네, 도와드릴게요!";
    await runTurn(db, agentsOf(db), novaOf(db), row(), "팀컨텍스트", fake);
    const replies = repliesFrom(db, "nova");
    expect(replies.length).toBe(1);
    expect(replies[0]?.body).toBe("네, 도와드릴게요!");
    expect(replies[0]?.to_agent_id).toBe("bill"); // 요청자가 에이전트 → directed
    expect(replies[0]?.in_reply_to).toBe("m1");
  });

  test("③요청자가 user → broadcast(텔레그램 visible은 M2)", async () => {
    const db = setup();
    const fake: LlmCaller = async () => "공개 답변";
    await runTurn(db, agentsOf(db), novaOf(db), row({ from_agent_id: "user" }), "", fake);
    expect(repliesFrom(db, "nova")[0]?.to_agent_id).toBe("broadcast");
  });

  test("④LLM 에러 → 메시지 게시 안 함(무음 아님 — audit만, M1은 재시도 X)", async () => {
    const db = setup();
    const fake: LlmCaller = async () => {
      throw new Error("boom");
    };
    await runTurn(db, agentsOf(db), novaOf(db), row(), "", fake);
    expect(repliesFrom(db, "nova").length).toBe(0);
  });

  test("⑤lease-safe: wake()는 즉시 dispatched 반환(블록 X) + 턴은 비동기 완료", async () => {
    const db = setup();
    const fake: LlmCaller = async () => "비동기 답";
    const adapter = makeB3osNativeAdapter(db, agentsOf(db), { callLlm: fake });
    const r = await adapter.wake("nova", row(), "");
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("b3os_native_dispatched");
    await sleep(20); // 비동기 턴 완료 대기
    expect(repliesFrom(db, "nova").length).toBe(1);
  });

  test("②in-flight 잠금: 처리 중 같은 message_id 재호출 → deferred, 중복 launch X(최종 1회만)", async () => {
    const db = setup();
    let release!: (s: string) => void;
    const blocking: LlmCaller = () => new Promise<string>((res) => (release = res));
    const adapter = makeB3osNativeAdapter(db, agentsOf(db), { callLlm: blocking });

    const r1 = await adapter.wake("nova", row(), "");
    expect(r1.detail).toBe("b3os_native_dispatched");
    // 첫 턴이 LLM에서 멈춘 동안 두 번째 wake(같은 message_id)
    const r2 = await adapter.wake("nova", row(), "");
    expect(r2.deferred).toBe(true);
    expect(r2.detail).toBe("b3os_native_in_flight");

    release("끝"); // 풀어주고 정리
    await sleep(20);
    expect(repliesFrom(db, "nova").length).toBe(1); // 딱 1회만 게시
  });

  test("모르는 에이전트 → ok:false", async () => {
    const db = setup();
    const adapter = makeB3osNativeAdapter(db, agentsOf(db), { callLlm: async () => "x" });
    const r = await adapter.wake("ghost", row({ agent_id: "ghost" }), "");
    expect(r.ok).toBe(false);
  });

  // ── 하네스 발견 반영: buildPrompt 라벨/중복, at-most-once 실제화, 실패통지 ──

  test("buildPrompt: 과거 대화 역할 라벨(나/상대) + 들어온 메시지 끝에 1회만(history서 필터)", async () => {
    const db = setup();
    insertMessage(db, {
      thread_id: "t1", from_agent_id: "bill", to_agent_id: "nova", type: "dm",
      body: "첫 질문", source: "agent", hop_count: 0, priority: "normal", dedupe_key: "k1",
    } as never);
    insertMessage(db, {
      thread_id: "t1", from_agent_id: "nova", to_agent_id: "bill", type: "dm",
      body: "이전 내 답", source: "agent", hop_count: 1, priority: "normal", dedupe_key: "k2",
    } as never);
    const incoming = insertMessage(db, {
      thread_id: "t1", from_agent_id: "bill", to_agent_id: "nova", type: "dm",
      body: "새 질문", source: "agent", hop_count: 0, priority: "normal", dedupe_key: "k3",
    } as never);
    let captured = "";
    const fake: LlmCaller = async (t) => {
      captured = t.prompt;
      return "답";
    };
    await runTurn(db, agentsOf(db), novaOf(db), row({ message_id: incoming.id, body: "새 질문" }), "", fake);
    expect(captured).toContain("bill: 첫 질문"); // 상대 = id 라벨
    expect(captured).toContain("나: 이전 내 답"); // 자기 = "나"
    expect((captured.match(/새 질문/g) ?? []).length).toBe(1); // 들어온 메시지 정확히 1회(필터+append)
  });

  test("at-most-once 실제화: 같은 답으로 runTurn 두 번 → 메시지 1개만(dedupe 스킵)", async () => {
    const db = setup();
    const fake: LlmCaller = async () => "동일한 답";
    await runTurn(db, agentsOf(db), novaOf(db), row(), "", fake);
    await runTurn(db, agentsOf(db), novaOf(db), row(), "", fake);
    expect(repliesFrom(db, "nova").length).toBe(1); // 두 번째는 findRecentDuplicate로 스킵
  });

  test("실패통지: 사용자 요청 + LLM 에러 → 가시 통지 1회 게시", async () => {
    const db = setup();
    const fail: LlmCaller = async () => {
      throw new Error("boom");
    };
    await runTurn(db, agentsOf(db), novaOf(db), row({ from_agent_id: "user" }), "", fail);
    const replies = repliesFrom(db, "nova");
    expect(replies.length).toBe(1);
    expect(String(replies[0]?.body)).toContain("응답을 만들지 못했어요");
  });

  test("실패통지: 에이전트 요청 + LLM 에러 → 통지 안 함(루프 방지)", async () => {
    const db = setup();
    const fail: LlmCaller = async () => {
      throw new Error("boom");
    };
    await runTurn(db, agentsOf(db), novaOf(db), row({ from_agent_id: "bill" }), "", fail);
    expect(repliesFrom(db, "nova").length).toBe(0);
  });
});

// b3os_native M2a — 역할 배열 멀티턴 테스트. buildMessages 매핑 + caller(messages 우선/prompt fallback).
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { insertMessage } from "../../db/inboxQueries";
import { buildMessages } from "./adapter";
import { callOpenAICompatible, OPENAI_COMPAT_FLAG } from "./runner";
import type { PendingDispatchRow } from "../../bus/types";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  const ins = (id: string, rt: string, sp: string) =>
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'r', ?, ?, '/tmp', 'p.md')`,
    ).run(id, id, rt, sp);
  ins("nova", "b3os_native", "b3os_native_runner");
  ins("bill", "claude_channel", "claude_tmux");
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','["nova","bill"]','bill')`,
  ).run();
  return db;
}
function add(db: Database, from: string, body: string): string {
  return insertMessage(db, {
    thread_id: "t1", from_agent_id: from, to_agent_id: "nova", type: "dm",
    body, source: "agent", hop_count: 0, priority: "normal",
  }).id;
}
function inboundRow(db: Database, from: string, body: string): PendingDispatchRow {
  const id = add(db, from, body);
  return { message_id: id, thread_id: "t1", from_agent_id: from, body, hop_count: 0 } as unknown as PendingDispatchRow;
}

describe("buildMessages (M2a 역할 배열)", () => {
  test("self(nova)=assistant · 타인(bill)=user, inbound=마지막 user, 첫 user", () => {
    const db = setup();
    add(db, "bill", "안녕");
    add(db, "nova", "네 보겠습니다");
    const row = inboundRow(db, "bill", "이 로그 봐줘");
    const msgs = buildMessages(db, row, "nova");
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.role).toBe("user"); // 첫 메시지 user (Anthropic 제약)
    expect(msgs[msgs.length - 1]!.role).toBe("user"); // inbound = user
    expect(msgs[msgs.length - 1]!.content).toContain("이 로그 봐줘");
    expect(msgs.some((m) => m.role === "assistant" && m.content.includes("네 보겠습니다"))).toBe(true);
    expect(msgs.some((m) => m.role === "user" && m.content.includes("bill: 안녕"))).toBe(true);
  });

  test("선행 assistant(self가 먼저 말함) → 드롭되어 첫 메시지가 user", () => {
    const db = setup();
    add(db, "nova", "먼저 한 말");
    const row = inboundRow(db, "bill", "질문");
    const msgs = buildMessages(db, row, "nova");
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).not.toContain("먼저 한 말");
  });

  test("연속 동일 role 병합(타인 2연속 user → 1개)", () => {
    const db = setup();
    add(db, "bill", "첫째");
    add(db, "bill", "둘째");
    const row = inboundRow(db, "bill", "셋째");
    const msgs = buildMessages(db, row, "nova");
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toContain("첫째");
    expect(msgs[0]!.content).toContain("셋째");
  });

  test("전부 self(assistant) → 선행 다 드롭, [inbound user]만 남음(Bill 하드닝②)", () => {
    const db = setup();
    add(db, "nova", "혼잣말1");
    add(db, "nova", "혼잣말2");
    const row = inboundRow(db, "bill", "이제 질문");
    const msgs = buildMessages(db, row, "nova");
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toContain("이제 질문");
  });

  test("빈 recent(과거 없음) → [inbound] 단일 user", () => {
    const db = setup();
    const row = inboundRow(db, "bill", "첫 메시지");
    const msgs = buildMessages(db, row, "nova");
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toContain("첫 메시지");
  });

  test("빈 content turn 드롭(self 빈 body) → 빈 assistant turn 안 생김(Anthropic 400 방어)", () => {
    const db = setup();
    add(db, "bill", "안녕");
    add(db, "nova", "   "); // 공백만 = 빈 self 발화
    const row = inboundRow(db, "bill", "질문");
    const msgs = buildMessages(db, row, "nova");
    expect(msgs.every((m) => m.content.trim().length > 0)).toBe(true); // 빈 turn 없음
    expect(msgs[0]!.role).toBe("user");
  });
});

describe("callOpenAICompatible — messages 우선/prompt fallback", () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    delete process.env[OPENAI_COMPAT_FLAG];
  });
  function captureFetch(): () => { messages: { role: string; content: string }[] } {
    let body: { messages: { role: string; content: string }[] } = { messages: [] };
    global.fetch = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    return () => body;
  }

  test("turn.messages 있으면 역할 배열 사용(prompt 무시)", async () => {
    const getBody = captureFetch();
    await callOpenAICompatible({
      provider: "ollama", model: "m", system: "sys", prompt: "FLAT",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "more" }],
    });
    const msgs = getBody().messages;
    expect(msgs).toContainEqual({ role: "user", content: "hi" });
    expect(msgs.some((m) => m.content === "FLAT")).toBe(false);
  });

  test("turn.messages 없으면 prompt fallback(회귀 0)", async () => {
    const getBody = captureFetch();
    await callOpenAICompatible({ provider: "ollama", model: "m", system: "sys", prompt: "FLAT" });
    const msgs = getBody().messages;
    expect(msgs.some((m) => m.role === "user" && m.content === "FLAT")).toBe(true);
  });
});

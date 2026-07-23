// b3os_native M3a — 에이전트 루프 + 읽기 도구 + 게이트(G1/G2/G3) + 하드닝.
// 유닛: parseToolCall/validateToolCall/stripToolMarkers · accessibleThreads(스코프).
// 통합(runTurn, 플래그 on/off): (h)maxSteps 마커미노출 (i)args reject (j)범위밖 thread 거부 (k)insertMessage==1 (l)canonical 반복 · 회귀0(off).
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { insertMessage } from "../../db/inboxQueries";
import { runTurn } from "./adapter";
import { parseToolCall, validateToolCall, stripToolMarkers, runTool, AGENT_LOOP_FLAG } from "./tools";
import { accessibleThreadIds, canAccessThread } from "../../db/accessibleThreads";
import { rebuildSearchIndex } from "../../db/searchQueries";
import { createTask } from "../../db/taskQueries";
import type { AgentRecord } from "../../types";
import type { PendingDispatchRow } from "../../bus/types";
import type { LlmCaller } from "./runner";

afterEach(() => {
  delete process.env[AGENT_LOOP_FLAG];
});

// ── 유닛: parseToolCall (H1 마커 마지막1줄·fenced 무시) ──
describe("parseToolCall (H1)", () => {
  test("유효 마커 파싱", () => {
    const p = parseToolCall('생각...\nTOOL_CALL: {"tool":"search_messages","args":{"query":"측정지표"}}');
    expect(p).toEqual({ tool: "search_messages", args: { query: "측정지표" } });
  });
  test("마커 없으면 null(=최종답)", () => {
    expect(parseToolCall("그냥 최종 답변입니다.")).toBeNull();
  });
  test("fenced code block 안 마커는 무시", () => {
    expect(parseToolCall('```\nTOOL_CALL: {"tool":"search_messages","args":{"query":"x"}}\n```')).toBeNull();
  });
  test("마지막 유효 마커만", () => {
    const p = parseToolCall('TOOL_CALL: {"tool":"read_thread","args":{"thread_id":"a"}}\nTOOL_CALL: {"tool":"read_thread","args":{"thread_id":"b"}}');
    expect(p?.args.thread_id).toBe("b");
  });
  test("깨진 JSON 마커는 무시", () => {
    expect(parseToolCall("TOOL_CALL: {broken")).toBeNull();
  });
});

// ── 유닛: validateToolCall (G2 스키마 검증) ──
describe("validateToolCall (G2)", () => {
  test("정상 search_messages", () => {
    expect(validateToolCall({ tool: "search_messages", args: { query: "x" } })).toEqual({ tool: "search_messages", args: { query: "x" } });
  });
  test("unknown_tool reject", () => {
    expect(validateToolCall({ tool: "delete_all", args: {} })).toHaveProperty("error");
  });
  test("unknown arg key reject", () => {
    expect(validateToolCall({ tool: "search_messages", args: { query: "x", extra: 1 } })).toHaveProperty("error");
  });
  test("query 길이초과 reject", () => {
    expect(validateToolCall({ tool: "search_messages", args: { query: "a".repeat(600) } })).toHaveProperty("error");
  });
  test("read_thread thread_id 필수", () => {
    expect(validateToolCall({ tool: "read_thread", args: {} })).toHaveProperty("error");
  });
  test("정상 list_tasks (args 없음 = 전체)", () => {
    expect(validateToolCall({ tool: "list_tasks", args: {} })).toEqual({ tool: "list_tasks", args: {} });
  });
  test("list_tasks lane enum 위반 reject", () => {
    expect(validateToolCall({ tool: "list_tasks", args: { lane: "backlog" } })).toHaveProperty("error");
  });
  test("list_tasks unknown key reject", () => {
    expect(validateToolCall({ tool: "list_tasks", args: { foo: 1 } })).toHaveProperty("error");
  });
  test("list_tasks limit 범위초과 reject", () => {
    expect(validateToolCall({ tool: "list_tasks", args: { limit: 999 } })).toHaveProperty("error");
  });
});

// ── 유닛: stripToolMarkers (G1) ──
describe("stripToolMarkers (G1)", () => {
  test("최종 텍스트에서 TOOL_CALL 라인 제거", () => {
    const out = stripToolMarkers('최종 답입니다.\nTOOL_CALL: {"tool":"search_messages","args":{"query":"x"}}');
    expect(out).toBe("최종 답입니다.");
    expect(out).not.toContain("TOOL_CALL");
  });
});

// ── 유닛: accessibleThreads (G3 스코프) ──
function scopeDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const [id, kind, parts] of [["t1", "dm", '["nova","bill"]'], ["t2", "dm", '["bill","steve"]'], ["t3", "broadcast", '["all"]']] as const) {
    db.prepare(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES (?,?,?,?,'bill')`).run(id, id, kind, parts);
  }
  // t1: nova 수신 / t2: bill↔steve(nova 무관) / t3: broadcast
  insertMessage(db, { thread_id: "t1", from_agent_id: "bill", to_agent_id: "nova", type: "dm", body: "hi nova", source: "agent", hop_count: 0, priority: "normal" });
  insertMessage(db, { thread_id: "t2", from_agent_id: "bill", to_agent_id: "steve", type: "dm", body: "private", source: "agent", hop_count: 0, priority: "normal" });
  insertMessage(db, { thread_id: "t3", from_agent_id: "bill", to_agent_id: "broadcast", type: "broadcast", body: "all", source: "agent", hop_count: 0, priority: "normal" });
  return db;
}
describe("accessibleThreads (G3)", () => {
  test("nova = 참여(t1) + broadcast(t3) 접근가능, 타인 private(t2) 불가", () => {
    const db = scopeDb();
    const acc = accessibleThreadIds(db, "nova");
    expect(acc.has("t1")).toBe(true);
    expect(acc.has("t3")).toBe(true);
    expect(acc.has("t2")).toBe(false); // ★타 에이전트 private DM 누출 차단★
    expect(canAccessThread(db, "nova", "t2")).toBe(false);
    expect(canAccessThread(db, "nova", "t1")).toBe(true);
  });
  test("runTool read_thread: 범위밖 thread = 접근불가 관찰(j)", () => {
    const db = scopeDb();
    const r = runTool(db, "nova", "read_thread", { thread_id: "t2" });
    expect(r.observation).toContain("접근 불가");
    expect(r.observation).not.toContain("private"); // 내용 누출 없음
  });

  test("runTool search_messages: 접근가능 스레드 결과만·타인 private 미노출(Bill finding 픽스)", () => {
    const db = new Database(":memory:");
    migrate(db);
    for (const [id, parts] of [["ta", '["nova","bill"]'], ["tb", '["bill","steve"]']] as const)
      db.prepare(`INSERT INTO thread (id,title,kind,participants_json,opened_by) VALUES (?,?,'dm',?,'bill')`).run(id, id, parts);
    // 같은 키워드가 ta(nova 참여)·tb(bill↔steve, nova 무관) 둘 다에 있음
    insertMessage(db, { thread_id: "ta", from_agent_id: "bill", to_agent_id: "nova", type: "dm", body: "ZZKEY 공개내용입니다", source: "agent", hop_count: 0, priority: "normal" });
    insertMessage(db, { thread_id: "tb", from_agent_id: "bill", to_agent_id: "steve", type: "dm", body: "ZZKEY 남의비밀입니다", source: "agent", hop_count: 0, priority: "normal" });
    rebuildSearchIndex(db, { docsDir: "/no", reportsDir: "/no", rulesDir: "/no", registryPath: "/no" });
    const r = runTool(db, "nova", "search_messages", { query: "ZZKEY" });
    expect(r.observation).toContain("공개내용"); // ta(접근가능) 결과는 나옴
    expect(r.observation).not.toContain("남의비밀"); // ★tb(타인 private) 미노출★
  });
});

// ── 유닛: list_tasks (읽기전용 칸반 — 팀공유라 G3 스코프 비해당) ──
describe("list_tasks (read-only 칸반)", () => {
  test("runTool list_tasks: lane 필터 + owner 표기 (스코프 무관)", () => {
    const db = new Database(":memory:");
    migrate(db);
    createTask(db, { title: "PLAN작업", column: "plan" });
    createTask(db, { title: "DOING작업", column: "doing", owner: "demis" });
    const r = runTool(db, "nova", "list_tasks", { lane: "doing" });
    expect(r.observation).toContain("DOING작업");
    expect(r.observation).toContain("owner: demis");
    expect(r.observation).not.toContain("PLAN작업"); // lane 필터 적용
  });
  test("runTool list_tasks: lane 없으면 전 lane 반환", () => {
    const db = new Database(":memory:");
    migrate(db);
    createTask(db, { title: "A작업", column: "plan" });
    createTask(db, { title: "B작업", column: "done" });
    const r = runTool(db, "nova", "list_tasks", {});
    expect(r.observation).toContain("A작업");
    expect(r.observation).toContain("B작업");
  });
  test("runTool list_tasks: 태스크 없으면 안내 (throw 아님)", () => {
    const db = new Database(":memory:");
    migrate(db);
    const r = runTool(db, "nova", "list_tasks", { lane: "doing" });
    expect(r.observation).toContain("해당 태스크 없음");
  });
});

// ── 통합: runTurn (루프·게이트) ──
function setupDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(`INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file) VALUES ('nova','nova','r','b3os_native','b3os_native_runner','/tmp','p.md')`).run();
  db.prepare(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','t','dm','["nova","bill"]','bill')`).run();
  return db;
}
function agentRec(): AgentRecord {
  return { id: "nova", display_name: "nova", role: "r", runtime: "b3os_native", persona_file: "p.md" } as unknown as AgentRecord;
}
function inbound(db: Database): PendingDispatchRow {
  const m = insertMessage(db, { thread_id: "t1", from_agent_id: "bill", to_agent_id: "nova", type: "dm", body: "봐줘", source: "agent", hop_count: 0, priority: "normal" });
  return { message_id: m.id, thread_id: "t1", from_agent_id: "bill", body: "봐줘", hop_count: 0 } as unknown as PendingDispatchRow;
}
function novaMessages(db: Database, replyTo: string): { body: string }[] {
  return db.prepare(`SELECT body FROM message WHERE from_agent_id='nova' AND in_reply_to=?`).all(replyTo) as { body: string }[];
}
function auditDetail(db: Database): Record<string, unknown> {
  const a = db.prepare(`SELECT detail_json FROM audit_event WHERE actor='nova' AND action='message_sent'`).get() as { detail_json: string } | undefined;
  return a ? JSON.parse(a.detail_json) : {};
}
/** 스텝별 지정 답을 순서대로 돌려주는 mock caller. */
function scriptedCaller(replies: string[]): LlmCaller {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)]!;
}

describe("runTurn M3a 루프 통합", () => {
  test("플래그 off → 단발 1회(회귀0): 답 게시·loop_steps=1·tools_used=[]", async () => {
    const db = setupDb();
    const row = inbound(db);
    await runTurn(db, () => [agentRec()], agentRec(), row, "", async () => "단발답");
    const sent = novaMessages(db, row.message_id);
    expect(sent.length).toBe(1);
    expect(sent[0]!.body).toBe("단발답");
    const d = auditDetail(db);
    expect(d.loop_steps).toBe(1);
    expect(d.tools_used).toEqual([]);
  });

  test("플래그 on·도구 안 씀 → 1스텝 최종답(단발 동치)", async () => {
    process.env[AGENT_LOOP_FLAG] = "1";
    const db = setupDb();
    const row = inbound(db);
    await runTurn(db, () => [agentRec()], agentRec(), row, "", async () => "그냥 답");
    const sent = novaMessages(db, row.message_id);
    expect(sent.length).toBe(1);
    expect(sent[0]!.body).toBe("그냥 답");
    expect(auditDetail(db).loop_steps).toBe(1);
  });

  test("(k) 도구 1회→관찰→최종: insertMessage==1(중간관찰 미게시)·tools_used·loop_steps=2", async () => {
    process.env[AGENT_LOOP_FLAG] = "1";
    const db = setupDb();
    const row = inbound(db);
    const caller = scriptedCaller(['TOOL_CALL: {"tool":"search_messages","args":{"query":"측정지표"}}', "검색 결과 반영한 최종답입니다."]);
    await runTurn(db, () => [agentRec()], agentRec(), row, "", caller);
    const sent = novaMessages(db, row.message_id);
    expect(sent.length).toBe(1); // ★at-most-once: 최종답만 1회, 중간 관찰 미게시★
    expect(sent[0]!.body).toBe("검색 결과 반영한 최종답입니다.");
    const d = auditDetail(db);
    expect(d.loop_steps).toBe(2);
    expect(d.tools_used).toEqual(["search_messages"]);
  });

  test("(h) maxSteps 도달 → 최종 게시에 TOOL_CALL 잔존 0", async () => {
    process.env[AGENT_LOOP_FLAG] = "1";
    const db = setupDb();
    const row = inbound(db);
    // caller가 매번 다른 마커(canonical 반복 회피) → maxSteps(4)까지 감
    let n = 0;
    const caller: LlmCaller = async () => `생각중\nTOOL_CALL: {"tool":"search_messages","args":{"query":"q${n++}"}}`;
    await runTurn(db, () => [agentRec()], agentRec(), row, "", caller);
    const sent = novaMessages(db, row.message_id);
    expect(sent.length).toBe(1);
    expect(sent[0]!.body).not.toContain("TOOL_CALL"); // ★G1: 마커 잔존 0★
    expect(auditDetail(db).loop_steps).toBe(4); // maxSteps
  });

  test("(i) args 스키마 위반 → 도구 미실행(관찰로 되먹임)·최종 게시", async () => {
    process.env[AGENT_LOOP_FLAG] = "1";
    const db = setupDb();
    const row = inbound(db);
    const caller = scriptedCaller(['TOOL_CALL: {"tool":"search_messages","args":{"badkey":"x"}}', "검증 실패 후 최종답"]);
    await runTurn(db, () => [agentRec()], agentRec(), row, "", caller);
    const sent = novaMessages(db, row.message_id);
    expect(sent.length).toBe(1);
    expect(sent[0]!.body).toBe("검증 실패 후 최종답");
    expect(auditDetail(db).tools_used).toEqual([]); // 검증 실패 → 도구 안 돎
  });

  test("(l) canonical 같은도구+args 반복 → 조기 최종화(중복 실행 안 함)", async () => {
    process.env[AGENT_LOOP_FLAG] = "1";
    const db = setupDb();
    const row = inbound(db);
    // 매번 같은 마커 → 1회 실행 후 반복 감지로 조기마감
    const caller: LlmCaller = async () => 'TOOL_CALL: {"tool":"search_messages","args":{"query":"same"}}';
    await runTurn(db, () => [agentRec()], agentRec(), row, "", caller);
    const sent = novaMessages(db, row.message_id);
    expect(sent.length).toBe(1);
    const d = auditDetail(db);
    expect(d.tools_used).toEqual(["search_messages"]); // ★1회만(반복 실행 안 함)★
    expect((d.loop_steps as number)).toBeLessThanOrEqual(2); // 조기마감(maxSteps 안 감)
  });
});

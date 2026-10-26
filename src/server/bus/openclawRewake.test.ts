/**
 * openclaw 만기 뒤 [재개 확인] — 실 스키마 DB 로 만기·발신·알림을 실제로 만들어 본다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { insertMessage } from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { openclawRewakeAfterMin, rewakeAfterOpenclawExpiry } from "./openclawRewake";
import type { AgentRecord } from "../types";

const AGENTS = [
  { id: "codex", display_name: "Codex", runtime: "openclaw" },
  { id: "steve", display_name: "Steve", runtime: "claude_channel" },
] as unknown as AgentRecord[];

const T0 = Date.parse("2026-10-26T14:40:00Z");
const MIN = 60_000;

function freshDb(): Database {
  const d = new Database(":memory:");
  migrate(d);
  d.run(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t-work','t','dm','[]','steve')`);
  // 직접 메시지의 수신 행은 agent 표에 있는 팀원에게만 생긴다(messages.ts).
  d.run(`INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
         VALUES ('codex','Codex','dev','openclaw','openclaw_gateway','/tmp','x'),
                ('steve','Steve','pm','claude_channel','claude_tmux','/tmp','x')`);
  return d;
}

function sql(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function send(db: Database, from: string, to: string, atMs: number): string {
  const m = insertMessage(db, {
    thread_id: "t-work", from_agent_id: from, to_agent_id: to, type: "dm", body: "x", source: "agent", hop_count: 0,
  } as Parameters<typeof insertMessage>[1]);
  db.prepare(`UPDATE message SET created_at = ? WHERE id = ?`).run(sql(atMs), m.id);
  return m.id;
}

function expire(db: Database, messageId: string, agentId: string, atMs: number): void {
  appendAudit(db, "bus_dispatcher", "openclaw_wake_expired_no_retry", messageId, { agent_id: agentId, last_error: "x" });
  db.prepare(`UPDATE audit_event SET at = ? WHERE id = (SELECT MAX(id) FROM audit_event)`).run(sql(atMs));
}

function notices(db: Database, agentId: string) {
  return db
    .prepare(`SELECT m.id, m.thread_id, m.source, r.delivery_state FROM message m JOIN message_recipient r ON r.message_id = m.id
               WHERE m.from_agent_id = 'system' AND r.agent_id = ? AND m.dedupe_key LIKE 'openclaw-rewake:%'`)
    .all(agentId) as { id: string; thread_id: string; source: string; delivery_state: string }[];
}

describe("openclaw 만기 뒤 [재개 확인]", () => {
  afterEach(() => { delete process.env.OPENCLAW_REWAKE_AFTER_MIN; });

  test("기본값은 꺼짐 — 환경 변수가 없거나 0 이하면 0", () => {
    expect(openclawRewakeAfterMin()).toBe(0);
    process.env.OPENCLAW_REWAKE_AFTER_MIN = "0";
    expect(openclawRewakeAfterMin()).toBe(0);
    process.env.OPENCLAW_REWAKE_AFTER_MIN = "abc";
    expect(openclawRewakeAfterMin()).toBe(0);
    process.env.OPENCLAW_REWAKE_AFTER_MIN = "20";
    expect(openclawRewakeAfterMin()).toBe(20);
    expect(rewakeAfterOpenclawExpiry(freshDb(), AGENTS, 0, T0)).toBe(0);
  });

  test("만기 뒤 20분 동안 발신이 없으면 그 스레드로 알림 하나 — 원문은 다시 안 보낸다", () => {
    const db = freshDb();
    send(db, "codex", "steve", T0 - 10 * MIN);
    const ask = send(db, "steve", "codex", T0 - 5 * MIN);
    expire(db, ask, "codex", T0);

    expect(rewakeAfterOpenclawExpiry(db, AGENTS, 20, T0 + 19 * MIN)).toBe(0);   // 아직 이르다
    expect(rewakeAfterOpenclawExpiry(db, AGENTS, 20, T0 + 21 * MIN)).toBe(1);
    const n = notices(db, "codex");
    expect(n).toHaveLength(1);
    expect(n[0]?.thread_id).toBe("t-work");
    expect(n[0]?.source).toBe("system");
    expect(n[0]?.delivery_state).toBe("pending");                                  // 디스패처가 깨운다
    const askState = db.prepare(`SELECT COUNT(*) AS c FROM message WHERE id = ?`).get(ask) as { c: number };
    expect(askState.c).toBe(1);                                                   // 원문 복제 없음
  });

  test("같은 끊김에는 한 번만 — 알림이 또 만기돼도 다시 안 보낸다", () => {
    const db = freshDb();
    send(db, "codex", "steve", T0 - 10 * MIN);
    const ask = send(db, "steve", "codex", T0 - 5 * MIN);
    expire(db, ask, "codex", T0);
    expect(rewakeAfterOpenclawExpiry(db, AGENTS, 20, T0 + 21 * MIN)).toBe(1);
    const nid = notices(db, "codex")[0]!.id;
    expire(db, nid, "codex", T0 + 25 * MIN);
    const ask2 = send(db, "steve", "codex", T0 + 30 * MIN);
    expire(db, ask2, "codex", T0 + 34 * MIN);
    expect(rewakeAfterOpenclawExpiry(db, AGENTS, 20, T0 + 90 * MIN)).toBe(0);
    expect(notices(db, "codex")).toHaveLength(1);
  });

  test("만기 뒤 그 팀원이 뭔가 보냈으면 살아 있다 — 안 보낸다", () => {
    const db = freshDb();
    const ask = send(db, "steve", "codex", T0 - 5 * MIN);
    expire(db, ask, "codex", T0);
    send(db, "codex", "steve", T0 + 3 * MIN);
    expect(rewakeAfterOpenclawExpiry(db, AGENTS, 20, T0 + 30 * MIN)).toBe(0);
  });

  test("발신했다가 다시 끊기면 새 끊김으로 본다 — 한 번 더 보낸다", () => {
    const db = freshDb();
    const ask = send(db, "steve", "codex", T0 - 5 * MIN);
    expire(db, ask, "codex", T0);
    expect(rewakeAfterOpenclawExpiry(db, AGENTS, 20, T0 + 21 * MIN)).toBe(1);
    send(db, "codex", "steve", T0 + 22 * MIN);
    const ask2 = send(db, "steve", "codex", T0 + 30 * MIN);
    expire(db, ask2, "codex", T0 + 35 * MIN);
    expect(rewakeAfterOpenclawExpiry(db, AGENTS, 20, T0 + 50 * MIN)).toBe(0);
    expect(rewakeAfterOpenclawExpiry(db, AGENTS, 20, T0 + 56 * MIN)).toBe(1);
    expect(notices(db, "codex")).toHaveLength(2);
  });

  test("openclaw 가 아닌 팀원·6시간 넘은 만기·한도 상태는 건너뛴다", () => {
    const db = freshDb();
    const a1 = send(db, "codex", "steve", T0 - 5 * MIN);
    expire(db, a1, "steve", T0);                                                  // claude 런타임
    expect(rewakeAfterOpenclawExpiry(db, AGENTS, 20, T0 + 30 * MIN)).toBe(0);

    const a2 = send(db, "steve", "codex", T0 - 5 * MIN);
    expire(db, a2, "codex", T0);
    expect(rewakeAfterOpenclawExpiry(db, AGENTS, 20, T0 + 7 * 60 * MIN)).toBe(0);  // 6시간 넘음

    const src = readFileSync(join(import.meta.dir, "openclawRewake.ts"), "utf8");
    expect(src).toContain("if (getQuotaBlock(db, agentId, now)) return false;");
  });

  test("디스패처 60초 주기에서 꺼져 있으면 부르지 않는다", () => {
    const src = readFileSync(join(import.meta.dir, "wakeDispatcher.ts"), "utf8");
    expect(src).toContain("const rewakeMin = openclawRewakeAfterMin();");
    expect(src).toContain("if (rewakeMin > 0) {");
  });
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import {
  hermesGdSessionKey,
  openclawGdSessionKey,
  parseHermesGdDirectMessages,
  parseOpenClawGdDirectMessages,
  parseOpenClawGdDms,
  syncHermesGdDirectMessages,
  syncOpenClawGdDirectMessages,
} from "./dmRuntimeParsers";

// 테스트 전용 팀장 chat_id (하드코딩된 실값이 아님 — 파서는 이제 인자로 받는다)
const OWNER = "1000000001";
const OPENCLAW_GD_DIRECT_SESSION_KEY = openclawGdSessionKey(OWNER, "gd");
const OPENCLAW_DEVON_DIRECT_SESSION_KEY = openclawGdSessionKey(OWNER, "devon");
const HERMES_GD_DIRECT_SESSION_KEY = hermesGdSessionKey(OWNER);
import { recallDmMessages } from "./dmCapture";

if (false) {
  // @ts-expect-error agentId is intentionally required so omission cannot silently fall back to gd.
  openclawGdSessionKey(OWNER);
  // @ts-expect-error parse options must name the OpenClaw agent id explicitly.
  parseOpenClawGdDirectMessages({ sessionsDir: "/tmp", chatId: OWNER });
}

const tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dm-runtime-parsers-"));
  tmpRoots.push(dir);
  return dir;
}

function writeJsonl(file: string, rows: unknown[]): void {
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function freshTeamDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function freshHermesDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      session_key TEXT,
      chat_id TEXT,
      chat_type TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp REAL NOT NULL,
      platform_message_id TEXT
    );
  `);
  return db;
}

test("openclaw parser keeps exact GD direct trajectory and excludes team/router sessions", () => {
  const dir = tmpRoot();
  writeJsonl(join(dir, "direct.trajectory.jsonl"), [
    {
      type: "prompt.submitted",
      ts: "2026-07-06T00:00:00.000Z",
      sessionKey: OPENCLAW_GD_DIRECT_SESSION_KEY,
      data: {
        turnId: "turn-in",
        prompt: `Current user request:
Conversation info:
\`\`\`json
{"chat_id":"telegram:1000000001","message_id":"261"}
\`\`\`

Conversation context:
#250 old line
새 요청 본문`,
      },
    },
    {
      type: "tool.call",
      ts: "2026-07-06T00:00:05.000Z",
      sessionKey: OPENCLAW_GD_DIRECT_SESSION_KEY,
      data: { turnId: "turn-out", name: "message", arguments: { action: "send", message: "응답 본문" } },
    },
    {
      type: "prompt.submitted",
      ts: "2026-07-06T00:01:00.000Z",
      sessionKey: "agent:gd:telegram:team-collab-router:devon:-100:thread",
      data: { turnId: "team", prompt: "팀방 본문" },
    },
  ]);

  const parsed = parseOpenClawGdDirectMessages({ sessionsDir: dir, chatId: OWNER, agentId: "gd" });
  expect(parsed.map((m) => [m.direction, m.body, m.dedupeKey])).toEqual([
    ["in", "새 요청 본문", "telegram:1000000001:261"],
    ["out", "응답 본문", "telegram:1000000001:openclaw-out:turn-out"],
  ]);
});

test("openclaw parser uses the member agent id for newer OpenClaw session keys", () => {
  const dir = tmpRoot();
  writeJsonl(join(dir, "devon.trajectory.jsonl"), [
    {
      type: "prompt.submitted",
      ts: "2026-07-17T10:00:00.000Z",
      sessionKey: OPENCLAW_DEVON_DIRECT_SESSION_KEY,
      data: { turnId: "devon-in", prompt: `Current user request:\n본문 [message_id: 901]` },
    },
    {
      type: "tool.call",
      ts: "2026-07-17T10:00:05.000Z",
      sessionKey: OPENCLAW_DEVON_DIRECT_SESSION_KEY,
      data: { turnId: "devon-out", name: "message", arguments: { action: "send", message: "devon 응답" } },
    },
    {
      type: "prompt.submitted",
      ts: "2026-07-17T10:01:00.000Z",
      sessionKey: OPENCLAW_GD_DIRECT_SESSION_KEY,
      data: { turnId: "old-gd", prompt: "옛 codex 저장소 본문 [message_id: 902]" },
    },
  ]);

  const parsed = parseOpenClawGdDms("devon", dir, OWNER);
  expect(parsed.map((m) => [m.memberId, m.direction, m.body, m.dedupeKey])).toEqual([
    ["devon", "in", "본문 [message_id: 901]", "telegram:1000000001:901"],
    ["devon", "out", "devon 응답", "telegram:1000000001:openclaw-out:devon-out"],
  ]);
});

test("openclaw parser can map a member id to a different OpenClaw agent id", () => {
  const dir = tmpRoot();
  writeJsonl(join(dir, "codex.trajectory.jsonl"), [
    {
      type: "prompt.submitted",
      ts: "2026-07-17T11:00:00.000Z",
      sessionKey: OPENCLAW_GD_DIRECT_SESSION_KEY,
      data: { turnId: "codex-in", prompt: `Current user request:\n옛 저장소 본문 [message_id: 911]` },
    },
    {
      type: "prompt.submitted",
      ts: "2026-07-17T11:01:00.000Z",
      sessionKey: OPENCLAW_DEVON_DIRECT_SESSION_KEY,
      data: { turnId: "wrong-agent", prompt: "devon 본문 [message_id: 912]" },
    },
  ]);

  const parsed = parseOpenClawGdDms("codex", dir, OWNER, "gd");
  expect(parsed.map((m) => [m.memberId, m.direction, m.body, m.dedupeKey])).toEqual([
    ["codex", "in", "옛 저장소 본문 [message_id: 911]", "telegram:1000000001:911"],
  ]);
});

test("openclaw sync inserts through dm_message with member isolation and dedupe", () => {
  const dir = tmpRoot();
  writeJsonl(join(dir, "backup.jsonl.reset.2026-07-06"), [
    {
      type: "message",
      id: "m1",
      timestamp: "2026-07-06T00:00:00.000Z",
      message: {
        role: "user",
        sourceChannel: "telegram",
        senderId: "1000000001",
        content: "본문 [message_id: 300]",
      },
    },
    {
      type: "message",
      id: "m2",
      timestamp: "2026-07-06T00:00:01.000Z",
      message: {
        role: "user",
        sourceChannel: "telegram",
        senderId: "999",
        content: "다른 사람",
      },
    },
  ]);
  const db = freshTeamDb();
  expect(syncOpenClawGdDirectMessages(db, { sessionsDir: dir, chatId: OWNER, agentId: "devon" }, { memberId: "devon" })).toBe(1);
  expect(syncOpenClawGdDirectMessages(db, { sessionsDir: dir, chatId: OWNER, agentId: "devon" }, { memberId: "devon" })).toBe(0);
  const rows = recallDmMessages(db, "devon");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.dedupe_key).toBe("telegram:1000000001:300");
});

test("hermes parser reads only exact dm session_key/chat_id and user/assistant rows", () => {
  const h = freshHermesDb();
  h.prepare("INSERT INTO sessions (id, session_key, chat_id, chat_type) VALUES (?, ?, ?, ?)").run("direct", HERMES_GD_DIRECT_SESSION_KEY, "1000000001", "dm");
  h.prepare("INSERT INTO sessions (id, session_key, chat_id, chat_type) VALUES (?, ?, ?, ?)").run("group", HERMES_GD_DIRECT_SESSION_KEY, "-100", "group");
  h.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, platform_message_id) VALUES (?, ?, ?, ?, ?, ?)").run(1, "direct", "user", "들어온 말", 1782786029.91, "1546");
  h.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, platform_message_id) VALUES (?, ?, ?, ?, ?, ?)").run(2, "direct", "assistant", "나간 말", 1782786030.91, null);
  h.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, platform_message_id) VALUES (?, ?, ?, ?, ?, ?)").run(3, "direct", "tool", "도구", 1782786031.91, null);
  h.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, platform_message_id) VALUES (?, ?, ?, ?, ?, ?)").run(4, "group", "user", "팀방", 1782786032.91, "999");

  const parsed = parseHermesGdDirectMessages({ stateDb: h, chatId: OWNER });
  expect(parsed.map((m) => [m.direction, m.body, m.dedupeKey])).toEqual([
    ["in", "들어온 말", "telegram:1000000001:1546"],
    ["out", "나간 말", "telegram:1000000001:hermes:direct:2"],
  ]);
});

test("hermes sync writes UTC rows and dedupes", () => {
  const h = freshHermesDb();
  h.prepare("INSERT INTO sessions (id, session_key, chat_id, chat_type) VALUES (?, ?, ?, ?)").run("direct", HERMES_GD_DIRECT_SESSION_KEY, "1000000001", "dm");
  h.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, platform_message_id) VALUES (?, ?, ?, ?, ?, ?)").run(10, "direct", "user", "안녕", 1782786029.91, "777");
  const db = freshTeamDb();
  expect(syncHermesGdDirectMessages(db, { stateDb: h, chatId: OWNER }, { memberId: "hermes" })).toBe(1);
  expect(syncHermesGdDirectMessages(db, { stateDb: h, chatId: OWNER }, { memberId: "hermes" })).toBe(0);
  const rows = recallDmMessages(db, "hermes");
  expect(rows[0]!.created_at).toBe("2026-06-30 02:20:29");
  expect(rows[0]!.dedupe_key).toBe("telegram:1000000001:777");
});

// dmSyncWorker 게이트 — 팀장 chat_id·on/off 설정이 실제로 캡처를 막는가(GD 2026-07-14).
//
// ★왜 이 테스트가 있나★
//   ① 팀장 chat_id 를 코드에 상수로 박아 두면, 다른 팀에서는 그 값이 아무와도 안 맞아
//      필터가 전부 걸러내고 dm_message 가 ★조용히 0건★ 이 된다 — 누출이 아니라 ★무동작★ 으로 실패한다.
//      그래서 설정값(owner_chat_id)을 읽고, 없으면 ★캡처를 아예 하지 않는다★(무동작이 오동작보다 낫다).
//   ② DM 적재는 팀원 세션 기록을 읽는 기능이라 ★끌 수 있어야★ 한다(dm_capture=off).
//      끄면 적재만 멈추고 버스·위임·발신은 그대로여야 한다 — dm_message 는 크리티컬이 아니다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { syncDmOnce, type DmSyncMember } from "./dmSyncWorker";
import { parseClaudeGdDms } from "../runtimes/claude/dmSource";

const OWNER = "555000111"; // 테스트 전용 팀장 chat_id (코드에 박힌 값이 아님 — 그게 요점이다)

function channelTag(chatId: string, mid: string, body: string): string {
  return `<channel source="plugin:telegram" chat_id="${chatId}" message_id="${mid}">${body}</channel>`;
}

/** 일반 턴 메시지(=팀원이 놀고 있을 때 도착) — user 이벤트로 기록된다. */
function normalTurnEvent(chatId: string, mid: string, body: string) {
  return { timestamp: new Date().toISOString(), type: "user", message: { role: "user", content: channelTag(chatId, mid, body) } };
}

/** ★인터럽트 메시지(=팀원이 일하는 중에 도착)★ — 클로드는 user 가 아니라 queue-operation 으로 적는다. */
function interruptEvent(chatId: string, mid: string, body: string) {
  return { type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), content: channelTag(chatId, mid, body) };
}

function writeSession(events: unknown[]): string {
  const ws = mkdtempSync(join(tmpdir(), "dmsync-ws-"));
  // dmSource 는 ~/.claude/projects/<워크스페이스경로의 / 를 - 로> 에서 세션을 찾는다.
  const sessionDir = join(process.env.HOME ?? tmpdir(), ".claude", "projects", ws.replace(/\//g, "-"));
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "s1.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return ws;
}

/** 팀장 1:1 DM 1건(일반 턴). */
function workspaceWithOneDm(ownerChatId: string): string {
  return writeSession([normalTurnEvent(ownerChatId, "9001", "안녕")]);
}

function writeOpenClawSession(agentsDir: string, agentId: string, sessionKey: string): void {
  const sessionDir = join(agentsDir, agentId, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "direct.trajectory.jsonl"), [
    JSON.stringify({
      type: "prompt.submitted",
      ts: "2026-07-17T10:00:00.000Z",
      sessionKey,
      data: { turnId: `${agentId}-in`, prompt: `Current user request:\n${agentId} 본문 [message_id: ${agentId === "gd" ? "9901" : "9902"}]` },
    }),
  ].join("\n") + "\n");
}

function writeHermesStateDb(rows: Array<{ role: "user" | "assistant"; content: string; platformMessageId?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "dmsync-hermes-"));
  const path = join(dir, "state.db");
  const stateDb = new Database(path);
  try {
    stateDb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, session_key TEXT, chat_type TEXT, chat_id TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp INTEGER, platform_message_id TEXT);
    `);
    stateDb.prepare("INSERT INTO sessions (id, session_key, chat_type, chat_id) VALUES (?, ?, 'dm', ?)")
      .run("s-hermes", `agent:main:telegram:dm:${OWNER}`, OWNER);
    const stmt = stateDb.prepare("INSERT INTO messages (session_id, role, content, timestamp, platform_message_id) VALUES (?, ?, ?, ?, ?)");
    rows.forEach((row, index) => {
      stmt.run("s-hermes", row.role, row.content, Date.UTC(2026, 6, 17, 5, index), row.platformMessageId ?? `h-${index}`);
    });
  } finally {
    stateDb.close();
  }
  return path;
}

function freshDb(settings: Record<string, string>): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const [k, v] of Object.entries(settings)) {
    db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)").run(k, v);
  }
  return db;
}

describe("dmSyncWorker 게이트", () => {
  const member = (ws: string): DmSyncMember[] => [{ id: "bill", runtime: "claude_channel", workspacePath: ws }];

  test("owner_chat_id 설정 → 그 chat_id 의 DM 을 적재한다", () => {
    const ws = workspaceWithOneDm(OWNER);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(1);
  });

  // ★이 테스트가 진짜 지키는 것★: 파서가 ★설정된 chat_id 로만★ 잡는다는 것.
  //   (owner_chat_id 를 아예 못 찾는 경우는 resolveOwnerDmId 3단 폴백이 실 파일시스템을 읽어서
  //    유닛에서 격리가 안 된다 — 그 경로는 코드 리뷰와 라이브로 본다. 여기서 억지로 흉내내면
  //    ★실제 페어링 파일에 의존하는 가짜 테스트★ 가 된다.)
  test("★설정과 다른 chat_id 의 DM 은 안 잡힌다★ (하드코딩 상수로 몰래 잡지 않는다)", () => {
    const ws = workspaceWithOneDm("999888777"); // 다른 사람의 DM
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(0);
  });

  test("★파서에 chat_id 를 안 넘기면 0건★ (조용한 오작동 대신 무동작)", () => {
    // 워커가 아니라 파서 계약을 직접 본다 — 설정 해석 경로와 무관하게 성립해야 한다.
    const ws = workspaceWithOneDm(OWNER);
    expect(parseClaudeGdDms("bill", ws, "").length).toBe(0);
    expect(parseClaudeGdDms("bill", ws, OWNER).length).toBe(1);
  });

  test("★dm_capture=off → 캡처 0건★ (팀원 세션 기록 적재를 끌 수 있다)", () => {
    const ws = workspaceWithOneDm(OWNER);
    const db = freshDb({ owner_chat_id: OWNER, dm_capture: "off" });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(0);
  });

  test("dm_capture 미설정 → 기본 on (기존 동작 보존)", () => {
    const ws = workspaceWithOneDm(OWNER);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(1);
  });

  test("한 멤버 파서 실패를 격리하고 health+audit에 남긴다", () => {
      const db = freshDb({ owner_chat_id: OWNER });
      const result = syncDmOnce(db, [
        { id: "broken", runtime: "broken_runtime", workspacePath: "/unused" },
        { id: "healthy", runtime: "healthy_runtime", workspacePath: "/unused" },
      ], {
        broken_runtime: () => { throw new Error("bad format"); },
        healthy_runtime: () => [{ memberId: "healthy", runtime: "test", direction: "in", body: "ok", createdAt: new Date(), dedupeKey: "healthy:1", sourceRef: "test" }],
      });
      expect(result.inserted).toBe(1); // 뒤 멤버는 계속 처리
      expect((db.prepare("SELECT state FROM dm_sync_health WHERE member_id='broken'").get() as { state: string }).state).toBe("error");
      expect((db.prepare("SELECT COUNT(*) n FROM audit_event WHERE action='dm_sync_member_failed' AND target='broken'").get() as { n: number }).n).toBe(1);
      syncDmOnce(db, [{ id: "broken", runtime: "broken_runtime", workspacePath: "/unused" }], {
        broken_runtime: () => { throw new Error("bad format"); },
      });
      expect((db.prepare("SELECT COUNT(*) n FROM audit_event WHERE action='dm_sync_member_failed' AND target='broken'").get() as { n: number }).n).toBe(1); // 연속 동일 실패 audit dedupe
  });
});

describe("런타임 저장소 경로 매핑", () => {
  test("member id와 OpenClaw agent id가 달라도 올바른 저장소와 sessionKey를 본다", () => {
    const oldAgentsDir = process.env.B3OS_OPENCLAW_AGENTS_DIR;
    const agentsDir = mkdtempSync(join(tmpdir(), "dmsync-openclaw-agents-"));
    process.env.B3OS_OPENCLAW_AGENTS_DIR = agentsDir;
    try {
      writeOpenClawSession(agentsDir, "gd", `agent:gd:telegram:direct:${OWNER}`);
      writeOpenClawSession(agentsDir, "codex", `agent:codex:telegram:direct:${OWNER}`);

      const db = freshDb({ owner_chat_id: OWNER });
      const result = syncDmOnce(db, [{
        id: "codex",
        runtime: "openclaw",
        workspacePath: "/unused",
        openclawAgentId: "gd",
      }]);

      expect(result.inserted).toBe(1);
      expect(result.byMember).toEqual({ codex: 1 });
    } finally {
      if (oldAgentsDir === undefined) delete process.env.B3OS_OPENCLAW_AGENTS_DIR;
      else process.env.B3OS_OPENCLAW_AGENTS_DIR = oldAgentsDir;
    }
  });

  test("hermes 멤버 id 와 profile/state.db 경로가 달라도 명시 경로에서 적재한다", () => {
    const hermesDb = writeHermesStateDb([
      { role: "user", content: "GD→Hermes", platformMessageId: "9900" },
      { role: "assistant", content: "Hermes→GD", platformMessageId: "9901" },
    ]);
    const db = freshDb({ owner_chat_id: OWNER });
    const result = syncDmOnce(db, [{
      id: "hermes",
      runtime: "hermes_agent",
      workspacePath: "/unused",
      hermesProfile: "b3ryshermes",
      hermesStateDbPath: hermesDb,
    }]);

    expect(result.inserted).toBe(2);
    expect(result.scanned).toBe(2);
    expect(result.byMember).toEqual({ hermes: 2 });
    const count = db.prepare("SELECT count(*) AS c FROM dm_message WHERE member_id = 'hermes'").get() as { c: number };
    expect(count.c).toBe(2);
  });

  test("hermes 전용 state.db 가 없으면 공유 ~/.hermes/state.db 로 폴백하지 않고 0건 처리한다", () => {
    const db = freshDb({ owner_chat_id: OWNER });
    const result = syncDmOnce(db, [{
      id: "hermes",
      runtime: "hermes_agent",
      workspacePath: "/unused",
      hermesProfile: "definitely-missing-profile-for-test",
      hermesStateDbPath: join(tmpdir(), "missing-hermes-state.db"),
    }]);

    expect(result).toEqual({ inserted: 0, scanned: 0, byMember: {} });
  });
});

describe("런타임 저장소 경로 매핑", () => {
  test("hermes 멤버 id 와 profile/state.db 경로가 달라도 명시 경로에서 적재한다", () => {
    const hermesDb = writeHermesStateDb([
      { role: "user", content: "GD→Hermes", platformMessageId: "9900" },
      { role: "assistant", content: "Hermes→GD", platformMessageId: "9901" },
    ]);
    const db = freshDb({ owner_chat_id: OWNER });
    const result = syncDmOnce(db, [{
      id: "hermes",
      runtime: "hermes_agent",
      workspacePath: "/unused",
      hermesProfile: "b3ryshermes",
      hermesStateDbPath: hermesDb,
    }]);

    expect(result.inserted).toBe(2);
    expect(result.scanned).toBe(2);
    expect(result.byMember).toEqual({ hermes: 2 });
    const count = db.prepare("SELECT count(*) AS c FROM dm_message WHERE member_id = 'hermes'").get() as { c: number };
    expect(count.c).toBe(2);
  });

  test("hermes 전용 state.db 가 없으면 공유 ~/.hermes/state.db 로 폴백하지 않고 0건 처리한다", () => {
    const db = freshDb({ owner_chat_id: OWNER });
    const result = syncDmOnce(db, [{
      id: "hermes",
      runtime: "hermes_agent",
      workspacePath: "/unused",
      hermesProfile: "definitely-missing-profile-for-test",
      hermesStateDbPath: join(tmpdir(), "missing-hermes-state.db"),
    }]);

    expect(result).toEqual({ inserted: 0, scanned: 0, byMember: {} });
  });
});

// ★팀원이 '일하는 중'에 팀장이 보낸 메시지(인터럽트) — GD 2026-07-14 발견.★
//   클로드는 인터럽트를 user 이벤트가 아니라 {type:"queue-operation", operation:"enqueue"} 로 적는다.
//   role==="user" 만 보던 옛 파서는 이걸 통째로 놓쳤다 →
//   ★실측(전 세션): 팀장 DM 1,718건 중 780건만 잡혔다 — 938건(55%) 유실. 최근 세션만 보면 66%.★
//   하필 인터럽트가 "빌 응답??" 같은 ★재촉★ 이라, 기록에서 빠진 게 제일 중요한 메시지들이었다.
describe("인터럽트 메시지 (턴 중 도착)", () => {
  const member = (ws: string): DmSyncMember[] => [{ id: "bill", runtime: "claude_channel", workspacePath: ws }];

  test("★queue-operation 으로 적힌 인터럽트도 적재한다★", () => {
    const ws = writeSession([interruptEvent(OWNER, "9100", "빌 응답??")]);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(1);
  });

  test("일반 턴 + 인터럽트 둘 다 적재 (한쪽만 잡는 회귀 방지)", () => {
    const ws = writeSession([
      normalTurnEvent(OWNER, "9200", "정상 턴 메시지"),
      interruptEvent(OWNER, "9201", "일하는 중에 보낸 메시지"),
    ]);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(2);
  });

  test("★같은 메시지가 양쪽에 다 적혀도 1건★ (dedupe_key 공유 — 이중적재 없음)", () => {
    const ws = writeSession([
      interruptEvent(OWNER, "9300", "같은 메시지"),
      normalTurnEvent(OWNER, "9300", "같은 메시지"), // 같은 message_id
    ]);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(1);
  });

  test("인터럽트도 owner_chat_id 필터를 지킨다 (다른 사람 DM 은 안 잡힘)", () => {
    const ws = writeSession([interruptEvent("999888777", "9400", "남의 메시지")]);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(0);
  });

  test("인터럽트 자리에 버스 메시지가 와도 1:1 로 오인하지 않는다", () => {
    const ws = writeSession([
      { type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(),
        content: `<external_message source="bus" from="codex"><channel source="plugin:telegram" chat_id="${OWNER}" message_id="9500">버스</channel></external_message>` },
    ]);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(0);
  });

  test("dequeue/remove(content 없음) 는 크래시 없이 무시한다", () => {
    const ws = writeSession([
      { type: "queue-operation", operation: "dequeue", timestamp: new Date().toISOString(), content: null },
      { type: "queue-operation", operation: "remove", timestamp: new Date().toISOString() },
      normalTurnEvent(OWNER, "9600", "정상"),
    ]);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(1);
  });
});

// ★본문에 <external_message> 라는 '글자' 가 있다고 DM 을 버리면 안 된다 (적대 리뷰 2026-07-14).★
//   팀장은 룰·포맷 스니펫을 자주 붙여넣는다. 옛 가드는 본문 어디든 그 문자열이 있으면 통째로 버렸다.
//   진짜 버스 메시지는 <external_message 로 ★시작★ 하므로, 시작 위치로만 판정한다.
describe("버스 배제 가드는 앵커로 판정한다", () => {
  const member = (ws: string): DmSyncMember[] => [{ id: "bill", runtime: "claude_channel", workspacePath: ws }];

  test("★본문이 <external_message> 를 '언급' 하는 팀장 DM 은 정상 적재★", () => {
    const ws = writeSession([normalTurnEvent(OWNER, "9700", "이 <external_message> 태그 파싱 어떻게 해?")]);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(1);
  });

  test("인터럽트로 온 것도 마찬가지 (두 경로 동일)", () => {
    const ws = writeSession([interruptEvent(OWNER, "9701", "<external_message> 가드 얘기인데")]);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(1);
  });

  test("진짜 버스 메시지(=<external_message 로 시작)는 계속 배제", () => {
    const ws = writeSession([
      { type: "user", timestamp: new Date().toISOString(), message: { role: "user",
        content: `<external_message source="bus" from="codex">팀 메시지<channel source="plugin:telegram" chat_id="${OWNER}" message_id="9702">x</channel></external_message>` } },
    ]);
    const db = freshDb({ owner_chat_id: OWNER });
    expect(syncDmOnce(db, member(ws)).inserted).toBe(0);
  });
});

/**
 * ★broadcast 수신자는 명부의 정식·활성 팀원이다 — DB 전원이 아니다.★
 *
 * ═══ 실제로 터진 일 ═══
 * 같은 질문("누가 받나")을 두 코드가 따로 답했다.
 *   팀장 @all   → `ownerDecision.broadcastTargets` → 정식·활성만
 *   팀원 broadcast → 여기 팬아웃 → `SELECT id FROM agent` = ★DB 전원★
 * 실측: @all 9명 vs 팀원 broadcast 11명. ★꺼둔(enabled:false) 팀원까지 수신행이 생겼다.★
 * 슬랙 답신도 같은 팬아웃을 지난다 — 실측 수신행 60건에 ★읽음 0★ 이었다(깨움 흔적은 없었다).
 *
 * 원인은 `agent` 표에 `team_official_member`·`enabled` 컬럼이 ★없다★ 는 것이다 —
 * 쿼리로는 규칙을 적용할 방법 자체가 없었다. 그래서 명부(agents.json)를 읽어 판정한다.
 *
 * ★기대값을 손으로 적지 않는다.★ 같은 명부에서 규칙으로 다시 계산해 두 집합을 비교한다.
 * 이름·숫자를 박으면 팀원이 늘거나 플래그가 바뀔 때 시험이 조용히 낡는다(오늘 7→8→9 로 움직였다).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../migrate";
import { ensureThread, insertMessage } from "./messages";
import { broadcastRecipientIds } from "../../lib/agentMembership";

const ROSTER = [
  { id: "sender", display_name: "Sender", role: "r", runtime: "claude_channel", team_official_member: true },
  { id: "member", display_name: "Member", role: "r", runtime: "claude_channel", team_official_member: true, nicknames: ["멤버"] },
  { id: "observer", display_name: "Observer", role: "r", runtime: "openclaw", team_official_member: false },
  { id: "paused", display_name: "Paused", role: "r", runtime: "openclaw", team_official_member: true, enabled: false },
];

let dir = "";
let prevRegistry: string | undefined;
let prevAudit: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcast-recip-"));
  // ★실 파일시스템 격리★ — 라이브 agents.json·감사로그를 건드리지 않는다.
  prevRegistry = process.env.TEAM_AGENT_REGISTRY;
  prevAudit = process.env.B3OS_AUDIT_LOG_DIR;
  process.env.B3OS_AUDIT_LOG_DIR = dir;
});
afterEach(() => {
  if (prevRegistry === undefined) delete process.env.TEAM_AGENT_REGISTRY;
  else process.env.TEAM_AGENT_REGISTRY = prevRegistry;
  if (prevAudit === undefined) delete process.env.B3OS_AUDIT_LOG_DIR;
  else process.env.B3OS_AUDIT_LOG_DIR = prevAudit;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function withRoster(roster: Array<Record<string, unknown>>): Database {
  // 캐시 키에 경로가 들어가므로 시험마다 새 파일을 쓰면 서로 안 섞인다.
  const path = join(dir, `agents-${roster.length}-${Math.abs(roster.length * 7 + roster.length)}.json`);
  writeFileSync(path, JSON.stringify(roster));
  process.env.TEAM_AGENT_REGISTRY = path;

  const db = new Database(":memory:");
  migrate(db);
  for (const a of roster) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'r', 'claude_channel', 'claude_tmux', '/tmp', 'p.md')`,
    ).run(a.id as string, a.display_name as string);
  }
  return db;
}

function broadcastFrom(db: Database, from: string, source = "agent", body = "@all 공지"): string[] {
  const { thread_id } = ensureThread(db, { from_agent_id: from, to_agent_id: "broadcast", type: "broadcast", body } as never);
  const stored = insertMessage(db, { from_agent_id: from, to_agent_id: "broadcast", type: "broadcast", body, thread_id, source } as never);
  return db
    .prepare(`SELECT agent_id FROM message_recipient WHERE message_id = ? ORDER BY agent_id`)
    .all(stored.id)
    .map((r) => (r as { agent_id: string }).agent_id);
}

describe("★팀원 broadcast 팬아웃은 @all 과 같은 규칙을 쓴다★", () => {
  test("비정식·정지 팀원에게는 수신행이 생기지 않는다", () => {
    const db = withRoster(ROSTER);
    const got = broadcastFrom(db, "sender");
    // 기대값 = 같은 명부에서 규칙으로 다시 계산 (하드코딩 아님)
    expect(got).toEqual(broadcastRecipientIds(ROSTER as never, "sender").slice().sort());
    expect(got, "★꺼둔 팀원이 깨어난다★ — 이게 원래 결함이었다").not.toContain("paused");
    expect(got, "비정식 팀원은 대상이 아니다").not.toContain("observer");
    expect(got, "발신자는 자기 글을 안 받는다").not.toContain("sender");
  });

  test("★슬랙 스레드 답신은 팀원 수신행을 만들지 않는다 (멘션 기준)★", () => {
    // 슬랙은 멘션된 글만 들어온다 → 그 대화의 우리 쪽 당사자는 발신자 한 명뿐이다.
    // ★빈 배열을 넘기는 방식으로는 못 막는다★ — `length > 0` 조건 때문에 else 로 떨어져
    // 조용히 전원으로 되돌아간다. 이 시험이 그 되돌아감을 잡는다.
    const db = withRoster(ROSTER);
    const { thread_id } = ensureThread(db, { from_agent_id: "sender", to_agent_id: "broadcast", type: "broadcast", body: "hi" } as never);
    // 슬랙 어댑터가 스레드를 열 때 붙이는 것과 같은 meta
    insertMessage(db, {
      from_agent_id: "sender", to_agent_id: "broadcast", type: "broadcast", body: "from slack",
      thread_id, source: "agent", meta: { slack: { channel: "C1", thread_ts: "1.0" } },
    } as never);
    const reply = insertMessage(db, {
      from_agent_id: "sender", to_agent_id: "broadcast", type: "broadcast", body: "@all 다들 확인", thread_id, source: "agent",
    } as never);
    const rows = db.prepare(`SELECT agent_id FROM message_recipient WHERE message_id = ?`).all(reply.id);
    expect(rows.length, "★슬랙 답신이 팀원 전원에게 수신행을 만든다★").toBe(0);

    // ★발송 자체는 막히지 않아야 한다★ — 수신행 0 과 '발송 실패' 는 겉보기가 비슷하다. 두 축을 따로 잰다.
    const stored = db.prepare(`SELECT id, body FROM message WHERE id = ?`).get(reply.id) as { id: string; body: string };
    expect(stored?.body, "★메시지 자체가 저장되지 않았다 = 슬랙으로도 못 나간다★").toBe("@all 다들 확인");
  });

  test("★멘션 없는 방 발언은 팀원 수신행을 안 만든다 — 방 게시는 그대로다★", () => {
    // "왜 팀원이 단톡방에서 나한테 얘기하는데 broadcast 로 전 팀원에 메시지가 가느냐" (GD)
    // 실측: 멘션 없는 방 발언 51건 중 ★답이 달린 것 0건★ — 잘라도 끊기는 대화가 없다.
    const db = withRoster(ROSTER);
    const got = broadcastFrom(db, "sender", "agent", "네 확인했습니다");
    expect(got.length, "★멘션도 없는데 팀원 전원에게 수신행이 생긴다★").toBe(0);
    // ★두 축을 따로 잰다★ — 수신행 0 과 '게시 실패' 는 겉보기가 같다.
    const row = db.prepare("SELECT body FROM message WHERE body = ?").get("네 확인했습니다");
    expect(row, "★메시지 자체가 저장되지 않았다 = 방에도 안 뜬다★").toBeTruthy();
  });

  test("★@이름 을 불러도 방에서는 전달하지 않는다 — 팀원끼리는 팀버스로★", () => {
    // GD: "단톡방에선 내가 멘션한 사람만 얘기하는 거야. 팀원끼리는 팀버스로."
    // 방 발언의 예외는 @all 하나뿐이다.
    const db = withRoster(ROSTER);
    expect(broadcastFrom(db, "sender", "agent", "@member 이거 봐줘")).toEqual([]);
  });

  test("★@all 은 정식·활성 팀원 전원에게 간다★", () => {
    const db = withRoster(ROSTER);
    const got = broadcastFrom(db, "sender", "agent", "@all 다들 확인");
    expect(got).toEqual(broadcastRecipientIds(ROSTER as never, "sender").slice().sort());
    expect(got).not.toContain("paused");
    expect(got).not.toContain("observer");
  });

  test("★@all 대상이 명부 플래그를 따른다 — 팬아웃과 @all 이 같은 답을 낸다★", () => {
    // 소스를 grep 하지 않는다. ★함수명만 바꿔도 깨지고, 다른 파일에 판정이 생기면 못 본다★(하네스 지적).
    // 대신 ★플래그를 바꿨을 때 결과가 따라오는지★ 로 잰다 — 판정이 둘이면 한쪽만 따라온다.
    const flipped = ROSTER.map((a) => (a.id === "observer" ? { ...a, team_official_member: true } : a));
    const db = withRoster(flipped);
    const got = broadcastFrom(db, "sender", "agent", "@all 공지");
    expect(got, "★명부 플래그를 켰는데 팬아웃이 안 따라온다 = 판정이 둘이다★").toContain("observer");
    expect(got).toEqual(broadcastRecipientIds(flipped as never, "sender").slice().sort());
  });

  test("★명부 파일이 없으면 DB 로 되돌아간다 — 아무에게도 안 가는 게 최악이다★", () => {
    // `agents.json` 은 gitignore 라 새 clone·공개 설치·테스트에 ★존재하지 않는다.★
    // 플래그가 비어 있는 것과 ★명부 자체가 없는 것★ 은 다르다 — 뒤쪽에서 빈 목록이 되면
    // broadcast 가 아무에게도 안 간다. 원래 결함보다 나쁘다.
    const db = withRoster(ROSTER);
    process.env.TEAM_AGENT_REGISTRY = join(dir, "does-not-exist.json");
    const got = broadcastFrom(db, "sender");
    expect(got.length, "★명부가 없다고 수신자가 0명이 되면 안 된다★").toBeGreaterThan(0);
    expect(got).not.toContain("sender");
  });

  test("★명부에만 있고 DB 에 없는 팀원은 조용히 빠지지 않는다 — 감사에 남는다★", () => {
    // 교집합으로 FK 사고는 막되, ★싱크가 깨진 사실은 남긴다.★ 안 남기면 아무도 모른다.
    const extra = [...ROSTER, { id: "ghost", display_name: "Ghost", role: "r", runtime: "claude_channel", team_official_member: true }];
    const path = join(dir, "roster-with-ghost.json");
    writeFileSync(path, JSON.stringify(extra));
    const db = withRoster(ROSTER);         // DB 에는 ghost 가 없다
    process.env.TEAM_AGENT_REGISTRY = path; // 명부에는 있다
    const got = broadcastFrom(db, "sender", "agent", "@all 공지");
    expect(got, "DB 에 없는 id 를 넣으면 FK 로 삽입 전체가 터진다").not.toContain("ghost");

    const f = join(dir, `audit-${new Date().toISOString().slice(0, 10)}.log`);
    const log = existsSync(f) ? readFileSync(f, "utf8") : "";
    expect(log, "★싱크가 깨졌는데 아무 기록이 없다★").toContain("registry_db_out_of_sync");
    expect(log).toContain("ghost");
  });

  test("★빠진 사람이 없으면 아무것도 안 남긴다★ — 평상시 잡음이 되면 아무도 안 본다", () => {
    const db = withRoster(ROSTER);
    broadcastFrom(db, "sender", "agent", "@all 공지");
    const f = join(dir, `audit-${new Date().toISOString().slice(0, 10)}.log`);
    const log = existsSync(f) ? readFileSync(f, "utf8") : "";
    expect(log, "★정상인데 싱크 경고가 남았다★").not.toContain("registry_db_out_of_sync");
  });

  test("★플래그를 아무도 안 쓰는 명부(공개 설치)에서 0명이 되지 않는다★", () => {
    const flagless = [
      { id: "sender", display_name: "S", role: "r", runtime: "claude_channel" },
      { id: "a", display_name: "A", role: "r", runtime: "claude_channel" },
      { id: "b", display_name: "B", role: "r", runtime: "claude_channel" },
    ];
    const db = withRoster(flagless);
    expect(broadcastFrom(db, "sender")).toEqual(["a", "b"]);
  });
});

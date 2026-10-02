// direct_to_gd 릴레이 — 발신자 텔레그램 수신이 죽어 있으면 게시 본문 끝에 시스템 줄 한 줄.
//   발신자 봇으로 게시되므로 수신이 죽은 팀원의 대화에 팀장이 답하면 아무도 받지 못한다.
//   정상 발신자의 게시 텍스트는 byte 단위로 그대로여야 한다(회귀).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { createInboxRoutes } from "./inbox";
import { channelRegistry } from "../channels/registry";
import type { ChannelAdapter } from "../channels/types";
import type { AgentRecord } from "../types";
import { buildDeadReceiverNote, isTelegramReceiverDown, receiverDownFromMissing } from "../lib/deadReceiverNote";
import { createRuntimeEssentialsRegistry } from "../lib/runtimeEssentials";

const DM = "7000000001";
let sent: Array<{ target: string; text: string }> = [];
let realTelegram: ChannelAdapter | undefined;

const LISA = { id: "lisa", display_name: "리사", runtime: "claude_channel", capabilities: ["coordinator"] } as unknown as AgentRecord;
const JANE = { id: "jane", display_name: "제인", runtime: "claude_channel" } as unknown as AgentRecord;
const CLO = { id: "clo", display_name: "클로", runtime: "openclaw" } as unknown as AgentRecord;

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of [LISA, JANE, CLO]) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'dev', ?, 'claude_tmux', '/tmp', 'p.md')`,
    ).run(a.id, a.display_name, a.runtime);
  }
  db.prepare(`INSERT INTO setting (key, value) VALUES ('owner_chat_id', ?)`).run(DM);
  return db;
}

const app = (db: Database, roster: AgentRecord[], down: Set<string>) =>
  createInboxRoutes({
    db,
    broadcast: () => {},
    registeredAgentIds: () => new Set(["lisa", "jane", "clo"]),  // 수신자 판정용 로스터(agents)와 분리
    agents: () => roster,
    receiverDown: (a: AgentRecord) => down.has(a.id),
  } as never);

const report = (from: string, body: string) => ({
  thread_id: "t-report",
  from_agent_id: from,
  to_agent_id: "lisa" === from ? "jane" : "lisa",
  in_reply_to: "REQ1",
  type: "dm",
  body,
  source: "agent",
  meta: { reply_mode: "direct_to_gd" },
});

async function post(db: Database, roster: AgentRecord[], down: Set<string>, body: Record<string, unknown>) {
  return app(db, roster, down).request("/inbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sent = [];
  realTelegram = channelRegistry.get("telegram");
  channelRegistry.set("telegram", {
    kind: "telegram",
    async send({ target, text }: { target: string; text: string }) {
      sent.push({ target, text });
      return { ok: true };
    },
  } as unknown as ChannelAdapter);
});
afterEach(() => {
  if (realTelegram) channelRegistry.set("telegram", realTelegram);
  else channelRegistry.delete("telegram");
});

describe("direct_to_gd 릴레이 — 발신자 수신이 죽었을 때 경고 줄", () => {
  test("수신 죽은 발신자 → 게시 본문 끝에 경고 줄(표시 이름 · 답받을 팀원), DB 본문은 그대로", async () => {
    const db = setup();
    const body = "재시작 승인 요청드립니다.";
    const res = await post(db, [LISA, JANE, CLO], new Set(["jane"]), report("jane", body));
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toBe(DM);
    expect(sent[0]!.text).toBe(`${body}\n\n${buildDeadReceiverNote(JANE, LISA)}`);
    expect(sent[0]!.text).toContain("제인의 텔레그램 수신이 끊겨");
    expect(sent[0]!.text).toContain("답은 리사 봇 대화로 주세요");
    const row = db.prepare(`SELECT body FROM message WHERE from_agent_id='jane'`).get() as { body: string };
    expect(row.body, "★저장 본문에 시스템 줄이 섞였다★").toBe(body);
  });

  test("정상 발신자 → 게시 텍스트가 본문과 byte 동일(회귀)", async () => {
    const db = setup();
    const body = "결과 보고\n- 항목 1\n- 항목 2";
    await post(db, [LISA, JANE, CLO], new Set(), report("jane", body));
    expect(sent).toHaveLength(1);
    expect(Buffer.from(sent[0]!.text).equals(Buffer.from(body))).toBe(true);
  });

  test("답받을 팀원이 없음(로스터에 발신자뿐) → 경고만, '봇 대화로' 문구 없음", async () => {
    const db = setup();
    await post(db, [JANE], new Set(["jane"]), report("jane", "보고"));
    expect(sent[0]!.text).toBe(`보고\n\n${buildDeadReceiverNote(JANE, null)}`);
    expect(sent[0]!.text).not.toContain("봇 대화로");
  });

  test("트레이드오프(op 알림 수신자 규칙 그대로): coordinator 가 죽은 발신자면 다음 팀원, 그 팀원의 생사는 보지 않는다", async () => {
    const db = setup();
    // lisa(coordinator) 와 jane 이 둘 다 죽어도 jane 을 지목한다 — 수신자 규칙에 liveness 필터를 두지 않는다.
    await post(db, [LISA, JANE, CLO], new Set(["lisa", "jane"]), report("lisa", "보고"));
    expect(sent[0]!.text).toContain("답은 제인 봇 대화로 주세요");
  });

  test("판정 함수가 던지면 경고 없이 원문 그대로 게시", async () => {
    const db = setup();
    const res = await createInboxRoutes({
      db,
      broadcast: () => {},
      registeredAgentIds: () => new Set(["lisa", "jane"]),
      agents: () => [LISA, JANE],
      receiverDown: () => { throw new Error("boom"); },
    } as never).request("/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report("jane", "보고")),
    });
    expect(res.status).toBe(201);
    expect(sent[0]!.text).toBe("보고");
  });
});

describe("수신 판정 — poller 항목만 본다", () => {
  const home = () => mkdtempSync(join(tmpdir(), "dead-recv-"));

  test("poller 접두사만 '수신 죽음' 이다", () => {
    expect(receiverDownFromMissing(["poller:claude bot.pid"])).toBe(true);
    expect(receiverDownFromMissing(["poller:codex pid not alive"])).toBe(true);
    expect(receiverDownFromMissing(["token:claude .env TELEGRAM_BOT_TOKEN", "channel:claude LaunchAgent plist"])).toBe(false);
    expect(receiverDownFromMissing([])).toBe(false);
  });

  test("claude: bot.pid 없음 → 죽음 · 살아 있는 pid → 정상 (tmp HOME)", async () => {
    const h = home();
    const dir = join(h, ".claude/channels/telegram-jane");
    mkdirSync(dir, { recursive: true });
    const reg = createRuntimeEssentialsRegistry({ home: h, pidAlive: () => true });
    expect(await isTelegramReceiverDown(JANE, reg)).toBe(true);
    writeFileSync(join(dir, "bot.pid"), "12345\n");
    expect(await isTelegramReceiverDown(JANE, reg)).toBe(false);
  });

  test("다른 런타임(openclaw·hermes_agent)은 설정이 전부 비어도 '수신 죽음' 오탐이 없다", async () => {
    const reg = createRuntimeEssentialsRegistry({ home: home() });
    expect(await isTelegramReceiverDown(CLO, reg)).toBe(false);
    const herm = { id: "herm", display_name: "헤름", runtime: "hermes_agent" } as unknown as AgentRecord;
    expect(await isTelegramReceiverDown(herm, reg)).toBe(false);
  });
});

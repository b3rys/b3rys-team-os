import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import { migrate } from "../db/migrate";
import {
  findExistingTelegramOriginMessage,
  shouldUseNativeCodexOpenclawPath,
  telegramOriginDedupeKey,
  telegramOriginMeta,
  telegramMediaRefs,
  isImageDocument,
  mediaUrlBase,
  replyAuthorAgentId,
  applyTelegramBotActivityAutoAck,
  fmtBoard,
  fmtReview,
  fmtDigest,
  fmtMenu,
  fmtStatus,
  slashCommands,
  bestPhoto,
} from "./telegramCapture";

const codex: AgentRecord = {
  id: "codex",
  display_name: "Codex",
  nicknames: ["codex", "코덱스"],
  role: "Step",
  capabilities: ["coordinator", "restricted_mention", "native_routing", "full_context"],
  runtime: "openclaw",
  status_provider: "openclaw_gateway",
  tmux_session: null,
  telegram_bot_username: "example_openclaw_bot",
  workspace_path: "",
  persona_file: "",
  moderator_eligible: true,
  avatar_emoji: "",
};

describe("telegramCapture Codex injection gating", () => {
  test("uses native OpenClaw path for explicit Codex mentions", () => {
    expect(shouldUseNativeCodexOpenclawPath("@코덱스 확인해줘", codex)).toBe(true);
    expect(shouldUseNativeCodexOpenclawPath("@example_openclaw_bot 확인해줘", codex)).toBe(true);
  });

  test("uses native OpenClaw path for replies to Codex messages", () => {
    expect(shouldUseNativeCodexOpenclawPath("위 메시지가 중복됐어. 다시 확인해봐.", codex, "codex")).toBe(true);
  });

  test("does not skip router injection for unmentioned sticky Codex follow-ups", () => {
    expect(
      shouldUseNativeCodexOpenclawPath(
        "검색어 말고 자연어로 물어보려면? 그리고 내가 테스트할만한 검색어나 문장이 있으면 좋겠는데.",
        codex,
      ),
    ).toBe(false);
  });

  test("does not assume native OpenClaw catches Korean-particle aliases", () => {
    expect(shouldUseNativeCodexOpenclawPath("오케이. @코덱스가 수행해.", codex)).toBe(false);
  });
});

describe("telegramCapture Telegram origin metadata", () => {
  test("stores original Telegram ids for downstream reactions", () => {
    expect(telegramOriginMeta("-1009999999999", "1947")).toEqual({
      telegram: {
        chat_id: "-1009999999999",
        message_id: "1947",
        source: "capture",
      },
    });
  });

  test("omits metadata when Telegram message id is missing", () => {
    expect(telegramOriginMeta("-1009999999999")).toBeUndefined();
  });

  test("builds a stable Telegram-origin dedupe key", () => {
    expect(telegramOriginDedupeKey("-1009999999999", "2299")).toBe("telegram:-1009999999999:2299");
    expect(telegramOriginDedupeKey("-1009999999999")).toBeNull();
  });

  test("finds duplicates by Telegram origin metadata from older rows", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT,
        meta_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(`INSERT INTO message (id, meta_json) VALUES (?, ?)`).run(
      "m-old",
      JSON.stringify({ telegram: { chat_id: "-1009999999999", message_id: "2299", source: "capture" } }),
    );

    expect(findExistingTelegramOriginMessage(db, "-1009999999999", "2299")).toBe("m-old");
    expect(findExistingTelegramOriginMessage(db, "-1009999999999", "2300")).toBeNull();
  });

  test("finds duplicates by Telegram origin dedupe key from new rows", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT,
        meta_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(`INSERT INTO message (id, dedupe_key, meta_json) VALUES (?, ?, ?)`).run(
      "m-new",
      "telegram:-1009999999999:2299",
      null,
    );

    expect(findExistingTelegramOriginMessage(db, "-1009999999999", "2299")).toBe("m-new");
  });
});

describe("telegramCapture media refs", () => {
  test("bestPhoto picks the largest Telegram photo variant", () => {
    const photo = bestPhoto([
      { file_id: "small", width: 90, height: 90, file_size: 1_000 },
      { file_id: "large", width: 1280, height: 720, file_size: 220_000 },
      { file_id: "medium", width: 640, height: 360, file_size: 80_000 },
    ]);
    expect(photo?.file_id).toBe("large");
  });

  test("telegramMediaRefs extracts a photo and an image document", () => {
    const refs = telegramMediaRefs({
      photo: [
        { file_id: "small", width: 90, height: 90, file_size: 1_000 },
        { file_id: "large", file_unique_id: "u-large", width: 1280, height: 720, file_size: 220_000 },
      ],
      document: {
        file_id: "doc",
        file_unique_id: "u-doc",
        file_name: "bug.png",
        mime_type: "image/png",
        file_size: 12_000,
      },
    });
    expect(refs).toEqual([
      {
        kind: "photo",
        file_id: "large",
        file_unique_id: "u-large",
        file_size: 220_000,
        width: 1280,
        height: 720,
        mime_type: "image/jpeg",
      },
      {
        kind: "document",
        file_id: "doc",
        file_unique_id: "u-doc",
        file_name: "bug.png",
        mime_type: "image/png",
        file_size: 12_000,
      },
    ]);
  });

  // 문서 첨부 캡처(GD 2026-07-03): 예전엔 이미지 문서만 캡처하고 나머지(PDF 등)는 무시했으나,
  //   일반 사용자에게 문서 첨부는 필요한 기능이라 image-only 게이트를 제거 → 모든 문서를 캡처한다.
  test("telegramMediaRefs captures non-image documents (e.g. PDF)", () => {
    expect(
      telegramMediaRefs({
        document: {
          file_id: "pdf",
          file_unique_id: "u-pdf",
          file_name: "notes.pdf",
          mime_type: "application/pdf",
          file_size: 12_000,
        },
      }),
    ).toEqual([
      {
        kind: "document",
        file_id: "pdf",
        file_unique_id: "u-pdf",
        file_name: "notes.pdf",
        mime_type: "application/pdf",
        file_size: 12_000,
      },
    ]);
  });

  test("isImageDocument accepts image extensions when Telegram omits mime type", () => {
    expect(isImageDocument({ file_id: "doc", file_name: "screenshot.PNG" })).toBe(true);
    expect(isImageDocument({ file_id: "doc", file_name: "notes.txt" })).toBe(false);
  });

  test("mediaUrlBase supports public URL override", () => {
    const prevPublic = process.env.TEAM_PUBLIC_BASE_URL;
    const prevBase = process.env.BASE_PATH;
    process.env.TEAM_PUBLIC_BASE_URL = "https://your-team.example.com/";
    process.env.BASE_PATH = "/team";
    try {
      expect(mediaUrlBase()).toBe("https://your-team.example.com/team/media");
    } finally {
      if (prevPublic === undefined) delete process.env.TEAM_PUBLIC_BASE_URL;
      else process.env.TEAM_PUBLIC_BASE_URL = prevPublic;
      if (prevBase === undefined) delete process.env.BASE_PATH;
      else process.env.BASE_PATH = prevBase;
    }
  });
});

// ─── extracted module functions (2026-06-06 ④ split, C-approach) ─────────────

const roster: AgentRecord[] = [
  { id: "bill", display_name: "Bill", role: "Infra", runtime: "claude_channel", status_provider: "claude_tmux", tmux_session: "claude-bill", telegram_bot_username: "example_dev_bot", workspace_path: "", persona_file: "", moderator_eligible: true, avatar_emoji: "" },
  { id: "codex", display_name: "Codex", role: "Step", runtime: "openclaw", status_provider: "openclaw_gateway", tmux_session: null, telegram_bot_username: "example_openclaw_bot", workspace_path: "", persona_file: "", moderator_eligible: true, avatar_emoji: "" },
];

describe("replyAuthorAgentId — reply-owner mapping", () => {
  test("matches bot username (case/@ insensitive) → agent id", () => {
    expect(replyAuthorAgentId("example_dev_bot", roster)).toBe("bill");
    expect(replyAuthorAgentId("@EXAMPLE_Dev_Bot", roster)).toBe("bill");
    expect(replyAuthorAgentId("example_openclaw_bot", roster)).toBe("codex");
  });
  test("unknown username (GD/external reply) → undefined", () => {
    expect(replyAuthorAgentId("some_human", roster)).toBeUndefined();
  });
  test("undefined input → undefined", () => {
    expect(replyAuthorAgentId(undefined, roster)).toBeUndefined();
  });
});

describe("telegramCapture out-of-band agent activity", () => {
  function activityDb(): Database {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, telegram_bot_username, workspace_path, persona_file)
       VALUES ('bill', 'Bill', 'Infra', 'claude_channel', 'claude_tmux', 'example_dev_bot', '/tmp', '/tmp/x')`,
    ).run();
    db.prepare(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('tg--100', 'tg', 'dm', '[]', 'user')`).run();
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
       VALUES ('m-open', 'tg--100', 'user', 'bill', 'dm', 'task', 'user', datetime('now', '-10 minutes'))`,
    ).run();
    db.prepare(
      `INSERT INTO message_recipient (message_id, agent_id, delivery_state, recipient_state)
       VALUES ('m-open', 'bill', 'wake_dispatched', 'open')`,
    ).run();
    return db;
  }

  test("mapped Telegram bot messages auto-ack that agent's stale open inbox without ingesting a bus message", () => {
    const db = activityDb();
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM message`).get() as { n: number }).n;
    const res = applyTelegramBotActivityAutoAck(db, {
      chatId: "-100",
      messageId: "777",
      from: { is_bot: true, username: "example_dev_bot" },
      agents: roster,
    });
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM message`).get() as { n: number }).n;
    const row = db
      .prepare(`SELECT recipient_state, close_reason, closing_message_id FROM message_recipient WHERE message_id = 'm-open'`)
      .get() as { recipient_state: string; close_reason: string | null; closing_message_id: string | null };
    expect(res).toEqual({ agentId: "bill", acked: 1 });
    expect(after).toBe(before);
    expect(row).toEqual({
      recipient_state: "acknowledged",
      close_reason: "activity_assumed",
      closing_message_id: "telegram:-100:777",
    });
  });

  test("human or unknown bot messages do not auto-ack agent inbox rows", () => {
    const db = activityDb();
    expect(
      applyTelegramBotActivityAutoAck(db, {
        chatId: "-100",
        messageId: "778",
        from: { is_bot: false, username: "example_dev_bot" },
        agents: roster,
      }),
    ).toEqual({ agentId: null, acked: 0 });
    expect(
      applyTelegramBotActivityAutoAck(db, {
        chatId: "-100",
        messageId: "779",
        from: { is_bot: true, username: "unknown_bot" },
        agents: roster,
      }),
    ).toEqual({ agentId: null, acked: 0 });
    const row = db
      .prepare(`SELECT recipient_state FROM message_recipient WHERE message_id = 'm-open'`)
      .get() as { recipient_state: string };
    expect(row.recipient_state).toBe("open");
  });
});

function dbWithTasks(): Database {
  const db = new Database(":memory:");
  migrate(db);
  const ins = db.prepare(`INSERT INTO task (id, title, lane, owner, sort_order) VALUES (?, ?, ?, ?, ?)`);
  ins.run("t1", "플랜 작업A", "plan", null, 0);
  ins.run("t2", "실행 작업B", "doing", "bill", 1);
  ins.run("t3", "완료 작업C", "done", "steve", 2);
  return db;
}

describe("slash command formatters (fmt*)", () => {
  test("fmtBoard lists active lanes with counts + owner and excludes done", () => {
    const out = fmtBoard(dbWithTasks());
    expect(out).toContain("📋 칸반 작업 보드");
    expect(out).toContain("📝 계획 (1)");
    expect(out).toContain("🔧 실행 중 (1)");
    expect(out).toContain("실행 작업B — @bill");
    expect(out).not.toContain("✅ 완료");
    expect(out).not.toContain("완료 작업C");
  });
  test("fmtReview lists doing; empty message when none", () => {
    expect(fmtReview(dbWithTasks())).toContain("실행 작업B — @bill");
    const empty = new Database(":memory:"); migrate(empty);
    expect(fmtReview(empty)).toContain("실행 중 과제 없음");
  });
  test("fmtDigest shows plan/doing/done counts", () => {
    expect(fmtDigest(dbWithTasks())).toContain("계획 1 · 실행중 1 · 완료 1");
  });
  test("public slash menu hides internal approve and digest actions", () => {
    expect(slashCommands(true)).not.toContain("/approve");
    expect(slashCommands(true)).not.toContain("/digest");
    expect(slashCommands(false)).toEqual(expect.arrayContaining(["/approve", "/digest"]));
    const out = fmtMenu(dbWithTasks(), { publicBuild: true });
    expect(out).not.toContain("/approve");
    expect(out).not.toContain("/digest");
    expect(out).not.toContain("digest");
    expect(out).not.toContain("승인 메뉴");
    expect(out).not.toContain("승인 가능 액션");
  });
  test("fmtStatus shows agent count + task counts", () => {
    const out = fmtStatus(dbWithTasks(), roster);
    expect(out).toContain("등록 에이전트: 2명");
    expect(out).toContain("실행중 1 / 완료 1");
  });
});

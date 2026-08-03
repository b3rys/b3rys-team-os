import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  DEFAULT_BOT_LIVENESS_LOG,
  DEFAULT_BOT_LIVENESS_STATE_DIR,
  botLivenessOwnerChatId,
  botLivenessLogPath,
  botLivenessMonitorPaths,
  renderBotLivenessMonitorPlist,
} from "./livenessMonitor";
import { botLivenessLaunchdLabel } from "./agentControl";
import { readLivenessStatus } from "./monitoringStatus";

const savedLog = process.env.BOT_LIVENESS_LOG;
const savedState = process.env.LIVENESS_STATE_DIR;
const savedPrefix = process.env.TEAMOS_LAUNCHD_PREFIX;
const savedUser = process.env.USER;
const savedTeamDb = process.env.TEAM_DB_PATH;
const savedGdChatId = process.env.GD_CHAT_ID;

afterEach(() => {
  if (savedLog === undefined) delete process.env.BOT_LIVENESS_LOG;
  else process.env.BOT_LIVENESS_LOG = savedLog;
  if (savedState === undefined) delete process.env.LIVENESS_STATE_DIR;
  else process.env.LIVENESS_STATE_DIR = savedState;
  if (savedPrefix === undefined) delete process.env.TEAMOS_LAUNCHD_PREFIX;
  else process.env.TEAMOS_LAUNCHD_PREFIX = savedPrefix;
  if (savedUser === undefined) delete process.env.USER;
  else process.env.USER = savedUser;
  if (savedTeamDb === undefined) delete process.env.TEAM_DB_PATH;
  else process.env.TEAM_DB_PATH = savedTeamDb;
  if (savedGdChatId === undefined) delete process.env.GD_CHAT_ID;
  else process.env.GD_CHAT_ID = savedGdChatId;
});

describe("bot liveness monitor shared defaults", () => {
  test("default log is repo-local durable var path, not /tmp", () => {
    delete process.env.BOT_LIVENESS_LOG;
    expect(botLivenessLogPath()).toBe(DEFAULT_BOT_LIVENESS_LOG);
    expect(botLivenessLogPath()).toContain("/var/bot-liveness-monitor.log");
    expect(botLivenessLogPath()).not.toStartWith("/tmp/");
  });

  test("env override is still honored for isolated tests or deployments", () => {
    process.env.BOT_LIVENESS_LOG = "/custom/bot-liveness-monitor.log";
    expect(botLivenessLogPath()).toBe("/custom/bot-liveness-monitor.log");
  });

  test("launchd label uses the same generic prefix rule as b3os services", () => {
    process.env.TEAMOS_LAUNCHD_PREFIX = "com.example";
    expect(botLivenessLaunchdLabel()).toBe("com.example.bot-liveness-monitor");
  });

  test("plist template passes the same durable log and state defaults to the script", () => {
    process.env.TEAMOS_LAUNCHD_PREFIX = "com.example";
    delete process.env.BOT_LIVENESS_LOG;
    delete process.env.LIVENESS_STATE_DIR;
    const xml = renderBotLivenessMonitorPlist();
    expect(xml).toContain("<key>StartInterval</key><integer>600</integer>");
    expect(xml).toContain("<key>BOT_LIVENESS_LOG</key>");
    expect(xml).toContain(DEFAULT_BOT_LIVENESS_LOG);
    expect(xml).toContain("<key>LIVENESS_STATE_DIR</key>");
    expect(xml).toContain(DEFAULT_BOT_LIVENESS_STATE_DIR);
    expect(xml).toContain("scripts/bot-liveness-monitor.sh");
    expect(xml).not.toContain("com.gdmini.bot-liveness-monitor");
    expect(xml).not.toContain("/tmp/bot-liveness-monitor.log");
  });

  test("plist template injects GD_CHAT_ID from team settings instead of hardcoding it", () => {
    const dir = mkdtempSync(join(tmpdir(), "b3os-liveness-db-"));
    try {
      const dbPath = join(dir, "team.db");
      process.env.TEAM_DB_PATH = dbPath;
      process.env.GD_CHAT_ID = "9999999999";
      const db = new Database(dbPath);
      db.exec("CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT)");
      db.query("INSERT INTO setting (key, value) VALUES ('owner_chat_id', '1000000001')").run();
      db.close();

      expect(botLivenessOwnerChatId()).toBe("1000000001");
      const xml = renderBotLivenessMonitorPlist();
      expect(xml).toContain("<key>GD_CHAT_ID</key><string>1000000001</string>");
      expect(xml).not.toContain("9999999999");
      expect(xml).not.toContain("7066867819");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plist template falls back to GD_CHAT_ID env when owner_chat_id setting is absent", () => {
    process.env.TEAM_DB_PATH = join(tmpdir(), "missing-b3os-team.db");
    process.env.GD_CHAT_ID = "1234567890";

    expect(botLivenessOwnerChatId()).toBe("1234567890");
    expect(renderBotLivenessMonitorPlist()).toContain("<key>GD_CHAT_ID</key><string>1234567890</string>");
  });

  test("server parser can read an actual log written at the durable default path", () => {
    delete process.env.BOT_LIVENESS_LOG;
    mkdirSync(dirname(DEFAULT_BOT_LIVENESS_LOG), { recursive: true });
    writeFileSync(
      DEFAULT_BOT_LIVENESS_LOG,
      "2026-08-03 15:00:00 bot-liveness START (dry_run=0)\n이상 없음\n",
      "utf-8",
    );

    const status = readLivenessStatus(DEFAULT_BOT_LIVENESS_LOG);
    expect(status.available).toBe(true);
    expect(status.runs).toBeGreaterThanOrEqual(1);
    expect(status.lastRun).toBe("2026-08-03 15:00:00");
    expect(status.healthy).toBe(true);
  });

  test("server parser treats machine-readable DONE status=issues as unhealthy", () => {
    const log = `${DEFAULT_BOT_LIVENESS_STATE_DIR}/issues-status.log`;
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(
      log,
      [
        "2026-08-03 15:20:00 bot-liveness START (dry_run=0)",
        "이상 발견 — 알림 전송 성공",
        "2026-08-03 15:20:03 bot-liveness DONE status=issues",
        "",
      ].join("\n"),
      "utf-8",
    );

    const status = readLivenessStatus(log);
    expect(status.available).toBe(true);
    expect(status.lastRun).toBe("2026-08-03 15:20:00");
    expect(status.lastResult).toBe("2026-08-03 15:20:03 bot-liveness DONE status=issues");
    expect(status.healthy).toBe(false);
  });

  test("server parser falls back past an unclassified DONE line for legacy logs", () => {
    const log = `${DEFAULT_BOT_LIVENESS_STATE_DIR}/legacy-done.log`;
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(
      log,
      [
        "2026-08-03 15:30:00 bot-liveness START (dry_run=0)",
        "--- 메시지 미리보기 ---",
        "⚠️ [steve] tmux 세션 없음 — 수동 확인 필요",
        "--- 끝 --- (sig=abc123, last=)",
        "Telegram API: HTTP 200",
        "DM 전송 완료",
        "2026-08-03 15:30:03 bot-liveness DONE",
        "",
      ].join("\n"),
      "utf-8",
    );

    const status = readLivenessStatus(log);
    expect(status.available).toBe(true);
    expect(status.lastResult).toBe("2026-08-03 15:30:03 bot-liveness DONE");
    expect(status.healthy).toBe(false);
  });

  test("server parser default follows BOT_LIVENESS_LOG at call time", () => {
    const override = `${DEFAULT_BOT_LIVENESS_STATE_DIR}/override.log`;
    mkdirSync(dirname(override), { recursive: true });
    writeFileSync(override, "2026-08-03 15:10:00 bot-liveness START (dry_run=0)\nOK\n", "utf-8");
    process.env.BOT_LIVENESS_LOG = override;

    const status = readLivenessStatus();
    expect(status.available).toBe(true);
    expect(status.lastRun).toBe("2026-08-03 15:10:00");
    expect(status.healthy).toBe(true);
  });

  test("path helper returns plist/script/log from one source", () => {
    process.env.TEAMOS_LAUNCHD_PREFIX = "com.example";
    const p = botLivenessMonitorPaths("/Users/alice");
    expect(p.plist).toBe("/Users/alice/Library/LaunchAgents/com.example.bot-liveness-monitor.plist");
    expect(p.script).toContain("scripts/bot-liveness-monitor.sh");
    expect(p.log).toBe(botLivenessLogPath());
  });
});

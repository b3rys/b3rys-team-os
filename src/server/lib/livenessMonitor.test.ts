import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_BOT_LIVENESS_LOG,
  DEFAULT_BOT_LIVENESS_STATE_DIR,
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

afterEach(() => {
  if (savedLog === undefined) delete process.env.BOT_LIVENESS_LOG;
  else process.env.BOT_LIVENESS_LOG = savedLog;
  if (savedState === undefined) delete process.env.LIVENESS_STATE_DIR;
  else process.env.LIVENESS_STATE_DIR = savedState;
  if (savedPrefix === undefined) delete process.env.TEAMOS_LAUNCHD_PREFIX;
  else process.env.TEAMOS_LAUNCHD_PREFIX = savedPrefix;
  if (savedUser === undefined) delete process.env.USER;
  else process.env.USER = savedUser;
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

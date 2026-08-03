import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { botLivenessLaunchdLabel, teamosLaunchdPrefix } from "./agentControl";
import { REPO_ROOT } from "./personaTemplates";

export const DEFAULT_BOT_LIVENESS_LOG = join(REPO_ROOT, "var", "bot-liveness-monitor.log");
export const DEFAULT_BOT_LIVENESS_STATE_DIR = join(REPO_ROOT, "var", "bot-liveness-monitor");

export function botLivenessLogPath(): string {
  return process.env.BOT_LIVENESS_LOG?.trim() || DEFAULT_BOT_LIVENESS_LOG;
}

function ownerChatIdFromSettings(): string {
  const dbPath = process.env.TEAM_DB_PATH?.trim() || join(REPO_ROOT, "team.db");
  if (!existsSync(dbPath)) return "";
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT value FROM setting WHERE key = 'owner_chat_id'").get() as { value?: string } | undefined;
    return (row?.value ?? "").trim();
  } catch {
    return "";
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export function botLivenessOwnerChatId(): string {
  return ownerChatIdFromSettings() || process.env.GD_CHAT_ID?.trim() || "";
}

export interface BotLivenessMonitorPaths {
  label: string;
  plist: string;
  script: string;
  log: string;
  stateDir: string;
}

export function botLivenessMonitorPaths(home: string = process.env.HOME ?? ""): BotLivenessMonitorPaths {
  const label = botLivenessLaunchdLabel();
  return {
    label,
    plist: join(home, "Library", "LaunchAgents", `${label}.plist`),
    script: join(REPO_ROOT, "scripts", "bot-liveness-monitor.sh"),
    log: botLivenessLogPath(),
    stateDir: process.env.LIVENESS_STATE_DIR?.trim() || DEFAULT_BOT_LIVENESS_STATE_DIR,
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderBotLivenessMonitorPlist(): string {
  const p = botLivenessMonitorPaths();
  const ownerChatId = botLivenessOwnerChatId();
  const env: Record<string, string> = {
    PATH: `${process.env.HOME ?? ""}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: process.env.HOME ?? "",
    TEAMOS_LAUNCHD_PREFIX: teamosLaunchdPrefix(),
    BOT_LIVENESS_LOG: p.log,
    LIVENESS_STATE_DIR: p.stateDir,
  };
  if (ownerChatId) env.GD_CHAT_ID = ownerChatId;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${xmlEscape(p.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>/bin/bash</string>`,
    `    <string>${xmlEscape(p.script)}</string>`,
    `  </array>`,
    `  <key>WorkingDirectory</key><string>${xmlEscape(REPO_ROOT)}</string>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>StartInterval</key><integer>600</integer>`,
    `  <key>StandardOutPath</key><string>${xmlEscape(join(REPO_ROOT, "logs", "bot-liveness-monitor.launchd.out.log"))}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(join(REPO_ROOT, "logs", "bot-liveness-monitor.launchd.err.log"))}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(env).map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`),
    `  </dict>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

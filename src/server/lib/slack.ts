// Slack adapter: read per-agent tokens from slack-tokens/<agent>.env, expose
// sign-verification helper + post helper. Designed to fail soft (warn) when
// signing secret missing — dev mode.
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { REPO_ROOT } from "./paths";

export interface SlackCreds {
  bot_token: string;
  signing_secret: string | null;
  app_id: string | null;
  app_token: string | null;
}

const DEFAULT_TOKENS_DIR = join(REPO_ROOT, "slack-tokens");

export function slackTokensDir(): string {
  return process.env.SLACK_TOKENS_DIR ?? DEFAULT_TOKENS_DIR;
}

export function slackTokenFile(agentId: string): string {
  return join(slackTokensDir(), `${agentId}.env`);
}

export function loadAgentCreds(agentId: string): SlackCreds | null {
  const file = slackTokenFile(agentId);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf-8");
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && m[1] && m[2]) map[m[1]] = m[2].trim();
  }
  const token = map["SLACK_BOT_TOKEN"];
  if (!token) return null;
  return {
    bot_token: token,
    signing_secret: map["SLACK_SIGNING_SECRET"] ?? null,
    app_id: map["SLACK_APP_ID"] ?? null,
    app_token: map["SLACK_APP_TOKEN"] ?? null,
  };
}

export function hasSlackTokenFile(agentId: string): boolean {
  return existsSync(slackTokenFile(agentId));
}

export function saveAgentCreds(
  agentId: string,
  input: { bot_token?: string; signing_secret?: string; app_id?: string; app_token?: string },
): { path: string; updated: string[] } {
  const existing = loadAgentCreds(agentId);
  const next = {
    bot_token: input.bot_token || existing?.bot_token || "",
    signing_secret: input.signing_secret ?? existing?.signing_secret ?? "",
    app_id: input.app_id ?? existing?.app_id ?? "",
    app_token: input.app_token ?? existing?.app_token ?? "",
  };
  if (!next.bot_token) throw new Error("SLACK_BOT_TOKEN required");
  mkdirSync(slackTokensDir(), { recursive: true });
  const lines = [
    `SLACK_BOT_TOKEN=${next.bot_token}`,
    ...(next.signing_secret ? [`SLACK_SIGNING_SECRET=${next.signing_secret}`] : []),
    ...(next.app_id ? [`SLACK_APP_ID=${next.app_id}`] : []),
    ...(next.app_token ? [`SLACK_APP_TOKEN=${next.app_token}`] : []),
  ];
  const file = slackTokenFile(agentId);
  writeFileSync(file, lines.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
  const updated = Object.entries(input)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key]) => key);
  return { path: file, updated };
}

// 토큰 파일 삭제(연동 해제). 파일이 없으면 removed=false. (agents.json의 신원 정리는 호출부에서.)
export function removeAgentCreds(agentId: string): { removed: boolean; path: string } {
  const file = slackTokenFile(agentId);
  if (!existsSync(file)) return { removed: false, path: file };
  unlinkSync(file);
  return { removed: true, path: file };
}

// Slack signing: HMAC-SHA256 of `v0:{timestamp}:{body}` with the signing secret,
// compared against the X-Slack-Signature header. Rejects requests older than 5min.
export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string;
  body: string;
  signature: string;
}): boolean {
  const tsNum = parseInt(opts.timestamp, 10);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false;
  const base = `v0:${opts.timestamp}:${opts.body}`;
  const expected = `v0=${createHmac("sha256", opts.signingSecret).update(base).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signature);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// chat.postMessage. Returns posted message ts (for thread tracking) or null.
export async function postMessage(opts: {
  bot_token: string;
  channel: string;
  text: string;
  thread_ts?: string;
}): Promise<{ ok: boolean; ts?: string; error?: string }> {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${opts.bot_token}`,
      },
      body: JSON.stringify({
        channel: opts.channel,
        text: opts.text,
        ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
      }),
    });
    const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    return data;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Strip <@USERID> mentions from message text to get the plain prompt.
export function cleanSlackText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse first mentioned bot user id from text. Returns null if none.
export function firstMentionedUser(text: string): string | null {
  const m = text.match(/<@([A-Z0-9]+)>/);
  return m && m[1] ? m[1] : null;
}

// Parse all mentioned bot user ids from text, in order, de-duplicated.
export function allMentionedUsers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /<@([A-Z0-9]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

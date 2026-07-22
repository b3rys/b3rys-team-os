import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { insertDmMessage, type DmMessageInput } from "./dmCapture";

// ★팀장 1:1 chat_id 는 설정값(setting: owner_chat_id)이다 — 상수로 박지 않는다(OWNER 2026-07-14).★
// 박아 두면 그 값이 곧 '팀장'이 되어, 다른 팀에서는 필터가 전부 어긋나 DM 캡처가 조용히 0건이 된다
// (누출이 아니라 무동작으로 실패한다 — 더 나쁘다). 호출자가 실제 설정값을 넘기고, 없으면 캡처를 건너뛴다.
export function openclawGdSessionKey(chatId: string, agentId: string): string { return `agent:${agentId}:telegram:direct:${chatId}`; }
export function hermesGdSessionKey(chatId: string): string { return `agent:main:telegram:dm:${chatId}`; }

export type RuntimeDmMessage = Omit<DmMessageInput, "memberId">;

// ★chatId/agentId 는 필수다.★ optional 로 두면 호출자가 빼먹었을 때 컴파일은 통과하고 ★조용히 0건★ 을 돌려준다
// (적대 리뷰 2026-07-14). 필수로 두면 같은 실수가 ★타입 에러★ 로 잡힌다 — 무동작 실패보다 낫다.
export interface OpenClawParseOptions {
  sessionsDir: string;
  chatId: string;
  agentId: string;
  sessionKey?: string;
}

export interface HermesParseOptions {
  stateDb: Database;
  chatId: string;
  sessionKey?: string;
}

export interface SyncRuntimeDmOptions {
  memberId: string;
}

export function defaultOpenClawGdSessionsDir(): string {
  return join(homedir(), ".openclaw", "agents", "owner", "sessions");
}

interface OpenClawTrajectoryRow {
  type?: string;
  ts?: string;
  sessionKey?: string;
  sessionId?: string;
  data?: {
    prompt?: unknown;
    turnId?: string;
    name?: string;
    arguments?: {
      action?: unknown;
      message?: unknown;
    };
    result?: unknown;
  };
}

interface OpenClawSessionRow {
  type?: string;
  timestamp?: string;
  id?: string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: string;
    sourceChannel?: string;
    senderId?: string;
    idempotencyKey?: string;
    __openclaw?: Record<string, unknown>;
  };
}

function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseJsonLine<T>(line))
    .filter((row): row is T => row !== null);
}

function asDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractTelegramMessageId(text: string, chatId: string): string | null {
  const currentBlock = text.match(/Current user request:\s*([\s\S]*)/);
  const scope = currentBlock?.[1] ?? text;
  const jsonMsg = scope.match(/"message_id"\s*:\s*"?([0-9A-Za-z_-]+)"?/);
  if (jsonMsg) return jsonMsg[1]!;
  const tagged = scope.match(/\[message_id:\s*([0-9A-Za-z_-]+)\]/i);
  if (tagged) return tagged[1]!;
  const dedupe = scope.match(new RegExp(`telegram:${chatId}:([0-9A-Za-z_-]+)`));
  return dedupe?.[1] ?? null;
}

function stripOpenClawPromptEnvelope(prompt: string): string {
  const current = prompt.match(/Current user request:\s*([\s\S]*?)(?:\nimagesCount:|\ntools:|$)/);
  const scoped = (current?.[1] ?? prompt).trim();
  const afterContext = scoped.match(/Conversation context[\s\S]*?\n(?!#)([^\n][\s\S]*)$/);
  if (afterContext?.[1]) return afterContext[1].trim();
  return scoped
    .replace(/Conversation info[\s\S]*?```\s*/g, "")
    .replace(/Sender[\s\S]*?```\s*/g, "")
    .trim();
}

function dedupeKey(chatId: string, messageId: string): string {
  return `telegram:${chatId}:${messageId}`;
}

function fallbackDedupe(chatId: string, runtime: string, ref: string): string {
  return `telegram:${chatId}:${runtime}:${ref}`;
}

function openClawFiles(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((name) => name !== "sessions.json" && /\.jsonl(?:\.|$)/.test(name))
    .map((name) => join(sessionsDir, name))
    .sort();
}

export function parseOpenClawGdDirectMessages(opts: OpenClawParseOptions): RuntimeDmMessage[] {
  const chatId = opts.chatId;
  if (!chatId) return []; // owner_chat_id 미설정 → 캡처 없음(무동작이 오동작보다 낫다)
  const sessionKey = opts.sessionKey ?? openclawGdSessionKey(chatId, opts.agentId);
  const out: RuntimeDmMessage[] = [];

  for (const file of openClawFiles(opts.sessionsDir)) {
    if (file.endsWith(".trajectory.jsonl")) {
      for (const row of readJsonl<OpenClawTrajectoryRow>(file)) {
        if (row.sessionKey !== sessionKey) continue;
        const createdAt = asDate(row.ts);
        if (!createdAt) continue;
        const sourceRef = `openclaw:${basename(file)}:${row.type ?? "event"}:${row.data?.turnId ?? row.sessionId ?? ""}`;

        if (row.type === "prompt.submitted" && typeof row.data?.prompt === "string") {
          const msgId = extractTelegramMessageId(row.data.prompt, chatId);
          const body = stripOpenClawPromptEnvelope(row.data.prompt);
          if (!body) continue;
          out.push({
            runtime: "openclaw",
            direction: "in",
            body,
            createdAt,
            dedupeKey: msgId ? dedupeKey(chatId, msgId) : fallbackDedupe(chatId, "openclaw-in", row.data.turnId ?? `${basename(file)}:${row.ts}`),
            sourceRef,
          });
          continue;
        }

        if (
          row.type === "tool.call" &&
          row.data?.name === "message" &&
          row.data.arguments?.action === "send" &&
          typeof row.data.arguments.message === "string" &&
          row.data.arguments.message.trim()
        ) {
          out.push({
            runtime: "openclaw",
            direction: "out",
            body: row.data.arguments.message.trim(),
            createdAt,
            dedupeKey: fallbackDedupe(chatId, "openclaw-out", row.data.turnId ?? `${basename(file)}:${row.ts}`),
            sourceRef,
          });
        }
      }
      continue;
    }

    for (const row of readJsonl<OpenClawSessionRow>(file)) {
      if (row.type !== "message" || !row.message) continue;
      if (row.message.sourceChannel && row.message.sourceChannel !== "telegram") continue;
      const content = firstNonEmptyString(row.message.content);
      const createdAt = asDate(row.message.timestamp ?? row.timestamp);
      if (!content || !createdAt) continue;
      const msgId = extractTelegramMessageId(content, chatId);
      if (!msgId && row.message.senderId !== chatId) continue;
      const role = row.message.role;
      if (role !== "user" && role !== "assistant") continue;
      out.push({
        runtime: "openclaw",
        direction: role === "user" ? "in" : "out",
        body: content.trim(),
        createdAt,
        dedupeKey: msgId ? dedupeKey(chatId, msgId) : fallbackDedupe(chatId, "openclaw-jsonl", row.message.idempotencyKey ?? row.id ?? `${basename(file)}:${row.timestamp}`),
        sourceRef: `openclaw:${basename(file)}:${row.id ?? row.message.idempotencyKey ?? ""}`,
      });
    }
  }

  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.dedupeKey.localeCompare(b.dedupeKey));
}

export function parseOpenClawGdDms(memberId: string, sessionsDir: string, ownerChatId: string, agentId = memberId): DmMessageInput[] {
  return parseOpenClawGdDirectMessages({ sessionsDir, chatId: ownerChatId, agentId }).map((msg) => ({ ...msg, memberId }));
}

export function parseHermesGdDirectMessages(opts: HermesParseOptions): RuntimeDmMessage[] {
  const chatId = opts.chatId;
  if (!chatId) return []; // owner_chat_id 미설정 → 캡처 없음
  const sessionKey = opts.sessionKey ?? hermesGdSessionKey(chatId);
  const rows = opts.stateDb
    .prepare(
      `SELECT
         m.id AS message_id,
         m.role AS role,
         m.content AS content,
         m.timestamp AS timestamp,
         m.platform_message_id AS platform_message_id,
         s.id AS session_id
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE s.session_key = ?
         AND s.chat_type = 'dm'
         AND s.chat_id = ?
         AND m.role IN ('user', 'assistant')
         AND COALESCE(m.content, '') != ''
       ORDER BY m.timestamp ASC, m.id ASC`,
    )
    .all(sessionKey, chatId) as Array<{
    message_id: number;
    role: "user" | "assistant";
    content: string;
    timestamp: number | string;
    platform_message_id: string | null;
    session_id: string;
  }>;

  return rows.flatMap((row) => {
    const createdAt = asDate(row.timestamp);
    if (!createdAt) return [];
    const platformMessageId = firstNonEmptyString(row.platform_message_id);
    return [{
      runtime: "hermes",
      direction: row.role === "user" ? "in" : "out",
      body: row.content.trim(),
      createdAt,
      dedupeKey: platformMessageId ? dedupeKey(chatId, platformMessageId) : fallbackDedupe(chatId, "hermes", `${row.session_id}:${row.message_id}`),
      sourceRef: `hermes:${row.session_id}:${row.message_id}`,
    } satisfies RuntimeDmMessage];
  });
}

export function parseHermesGdDms(memberId: string, stateDb: Database, ownerChatId: string): DmMessageInput[] {
  return parseHermesGdDirectMessages({ stateDb, chatId: ownerChatId }).map((msg) => ({ ...msg, memberId }));
}

export function syncOpenClawGdDirectMessages(db: Database, parseOpts: OpenClawParseOptions, syncOpts: SyncRuntimeDmOptions): number {
  let inserted = 0;
  for (const msg of parseOpenClawGdDirectMessages(parseOpts)) {
    if (insertDmMessage(db, { ...msg, memberId: syncOpts.memberId })) inserted += 1;
  }
  return inserted;
}

export function syncHermesGdDirectMessages(db: Database, parseOpts: HermesParseOptions, syncOpts: SyncRuntimeDmOptions): number {
  let inserted = 0;
  for (const msg of parseHermesGdDirectMessages(parseOpts)) {
    if (insertDmMessage(db, { ...msg, memberId: syncOpts.memberId })) inserted += 1;
  }
  return inserted;
}

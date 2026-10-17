import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import type { AgentRecord } from "../types";
import { pick, type Locale } from "./i18n";
import { teamContextLabel } from "../channels/registry";
import { appendAuditFile } from "./auditFile";
import { hasCapability } from "./capabilities";
import { clearRuntimeBlock, recordRuntimeBlock } from "./runtimeBlocks";
import { LOCAL_BIN, openclawEnvPath } from "./paths";

const { X_OK } = constants;

interface RunOpenclawTurnOptions {
  agent: AgentRecord;
  slackUserId?: string;
  channel: string;
  threadId: string;
  messageId: string;
  body: string;
  /** 로케일(ko 기본 · en 토글). */
  locale?: Locale;
}

type BusAttachment = {
  kind: "path" | "url";
  value: string;
  note?: string;
};

interface InjectOpenclawTelegramOptions {
  agent: AgentRecord;
  groupId: string;
  threadId: string;
  messageId: string;
  // 배달 기록은 호출부가 남기므로 본문을 전달한다. 기록 실패가 발송을 막지는 않는다.
  onDelivered?: (info: { ok: boolean; text: string; groupId: string; deliveryMessageId?: string | number | null }) => void;
  body: string;
  attachments?: BusAttachment[];
  fromLabel?: string;
  /** 로케일(ko 기본 · en 토글). owner_name 치환과 직교. */
  locale?: Locale;
  teamContext?: string;
  /** 원본 Telegram message_id. 있으면 owner ack/reply target 으로 사용한다. */
  origTgMessageId?: string;
  /** v1.2 issue 3: anti-pingpong — in_reply_to message id for hop chain tracking */
  inReplyTo?: string;
  /** v1.2 issue 3: anti-pingpong — current hop count (agent should increment on reply) */
  hopCount?: number;
  directReport?: boolean;
  // 그룹과 팀장 직접 보고는 답 목적지가 다르므로 호출부가 replyRouteKind로 구분한다.
  kind?: "group" | "direct_to_gd";
}

interface GatewayPreview {
  previews?: Array<{
    items?: Array<{
      role?: string;
      text?: string;
    }>;
  }>;
}

interface GatewaySessionDescribe {
  session?: {
    status?: string;
    abortedLastRun?: boolean;
    startedAt?: number; // epoch ms
    endedAt?: number; // epoch ms — 이 세션에서 마지막으로 끝난 턴 의 종료 시각
  };
}

// 본문 없는 terminal-failed는 확정 실패다. 아직 실행 중일 수 있는 단순 timeout과 구분한다.
export class OpenclawTurnFailedError extends Error {
  constructor(public readonly status: string) {
    super(`openclaw turn failed: ${status}`);
    this.name = "OpenclawTurnFailedError";
  }
}

// session.describe 의 status 가 이 집합이면 "확정된 죽은 턴"으로 본다.
const OPENCLAW_TERMINAL_FAILED_STATUS = new Set([
  "failed",
  "error",
  "aborted",
  "timedout",
  "timed_out",
]);

/** session 을 조회한다(status·endedAt). 게이트웨이 오류 시 undefined(=판단 보류, 헛경보 금지). */
async function describeOpenclawSession(
  key: string,
): Promise<{ status?: string; endedAt?: number } | undefined> {
  try {
    const d = (await runOpenclawJsonForBridge([
      "sessions.describe",
      "--params",
      JSON.stringify({ key }),
    ])) as GatewaySessionDescribe;
    return d.session ? { status: d.session.status, endedAt: d.session.endedAt } : undefined;
  } catch {
    return undefined;
  }
}

/** session status 만. 게이트웨이 오류 시 undefined(=판단 보류, 헛경보 금지). */
async function describeOpenclawSessionStatus(key: string): Promise<string | undefined> {
  return (await describeOpenclawSession(key))?.status;
}

/** openclaw 바이너리 후보 — 실경로 우선순위. npm global(~/.local/bin)이 기본 설치 위치다. */
export const OPENCLAW_BIN_CANDIDATES = [
  `${LOCAL_BIN}/openclaw`, // npm global prefix — openclaw 기본 설치 위치
  "/opt/homebrew/bin/openclaw", // homebrew (apple silicon)
  "/usr/local/bin/openclaw", // homebrew (intel) · 수동 설치
];

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, X_OK);
    return true;
  } catch {
    return false;
  }
}

// launchd의 PATH에는 npm 전역 설치 경로가 없을 수 있어 명시 환경변수→실경로 후보→PATH 순서로 호출마다 해석한다.
// 점검도 실행부와 같은 후보 우선순위를 써야 OPENCLAW_BIN으로 지정한 비표준 설치를 미설치로 오인하지 않는다.
export function openclawCliCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const explicit = env.OPENCLAW_BIN?.trim();
  return explicit ? [explicit, ...OPENCLAW_BIN_CANDIDATES] : [...OPENCLAW_BIN_CANDIDATES];
}

export function resolveOpenclawBin(
  env: Record<string, string | undefined> = process.env,
  candidates: readonly string[] = OPENCLAW_BIN_CANDIDATES,
  executable: (path: string) => boolean = isExecutableFile,
): string {
  const explicit = env.OPENCLAW_BIN?.trim();
  if (explicit) return explicit; // 비표준 prefix(리눅스·nix) 주입구. 존재검사 없이 그대로 존중.
  for (const candidate of candidates) {
    if (executable(candidate)) return candidate;
  }
  return "openclaw"; // 최후 폴백 — PATH 에 맡긴다(기존 동작).
}
// 코드 수정·검증을 포함하는 긴 턴을 위해 기본 대기는 10분이다. 확정 실패는 session.describe로 조기 감지한다.
const OPENCLAW_GATEWAY_TIMEOUT_MS = Number(process.env.OPENCLAW_GATEWAY_TIMEOUT_MS ?? 600_000);
// Plain timeouts are ambiguous: the OpenClaw turn may still be running and can post a real reply
// later. Keep terminal-failure notices visible, but make delay notices opt-in so transient slow
// turns do not spam the Telegram room.
function isOpenclawTimeoutNoticeEnabled(): boolean {
  return process.env.OPENCLAW_TIMEOUT_NOTICE === "1";
}
// CLI가 타임아웃 결과 JSON을 기록할 유예다. 길이는 측정으로 보장된 값이 아니므로 조정 전 백스톱 audit로 확인해야 한다.
const CLI_TIMEOUT_BACKSTOP_MARGIN_MS = 10_000;
const OPENCLAW_PREVIEW_LIMIT = Number(process.env.OPENCLAW_PREVIEW_LIMIT ?? 80);
const DEFAULT_OPENCLAW_ENV = process.env.OPENCLAW_ENV ?? openclawEnvPath();

function resolveOpenclawAgentId(agent: AgentRecord): string {
  // 게이트웨이 프로필은 openclaw_agent_id를 사용한다. 미설정 시 멤버 ID를 그대로 쓴다.
  if (agent.openclaw_agent_id) return agent.openclaw_agent_id;
  return agent.id;
}

function sessionKeyFor(agent: AgentRecord, channel: string, threadId: string): string {
  const openclawAgentId = resolveOpenclawAgentId(agent);
  // Scope session per Slack thread so unrelated conversations don't bleed context.
  // Was: channel-only — caused stale prior-thread messages to taint replies.
  return `agent:${openclawAgentId}:slack:team-collab:${agent.id}:${channel}:${threadId}`;
}

function telegramRouterSessionKeyFor(agent: AgentRecord, groupId: string, threadId: string): string {
  const openclawAgentId = resolveOpenclawAgentId(agent);
  const safeGroup = groupId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeThread = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `agent:${openclawAgentId}:telegram:team-collab-router:${agent.id}:${safeGroup}:${safeThread}`;
}

async function runOpenclawJson(args: string[], timeoutMs = 30_000): Promise<unknown> {
  const { OPENCLAW_GATEWAY_URL: _gatewayUrl, ...env } = process.env;
  // gateway call의 전송 기본 타임아웃은 내부 agent.wait 대기와 별개다. 전송이 먼저 끊기지 않도록 spawn 제한과 맞춘다.
  const bin = resolveOpenclawBin();
  const spawnArgs = [bin, "gateway", "call", ...args, "--timeout", String(timeoutMs), "--json"];
  const proc = (() => {
    try {
      // 자식의 PATH 도 보강한다 — 절대경로 해석은 openclaw 자신만 구한다. openclaw 는
      //   `#!/usr/bin/env node` 셔뱅이라 node 를 상속 PATH 에서 찾는다. launchd PATH 에
      //   node 가 없으면 바이너리를 제대로 찾아놓고도 셔뱅 단계에서 죽고, 아래 catch 가 그걸
      //   "실행파일을 찾지 못했습니다" 로 오진 한다. activation.ts 의 openclaw spawn 이 이미
      //   같은 방식으로 풀고 있다 — 두 call site 를 같은 규약으로 맞춘다.
      const pathForChild = [`${LOCAL_BIN}`, "/opt/homebrew/bin", env.PATH ?? ""].filter(Boolean).join(":");
      return Bun.spawn(spawnArgs, { stdout: "pipe", stderr: "pipe", env: { ...env, PATH: pathForChild } });
    } catch (e) {
      // 명시 OPENCLAW_BIN은 후보 탐색을 건너뛰므로 오류에는 실제로 시도한 경로를 우선 표시한다.
      throw new Error(
        `openclaw 실행파일을 찾지 못했습니다. 실행 시도: ${bin} ` +
          `(${e instanceof Error ? e.message : String(e)}). ` +
          `${process.env.OPENCLAW_BIN?.trim() ? "OPENCLAW_BIN 환경변수로 지정된 경로입니다 — 값이 맞는지 확인하세요." : `후보: ${OPENCLAW_BIN_CANDIDATES.join(", ")} → PATH. 비표준 위치에 설치했다면 OPENCLAW_BIN 환경변수로 절대경로를 지정하세요 (launchd 서비스면 plist 의 EnvironmentVariables 에 추가).`}`,
      );
    }
  })();
  // CLI 타임아웃과 동시에 kill하면 결과 JSON이 잘릴 수 있어 유예를 둔다. 유예 뒤 kill은 CLI가 종료하지 않은 경우이므로 audit에 남긴다.
  const timeout = setTimeout(() => {
    appendAuditFile("openclaw_bridge", "cli_timeout_backstop_kill", null, {
      call: args[0] ?? "(unknown)",
      cli_timeout_ms: timeoutMs,
      waited_ms: timeoutMs + CLI_TIMEOUT_BACKSTOP_MARGIN_MS,
    });
    proc.kill();
  }, timeoutMs + CLI_TIMEOUT_BACKSTOP_MARGIN_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // state-migration 경고가 stdout을 오염시키거나 비정상 종료를 유발할 수 있다. 유효한 JSON이 있으면 결과를 사용한다.
    const s = stdout.trim();
    if (s) {
      const start = s.indexOf("{");
      try {
        return JSON.parse(start >= 0 ? s.slice(start) : s);
      } catch {
        /* JSON 아님 → 아래에서 실패 처리 */
      }
    }
    throw new Error((stderr || s || `openclaw exited ${exitCode}`).trim());
  } finally {
    clearTimeout(timeout);
  }
}

type RunOpenclawJsonFn = typeof runOpenclawJson;
type FetchFn = typeof fetch;

let runOpenclawJsonForBridge: RunOpenclawJsonFn = runOpenclawJson;
let fetchForBridge: FetchFn = ((input, init) => fetch(input, init)) as FetchFn;

export function __setOpenclawBridgeTestDeps(deps?: {
  runOpenclawJson?: RunOpenclawJsonFn;
  fetch?: FetchFn;
}): void {
  runOpenclawJsonForBridge = deps?.runOpenclawJson ?? runOpenclawJson;
  fetchForBridge = deps?.fetch ?? (((input, init) => fetch(input, init)) as FetchFn);
}

async function ensureSession(agent: AgentRecord, key: string): Promise<void> {
  await runOpenclawJsonForBridge([
    "sessions.create",
    "--params",
    JSON.stringify({
      key,
      agentId: resolveOpenclawAgentId(agent),
      label: `Slack ${agent.display_name} ${key.split(":").at(-1) ?? ""}`.slice(0, 80),
    }),
  ]);
}

async function ensureTelegramRouterSession(agent: AgentRecord, key: string): Promise<void> {
  const labelSuffix = key.split(":").slice(-2).join(":");
  try {
    await runOpenclawJsonForBridge([
      "sessions.create",
      "--params",
      JSON.stringify({
        key,
        agentId: resolveOpenclawAgentId(agent),
        label: `Telegram router ${agent.display_name} ${labelSuffix}`.slice(0, 80),
      }),
    ]);
  } catch (e) {
    // If the router session already exists, continue and send into it. This avoids a
    // stale/parallel create attempt turning a valid wake into a dead_letter.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("label already in use")) throw e;
  }
}

async function waitForAssistantText(
  key: string,
  userMarker?: string,
  timeoutMs = OPENCLAW_GATEWAY_TIMEOUT_MS,
): Promise<string> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  // 직전 run 의 stale status 를 새 턴 실패로 오인하지 않도록 grace 후에만 terminal-failed 를 인정.
  const failGraceMs = Number(process.env.OPENCLAW_TURN_FAIL_GRACE_MS ?? 5000);
  while (Date.now() < deadline) {
    const preview = (await runOpenclawJsonForBridge([
      "sessions.preview",
      "--params",
      JSON.stringify({ keys: [key], limit: OPENCLAW_PREVIEW_LIMIT, maxChars: 24000 }),
    ])) as GatewayPreview;
    const items = preview.previews?.[0]?.items ?? [];
    const lastUserIndex = userMarker
      ? items.findLastIndex((i) => i.role === "user" && Boolean(i.text?.includes(userMarker)))
      : items.map((i) => i.role).lastIndexOf("user");
    if (lastUserIndex < 0) {
      await Bun.sleep(1500);
      continue;
    }
    const assistant = items
      .slice(Math.max(0, lastUserIndex + 1))
      .findLast((item) => item.role === "assistant" && item.text?.trim());
    if (assistant?.text) return assistant.text.trim();
    // 직전 run의 stale 실패 상태를 새 턴 실패로 오인하지 않도록 grace 이후에만 terminal-failed를 확정한다.
    if (Date.now() - started >= failGraceMs) {
      const status = await describeOpenclawSessionStatus(key);
      if (status && OPENCLAW_TERMINAL_FAILED_STATUS.has(status.toLowerCase())) {
        throw new OpenclawTurnFailedError(status);
      }
    }
    await Bun.sleep(1500);
  }
  throw new Error("openclaw response timeout");
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function openclawTelegramBotToken(agent: AgentRecord): string | null {
  const candidates = [
    `${agent.id.toUpperCase()}_TELEGRAM_BOT_TOKEN`,
    `${agent.id.toUpperCase()}_BOT_TOKEN`,
    "OPENCLAW_TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
  ];
  for (const key of candidates) {
    const value = process.env[key];
    if (value) return value;
  }
  // native_routing agent(codex)만 공유 openclaw env 파일(gd 프로필 토큰)을 fallback 으로 읽는다.
  // 다른 openclaw 에이전트(devon 등)는 각자 tokenFile 을 쓰므로 이 fallback 대상이 아니다.
  if (hasCapability(agent, "native_routing") && existsSync(DEFAULT_OPENCLAW_ENV)) {
    const env = parseDotenv(readFileSync(DEFAULT_OPENCLAW_ENV, "utf8"));
    for (const key of candidates) {
      if (env[key]) return env[key];
    }
  }
  // openclaw account tokenFile fallback — openclaw 에이전트(devon 등)의 텔레그램 봇 토큰은
  // ~/.openclaw/openclaw.json 의 channels.telegram.accounts[<account>].tokenFile 에 저장된다.
  // codex 만 env-파일 fallback 이 있어 다른 openclaw 에이전트(devon)는 토큰을 못 찾아 그룹 react/응답을
  // 못 올리던 버그 수정. 값은 런타임에 파일에서 읽고 어디에도 복사하지 않는다.
  try {
    const openclawConfig = `${process.env.HOME ?? ""}/.openclaw/openclaw.json`;
    if (existsSync(openclawConfig)) {
      const cfg = JSON.parse(readFileSync(openclawConfig, "utf8")) as {
        channels?: { telegram?: { accounts?: Record<string, { tokenFile?: string }> } };
      };
      const accounts = cfg.channels?.telegram?.accounts ?? {};
      const account = accounts[resolveOpenclawAgentId(agent)] ?? accounts[agent.id];
      if (account?.tokenFile && existsSync(account.tokenFile)) {
        const tok = readFileSync(account.tokenFile, "utf8").trim();
        if (tok) return tok;
      }
    }
  } catch {
    // 무시 — null 로 폴백
  }
  return null;
}

async function reactTelegramAsOpenclaw(
  agent: AgentRecord,
  chatId: string,
  messageId: string | number,
  emoji = "👀",
): Promise<boolean> {
  const token = openclawTelegramBotToken(agent);
  if (!token) return false;
  const numericMessageId = Number(messageId);
  if (!Number.isFinite(numericMessageId)) return false;
  try {
    const res = await fetchForBridge(`https://api.telegram.org/bot${token}/setMessageReaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(chatId),
        message_id: numericMessageId,
        reaction: [{ type: "emoji", emoji }],
      }),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

// 본문 생성과 실제 배달을 구분할 수 있도록 message_id까지 반환한다.
export async function postTelegramAsOpenclaw(
  agent: AgentRecord,
  chatId: string,
  text: string,
  replyToMessageId?: string | number,
): Promise<{ ok: boolean; messageId?: number }> {
  const token = openclawTelegramBotToken(agent);
  if (!token) return { ok: false };
  const body = buildOpenclawTelegramSendMessageBody(chatId, text, replyToMessageId);
  try {
    const res = await fetchForBridge(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false };
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: { message_id?: number } }
      | null;
    if (json?.ok === true) return { ok: true, messageId: json.result?.message_id };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export function buildOpenclawTelegramSendMessageBody(
  chatId: string,
  text: string,
  replyToMessageId?: string | number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_id: String(chatId),
    text,
    disable_notification: true,
  };
  if (replyToMessageId !== undefined) {
    const numericReplyId = Number(replyToMessageId);
    if (Number.isFinite(numericReplyId)) {
      body.reply_parameters = {
        message_id: numericReplyId,
        allow_sending_without_reply: true,
      };
    }
  }
  return body;
}

export async function runOpenclawSlackTurn(opts: RunOpenclawTurnOptions): Promise<string> {
  const key = sessionKeyFor(opts.agent, opts.channel, opts.threadId);
  await ensureSession(opts.agent, key);
  const prompt =
    // source·kind 순서(hermes 봉투와 일관). slack 경로는 kind 가 항상 "slack" 이라 리터럴로 싣는다
    //   (이 함수는 슬랙 전용 — 다른 kind 로 불릴 일이 없다). 팀원은 kind 로 답 주소를 정한다(룰 9039834).
    `<external_message source="slack" kind="slack" from="${opts.slackUserId ?? "slack:user"}" thread="${opts.threadId}" msg="${opts.messageId}">\n` +
    `${opts.body}\n` +
    `</external_message>\n\n` +
    pick(opts.locale,
      "Slack에서 온 멘션입니다. ★말하려면 직접 보내세요. 안 보내면 아무 말도 안 한 것입니다.★ " +
      "여기 쓰는 글은 ★당신의 메모★ 일 뿐 아무 데도 안 갑니다 — 서버가 대신 게시하지 않습니다. " +
      `thread="${opts.threadId}" 로 보내면 서버가 원래 Slack 스레드에 릴레이합니다.`,
      "This is a mention from Slack. **To speak, you must send. If you do not send, you have said nothing.** " +
      "What you write here is **your own scratchpad** — it goes nowhere; the server does not post it for you. " +
      `Send on thread="${opts.threadId}" and the server relays it back to the original Slack thread.`);
  await runOpenclawJsonForBridge([
    "sessions.send",
    "--params",
    JSON.stringify({
      key,
      message: prompt,
      idempotencyKey: `slack-${opts.messageId}`,
    }),
  ], OPENCLAW_GATEWAY_TIMEOUT_MS);
  return waitForAssistantText(key);
}

function busDirectedSessionKeyFor(agent: AgentRecord, threadId: string): string {
  const openclawAgentId = resolveOpenclawAgentId(agent);
  const safeThread = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `agent:${openclawAgentId}:bus:team-collab:${agent.id}:${safeThread}`;
}


interface InjectOpenclawDirectedOptions {
  agent: AgentRecord;
  threadId: string;
  messageId: string;
  body: string;
  attachments?: BusAttachment[];
  fromLabel?: string;
  /** 로케일(ko 기본 · en 토글). owner_name 치환과 직교. */
  locale?: Locale;
  teamContext?: string;
  inReplyTo?: string;
  hopCount?: number;
  // 버스 경로는 teammate·notice만 받는다. 직접 보고는 별도 주입 경로이므로 kind를 필수로 받아 배선 누락을 방지한다.
  kind: "teammate" | "notice";
  // 수집 기여자의 답은 버스 행으로 남아야 한다. 그룹 주입 경로는 버스 행을 남기지 않으므로 directed 경로를 사용한다.
}

/**
 * Directed(지정) 버스 메시지로 openclaw 에이전트를 깨운다. 텔레그램 그룹에는 아무것도 올리지 않고,
 * 에이전트가 발신자에게 버스(inbox API)로 ack/응답하도록 지시한다.
 * 배경: 기존엔 비-tg thread = inbox-only(안 깨움) → directed handoff 가 openclaw 에이전트한테 안 닿았다
 * (devon handoff 미응답 버그, GD 2489). claude 봇이 directed 도 tmux 로 깨워지는 것과 동일하게 맞춘다.
 */
export async function injectOpenclawDirectedTurn(opts: InjectOpenclawDirectedOptions): Promise<boolean> {
  const key = busDirectedSessionKeyFor(opts.agent, opts.threadId);
  await ensureTelegramRouterSession(opts.agent, key); // create-or-continue (label 충돌은 무시)
  const locale = opts.locale;
  const teamContextBlock = opts.teamContext
    ? `${teamContextLabel(locale)}\n${opts.teamContext}\n\n`
    : "";
  const attachmentBlock = opts.attachments?.length
    ? pick(locale, `[첨부 파일 — 팀 내부 media URL/경로, 필요하면 직접 열람]\n`, `[Attachments — internal team media URL/path, open directly if needed]\n`) +
      opts.attachments.map((a, i) => `${i + 1}. ${a.kind}: ${a.value}${a.note ? ` (${a.note})` : ""}`).join("\n") +
      "\n\n"
    : "";
  // 팀원 규칙이 hop을 1 증가시키므로 봉투에는 현재 값을 그대로 싣는다.
  const currentHop = opts.hopCount ?? 0;
  const replyToMeta = opts.inReplyTo ? ` in_reply_to="${opts.inReplyTo}"` : "";
  const owner = pick(locale, "팀장", "the team lead");
  const prompt =
    teamContextBlock +
    attachmentBlock +
    `<external_message source="bus" kind="${opts.kind}" from="${opts.fromLabel ?? "team"}" thread="${opts.threadId}" msg="${opts.messageId}"${replyToMeta} hop_count=${currentHop}>\n` +
    `${opts.body}\n` +
    `</external_message>\n\n` +
    // 수집 답은 부모 메시지가 아니라 ask 자체를 가리켜야 해당 요청과 엄격히 매칭된다.
    (() => {
      // 봉투는 사실만 제공한다. 답 주소와 수집 절차를 중복 지시하면 팀원 규칙과 충돌할 수 있다.
      const replyId = opts.inReplyTo ?? opts.messageId;
      return pick(locale,
        `이건 팀 버스의 directed(지정) 메시지입니다 — ${opts.fromLabel ?? "팀원"} 이(가) thread=${opts.threadId} 로 당신에게 보냈습니다 ` +
        `(msg=${replyId}, hop_count=${currentHop}).`,
        `This is a directed message on the team bus — ${opts.fromLabel ?? "a member"} sent it to you on thread=${opts.threadId} ` +
        `(msg=${replyId}, hop_count=${currentHop}).`);
    })();
  // 완료를 기다려야 실행 중인 턴을 성공으로 조기 반환하지 않는다.
  const idk = `bus-directed-${opts.messageId}`;
  const openclawAgentId = resolveOpenclawAgentId(opts.agent);
  const started = (await runOpenclawJsonForBridge([
    "agent",
    "--params",
    JSON.stringify({ sessionKey: key, agentId: openclawAgentId, message: prompt, deliver: false, idempotencyKey: idk }),
  ], OPENCLAW_GATEWAY_TIMEOUT_MS)) as { runId?: string; status?: string } | null;
  const runId = started?.runId;
  if (!runId) return false; // accept 실패 = 깨우기 실패로 취급(어댑터가 expire_no_retry 처리)
  // agent.wait 캡은 claim lease(OPENCLAW_LEASE_MS=300s)보다 짧아야 한다 — 안 그러면 블록 중 lease 만료 →
  //   recoverStaleClaims 가 row 를 재클레임 → 이중발사. 실측 턴 125~149s(캡 240s)라 230s 로 캡한다.
  const AGENT_WAIT_CAP_MS = 230_000;
  const done = (await runOpenclawJsonForBridge([
    "agent.wait",
    "--params",
    JSON.stringify({ runId, timeoutMs: AGENT_WAIT_CAP_MS }),
  ], AGENT_WAIT_CAP_MS + 10_000)) as { status?: string } | null;
  return done?.status === "ok";
}

export async function injectOpenclawTelegramTurn(opts: InjectOpenclawTelegramOptions): Promise<boolean> {
  const key = telegramRouterSessionKeyFor(opts.agent, opts.groupId, opts.threadId);
  await ensureTelegramRouterSession(opts.agent, key);
  const locale = opts.locale;
  const teamContextBlock = opts.teamContext
    ? `${teamContextLabel(locale)}\n${opts.teamContext}\n\n`
    : "";
  const attachmentBlock = opts.attachments?.length
    ? pick(locale, `[첨부 파일 — 팀 내부 media URL/경로, 필요하면 직접 열람]\n`, `[Attachments — internal team media URL/path, open directly if needed]\n`) +
      opts.attachments.map((a, i) => `${i + 1}. ${a.kind}: ${a.value}${a.note ? ` (${a.note})` : ""}`).join("\n") +
      "\n\n"
    : "";
  // 팀원 규칙이 hop을 1 증가시키므로 봉투에는 현재 값을 그대로 싣는다. 미리 증가시키면 메시지당 두 번 오른다.
  const currentHop = opts.hopCount ?? 0;
  const replyToMeta = opts.inReplyTo ? ` in_reply_to="${opts.inReplyTo}"` : "";
  const hopMeta = `hop_count=${currentHop}`;
  const owner = pick(locale, "팀장", "the team lead");
  const hopInstruction = opts.inReplyTo !== undefined
    ? pick(locale,
        ` 응답 시 공유 버스에 올릴 때 반드시 in_reply_to=${opts.inReplyTo ?? opts.messageId}, hop_count=${currentHop} 를 포함하세요(무한루프 방지).`,
        ` When you post to the shared bus, you MUST include in_reply_to=${opts.inReplyTo ?? opts.messageId}, hop_count=${currentHop} (loop prevention).`)
    : "";
  // 사실만: 이 보고는 ${owner} 가 직접 볼 것이다 → --direct-to-gd. 보내는 법의 상세는 룰에 있다.
  const directReportNote = opts.directReport
    ? pick(locale,
        `[direct_to_gd] 이 작업은 ${opts.fromLabel ?? "a teammate"}이(가) 위임한 ${owner}-facing 보고입니다 — ${owner}가 결과를 직접 보길 원합니다. 최종 보고는 ★--direct-to-gd 로 보내세요★ (서버가 ${owner}의 1:1 DM 으로 릴레이합니다). 안 보내면 아무 데도 안 갑니다.\n\n`,
        `[direct_to_gd] This task is an ${owner}-facing report delegated by ${opts.fromLabel ?? "a teammate"} — ${owner} wants to see the result directly. **Send your final report with --direct-to-gd** (the server relays it to ${owner}'s 1:1 DM). If you do not send, it goes nowhere.\n\n`)
    : "";
  const prompt =
    teamContextBlock +
    attachmentBlock +
    directReportNote +
    `<external_message source="telegram" kind="${opts.kind ?? "group"}" from="${opts.fromLabel ?? `${owner} (${pick(locale, "그룹 라우터", "group router")})`}" thread="${opts.threadId}" msg="${opts.messageId}"${replyToMeta} ${hopMeta}>\n` +
    `${opts.body}\n` +
    `</external_message>\n\n` +
    // 깨어난 것만으로 owner가 되지는 않는다. 수신자는 멘션·답장·직전 owner 규칙으로 소유권을 판정한다.
    pick(locale,
      `이 방에 올라온 메시지입니다. ` +
      `★말하려면 직접 보내세요. 안 보내면 아무 말도 안 한 것입니다.★ 턴에 쓴 글은 당신의 메모일 뿐, 아무 데도 안 갑니다(서버가 대신 게시하지 않습니다). ` +
      `이 방의 스레드는 thread="${opts.threadId}" 입니다. 할 말이 없으면 그냥 안 보내면 됩니다.` +
      hopInstruction,
      `A message arrived in this group room. ` +
      `**To speak, you must send. If you do not send, you have said nothing.** Your turn text is your own scratchpad — it goes nowhere (the server does not post it for you). ` +
      `This room's thread is thread="${opts.threadId}". If you have nothing to say, simply do not send.` +
      hopInstruction);

  // React before sessions.send. This is the user's immediate "received" signal and should not
  // wait behind a slow/stuck OpenClaw turn.
  if (opts.origTgMessageId) {
    await reactTelegramAsOpenclaw(opts.agent, opts.groupId, opts.origTgMessageId);
  }

  await runOpenclawJsonForBridge([
    "sessions.send",
    "--params",
    JSON.stringify({
      key,
      message: prompt,
      idempotencyKey: `telegram-router-${opts.messageId}`,
    }),
  ], OPENCLAW_GATEWAY_TIMEOUT_MS);
  // 응답 지연은 실패와 구분해 안내한다. terminal-failed는 지연 대신 실패 공지를 사용한다.
  let reply: string;
  try {
    reply = await waitForAssistantText(key, `msg="${opts.messageId}"`, OPENCLAW_GATEWAY_TIMEOUT_MS);
  } catch (e) {
    const isTurnFailed = e instanceof OpenclawTurnFailedError;
    const isTimeout = !isTurnFailed && e instanceof Error && /timeout/i.test(e.message);
    recordRuntimeBlock(
      opts.agent.id,
      `openclaw runtime ${isTurnFailed ? `turn_failed:${(e as OpenclawTurnFailedError).status}` : isTimeout ? "openclaw response timeout" : "error"}: ${
        e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)
      }`,
    );
    appendAuditFile("bus_dispatcher", "agent_reply_failed", opts.messageId, {
      agent: opts.agent.id,
      reason: isTurnFailed ? `turn_failed:${(e as OpenclawTurnFailedError).status}` : isTimeout ? "timeout" : "error",
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
    // 확정된 죽은 턴은 실패 notice, 단순 timeout 은 지연 notice.
    if (isTurnFailed) {
      const status = (e as OpenclawTurnFailedError).status;
      const notice = pick(locale,
        `⚠️ 방금 받은 작업을 처리하던 턴이 중단됐습니다 (${status}). ` +
        `자동으로 재생되지 않으니 다시 시도하거나 메시지를 재전송해 주세요.`,
        `⚠️ The turn handling the task I just received was aborted (${status}). ` +
        `It does not resume automatically, so please retry or resend the message.`);
      const noticed = await postTelegramAsOpenclaw(opts.agent, opts.groupId, notice, opts.origTgMessageId);
      appendAuditFile("bus_dispatcher", "agent_turn_failed_notified", opts.messageId, {
        agent: opts.agent.id,
        status,
        notified: noticed.ok,
        notice_message_id: noticed.messageId ?? null,
      });
    } else if (isTimeout && isOpenclawTimeoutNoticeEnabled()) {
      const agentName = opts.agent.display_name || opts.agent.id;
      const notice = pick(
        locale,
        `⏳ ${agentName} 응답이 지연되어 bridge가 기다림을 멈췄습니다. 작업이 계속 진행 중이면 이후 응답이 별도로 도착할 수 있습니다.`,
        `⏳ The ${agentName} response is delayed and the bridge stopped waiting. If the work is still running, a response may arrive separately later.`,
      );
      const noticed = await postTelegramAsOpenclaw(opts.agent, opts.groupId, notice, opts.origTgMessageId);
      appendAuditFile("bus_dispatcher", "agent_timeout_notified", opts.messageId, {
        agent: opts.agent.id,
        notified: noticed.ok,
        notice_message_id: noticed.messageId ?? null,
      });
    }
    return false;
  }
  clearRuntimeBlock(opts.agent.id);
  // 턴 본문은 자동 게시하지 않는다. 침묵 표식이 사용자 메시지로 노출될 수 있어 발신 도구로 보낸 것만 전달한다.
  appendAuditFile("openclaw_bridge", "turn_completed_no_autopost", opts.messageId, {
    agent_id: opts.agent.id,
    chars: reply.length,   // 본문은 남기지 않는다 — 말한 게 아니라 메모다
  });
  // '팀장께 보고가 도달했다' 는 이제 그 팀원이 보낸 시점 에 routes/inbox.ts 가 기록한다.
  //   (여기서 기록하면 서버가 대신 보낸 것 을 '보고 완료' 로 세는 셈이라 거짓이 된다)
  return true;
}

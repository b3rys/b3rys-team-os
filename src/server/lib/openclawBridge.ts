import { existsSync, readFileSync } from "node:fs";
import type { AgentRecord } from "../types";
import { pick, type Locale } from "./i18n";
import { teamContextLabel } from "../channels/registry";
import { appendAuditFile } from "./auditFile";
import { hasCapability } from "./capabilities";
import { clearRuntimeBlock, recordRuntimeBlock } from "./runtimeBlocks";
import { openclawEnvPath } from "./paths";

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
  /**
   * ★서버가 '무엇을 내보냈는지' 알 수 있는 유일한 통로.★ (2026-07-12)
   * openclaw 는 답을 ★자기가 직접 텔레그램에 게시★하고 서버엔 boolean 만 돌려준다 →
   * ★종합 본문이 DB 에 안 남아 "팀원 답이 담겼나"를 검증할 수 없었다.★
   * 여기서 본문을 넘겨 호출자(wakeDispatcher)가 배달 기록을 남긴다. ★기록 실패가 발송을 막지 않는다(fail-soft).★
   */
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
  /** case 6 (2026-06-05): Bill 등이 위임한 GD-facing 보고(direct_to_gd). 프롬프트에 "GD에게 직접
   *  그룹 보고" 맥락을 넣는다. 기본 흐름(브릿지가 답을 그룹 reply 로 전송)은 동일. */
  directReport?: boolean;
  /** ★봉투 kind★ (2026-07-15) — 서버가 계산한 replyRoute.kind. 팀원은 이걸로 답 주소를 정한다(룰 9039834).
   *  이 함수는 두 경로가 쓴다: 단톡방 라우터(kind="group") · direct_to_gd 보고(kind="direct_to_gd").
   *  기본값 "group" — 단톡방 라우터(telegramCapture)·테스트 호출부는 group 이 정답이라 배선 없이 맞다.
   *  direct_to_gd 경로(wakeDispatcher)만 "direct_to_gd" 로 ★명시 override★ 한다. */
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
    endedAt?: number; // epoch ms — 이 세션에서 ★마지막으로 끝난 턴★ 의 종료 시각
  };
}

/**
 * B (2026-06-13, Lui silent-abort 사후): 확정된 죽은 턴 신호.
 * openclaw 턴이 `turn.completion_idle_timeout` 등으로 session status=failed/error 로 끝나면
 * 본문 없이 턴이 죽은 것이다(assistantTexts=[]). 이걸 단순 응답 지연(턴이 아직 살아있을 수 있음)과
 * 구분해서, 확정 실패에만 visible notice 를 띄운다. 단순 timeout 은 2026-06-05 롤백 규칙대로 침묵.
 */
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

const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";
// 2026-07-06 (GD live): 300초는 코드 수정·검증 같은 긴 turn에서 bridge가 먼저 포기해
// "Codex가 끝까지 답했지만 Telegram에는 안 보이는" 상태를 만들었다. 팀방 visible reply는 실제 최종보고가
// 보이는 것이 완료 기준이다. 팀 기본 과제 수행시간 단위에 맞춰 기본 대기 시간을 10분으로 둔다.
// 실제 턴 실패는 session.describe 로 조기 감지.
const OPENCLAW_GATEWAY_TIMEOUT_MS = Number(process.env.OPENCLAW_GATEWAY_TIMEOUT_MS ?? 600_000);
// Plain timeouts are ambiguous: the OpenClaw turn may still be running and can post a real reply
// later. Keep terminal-failure notices visible, but make delay notices opt-in so transient slow
// turns do not spam the Telegram room.
function isOpenclawTimeoutNoticeEnabled(): boolean {
  return process.env.OPENCLAW_TIMEOUT_NOTICE === "1";
}
const OPENCLAW_PREVIEW_LIMIT = Number(process.env.OPENCLAW_PREVIEW_LIMIT ?? 80);
// 2026-06-05 롤백(GD): 오늘 넣었던 "작성 중"(EARLY_PROGRESS)·별도 보이는-한도(VISIBLE_REPLY_TIMEOUT)
// 제거. 응답 대기는 게이트웨이 타임아웃(OPENCLAW_GATEWAY_TIMEOUT_MS, 300초)만 사용.
const DEFAULT_OPENCLAW_ENV = process.env.OPENCLAW_ENV ?? openclawEnvPath();

function resolveOpenclawAgentId(agent: AgentRecord): string {
  // 게이트웨이 프로필명은 agents.json 의 openclaw_agent_id 정본을 쓴다(codex="gd" 등 이미 박힘).
  // 이전 `agent.id === "codex" → "gd"` 하드코딩 폴백은 codex 레코드가 openclaw_agent_id 를 이미
  // 가지므로 dead 였다 — 제거. 미설정 시 id 그대로.
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
  // ★게이트웨이 전송(WebSocket) 타임아웃을 의도한 대기시간과 일치시킨다★ (2026-07-16, 라이브 실측)
  //   `openclaw gateway call` 의 --timeout 기본값은 10000ms 다. 안 넘기면 agent.wait 의 내부
  //   timeoutMs(230s)와 무관하게 ★전송이 10초에 끊겨★ {ok:false,error:{kind:"timeout"}} 를 뱉는다
  //   (status 없음 → done?.status==="ok" false → codex 가 10초 넘는 턴을 정상 처리했는데도 '전달 실패' 오탐).
  //   → 전송 타임아웃 = spawn-kill 타임아웃(timeoutMs)으로 맞춘다.
  const proc = Bun.spawn([OPENCLAW_BIN, "gateway", "call", ...args, "--timeout", String(timeoutMs), "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // ★state-migration 경고를 '실패'로 오인하지 않는다★ (2026-07-16, steve+harness) — openclaw 공유 SQLite
    //   의 acpx/codex plugin-install 메타 충돌로 CLI 가 매 호출마다 경고를 뱉는다(때론 exit≠0/stdout 오염).
    //   ★유효한 JSON 이 나오면 성공★ 으로 본다(경고는 노이즈). JSON 이 아예 없을 때만 진짜 실패로 던진다.
    //   (이게 없으면 codex 가 정상 종합했는데도 '전달 실패' 오탐 알림이 나갔다 — aw-test-codex 라이브)
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
    // B (2026-06-13): 본문이 아직 없는데 session 이 terminal-failed 면 = 확정된 죽은 턴.
    // 300초 대기를 끝까지 기다리지 않고 즉시 실패로 끊어 visible notice 로 넘긴다.
    // grace(기본 5초) 후에만: 직전 run 의 stale status 를 새 턴 실패로 오인하지 않도록.
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
  // 못 올리던 버그(GD 2501) 수정. 값은 런타임에 파일에서 읽고 어디에도 복사하지 않는다.
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

/**
 * C (2026-06-13): 텔레그램 전송 결과를 message_id(실제 delivery 증거)까지 반환한다.
 * 완료판정을 "본문 생성"이 아니라 "실제 도달(message_id 존재)"로 닫기 위함.
 */
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
    // ★source·kind★ 순서(hermes 봉투와 일관). slack 경로는 kind 가 항상 "slack" 이라 리터럴로 싣는다
    //   (이 함수는 슬랙 전용 — 다른 kind 로 불릴 일이 없다). 팀원은 kind 로 답 주소를 정한다(룰 9039834).
    `<external_message source="slack" kind="slack" from="${opts.slackUserId ?? "slack:user"}" thread="${opts.threadId}" msg="${opts.messageId}">\n` +
    `${opts.body}\n` +
    `</external_message>\n\n` +
    // ★[B] — 말하려면 보내라.★ (GD 2026-07-13) 예전엔 "직접 보내지 마세요, 브릿지가 전송합니다" 였다.
    // 보내는 법(send.sh)은 룰에 있다 — 여기서 두 번째 입구를 열지 않는다(GD 2026-07-14).
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

// [2026-07-16 제거] OPENCLAW_TURN_OVER_STATUS / isOpenclawTurnOver / isOpenclawBusTurnRunning —
//   openclaw 가 fire-and-forget 이던 시절, dispatcher 가 "턴 끝났나"를 게이트웨이에 물어보려고
//   openclaw CLI 를 10초마다 띄우던 프로브였다. injectOpenclawDirectedTurn 이 agent.wait 으로
//   턴 종료까지 블록하게 되면서 불필요해져 제거했다. (describeOpenclawSession / busDirectedSessionKeyFor
//   는 텔레그램 경로 waitForAssistantText 에서 계속 쓰이므로 유지.)

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
  /** ★봉투 kind★ (2026-07-15) — 서버가 계산한 replyRoute.kind. 이 directed(버스) 경로는 두 종류다:
   *  팀원간 함수호출("teammate") · 순수 시스템 통지("notice", 답할 곳 없음). direct_to_gd 는 이 함수로
   *  오지 않는다(그 경로는 injectOpenclawTelegramTurn kind="direct_to_gd" 로 갈린다). 유일 호출부는
   *  wakeDispatcher — ★필수★ 로 둬 배선 누락 시 컴파일이 깨지게 한다(hermes 와 동일 원칙). */
  kind: "teammate" | "notice";
  /** 수집(collection) fan-out ask (meta.collect=true). set 되면 ①in_reply_to 를 이 ask 자신의
   *  messageId 로 고정(collection 엄격매칭) ②그룹 게시 금지·집계 경고를 프롬프트에 추가.
   *  ★tg- thread 에서도 이 directed(버스 복귀) 경로로 와야 한다★ — 그룹 경로(injectOpenclawTelegramTurn)
   *  는 버스 row 를 안 남겨 openclaw 기여자가 collection 에서 ★영구 missing★ 된다(codex 리뷰, 2026-07-12). */
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
    ? `${teamContextLabel(opts.threadId, locale)}\n${opts.teamContext}\n\n`
    : "";
  const attachmentBlock = opts.attachments?.length
    ? pick(locale, `[첨부 파일 — 팀 내부 media URL/경로, 필요하면 직접 열람]\n`, `[Attachments — internal team media URL/path, open directly if needed]\n`) +
      opts.attachments.map((a, i) => `${i + 1}. ${a.kind}: ${a.value}${a.note ? ` (${a.note})` : ""}`).join("\n") +
      "\n\n"
    : "";
  const nextHop = (opts.hopCount ?? 0) + 1;
  const replyToMeta = opts.inReplyTo ? ` in_reply_to="${opts.inReplyTo}"` : "";
  const owner = pick(locale, "팀장", "the team lead");
  const prompt =
    teamContextBlock +
    attachmentBlock +
    `<external_message source="bus" kind="${opts.kind}" from="${opts.fromLabel ?? "team"}" thread="${opts.threadId}" msg="${opts.messageId}"${replyToMeta} hop_count=${nextHop}>\n` +
    `${opts.body}\n` +
    `</external_message>\n\n` +
    // ★수집(collect) fan-out ask 는 in_reply_to 를 반드시 ★이 ask 자신의 id(messageId)★ 로 써야 한다 —
    //   matchCollectionForReply 가 reply.in_reply_to === collection_expected.call_msg_id(=fan-out
    //   message_id) ★엄격 매칭★ 이라(thread fallback 없음), 평소의 `inReplyTo ?? messageId` 를 쓰면
    //   fan-out 에 부모가 있을 때 부모 id 로 답해 ★집계 실패 → 종합에서 누락★ (codex 리뷰 blocker,
    //   2026-07-12). collect 아닐 때는 기존 hop-chain 규약(inReplyTo ?? messageId) 그대로.
    (() => {
      // ★주입문은 사실만 말한다(GD 2026-07-14).★ 예전 문구는 세 가지를 했고 셋 다 해로웠다:
      //   ① "발신자에게 응답/ack 를 보내세요" → ★ack 를 시켰다.★ 룰은 정반대다(요청받은 답·결과는 TERMINAL —
      //      ack·동의·확인으로 답하지 않는다). 그래서 수집자가 기여자 답마다 ack 를 보내고, 정작 종합은
      //      마감 알림이 깨울 때까지 안 보냈다 — ★"코덱스가 마감까지 기다린다"의 원인이 이 문장이었다.★
      //   ② "envelope API: POST http://127.0.0.1:7878/team/api/inbox, to=<발신자>" → ★두 번째 입구.★
      //      룰은 send.sh 하나를 말하는데 주입문이 다른 문을 열어 줬고, to= 를 미리 채워 답을 요청자가 아닌
      //      발신자에게 향하게 했다. 입구가 둘이면 언젠가 한쪽으로 샌다.
      //   ③ "그룹에 아무것도 올리지 마세요 / broadcast 금지" → ★억제.★ 팀원 자율에 맡기기로 한 것과 어긋난다.
      //      어디로 보낼지는 룰(§5: 답은 물어본 사람에게 directed)이 이미 말한다.
      // 남은 것은 팀원이 알 수 없는 사실뿐이다 — 누가·어느 스레드로·무슨 메시지로 보냈는가.
      // ★보내는 법은 룰(AGENTS.md)에 있다. 여기서 다시 말하지 않는다.★
      const replyId = opts.inReplyTo ?? opts.messageId;
      return pick(locale,
        `이건 팀 버스의 directed(지정) 메시지입니다 — ${opts.fromLabel ?? "팀원"} 이(가) thread=${opts.threadId} 로 당신에게 보냈습니다 ` +
        `(msg=${replyId}, hop_count=${nextHop}).`,
        `This is a directed message on the team bus — ${opts.fromLabel ?? "a member"} sent it to you on thread=${opts.threadId} ` +
        `(msg=${replyId}, hop_count=${nextHop}).`);
    })();
  // ★sessions.send(fire-and-forget) → agent + agent.wait★ (2026-07-16, GD)
  //   sessions.send 는 "밀어넣었다(ack)"만 돌려줘 서버가 '턴 돌았다'로 착각했다 → codex 침묵 턴의 4분
  //   유령-활성 창(turnCompletionIdleTimeoutMs)에 2번째 기여자 답이 주입돼 조용히 유실됐다(codex 고아, 실측 17건).
  //   agent 는 ★deliver:false★ 로 채널에 아무것도 안 올리고(누출 0 — 버스 세션은 원래 비게시), agent.wait 은
  //   ★턴의 lifecycle-end(진짜 끝)★ 까지 블록한다 — 화면 텍스트가 아니라 '턴 끝' 이벤트라 ★침묵 턴도 즉시★.
  //   이 함수가 '턴 끝날 때까지' 블록하므로 inFlight 잠금이 턴 내내 유지 → 다음 답은 busy-defer(자가복구 경로)로
  //   흘러 mid-turn 주입 자체가 사라진다 = 고아 소멸. (라이브 프로브 확인: agent.wait 이 13s 블록 후 status:ok)
  const idk = `bus-directed-${opts.messageId}`;
  const openclawAgentId = resolveOpenclawAgentId(opts.agent);
  const started = (await runOpenclawJsonForBridge([
    "agent",
    "--params",
    JSON.stringify({ sessionKey: key, agentId: openclawAgentId, message: prompt, deliver: false, idempotencyKey: idk }),
  ], OPENCLAW_GATEWAY_TIMEOUT_MS)) as { runId?: string; status?: string } | null;
  const runId = started?.runId;
  if (!runId) return false; // accept 실패 = 깨우기 실패로 취급(어댑터가 expire_no_retry 처리)
  // ★agent.wait 캡은 claim lease(OPENCLAW_LEASE_MS=300s)보다 짧아야 한다★ — 안 그러면 블록 중 lease 만료 →
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
    ? `${teamContextLabel(opts.threadId, locale)}\n${opts.teamContext}\n\n`
    : "";
  const attachmentBlock = opts.attachments?.length
    ? pick(locale, `[첨부 파일 — 팀 내부 media URL/경로, 필요하면 직접 열람]\n`, `[Attachments — internal team media URL/path, open directly if needed]\n`) +
      opts.attachments.map((a, i) => `${i + 1}. ${a.kind}: ${a.value}${a.note ? ` (${a.note})` : ""}`).join("\n") +
      "\n\n"
    : "";
  // v1.2 issue 3: include anti-pingpong hop metadata in prompt — same convention as tmux adapter.
  const nextHop = (opts.hopCount ?? 0) + 1;
  const replyToMeta = opts.inReplyTo ? ` in_reply_to="${opts.inReplyTo}"` : "";
  const hopMeta = `hop_count=${nextHop}`;
  const owner = pick(locale, "팀장", "the team lead");
  const hopInstruction = opts.inReplyTo !== undefined
    ? pick(locale,
        ` 응답 시 공유 버스에 올릴 때 반드시 in_reply_to=${opts.inReplyTo ?? opts.messageId}, hop_count=${nextHop} 를 포함하세요(무한루프 방지).`,
        ` When you post to the shared bus, you MUST include in_reply_to=${opts.inReplyTo ?? opts.messageId}, hop_count=${nextHop} (loop prevention).`)
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
    // ★사실만 말한다(GD 2026-07-14).★ 예전 문구는 envelope API(두 번째 입구)를 두 번 안내하고,
    //   broadcast 를 두 번 금지하고, 누구에게 답할지·재실행 말지까지 지시했다 — 전부 룰(§2 owner, §5 협업)에
    //   이미 있는 것을 주입문이 변형해서 다시 말한 것이다. 룰과 주입문이 어긋나면 팀원은 주입문을 따른다.
    //   남기는 것: ①이건 흘러가는 그룹 대화가 아니라 너에게 배정된 작업이다 ②[B] 불변식 ③이 방의 thread id
    //   ④루프 방지 메타. 보내는 법·누구에게·무엇을 금지하는지는 룰이 말한다.
    pick(locale,
      `b3rys team-collab 라우터가 이 메시지를 당신에게 배정했습니다 — 흘러가는 그룹 대화가 아니라 당신에게 온 명시적 작업입니다. ` +
      `★말하려면 직접 보내세요. 안 보내면 아무 말도 안 한 것입니다.★ 턴에 쓴 글은 당신의 메모일 뿐, 아무 데도 안 갑니다(서버가 대신 게시하지 않습니다). ` +
      `이 방의 스레드는 thread="${opts.threadId}" 입니다. 할 말이 없으면 그냥 안 보내면 됩니다.` +
      hopInstruction,
      `The b3rys team-collab router assigned this message to you — it is not ambient group chatter but an explicit task for you. ` +
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
  // 2026-07-06 (GD live): timeout 뒤 침묵하면 팀장 입장에서는 "아무것도 안 함"이 된다.
  // 단순 응답 지연도 bridge가 포기한 순간에는 visible notice 를 남긴다(OPENCLAW_TIMEOUT_NOTICE=0 이면 비활성).
  // B (2026-06-13): 다만 session 이 terminal-failed(확정된 죽은 턴)면 그건 지연이 아니라 실패이므로,
  // 침묵하지 말고 visible notice 를 띄운다(Lui silent-abort 재발 방지). 둘의 구분은
  // OpenclawTurnFailedError(확정 실패) vs "openclaw response timeout"(단순 지연).
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
  // ★[B] — 서버는 팀원 대신 말하지 않는다.★ (GD 2026-07-13: "팀원한테 맡겨. 다 빼.")
  //
  // ═══ 예전엔 ═══
  //   게이트웨이가 뱉은 최종 텍스트를 ★브릿지가 대신 단톡방에 게시★했다.
  //   그래서 codex 는 ★뭘 쓰든 나갔다★ → 침묵이 불가능 → `[NO_REPLY]` 우회로 →
  //   ★"GD Step Codex: [NO_REPLY]" 가 팀장 단톡방에 문자 그대로 찍혔다.★ (2026-07-13 라이브)
  //
  // ═══ 지금 ═══
  //   ★턴 본문은 그 팀원의 메모다. 아무 데도 안 간다.★ 말하려면 팀원이 자기 도구로 보낸다:
  //     · 방에    → POST /team/api/inbox  (to=broadcast, thread=이 그룹 thread)
  //     · 팀원에게 → POST /team/api/inbox  (to=<상대>)
  //     · 팀장께   → meta.reply_mode=direct_to_gd
  //   서버는 그 발신을 ★릴레이만★ 한다(routes/inbox.ts). ★"보낸 것만 말한 것이다."★
  appendAuditFile("openclaw_bridge", "turn_completed_no_autopost", opts.messageId, {
    agent_id: opts.agent.id,
    chars: reply.length,   // ★본문은 남기지 않는다★ — 말한 게 아니라 메모다
  });
  // ★'팀장께 보고가 도달했다' 는 이제 ★그 팀원이 보낸 시점★ 에 routes/inbox.ts 가 기록한다.★
  //   (여기서 기록하면 ★서버가 대신 보낸 것★ 을 '보고 완료' 로 세는 셈이라 거짓이 된다)
  return true;
}

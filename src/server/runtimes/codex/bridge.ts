import { currentCogsAllowlist } from "./cogsAllowlist";
import { handleCogsApprovalCallback } from "../../lib/cogsPermissions/bridgeCallback";
import { createBridgeCogsApprovals } from "../../lib/cogsPermissions/waiters";
import { readPolicy } from "../../lib/cogsPermissions/policy";
import { resolveCogsCodexRun, type CogsCodexRun } from "./cogsRunPolicy";
import { createCogsCodexApprover } from "./cogsApprover";
import { currentCogsStamp } from "../../lib/cogsPermissions/service";
import { sendApprovalCard } from "../../lib/cogsPermissions/card";
import { openDb } from "../../db/migrate";
import { reasoningSummaryOf } from "./reasoningSummary";
import { createReactionInbox, reactionInputs, type ReactionInbox, type ReactionUpdate, type ReactionRef } from "../../lib/reactionInput";
import { randomUUID } from "node:crypto";
import { preserveAnswer } from "./answerText";
import { modelLine } from "../../lib/b3chatModels";
/** 팀원 봇의 수신·리액션·진행표시·채널 발신은 브리지가 담당하고 모델은 답을 생성한다.
 * 채팅별 resume 세션을 보존하며 서버가 넣는 그룹 턴은 명시적 버스 발신 계약을 따른다. */
import { codexBridgePaths } from "./launcher";
import { runCodexTurn, type CodexTurnOptions, type CodexTurnResult } from "./runner";
import {
  attachmentNote, attachmentsOrFailure, decideDmMessage, downloadDmAttachmentsSafe,
  type DmAttachments, type DmMessageMedia,
} from "./dmMedia";
import { createSerialTurnQueue } from "./serialTurnQueue";
import { startBridgeWindow, groupTurnCall } from "./bridgeWindow";
import { makeChatSessionStore, NOOP_DM_SESSION_STORE, type DmSessionStore } from "./dmSessionStore";
import { toMarkdownV2, splitForTelegram, toPlain } from "./telegramMarkdown";
import { assertChannelUsable, channelFromEnv, isGroupChat, type MemberChannel } from "../../lib/memberChannel";
import { captureActiveTurnSteer } from "./activeTurns";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../../lib/registry";
import { appendAuditFile } from "../../lib/auditFile";
import { consumeGroupReply, ensureOutboxDir, groupReplyPath, outboxDir } from "./groupOutbox";
import type { CodexSandboxMode } from "../../types";
import type { PermissionContext } from "../../lib/permissionGate";
import { codexRuntimePreflight, codexConfiguredGrants } from "./permissions";
import { appendLine, renderBubble, fits, EDIT_MIN_INTERVAL_MS, type ProgressLine } from "./progressLines";

import { cogsActivityCode, cogsActivityArgs, cogsActivityLine } from "./cogsActivity";
import { uiText, renderRuntimeEvent } from "./uiStrings";

export interface BridgeDeps {
  /** 이 팀원의 채널(시험 주입). 없으면 런처가 넣은 env(CODEX_CHANNEL_KIND·TELEGRAM_API_BASE)에서 읽는다. */
  channel?: MemberChannel;
  reactionInbox?: ReactionInbox;
  /** codex 한 턴 구동(기본 runCodexTurn — 테스트 mock). */
  runTurn?: (opts: CodexTurnOptions) => Promise<CodexTurnResult>;
  /** 텔레그램 발신 → 보낸 message_id 반환(작업중 메시지 교체용). */
  sendMessage?: (chatId: number, text: string, response?: { state: string; replyTo?: number; activity?: string; activityCode?: string; activityArgs?: Record<string, unknown>; errorCode?: string; idempotencyKey?: string; reactionRef?: ReactionRef }) => Promise<number | null>;
  /** 텔레그램 메시지 편집(작업중 → 답). */
  editMessage?: (chatId: number, messageId: number, text: string, responseState?: string, activity?: string, activityCode?: string, reactionRef?: ReactionRef, activityArgs?: Record<string, unknown>, errorCode?: string) => Promise<boolean>;
  /** 텔레그램 리액션(👀 ack). */
  reactMessage?: (chatId: number, messageId: number, emoji: string) => Promise<boolean>;
  /** 팀원 정체성 격리 루트(CODEX_HOME). */
  codexHome?: string;
  /** 팀원 작업폴더 = AGENTS.md 페르소나 + 스킬 접근(codex가 cwd의 AGENTS.md 로드). */
  workdir?: string;
  /** Codex sandbox mode for this bridge process. Defaults conservatively in runner. */
  sandbox?: CodexSandboxMode;
  /** Codex network access toggle when sandbox is workspace-write. */
  networkAccess?: boolean;
  /** Permission-gate context. Empty means ask-tier actions stay blocked. */
  permissionContext?: PermissionContext;
  /** "작업 중" 표시 문구(기본값 제공). */
  workingText?: string;
  /** agent id used by schedule_reminder tool instructions. */
  agentId?: string;
  /** team-collab base URL, e.g. http://127.0.0.1:7878/team. */
  teamBaseUrl?: string;
  /** team-comm owner-gate 조회(기본 = /api/route). effective 권위값 반환. null=조회실패(fail-open). */
  ownerGate?: (input: { text: string; self: string; tgMessageId: string }) => Promise<{ suppress: boolean; reason?: string; targets?: string[]; source?: string } | null>;
  /** repo root used to locate scripts/schedule-reminder.ts. */
  repoRoot?: string;
  /** true only when the b3os scheduler tool contract is ready to accept jobs. */
  scheduleToolEnabled?: boolean;
  /** Host-side executor for structured schedule requests emitted by the Codex turn. */
  registerScheduleReminder?: (req: ScheduleMarkerRequest, ctx: ScheduleMarkerContext) => Promise<string>;
  /** 1:1 대화 세션을 재시작 넘어 기억한다. 미지정이면 기억하지 않는다(시험 기본값). */
  dmSessions?: DmSessionStore;
  /** cogs 채널 브리지만: 턴마다 정책 원본을 다시 읽어 실행 설정을 정한다. 없으면 지금 동작 그대로. */
  cogsRunFor?: () => CogsCodexRun;
  /** cogs 정책 팀원의 승인 요청 처리(카드). */
  onCogsApproval?: CodexTurnOptions["onCogsApproval"];
}

/** 모든 턴 진입점(1:1·그룹·인사·리액션·일정 요약)이 같은 cogs 실행 설정을 싣는다. */
function cogsTurnOpts(deps: BridgeDeps): Pick<CodexTurnOptions, "cogsRun" | "onCogsApproval"> {
  if (!deps.cogsRunFor) return {};
  let run: CogsCodexRun;
  try { run = deps.cogsRunFor(); } catch (e) { run = { mode: "blocked", reason: `policy_read_failed: ${e instanceof Error ? e.message : e}` }; }
  return { cogsRun: run, ...(deps.onCogsApproval ? { onCogsApproval: deps.onCogsApproval } : {}) };
}

/** 팀원 단위 activeTurns만으로는 대화를 구분할 수 없어 진행 중 chat도 보존한다. 같은 대화만 steer해야 다른 대화의 입력이 섞이지 않는다. */
let runningTurnChatId: number | null = null;

/**
 * 진행 중 작업에 밀어 넣을 문구.
 * 버스 쪽(buildSteerText)과 같은 모양으로 둔다 — 받는 쪽(codex)이 같은 형식을 이미 읽고 있다.
 * "반영해서 계속하라 · 답할 때 이 말에도 답하라" 를 명시 하지 않으면 조용히 무시될 수 있다.
 */
/** 중간 개입도 첨부를 입력 아이템에 전달해야 글자만 모델로 가는 누락을 막는다. 폴 루프 밖 함수로 분리해 이 실사용 경로를 직접 검증한다. */
export async function steerWithAttachments(
  text: string,
  d: {
    fetchAttachments: (() => Promise<DmAttachments>) | null;
    steer: (text: string, imagePaths?: readonly string[]) => Promise<boolean>;
  },
): Promise<boolean> {
  const mid = d.fetchAttachments ? await d.fetchAttachments() : null;
  const note = mid ? attachmentNote(mid) : "";
  const body = note ? `${text}\n\n${note}` : text;
  return d.steer(body, mid?.imagePaths);
}

export function buildDmSteerText(body: string): string {
  return [
    "[중간 메시지 — 팀 리드]",
    body,
    "",
    "이 말을 반영해서 계속하라. 답할 때는 이 메시지에도 답해라.",
  ].join("\n");
}

/** Steer accepted inputs silently; start a receipt only for a new queued turn. */
export interface IncomingRouteDeps {
  isRunning: (chatId: number) => boolean;
  steer: (text: string) => Promise<boolean>;
  enqueue: (run: () => Promise<void>) => void;
  runTurnFor: () => Promise<void>;
  receive?: () => Promise<number | null>;
  steerText?: (text: string) => string;
  captureSteer?: () => ((text: string) => Promise<boolean>) | null;
}

export type IncomingRoute = "steered" | "newTurn";

export async function routeIncoming(
  chatId: number,
  text: string,
  d: IncomingRouteDeps,
): Promise<IncomingRoute> {
  if (d.isRunning(chatId)) {
    // 던져도 말을 잃지 않는다 — 연결이 끊기면 steer 는 성공/실패가 아니라 예외로 끝난다.
    //   그때 그냥 올려보내면 이 말은 새 작업으로도 안 가고 사라진다.
    const steer = d.captureSteer ? d.captureSteer() : d.steer;
    const injected = steer && await steer((d.steerText ?? buildDmSteerText)(text)).catch((e) => {
      console.warn(`[codex-bridge] 전달 중 오류 → 새 작업으로: ${String(e)}`);
      return false;
    });
    if (injected) {
      return "steered";
    }
    // 번호가 아직 없어 못 넣었다 — 여기서 멈추면 그 말은 아무 데도 안 간다.
  }
  // Start immediately after routing, before a blocked serial queue can delay the receipt.
  d.receive?.();
  d.enqueue(d.runTurnFor);
  return "newTurn";
}

/** Capture the destination before delays, then recheck the conversation at actual send. */
export function captureConversationSteer(chatId: number, d: {
  isRunning: (chatId: number) => boolean;
  captureSend: () => ((text: string, imagePaths?: readonly string[]) => Promise<boolean>) | null;
  inbox: ReactionInbox;
  fetchAttachments?: (() => Promise<DmAttachments>) | null;
}): ((text: string) => Promise<boolean>) | null {
  const send = d.captureSend();
  if (!send) return null;
  return text => steerWithAttachments(text, {
    fetchAttachments: d.fetchAttachments ?? null,
    steer: (body, images) => d.inbox.steer(chatId, body,
      text => d.isRunning(chatId) ? send(text, images) : Promise.resolve(false)),
  });
}

/** Reactions use the existing serial queue/steer path without a receipt bubble. */
export async function routeReactionUpdate(
  updateId: number, reaction: ReactionUpdate,
  d: { channel: MemberChannel; allowFrom: Set<number>; ownBotId?: number; inbox: ReactionInbox; route: Omit<IncomingRouteDeps, "runTurnFor">; runTurn: (input: string, reactionRef?: ReactionRef) => Promise<void> },
): Promise<IncomingRoute | null> {
  if (d.channel.kind !== "b3chat" || !isAllowedChat(d.allowFrom, reaction.chat.id)) return null;
  const input = d.inbox.accept(updateId, reaction, d.ownBotId);
  if (!input) return null;
  const ref = reactionInputs(reaction, reaction.cogs_message_text!, reaction.cogs_reactor_is_master!)
    .filter(row => row.wake).at(-1)?.ref;
  return routeIncoming(reaction.chat.id, input, {
    ...d.route,
    runTurnFor: () => d.runTurn(input, ref),
    receive: undefined,
    steerText: text => text,
    captureSteer: () => {
      const response = d.inbox.captureResponse(reaction.chat.id);
      const steer = captureConversationSteer(reaction.chat.id, {
        isRunning: d.route.isRunning,
        captureSend: () => d.route.captureSteer ? d.route.captureSteer() : d.route.steer,
        inbox: d.inbox,
      });
      return steer ? async text => {
        const sent = await steer(text);
        if (sent && response) response.ref = ref;
        return sent;
      } : null;
    },
  });
}

export function bridgeUpdatesUrl(apiBase: string, token: string, offset: number): string {
  return `${apiBase}/bot${token}/getUpdates?timeout=30&offset=${offset}&allowed_updates=["message","callback_query","message_reaction"]`;
}

/** 시험·진단용 — 지금 그 대화의 턴이 도는 중인가. */
export function isTurnRunningFor(chatId: number): boolean {
  return runningTurnChatId === chatId;
}

// 채팅별 codex thread(resume sessionId) → 같은 대화 맥락 유지.
const chatThreads = new Map<number, string>();
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DEFAULT_AGENT_REGISTRY = resolve(REPO_ROOT, "agents.json");

// 첫 접촉(영입 후 첫 인사) 판정을 영속 마커로 한다.
//   과거엔 인메모리 chatThreads(세션 캐시)가 비면 "첫 접촉"으로 봤는데, 이 캐시는 서버 재시작마다
//   날아가서 이미 합류한 팀원(devon·lui…)이 재시작 후 첫 wake마다 신입처럼 영입인사를 반복했다.
//   마커(파일)는 재시작·새 스레드에도 남으므로 "여태 한 번이라도 인사했나"를 정확히 판정한다.
//   env override = 테스트 격리(라이브 var/ 안 건드림). 재영입 시 워크스페이스 정리로 마커도 사라져 재인사=의도대로.
function firstContactMarker(agentId: string): string {
  const dir = process.env.B3OS_FIRST_CONTACT_DIR ?? resolve(REPO_ROOT, "var/first-contact");
  return resolve(dir, `${agentId}.done`);
}
export function hasGreetedFirstContact(agentId: string): boolean {
  try { return existsSync(firstContactMarker(agentId)); } catch { return false; }
}
/** 첫 인사를 했다고 남긴다 — 앱 [팀원 추가] 가 첫 인사를 먼저 보낸 뒤에도 쓴다(첫 글에 다시 소개하지 않게). */
export function markGreetedFirstContact(agentId: string): void {
  try {
    const p = firstContactMarker(agentId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "greeted\n");
  } catch { /* best-effort — 실패해도 대화는 진행 */ }
}

export const DEFAULT_WORKING_TEXT = uiText("working");
export const SCHEDULE_UNSUPPORTED_TEXT =
  uiText("schedule_unsupported");
export const SCHEDULE_MARKER = "B3OS_SCHEDULE_REMINDER_REQUEST";

export interface ScheduleMarkerRequest {
  body: string;
  delay_seconds?: number;
  run_at?: string;
  title?: string;
  direct_to_gd?: boolean;
}

export interface ScheduleMarkerContext {
  agentId: string;
  teamBaseUrl: string;
  repoRoot?: string;
}

const DELAY_TIME_PATTERNS = [
  /\d+\s*(초|분|시간|일)\s*(뒤|후)/u,
  /\b\d+\s*(seconds?|minutes?|mins?|hours?|days?)\s*(later|from now)\b/i,
  /\bin\s+\d+\s*(seconds?|minutes?|mins?|hours?|days?)\b/i,
  /\b(tomorrow|tonight|next\s+\w+|at\s+\d{1,2}(:\d{2})?\s*(am|pm)?)\b/i,
  /(내일|모레|오늘\s*밤|오늘\s*오후|오늘\s*저녁|다음\s*(주|달)|[오전후]{2}\s*\d{1,2}시|\d{1,2}시\s*\d{0,2}분?)/u,
];

const DELAY_ACTION_PATTERNS = [
  /(메시지|알림|리마인드|상기|깨워|보내|말해|알려)/u,
  /\b(remind|reminder|message|notify|ping|send|tell)\b/i,
];

export function isOneShotScheduleRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return DELAY_TIME_PATTERNS.some((re) => re.test(normalized)) && DELAY_ACTION_PATTERNS.some((re) => re.test(normalized));
}

export function bridgeRuntimeConfigForAgent(input: {
  agentId?: string | null;
  registryPath?: string | null;
}): Pick<BridgeDeps, "sandbox" | "networkAccess"> {
  const agentId = input.agentId?.trim();
  if (!agentId) return {};
  try {
    const registryPath = input.registryPath?.trim() || DEFAULT_AGENT_REGISTRY;
    const agent = loadRegistry(registryPath).find((a) => a.id === agentId);
    if (!agent) return {};
    return {
      ...(agent.codex_sandbox ? { sandbox: agent.codex_sandbox } : {}),
      ...(agent.codex_network_access !== null && agent.codex_network_access !== undefined
        ? { networkAccess: agent.codex_network_access }
        : {}),
    };
  } catch (e) {
    console.warn(`[codex-bridge] agent registry runtime config load failed: ${e instanceof Error ? e.message : e}`);
    return {};
  }
}

function unitToSeconds(unit: string): number | null {
  if (/^(초|seconds?|secs?)$/i.test(unit)) return 1;
  if (/^(분|minutes?|mins?)$/i.test(unit)) return 60;
  if (/^(시간|hours?)$/i.test(unit)) return 60 * 60;
  if (/^(일|days?)$/i.test(unit)) return 60 * 60 * 24;
  return null;
}

function relativeDelaySeconds(text: string): number | null {
  const normalized = text.trim();
  const ko = normalized.match(/(\d+)\s*(초|분|시간|일)\s*(뒤|후)/u);
  if (ko) {
    const unit = unitToSeconds(ko[2] ?? "");
    const n = Number(ko[1]);
    return unit && Number.isFinite(n) && n > 0 ? n * unit : null;
  }
  const en = normalized.match(/\b(?:in\s+)?(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|days?)\s*(?:later|from now)?\b/i);
  if (en) {
    const unit = unitToSeconds(en[2] ?? "");
    const n = Number(en[1]);
    return unit && Number.isFinite(n) && n > 0 ? n * unit : null;
  }
  return null;
}

export function buildDirectScheduleRequest(text: string): ScheduleMarkerRequest | null {
  const delaySeconds = relativeDelaySeconds(text);
  if (!delaySeconds) return null;
  const body = text.trim();
  return {
    body: body.startsWith("[예약 알림]") ? body : `[예약 알림] ${body}`,
    delay_seconds: delaySeconds,
    title: body.slice(0, 80) || "one-shot reminder",
    direct_to_gd: true,
  };
}

function scheduleToolEnabled(deps: BridgeDeps): boolean {
  return deps.scheduleToolEnabled ?? process.env.CODEX_SCHEDULE_TOOL_ENABLED === "true";
}

function scheduleToolPrompt(input: { text: string; agentId: string; teamBaseUrl: string; repoRoot: string }): string {
  return [
    "[b3os schedule_reminder tool]",
    "The user is asking for delayed work. Do not sleep, wait, or keep this turn open.",
    "If this is truly a one-shot reminder/scheduled message, register it through the b3os schedule_reminder tool and then reply with the human-readable reservation summary.",
    "The tool sends x-actor-id from --created-by and uses OP_MESSAGE_TOKEN from the environment when available; do not invent another created_by.",
    "Command contract:",
    `bun run ${input.repoRoot}/scripts/schedule-reminder.ts --base-url ${input.teamBaseUrl} --agent ${input.agentId} --created-by ${input.agentId} --body "<reminder body>" (--delay-seconds <seconds> | --run-at <iso>) --direct-to-gd`,
    "If the command/API fails because the sandbox cannot reach localhost, do not wait. Instead reply with exactly one structured fallback line:",
    `${SCHEDULE_MARKER} {"body":"<reminder body>","delay_seconds":300,"title":"<short title>","direct_to_gd":true}`,
    "If the command/API fails for any other reason, say the scheduler is not available and do not claim the reminder was scheduled.",
    "",
    "[User message]",
    input.text,
  ].join("\n");
}

export function extractScheduleMarker(reply: string): ScheduleMarkerRequest | null {
  const line = reply
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(SCHEDULE_MARKER));
  if (!line) return null;
  const raw = line.slice(SCHEDULE_MARKER.length).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ScheduleMarkerRequest>;
    const hasDelay = typeof parsed.delay_seconds === "number" && Number.isFinite(parsed.delay_seconds) && parsed.delay_seconds > 0;
    const hasRunAt = typeof parsed.run_at === "string" && parsed.run_at.trim() !== "";
    if (typeof parsed.body !== "string" || !parsed.body.trim()) return null;
    if (hasDelay === hasRunAt) return null;
    return {
      body: parsed.body,
      ...(hasDelay ? { delay_seconds: Math.floor(parsed.delay_seconds!) } : { run_at: parsed.run_at }),
      ...(typeof parsed.title === "string" && parsed.title.trim() ? { title: parsed.title } : {}),
      direct_to_gd: parsed.direct_to_gd !== false,
    };
  } catch {
    return null;
  }
}

export async function registerScheduleMarker(
  req: ScheduleMarkerRequest,
  ctx: ScheduleMarkerContext,
): Promise<string> {
  return runScheduleReminderCli(req, ctx);
}

export async function runScheduleReminderCli(
  req: ScheduleMarkerRequest,
  ctx: ScheduleMarkerContext,
): Promise<string> {
  const repoRoot = ctx.repoRoot ?? process.env.B3OS_REPO_ROOT ?? REPO_ROOT;
  const args = [
    "run",
    `${repoRoot}/scripts/schedule-reminder.ts`,
    "--base-url",
    ctx.teamBaseUrl,
    "--agent",
    ctx.agentId,
    "--created-by",
    ctx.agentId,
    "--body",
    req.body,
    ...(req.run_at ? ["--run-at", req.run_at] : ["--delay-seconds", String(req.delay_seconds)]),
    ...(req.title ? ["--title", req.title] : []),
    ...(req.direct_to_gd !== false ? ["--direct-to-gd"] : []),
  ];
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const proc = spawn(process.env.BUN_BIN ?? "bun", args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => resolve({ code: null, stdout, stderr: e.message }));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code === 0 && result.stdout.trim()) {
    try { return JSON.stringify({ code: "schedule_registered", result: JSON.parse(result.stdout) }); }
    catch { return JSON.stringify({ code: "schedule_registered", result: result.stdout.trim() }); }
  }
  let error = "unknown";
  try {
    const parsed = JSON.parse(result.stderr || result.stdout || "{}") as { error?: unknown; status?: unknown };
    error = typeof parsed.error === "string" ? parsed.error : typeof parsed.status === "number" ? `status_${parsed.status}` : error;
  } catch {
    error = (result.stderr || result.stdout || error).trim().slice(0, 200);
  }
  return JSON.stringify({ code: "schedule_failed", error_code: error || "unknown" });
}

export async function registerScheduleMarkerViaApi(
  req: ScheduleMarkerRequest,
  ctx: ScheduleMarkerContext,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-actor-id": ctx.agentId,
  };
  if (process.env.OP_MESSAGE_TOKEN) headers["x-op-token"] = process.env.OP_MESSAGE_TOKEN;
  const res = await fetch(`${ctx.teamBaseUrl}/api/schedules/reminder`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      target_agent_id: ctx.agentId,
      body: req.body,
      ...(req.run_at ? { run_at: req.run_at } : { delay_seconds: req.delay_seconds }),
      created_by: ctx.agentId,
      ...(req.title ? { title: req.title } : {}),
      direct_to_gd: req.direct_to_gd !== false,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !json.ok || !json.job) {
    return JSON.stringify({ code: "schedule_failed", status: res.status, error_code: typeof json.error === "string" ? json.error : "unknown" });
  }
  return JSON.stringify({ code: "schedule_registered", job: json.job });
}

// 그룹 담당자 판정은 /api/route를 조회하고 브리지가 재판정하지 않는다. 오류·캡처 경합은 정상 입력 유실을 막기 위해 fail-open으로 둔다.
async function fetchOwnerGate(
  teamBaseUrl: string,
  input: { text: string; self: string; tgMessageId: string },
): Promise<{ suppress: boolean; reason?: string; targets?: string[]; source?: string } | null> {
  try {
    const res = await fetch(`${teamBaseUrl}/api/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: input.text, self: input.self, tgMessageId: input.tgMessageId }),
    });
    if (!res.ok) return null;
    // effective* = suppress 판단에 실제 쓰인 권위값(Codex F2). 없으면 원래 decision 필드로 폴백(호환).
    const j = (await res.json()) as {
      suppress?: boolean; reason?: string; targetAgentIds?: string[];
      effectiveReason?: string; effectiveTargets?: string[]; authoritySource?: string;
    };
    return {
      suppress: !!j.suppress,
      reason: j.effectiveReason ?? j.reason,
      targets: j.effectiveTargets ?? j.targetAgentIds,
      source: j.authoritySource,
    };
  } catch {
    return null; // 조회 실패 = 억제 안 함(fail-open)
  }
}

/** 그룹 턴은 직접 채널 발신을 끄고 팀원의 명시적 버스 발신을 사용해 기록과 전달을 맞춘다.
 * 발신 여부 ok 대신 실행 여부 turnOk로 판정하고, 반환 실패·예외는 경고 리액션으로 드러내되 대신 답을 게시하지 않는다. */
export async function runGroupTurn(ctx: {
  deps: BridgeDeps;
  agentId: string;
  repoRoot: string;
  chatId: number;
  tgMsgId: number | undefined;
  req: { body: string; threadId: string; messageId: string };
  run?: typeof handleMessage;
  audit?: (action: string, target: string, detail: Record<string, unknown>) => void;
  /** 답 파일을 읽고 지우는 것 · 버스로 운반하는 것. 시험에서 갈아 끼운다. */
  consume?: typeof consumeGroupReply;
  deliver?: (a: { agentId: string; text: string; threadId: string; messageId: string })
    => Promise<{ ok: boolean; detail: string }>;
  replyPath?: string;
}): Promise<void> {
  const { deps, chatId, tgMsgId, req } = ctx;
  const run = ctx.run ?? handleMessage;
  const audit = ctx.audit ?? ((a, t, d) => appendAuditFile("codex_bridge", a, t, d));
  const consume = ctx.consume ?? consumeGroupReply;
  const deliver = ctx.deliver ?? deliverGroupReply;
  const replyPath = ctx.replyPath ?? groupReplyPath(ctx.repoRoot, ctx.agentId);
  // 자리를 못 만들면 턴을 돌리지 않는다 — 돌려봐야 답을 받을 데가 없고,
  //   그 실패는 "답 안 함" 과 구분이 안 되는 모양으로 기록된다.
  const prep = ensureOutboxDir(replyPath);
  const warn = () => {
    if (tgMsgId !== undefined && Number.isFinite(tgMsgId)) void deps.reactMessage?.(chatId, tgMsgId, "⚠️");
  };
  if (!prep.ok) {
    warn();
    audit("turn_completed_no_autopost", req.messageId, {
      agent_id: ctx.agentId, thread_id: req.threadId, turn_ok: false, chars: 0,
      replied: false, delivered: false, detail: `outbox_unavailable:${prep.detail}`,
    });
    return;
  }
  // 한 번만 부른다 — 발신을 떼는 것과 답 보내는 명령을 넣는 것은 한 쌍이다.
  const call = groupTurnCall(deps, {
    body: req.body,
    threadId: req.threadId,
    messageId: req.messageId,
    replyPath,
  });
  let res: Awaited<ReturnType<typeof handleMessage>>;
  try {
    res = await run(chatId, call.body, tgMsgId, call.deps, undefined, "window");
  } catch (e) {
    warn();
    // 던져도 자리를 비운다 — 안 지우면 다음 턴이 이번 답을 자기 답으로 읽는다.
    consume(replyPath, outboxDir(ctx.repoRoot, ctx.agentId));
    audit("turn_completed_no_autopost", req.messageId, {
      agent_id: ctx.agentId, thread_id: req.threadId, turn_ok: false, chars: 0, replied: false,
      detail: `threw:${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`,
    });
    return;
  }
  // 답은 턴의 stdout 이 아니라 팀원이 쓴 파일에서 온다. 안 썼으면 안 보낸다.
  const out = consume(replyPath, outboxDir(ctx.repoRoot, ctx.agentId));
  let delivered = false;
  let deliverDetail = "";
  if (out.kind === "reply") {
    try {
      const d = await deliver({
        agentId: ctx.agentId, text: out.text, threadId: req.threadId, messageId: req.messageId,
      });
      delivered = d.ok;
      if (!d.ok) deliverDetail = `deliver_failed:${d.detail}`;
    } catch (e) {
      deliverDetail = `deliver_threw:${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`;
    }
  } else if (out.kind === "rejected") {
    deliverDetail = `reply_rejected:${out.reason}`;
  }
  const replyChars = out.kind === "reply" ? out.text.length : 0;
  console.log(
    `[codex-bridge] 창구 턴 완료 → ${res.detail} · 답파일 ${out.kind}${replyChars ? ` ${replyChars}자` : ""}` +
      `${out.kind === "reply" ? ` · 운반 ${delivered ? "성공" : "실패"}` : ""}`,
  );
  audit("turn_completed_no_autopost", req.messageId, {
    agent_id: ctx.agentId, thread_id: req.threadId, turn_ok: res.turnOk, chars: replyChars,
    // "턴이 됐나" 와 "답을 했나" 와 "운반됐나" 는 서로 다른 값이다 — 한 칸에 뭉치면 판정이 거짓이 된다.
    //   턴이 성공했는데 답 파일이 없는 것은 고장이 아니라 "답 안 함" 이다(오너가 아니었을 수 있다).
    replied: out.kind === "reply",
    delivered,
    // send_failed 는 이 경로의 기대값이다 — 텔레그램 발신을 뗐으므로. 실패 사유로 적으면 전부 거짓값이 된다.
    detail: !res.turnOk ? res.detail : deliverDetail || (out.kind === "reply" ? "turn_ok" : `no_reply:${out.kind}`),
  });
  // 경고는 "고장" 에만 붙인다 — 답을 안 한 것은 고장이 아니다. 운반 실패는 고장이다.
  if (!res.turnOk || deliverDetail) warn();
}

/** 브리지는 팀원 작업폴더·tmux 밖에서 실행될 수 있어 send.sh의 발신자 추측에 의존하지 않고 알고 있는 from_agent_id로 HTTP에 직접 넣는다.
 * 셸을 거치지 않아 본문의 따옴표·백틱·$가 명령으로 해석되지 않는다. */
async function deliverGroupReply(a: {
  agentId: string; text: string; threadId: string; messageId: string;
}): Promise<{ ok: boolean; detail: string }> {
  const base = process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7878/team";
  try {
    const res = await fetch(`${base}/api/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from_agent_id: a.agentId,
        to_agent_id: "broadcast",
        body: a.text,
        type: "dm",
        priority: "normal",
        source: "agent",
        thread_id: a.threadId,
        in_reply_to: a.messageId,
      }),
    });
    // 사유를 버리지 않는다 — 버리면 다음 실패도 "운반 실패" 넉 자로만 남아 같은 조사를 반복한다.
    if (res.ok) return { ok: true, detail: "" };
    return { ok: false, detail: `http ${res.status}: ${(await res.text()).slice(0, 160)}` };
  } catch (e) {
    return { ok: false, detail: `fetch: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}` };
  }
}

/**
 * 텔레그램 메시지 1건 처리(순수 로직 — 토큰 불필요, mock 테스트 가능).
 * 흐름: 👀 리액션 → "작업 중…" 게시 → codex 턴 → 작업중 메시지를 답으로 교체(편집 실패 시 신규 발신).
 */

// A response context belongs to one running turn; queued turns capture their own
// initial reaction, and successful steers can update only the captured context.
export async function handleMessage(
  chatId: number, text: string, messageId: number | undefined, deps: BridgeDeps = {},
  fetchAttachments?: () => Promise<DmAttachments>, ingress: "poll" | "window" = "poll",
  isGroup?: boolean, receipt?: Promise<number | null>, reactionRef?: ReactionRef,
): Promise<{ ok: boolean; turnOk: boolean; reply: string; detail: string }> {
  if ((deps.channel ?? channelFromEnv()).kind !== "b3chat") {
    return handleMessageTurn(chatId, text, messageId, deps, fetchAttachments, ingress, isGroup, receipt);
  }
  const lease = deps.reactionInbox?.beginResponse(chatId, reactionRef);
  const context = lease?.context ?? { ref: reactionRef };
  const wrapped: BridgeDeps = {
    ...deps,
    sendMessage: (chat, text, response) => deps.sendMessage?.(chat, text,
      context.ref ? { ...response, state: response?.state ?? "complete", reactionRef: context.ref } : response) ?? Promise.resolve(null),
    editMessage: (chat, id, text, state, activity, code, ref, args, errorCode) => deps.editMessage?.(chat, id, text, state, activity, code, context.ref ?? ref, args, errorCode) ?? Promise.resolve(false),
  };
  try {
    return await handleMessageTurn(chatId, text, messageId, wrapped, fetchAttachments, ingress, isGroup, receipt, reactionRef !== undefined);
  } finally { lease?.close(); }
}

async function handleMessageTurn(
  chatId: number,
  text: string,
  messageId: number | undefined,
  deps: BridgeDeps = {},
  /** 첨부는 폴 루프가 아닌 턴 안에서 내려받아 다음 업데이트·콜백 수신을 막지 않는다. 함수 주입으로 시험 통신을 격리한다. */
  fetchAttachments?: () => Promise<DmAttachments>,
  /** 그룹 native 차단은 담당자 판정이 없는 폴링 입구에만 적용한다. 서버가 이미 담당자를 정해 넣은 window 입구에는 적용하지 않는다. */
  ingress: "poll" | "window" = "poll",
  /** 그룹 여부는 chat.type으로 전달한다. b3chat 그룹 ID는 양수일 수 있어 음수 판정만으로는 부족하며 미지정 때만 기존 판정을 쓴다. */
  isGroup?: boolean,
  receipt?: Promise<number | null>,
  reactionOnly = false,
): Promise<{ ok: boolean; turnOk: boolean; reply: string; detail: string }> {
  // 직접 대화도 버스와 같은 app-server를 사용해 steer·프로세스 상주·서브에이전트 생존을 유지한다. 현재 never 정책은 승인창을 만들지 않는다.
  const runTurn = deps.runTurn ?? defaultBridgeCaller();
  const registerReminder = deps.registerScheduleReminder ?? registerScheduleMarker;
  const send = deps.sendMessage ?? (async () => null);
  const edit = deps.editMessage ?? (async () => false);
  const react = deps.reactMessage ?? (async () => false);
  const workingText = deps.workingText ?? DEFAULT_WORKING_TEXT;

  // 폴링 그룹 native 처리를 막아 capture→bus의 담당자 주입과 이중응답하지 않게 한다. gate 조회는 shadow 감사용이다.
  // 브리지의 팀원 신원은 한 곳에서 결정해 승인 요청 주인도 다른 팀원으로 기록되지 않게 한다.
  const selfAgentId = deps.agentId ?? process.env.CODEX_AGENT_ID ?? "codex";

  // b3chat 팀원은 이 차단을 지나지 않는다 — b3chat 서버가 이미 멘션·답장·1:1 만 골라 보내고,
  //   그룹을 capture→bus 로 넘기는 길이 아직 없다(텔레그램 capture 는 텔레그램 그룹만 본다).
  //   막으면 그 팀원은 그룹에서 영영 말을 못 듣는다.
  const channel = deps.channel ?? channelFromEnv();
  const isCogs = channel.kind === "b3chat";
  const group = isGroup ?? chatId < 0;
  if (ingress === "poll" && group && channel.kind !== "b3chat" && messageId !== undefined) {
    const shadowOn = process.env.CODEX_GROUP_NATIVE_DENY_SHADOW === "true";
    // 그룹 native 차단은 기본 ON이며 명시적 false로만 끈다. 담당자는 capture→bus가 정하므로 별도 native 응답은 다른 팀원의 호출에도 반응할 수 있다.
    const enforceOn = (process.env.CODEX_GROUP_NATIVE_DENY ?? "true") !== "false";
    if (shadowOn || enforceOn) {
      const self = selfAgentId;
      const teamBaseUrl = deps.teamBaseUrl ?? process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7878/team";
      const gate = deps.ownerGate
        ? await deps.ownerGate({ text, self, tgMessageId: String(messageId) })
        : await fetchOwnerGate(teamBaseUrl, { text, self, tgMessageId: String(messageId) });
      const auditFields = {
        self, chat_id: chatId,
        authority_reason: gate?.reason ?? null,
        authority_targets: gate?.targets ?? null,
        authority_source: gate?.source ?? null,
        gate_suppress: gate?.suppress ?? null,
      };
      if (enforceOn) {
        // 그룹 native 전체 drop (react/runTurn 전 → 👀도 안 찍힘). DM/health 무관(chatId<0 only).
        appendAuditFile("codex_bridge", "group_native_denied", String(messageId), auditFields);
        return { ok: true, turnOk: true, reply: "", detail: "group_native_denied" };
      }
      // shadow: drop 없이 effective authority audit만 (24h 3자비교로 capture 커버 검증).
      appendAuditFile("codex_bridge", "group_native_shadow", String(messageId), { ...auditFields, shadow: true });
      // continue (delivered)
    }
  }

  // Telegram keeps its receipt reaction; cogs uses server-managed read receipts.
  if (!isCogs && messageId !== undefined) void react(chatId, messageId, "👀");

  const scheduleRequest = isOneShotScheduleRequest(text);

  // 단발 리마인더는 예약 도구로 등록하고 꺼져 있으면 조기 안내해 현재 턴의 sleep이 폴링을 막지 않게 한다.
  // 키워드는 도구 안내 힌트로만 사용한다. 불평·질문까지 예약되지 않도록 실제 등록은 LLM이 예약 의도를 판단해 마커를 낸 경우로 제한한다.


  const workingMsgId = reactionOnly ? null : receipt ? await receipt : await send(chatId, isCogs ? "" : workingText, isCogs ? { state: "waiting", replyTo: messageId } : undefined);

  // 메모리의 대화 지도가 재시작으로 비면 영속 세션을 조회해 1:1 맥락을 이어받는다.
  const sessions = deps.dmSessions ?? NOOP_DM_SESSION_STORE;
  let prior = chatThreads.get(chatId);
  if (prior === undefined) {
    prior = sessions.get(chatId);
    if (prior !== undefined) chatThreads.set(chatId, prior); // 다음 턴부터는 메모리에서 바로
  }
  const reactionClaim = deps.reactionInbox?.claim(chatId, text);
  text = reactionClaim?.text ?? text;
  const toolAwareText = scheduleRequest && !scheduleToolEnabled(deps)
    ? `[Tool availability: schedule_reminder unavailable. Do not wait, sleep, or claim a reservation was created.]\n${text}`
    : scheduleRequest
    ? scheduleToolPrompt({
        text,
        agentId: selfAgentId,
        teamBaseUrl: deps.teamBaseUrl ?? process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7878/team",
        repoRoot: deps.repoRoot ?? process.env.B3OS_REPO_ROOT ?? REPO_ROOT,
      })
    : text;
  // 첫 접촉(여태 한 번도 인사 안 한 신입) = 영입 후 첫 응답 → 인사 + OT 받은 것 언급하며 시작.
  //   판정은 영속 마커(재시작에도 남음) — 인메모리 prior(세션 resume용)와 분리해, 이미 합류한 팀원이
  // 재시작 후 재소개하지 않게 한다. prior는 아래 resumeSessionId 로만 쓴다.
  const greetAgentId = selfAgentId;
  const greetedBefore = reactionOnly || hasGreetedFirstContact(greetAgentId);
  const promptText = greetedBefore
    ? toolAwareText
    : `[이번이 이 대화의 첫 응답입니다. 먼저 짧게 인사하고, OT(팀 미션·규칙·역할·팀 스킬)를 받아 팀에 합류했음을 한 줄로 밝힌 뒤 본론에 답하세요.]\n\n${toolAwareText}`;
  // 진행 표시 뒤 첨부를 내려받고 실패도 본문에 알려 조용히 누락하지 않는다.
  // 새 턴·중간 개입은 attachmentsOrFailure 정의를 공유하되 주입 함수가 예외를 던지는 경우도 같은 실패 표현으로 처리한다.
  const attachments: DmAttachments | null = fetchAttachments ? await attachmentsOrFailure(fetchAttachments) : null;
  const note = attachments ? attachmentNote(attachments) : "";
  const promptWithMedia = note ? `${promptText}\n\n${note}` : promptText;

  const preflight = codexRuntimePreflight(
    {
      id: selfAgentId,
      workspace_path: deps.workdir ?? process.env.CODEX_WORKDIR ?? "",
    },
    deps.sandbox ?? "read-only",
    deps.networkAccess,
    deps.permissionContext,
  );
  if (preflight) {
    reactionClaim?.rollback();
    const errText = isCogs ? "" : toMarkdownV2(uiText("permission_denied"));
    if (workingMsgId !== null) await edit(chatId, workingMsgId, errText, isCogs ? "error" : undefined, undefined, undefined, undefined, undefined, "permission_required");
    else await send(chatId, errText, isCogs ? { state: "error", errorCode: "permission_required", replyTo: messageId } : undefined);
    return { ok: false, turnOk: false, reply: "", detail: `permission_${preflight.tier}:${preflight.rule}` };
  }
  // 창 없는 런타임의 도구 진행을 버블에 누적한다. 편집은 깜빡임과 채널 제한 여유를 위해 2초 간격으로 모아 처리한다.
  let bubbleId = workingMsgId;          // 지금 고쳐 쓰는 메시지
  let lines: ProgressLine[] = [];       // 그 메시지에 담긴 줄
  let lastEditAt = 0;                   // 마지막 편집 시각
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editing = false;                  // 편집 진행 중이면 다음 것을 겹쳐 치지 않는다
  let dirty = false;                    // 아직 화면에 안 나간 줄이 있나
  let inFlightEdit: Promise<void> | null = null; // 지금 날아가 있는 편집(답을 쓰기 전에 기다린다)

  let cogsActivity = "";
  let activityCode: string | undefined;
  let activityArgs: Record<string, unknown> | undefined;
  let cogsBody = "";
  let cogsState = "waiting";
  const flush = async (): Promise<void> => {
    if (editing || !dirty || bubbleId === null) return;
    editing = true;
    dirty = false;
    lastEditAt = Date.now();
    // MarkdownV2 로 보낼 것이면 여기서 이스케이프한다.
    //   진행 버블은 `renderBubble` 이 만든 순수 텍스트 인데 그대로 parse_mode=MarkdownV2 로 나갔다.
    //   그래서 `-`·`.` 같은 예약문자가 있는 줄마다 400 이 났고(실측 156건: `-` 49 · `.` 2 …),
    //   매번 평문으로 재전송해서 같은 편집을 두 번씩 했다. 화면은 멀쩡했지만 호출이 2배였다.
    //   최종 답은 이미 `toMarkdownV2` 를 타고 있었다(:769) — 버블만 빠져 있었다.
    const text = toMarkdownV2(isCogs ? cogsBody : renderBubble(headLine, lines));
    const responseState = isCogs ? cogsState : undefined;
    const activity = isCogs ? cogsActivity : undefined;
    const work = (async () => {
      const ok = await edit(chatId, bubbleId as number, text, responseState, undefined, activityCode, undefined, activityArgs);
      if (!ok) {
        // 편집이 안 되면 그 버블은 그대로 두고 새 버블을 연다. 이미 보낸 줄을 지우지 않는다.
        const fresh = await send(chatId, text, isCogs ? { state: responseState!, replyTo: messageId, activityCode, activityArgs } : undefined);
        if (fresh !== null) bubbleId = fresh;
        else bubbleId = null; // 보내기까지 막히면 진행 표시를 포기한다(턴은 계속 간다)
      }
    })();
    inFlightEdit = work;
    try {
      await work;
    } finally {
      inFlightEdit = null;
      editing = false;
    }
    // 편집 중에 들어온 줄은 여기서 다시 예약한다. 안 하면 타이머는 이미 소진돼 있어
    //   뒤에 줄이 더 오지 않는 한 마지막 줄이 화면에 영영 안 나간다.
    if (dirty) schedule();
  };

  const schedule = (): void => {
    if (editTimer !== null || bubbleId === null) return;
    if (isCogs && lastEditAt === 0) { void flush(); return; }
    const wait = Math.max(0, (isCogs ? 400 : EDIT_MIN_INTERVAL_MS) - (Date.now() - lastEditAt));
    editTimer = setTimeout(() => {
      editTimer = null;
      void flush();
    }, wait);
  };

  // 상태는 한 자리에서 교체된다 — 쌓지 않는다. 실제 작업만 아래에 쌓인다.
  let headLine = isCogs ? "" : workingText;
  let lastReasoningSummary = "";
  const onStatus = (line: string, item?: unknown): void => {
    if (bubbleId === null) return;
    if (isCogs) {
      const head = reasoningSummaryOf(item);
      const target = Array.from(head).slice(0, 60).join("");
      if (!target || target === lastReasoningSummary) return;
      lastReasoningSummary = target;
      activityCode = "thinking";
      activityArgs = { target };
      cogsState = cogsBody ? "streaming" : "activity";
      dirty = true;
      schedule();
      return;
    }
    if (line === headLine) return;
    headLine = renderRuntimeEvent(line);
    dirty = true;
    schedule();
  };

  const onActivity = (line: string, itemId?: string, item?: unknown): void => {
    if (bubbleId === null) return;
    if (isCogs) {
      const code = cogsActivityCode(item);
      if (!code) return;
      activityCode = code;
      activityArgs = cogsActivityArgs(item);
      cogsState = cogsBody ? "streaming" : "activity";
      dirty = true;
      schedule();
      return;
    }
    const displayLine = item ? cogsActivityLine(item) : renderRuntimeEvent(line);
    const next = appendLine(lines, displayLine, undefined, itemId);
    if (next === lines) return; // 빈 줄이라 담을 것이 없다
    if (!fits(headLine, next)) {
      // 한도에 닿으면 지금 버블은 남기고 새 버블로 넘어간다 — 어디까지 했는지가 사라지지 않는다.
      lines = appendLine([], displayLine);
      dirty = true;
      void (async () => {
        const fresh = await send(chatId, toMarkdownV2(renderBubble(headLine, lines)));
        if (fresh !== null) { bubbleId = fresh; dirty = false; lastEditAt = Date.now(); }
      })();
      return;
    }
    lines = next;
    dirty = true;
    schedule();
  };

  const onDelta = isCogs ? (text: string): void => {
    if (!text || (bubbleId === null && !reactionOnly) || scheduleRequest && scheduleToolEnabled(deps)) return;
    cogsBody = Array.from(cogsBody + text).slice(0, 4096).join("");
    cogsState = "streaming";
    dirty = true;
    schedule();
  } : undefined;

  const onAnswerText = isCogs ? (text: string): void => {
    if (!text || (bubbleId === null && !reactionOnly) || scheduleRequest && scheduleToolEnabled(deps)) return;
    // An earlier item can finish after a later item's delta; publish the full ordered text.
    cogsBody = Array.from(text).slice(0, 4096).join("");
    cogsState = "streaming";
    dirty = true;
    schedule();
  } : undefined;

  runningTurnChatId = chatId;
  let result: CodexTurnResult;
  try {
    result = await runTurn({
      prompt: promptWithMedia,
      ...(reactionOnly ? { allowEmptyReply: true } : {}),
      // 그림은 본문이 아니라 입력으로 간다 — 경로를 적어주면 codex 는 바이트로 읽을 뿐 보지 못한다.
      imagePaths: attachments?.imagePaths,
      agentId: selfAgentId, // 필수 — 승인 요청의 주인이 된다
      onActivity,
      onStatus,
      onDelta,
      onAnswerText,
      model: isCogs ? configuredCogsModel(deps.codexHome ?? codexBridgePaths(selfAgentId).codexHome) : undefined,

      resumeSessionId: prior,
      codexHome: deps.codexHome,
      cwd: deps.workdir,
      sandbox: deps.sandbox,
      networkAccess: deps.networkAccess,
      writableRoots: deps.workdir ? [deps.workdir] : [],
      ...cogsTurnOpts(deps),
    });
    if (result.ok) reactionClaim?.commit(); else reactionClaim?.rollback();
  } catch (error) {
    reactionClaim?.rollback();
    if (!isCogs) throw error;
    result = {ok:false,reply:"",sessionId:prior,detail:"turn_exception",elapsedMs:0};
  } finally {
    if (editTimer !== null) { clearTimeout(editTimer); editTimer = null; }
    if (inFlightEdit !== null) { try { await inFlightEdit; } catch { /* Failure must not leave a waiting reply. */ } }
    // Deliver the last activity even when the turn finishes before its batch timer fires.
    if (isCogs && dirty) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 400 - (Date.now() - lastEditAt))));
      try { await flush(); } catch { /* Presentation must not prevent completion. */ }
    }
    dirty = false;
    // 던지고 나가도 반드시 지운다. 안 지우면 그 대화는 영영 "도는 중" 으로 남아
    //   이후 모든 말이 끼어들기로 가고, 끼어들 턴이 없어 아무 데도 안 간다.
    runningTurnChatId = null;
  }

  // 예약된 편집이 답을 덮어쓰지 못하게 먼저 끈다. 끄지 않으면 답을 쓴 뒤 진행 줄이 다시 올라온다.
  if (editTimer !== null) { clearTimeout(editTimer); editTimer = null; }
  dirty = false;
  // 이미 날아간 편집은 취소할 수 없다 — 끝나기를 기다린 뒤에 답을 쓴다.
  //   기다리지 않으면 그 응답이 답보다 늦게 도착해 답이 진행 줄로 덮인다.
  if (inFlightEdit !== null) { try { await inFlightEdit; } catch { /* 표시 실패가 답을 막지 않는다 */ } }

  if (isCogs) await new Promise(resolve => setTimeout(resolve, Math.max(0,400-(Date.now()-lastEditAt))));
  if (result.sessionId) {
    chatThreads.set(chatId, result.sessionId);
    sessions.save(chatId, result.sessionId); // 재시작 넘어 기억한다
  }

  if (reactionOnly && result.ok && !result.reply.trim() && !cogsBody) {
    return { ok: true, turnOk: true, reply: "", detail: "reaction_silent" };
  }
  if (!result.ok || (!result.reply && !(reactionOnly && cogsBody))) {
    // 턴 실패와 세션 소멸은 다르므로 thread ID가 살아 있으면 저장된 맥락을 유지한다. resume 자체가 실패하면 클라이언트가 새 thread를 만들고 그 번호로 갱신한다.
    if (!result.sessionId) {
      chatThreads.delete(chatId);
      sessions.clear(chatId); // 이번 턴에서 쓸 수 있는 thread 를 못 얻었다 = 그 세션은 못 쓴다
    } else {
      console.warn(`[codex-bridge] 턴 실패했지만 세션은 유지한다(thread 살아 있음): ${result.detail ?? "사유 없음"}`);
    }
    const partial = isCogs ? preserveAnswer(cogsBody, result.reply) : "";
    const errorCode = /timeout/.test(result.detail ?? "") ? "timeout" : /rate.limit/.test(result.detail ?? "") ? "rate_limited" : "response_failed";
    const errText = isCogs ? toMarkdownV2(partial) : toMarkdownV2(uiText("turn_failed"));
    if (bubbleId !== null) await edit(chatId, bubbleId, errText, isCogs ? "error" : undefined, undefined, undefined, undefined, undefined, errorCode);
    else await send(chatId, errText, isCogs ? { state: "error", errorCode, replyTo: messageId } : undefined);
    return { ok: false, turnOk: false, reply: "", detail: `codex_turn_failed:${result.detail}` };
  }
  // 성공 턴에서 첫 인사를 했다면 영속 마커를 남긴다 → 다음부터(재시작·새 스레드 포함) 재소개 안 함.
  if (!greetedBefore) markGreetedFirstContact(greetAgentId);
  let reply = result.reply;
  if (scheduleRequest && scheduleToolEnabled(deps)) {
    const marker = extractScheduleMarker(result.reply);
    if (marker) {
      let hostResult: string;
      try {
        hostResult = await registerReminder(marker, {
          agentId: selfAgentId,
          teamBaseUrl: deps.teamBaseUrl ?? process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7878/team",
        });
      } catch {
        hostResult = JSON.stringify({ code: "schedule_failed", error_code: "schedule_failed" });
      }
      let summary: CodexTurnResult;
      try {
        summary = await runTurn({
          prompt: `[schedule_reminder tool result]\n${hostResult}\nDescribe this result to the user. Do not call the scheduler again.`,
          agentId: selfAgentId, resumeSessionId: result.sessionId, codexHome: deps.codexHome,
          cwd: deps.workdir, sandbox: deps.sandbox, networkAccess: deps.networkAccess,
          ...cogsTurnOpts(deps),
        });
      } catch {
        summary = { ok: false, reply: "", detail: "schedule_summary_exception", elapsedMs: 0 };
      }
      if (summary.sessionId) {
        chatThreads.set(chatId, summary.sessionId);
        sessions.save(chatId, summary.sessionId);
      }
      if (!summary.ok || !summary.reply.trim() || extractScheduleMarker(summary.reply)) {
        const notice = isCogs ? "" : toMarkdownV2(uiText("turn_failed"));
        if (bubbleId !== null) {
          await edit(chatId, bubbleId, notice, isCogs ? "error" : undefined, undefined, undefined, undefined, undefined, "response_failed");
        } else {
          await send(chatId, notice, isCogs ? { state: "error", errorCode: "response_failed", replyTo: messageId } : undefined);
        }
        return { ok: false, turnOk: false, reply: "", detail: "schedule_summary_failed" };
      }
      reply = summary.reply;
      cogsBody = "";
    }
  }

  // 최종답은 현재 마지막 진행 버블에 써야 새 버블이 작업 중인 채 남지 않는다.
  // MarkdownV2 변환 후 길이가 늘 수 있으므로 변환된 UTF-16 길이로 나누고 편집 실패·대상 없음이면 새로 보낸다.
  if (isCogs) reply = preserveAnswer(cogsBody, reply);
  const parts = splitForTelegram(toMarkdownV2(reply));
  let delivered = false;
  const first = parts[0] as string;
  if (bubbleId !== null) delivered = await edit(chatId, bubbleId, first, isCogs ? "complete" : undefined);
  if (!delivered) {
    const newId = await send(chatId, first, isCogs ? { state: "complete", replyTo: messageId } : undefined);
    delivered = newId !== null;
  }
  // 남은 조각은 이어서 보낸다 — 자르지 않는다.
  for (const rest of parts.slice(1)) {
    const id = await send(chatId, rest, isCogs ? { state: "complete", replyTo: messageId } : undefined);
    if (id === null) { delivered = false; break; }
  }
  // ok는 채널 발신, turnOk는 턴 실행 결과다. 직접 발신을 끈 bridge window에서 ok로 실행을 판정하면 성공도 실패로 읽는다.
  return { ok: delivered, turnOk: true, reply, detail: delivered ? "delivered" : "send_failed" };
}

/** 테스트/리셋용 — 채팅 thread 맥락 비우기. */
export function resetChatThreads(): void {
  chatThreads.clear();
}

//  라이브 텔레그램 I/O (토큰 필요 — 봇별 CODEX_BOT_TOKEN)
// 봇 API 주소 — 런처가 팀원 채널대로 TELEGRAM_API_BASE 를 넣는다(없으면 텔레그램).
const TG_API = channelFromEnv().apiBase;
/** b3chat 은 parse_mode 를 무시하고 글자를 그대로 저장한다 — MarkdownV2 로 보내면 \ 가 화면에 남는다. */
const PLAIN_ONLY = channelFromEnv().kind === "b3chat";

/** 텔레그램 발신 → 보낸 message_id 반환(작업중 메시지 교체용). */
/**
 * fetchFn 을 받는 이유: 폴백(MarkdownV2 거부 → 표시 걷고 재전송)은 실패했을 때만 도는 분기 라
 * 주입 없이는 시험에서 한 번도 실행되지 않는다. 정말 필요한 순간에 처음 돌면 거기서 또 틀려도
 * 알 방법이 없고, 그 결과가 답이 통째로 사라짐 — 이 코드가 막으려던 바로 그 상황이다.
 */
/** Receipt send is bounded even if a supplied transport never settles. Retries reuse one key. */
export async function sendCogsReceipt(
  chatId: number, messageId: number | undefined, send: NonNullable<BridgeDeps["sendMessage"]>, timeoutMs = 6000,
): Promise<number | null> {
  const idempotencyKey = `codex:receipt:${chatId}:${messageId ?? randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const id = await Promise.race([
        send(chatId, "", { state: "waiting", replyTo: messageId, idempotencyKey }),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
      if (id !== null) return id;
    } catch { /* Keep receipt failure out of the turn queue. */ }
    finally { clearTimeout(timer); }
  }
  return null;
}

export function tgSend(token: string, fetchFn: typeof fetch = fetch, opts: { apiBase?: string; plainOnly?: boolean; timeoutMs?: number } = {}): NonNullable<BridgeDeps["sendMessage"]> {
  const apiBase = opts.apiBase ?? TG_API;
  const plainOnly = opts.plainOnly ?? PLAIN_ONLY;
  let lastReason = "";
  const post = async (body: Record<string, unknown>): Promise<number | null> => {
    const res = await fetchFn(`${apiBase}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: plainOnly ? AbortSignal.timeout(opts.timeoutMs ?? 2500) : undefined,
    });
    const j = (await res.json()) as { ok?: boolean; result?: { message_id?: number }; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (j.ok && j.result?.message_id != null) return j.result.message_id;
    lastReason = tgFailureReason(j); // 사유를 들고 있는다 — 없으면 왜 막혔는지 영영 모른다
    return null;
  };
  return async (chatId, text, response) => {
    try {
      if (plainOnly) {
        const body = { chat_id: chatId, text: toPlain(text),
          cogs_idempotency_key: response?.idempotencyKey ?? `codex:${chatId}:${randomUUID()}`,
          ...(response?.reactionRef ? { cogs_reaction_ref: response.reactionRef } : {}),
          ...(response ? { cogs_response_state: response.state, reply_to_message_id: response.replyTo,
            ...(response.activityArgs ? { cogs_activity_args: response.activityArgs } : {}),
            ...(response.errorCode ? { cogs_error_code: response.errorCode } : {}),
            ...(response.activityCode ? { cogs_activity_code: response.activityCode } : {}) } : {}) };
        // A retry reuses the intent key even when the first response was lost after storage.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const id = await post(body);
            if (id !== null) return id;
          } catch { /* Retry the same send intent once. */ }
        }
        console.warn(`[codex-bridge] 전송 실패: ${lastReason}`);
        return null;
      }
      const id = await post({ chat_id: chatId, text, parse_mode: "MarkdownV2" });
      if (id !== null) return id;
      // 전송 실패 시 표시를 뺀 평문으로 한 번 재시도하고 실패 사유를 기록한다.
      // null은 형식 오류뿐 아니라 429·잘못된 방·비JSON에서도 오므로 원인을 Markdown으로 단정하지 않는다.
      console.warn(`[codex-bridge] 1차 전송 실패(MarkdownV2) → 순수 텍스트로 재전송: ${lastReason}`);
      const retried = await post({ chat_id: chatId, text: toPlain(text), ...(response ? { cogs_response_state: response.state, reply_to_message_id: response.replyTo, ...(response.activityCode ? { cogs_activity_code: response.activityCode } : {}), ...(response.activityArgs ? { cogs_activity_args: response.activityArgs } : {}), ...(response.errorCode ? { cogs_error_code: response.errorCode } : {}) } : {}) });
      if (retried === null) console.warn(`[codex-bridge] ★재전송도 실패 — 이 답은 안 나간다★: ${lastReason}`);
      return retried;
    } catch {
      return null;
    }
  };
}

/** 텔레그램 메시지 편집(작업중 → 답). */
/** 폴백을 시험할 수 있게 fetchFn 을 받는다 — tgSend 주석 참조. */
/** 전송 거절의 description과 retry_after를 기록해야 한도·형식·내용 동일 실패를 구분할 수 있다. description에는 토큰이 포함되지 않는다. */
export function tgFailureReason(j: { description?: string; error_code?: number; parameters?: { retry_after?: number } }): string {
  const retry = j.parameters?.retry_after;
  return [
    j.error_code !== undefined ? `code=${j.error_code}` : "",
    j.description ? `desc=${j.description}` : "",
    retry !== undefined ? `retry_after=${retry}s` : "",
  ].filter(Boolean).join(" · ") || "사유 없음(응답에 description 이 없다)";
}

export function tgEdit(token: string, fetchFn: typeof fetch = fetch, opts: { apiBase?: string; plainOnly?: boolean } = {}): NonNullable<BridgeDeps["editMessage"]> {
  const apiBase = opts.apiBase ?? TG_API;
  const plainOnly = opts.plainOnly ?? PLAIN_ONLY;
  const post = async (body: Record<string, unknown>): Promise<{ ok: boolean; reason: string }> => {
    const res = await fetchFn(`${apiBase}/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { ok?: boolean; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    return j.ok === true ? { ok: true, reason: "" } : { ok: false, reason: tgFailureReason(j) };
  };
  return async (chatId, messageId, text, responseState, activity, activityCode, reactionRef, activityArgs, errorCode) => {
    try {
      if (plainOnly) {
        const only = await post({ chat_id: chatId, message_id: messageId, text: toPlain(text), ...(reactionRef ? { cogs_reaction_ref: reactionRef } : {}), ...(responseState ? { cogs_response_state: responseState, ...(activityArgs ? { cogs_activity_args: activityArgs } : {}), ...(errorCode ? { cogs_error_code: errorCode } : {}), ...(activityCode ? { cogs_activity_code: activityCode } : {}) } : {}) });
        if (!only.ok) console.warn(`[codex-bridge] ★편집 실패 → 새 버블로 갈라진다★: ${only.reason}`);
        return only.ok;
      }
      const first = await post({ chat_id: chatId, message_id: messageId, text, parse_mode: "MarkdownV2" });
      if (first.ok) return true;
      console.warn(`[codex-bridge] 1차 편집 실패(MarkdownV2) → 순수 텍스트로 재전송: ${first.reason}`);
      const second = await post({ chat_id: chatId, message_id: messageId, text: toPlain(text), ...(responseState ? { cogs_response_state: responseState, ...(activityArgs ? { cogs_activity_args: activityArgs } : {}), ...(errorCode ? { cogs_error_code: errorCode } : {}), ...(activityCode ? { cogs_activity_code: activityCode } : {}) } : {}) });
      // 둘 다 막히면 여기서 새 버블이 열린다 — 화면이 갈라지는 그 순간이라 반드시 남긴다.
      if (!second.ok) console.warn(`[codex-bridge] ★2차 편집도 실패 → 새 버블로 갈라진다★: ${second.reason}`);
      return second.ok;
    } catch (e) {
      console.warn(`[codex-bridge] 편집 중 예외: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };
}

/** 텔레그램 리액션(setMessageReaction) — 봇도 Bot API로 react 가능. */
function tgReact(token: string): NonNullable<BridgeDeps["reactMessage"]> {
  return async (chatId, messageId, emoji) => {
    try {
      const res = await fetch(`${TG_API}/bot${token}/setMessageReaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] }),
      });
      const j = (await res.json()) as { ok?: boolean };
      return j.ok === true;
    } catch {
      return false;
    }
  };
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    /** private | group | supergroup | channel (텔레그램) — b3chat 도 같은 값을 쓴다. */
    chat: { id: number; type?: string };
    text?: string;
    /** 사진에 달린 설명 — 사진 메시지는 text 가 아니라 caption 으로 온다. */
    caption?: string;
    /**
     * 인용 답장의 원문. 사람이 앞 메시지를 집어 답하면 새 글자만 오고 무엇을 집었는지는 안 온다.
     * 그룹방 경로는 이미 싣고 있었다(7군데) — 1:1 만 0군데였다. 또 같은 축이다.
     */
    reply_to_message?: { text?: string; caption?: string; from?: { username?: string; first_name?: string } };
    /** 같은 그림의 여러 크기 (썸네일·중간·원본). 장수가 아니다 — 여러 장은 메시지가 나뉘어 온다. */
    photo?: DmMessageMedia["photo"];
    document?: DmMessageMedia["document"];
  };
  message_reaction?: ReactionUpdate;
  callback_query?: TgCallbackQuery;
}

interface TgCallbackQuery {
  id: string;
  data?: string;
  from?: { id: number };
  message?: { message_id: number; chat: { id: number } };
  /** cogs 서버만 채운다(봇 owner_id). */
  cogs_bot_owner_id?: number;
}

/** exec 폴백은 steer·서브에이전트 생존 기능을 잃으므로 app-server 준비 실패를 그대로 실패로 드러낸다.
 * 현재 never 정책에서는 app-server도 승인창을 만들지 않으므로 승인창 유무를 두 경로의 차이로 보지 않는다. */
export function defaultBridgeCaller(): (o: CodexTurnOptions) => Promise<CodexTurnResult> {
  const { openDb } = require("../../db/migrate") as typeof import("../../db/migrate");
  const { makeAppServerCaller } = require("./appServerRunner") as typeof import("./appServerRunner");
  return makeAppServerCaller(openDb(defaultTeamDbPath()));
}

/** 브리지에 저장소 env가 없을 수 있으므로 team.db는 cwd 대신 모듈 위치에서 찾는다. 잘못된 DB는 승인 콜백 응답도 막는다. */
export function defaultTeamDbPath(): string {
  return process.env.B3OS_TEAM_DB ?? join(import.meta.dir, "..", "..", "..", "..", "team.db");
}

/**
 * 승인 버튼을 이 팀원 방에서 처리한다.
 *
 * 요청 자체는 서버가 이 봇으로 띄운다(appServerPopup.sendApprovalToMemberRoom).
 * getUpdates 는 봇당 한 프로세스만 가능하므로, 폴링을 하는 브리지가 콜백을 맡는다.
 */
export async function handleApprovalCallback(
  token: string,
  cb: TgCallbackQuery,
  allowFrom: Set<number>,
  deps: { dbPath?: string; fetchFn?: typeof fetch; plainOnly?: boolean } = {},
): Promise<"decided" | "ignored" | "stale" | "unauthorized"> {
  const doFetch = deps.fetchFn ?? fetch;
  const answer = (code: string, alert = false, args: Record<string, unknown> = {}) =>
    doFetch(`${TG_API}/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: cb.id, ...((deps.plainOnly ?? PLAIN_ONLY) ? { text_code: code, text_args: args } : { text: uiText(code, args) }), show_alert: alert }),
    }).catch(() => undefined);

  const m = /^(pg1|pgs|pga|pgd):((?:apr|prm)_[a-f0-9]+)$/.exec(cb.data ?? "");
  if (!m) return "ignored";

  // 발신자 게이트 — 메시지와 같은 규칙(fail-closed).
  const fromId = cb.from?.id;
  if (fromId === undefined || !isAllowedChat(allowFrom, fromId)) {
    await answer("callback_forbidden", true);
    return "unauthorized";
  }

  const { openDb } = await import("../../db/migrate");
  const { decidePermissionRequest, getPermissionRequest } = await import("../../lib/permissionGate");
  const db = openDb(deps.dbPath ?? defaultTeamDbPath());
  try {
    const id = m[2]!;
    const row = getPermissionRequest(db, id);
    // 이미 지난 요청은 지난 대로 알린다 — 눌렀는데 아무 반응이 없으면 사람은 다시 누른다.
    if (!row || row.status !== "pending") {
      await answer(row ? "callback_processed" : "callback_expired", false, row ? { status: row.status } : {});
      if (cb.message) {
        await doFetch(`${TG_API}/bot${token}/editMessageReplyMarkup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }),
        }).catch(() => undefined);
      }
      return "stale";
    }
    const decision =
      m[1] === "pg1" ? "allow_once"
      : m[1] === "pgs" ? "allow_session"   // 이 세션 동안만 — 지속 허가를 남기지 않는다
      : m[1] === "pga" ? "allow_always"
      : "deny";

    // '항상 허용' 은 codex 설정 파일에 쓴다.
    //   우리 DB 에 영구 권한을 쌓지 않는다 — 그건 취소 경로가 없었다. 설정은 사람이 열어서 지울 수 있다.
    if (decision === "allow_always") {
      const target = (row as { target?: string }).target;
      // shell target은 명령 문자열일 수 있어 writable_roots에 넣지 않는다. 공백 없는 단일 절대경로만 설정에 저장해 잘못된 경로 권한을 만들지 않는다.
      const looksLikePath = Boolean(target) && /^\/[^\s]*$/.test(target as string);
      if (target && !looksLikePath) {
        console.log(`[codex-bridge] 항상 허용 → 설정 기록 건너뜀(경로가 아님): ${target.slice(0, 60)}`);
      }
      if (target && looksLikePath) {
        try {
          const { addWritableRoot } = await import("./persistAlwaysAllow");
          const { codexBridgePaths } = await import("./launcher");
          const agentId = (row as { agent_id?: string }).agent_id ?? process.env.CODEX_AGENT_ID ?? "";
          if (agentId) {
            const r = addWritableRoot(`${codexBridgePaths(agentId).codexHome}/config.toml`, target);
            console.log(`[codex-bridge] 항상 허용 → 설정에 기록: ${r.root} (${r.changed ? "추가" : "이미 있음"})`);
          }
        } catch (e) { console.error(`[codex-bridge] 설정 기록 실패(승인 자체는 진행): ${e instanceof Error ? e.message : e}`); }
      }
    }
    const res = decidePermissionRequest(db, id, decision, {
      approver: "GD",
      provenance: { surface: "telegram_member_room", approver_telegram_id: fromId, callback_data: cb.data },
    });
    if (!res.ok) { await answer("callback_failed", true); return "ignored"; }
    await answer(
      `callback_${decision}`,
    );
    if (cb.message) {
      await doFetch(`${TG_API}/bot${token}/editMessageReplyMarkup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }),
      }).catch(() => undefined);
    }
    return "decided";
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

/**
 * 승인 버튼 누름을 채널에 맞는 처리로 보낸다.
 * cogs(b3chat) 방은 사람(봇 주인)으로 인가한다 — 방 id 허용 목록과 섞지 않는다. 텔레그램은 기존 handleApprovalCallback 그대로.
 */
export async function dispatchApprovalCallback(
  token: string,
  cb: TgCallbackQuery,
  ctx: { channelKind: string | undefined; allowFrom: Set<number>; apiBase: string; agentId: string; registryPath: string; dbPath: string },
  handlers: { cogs: typeof handleCogsApprovalCallback; telegram: typeof handleApprovalCallback } = { cogs: handleCogsApprovalCallback, telegram: handleApprovalCallback },
): Promise<string> {
  if (ctx.channelKind === "b3chat") {
    return handlers.cogs(token, cb, { apiBase: ctx.apiBase, agentId: ctx.agentId, registryPath: ctx.registryPath, dbPath: ctx.dbPath });
  }
  return handlers.telegram(token, cb, ctx.allowFrom);
}

/** 첫 getUpdates 성공 후 ready marker를 원자적으로 쓴다. marker 존재 = 브리지가 실제 Telegram polling에 진입. */
export function writeBridgeReadyMarker(pidFile: string, pid = process.pid, agentId = process.env.CODEX_AGENT_ID ?? ""): boolean {
  if (!pidFile) return false;
  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    const tmp = `${pidFile}.tmp-${pid}`;
    writeFileSync(tmp, JSON.stringify({ pid, agentId, readyAt: new Date().toISOString() }) + "\n", "utf-8");
    renameSync(tmp, pidFile);
    return true;
  } catch {
    return false;
  }
}

/** CODEX_ALLOW_FROM(comma-sep chat_id) → 허용 발신자 Set. 공백·비숫자 무시. 빈/미설정 → 빈 Set(브리지가 fail-closed 로 차단). */
export function parseAllowFrom(raw: string | undefined | null): Set<number> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "") // 빈 문자열 먼저 제거 — Number("")=0 이 chat_id 0 으로 새는 것 방지
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
	  );
}

export function isAllowedChat(allowFrom: Set<number>, chatId: number): boolean {
  return allowFrom.size > 0 && allowFrom.has(chatId);
}

/**
 * 라이브 텔레그램 폴링 루프(long-poll). 봇 토큰·워크스페이스는 env로(코드 변경 없이 팀원별 구동).
	 *   CODEX_BOT_TOKEN(필수) · CODEX_WORKDIR(페르소나 AGENTS.md) · CODEX_HOME(정체성 격리, 선택)
	 *   CODEX_ALLOW_FROM(comma-sep chat_id, 런처 자동 시드) · 발신자 게이트(미설정 시 fail-closed 차단)
 */
export async function runBridge(deps: BridgeDeps = {}): Promise<void> {
  const token = process.env.CODEX_BOT_TOKEN ?? "";
  const workdir = deps.workdir ?? process.env.CODEX_WORKDIR ?? undefined;
  const codexHome = deps.codexHome ?? process.env.CODEX_HOME ?? undefined;
  const agentRuntime = bridgeRuntimeConfigForAgent({
    agentId: process.env.CODEX_AGENT_ID,
    registryPath: process.env.TEAM_AGENT_REGISTRY,
  });
  if (!token) {
    console.error("[codex-bridge] CODEX_BOT_TOKEN 미설정 — 라이브 폴링 불가.");
    return;
  }
  // 채널 설정이 틀리면 폴링하지 않는다 — b3chat 인데 주소가 없으면 텔레그램으로 떨어지지 않고 멈춘다
  //   (그 토큰이 api.telegram.org 로 나가면 안 된다). 런처가 먼저 막지만 wrapper 를 손으로 고친 경우의 두 번째 벽.
  try { assertChannelUsable(deps.channel ?? channelFromEnv(), "codex-bridge"); }
  catch (e) { console.error(`[codex-bridge] ${e instanceof Error ? e.message : String(e)}`); return; }
	  // 발신자 게이트(allowlist, fail-closed): claude access.json allowFrom / openclaw ownerAllowFrom 와 동일 목적.
	  // 텔레그램은 봇 @username 아는 누구나 DM 가능 → 게이트 없으면 임의 사용자가 이 봇 정체성으로 codex 턴(quota/비용) 소진.
	  // CODEX_ALLOW_FROM=comma-sep chat_id (오너 DM·팀그룹, 런처가 자동 시드). 그 외 발신자 무시+audit. 미설정 시 전체 차단.
	  // 복구는 dashboard/launchd/env 경로에서 해야 한다. in-band DM 복구를 위해 전체 허용하지 않는다.
  // chat_id(1:1 DM=user.id) 기반 — DM 게이트 정확. 그룹(chat.id 음수)은 팀원 공유라 외부인 그룹편입 시 from.id 2차체크 필요(P2).
  const seededAllowFrom = parseAllowFrom(process.env.CODEX_ALLOW_FROM);
  let warnedNoAllowlist = false;
  const liveSandbox = deps.sandbox ?? agentRuntime.sandbox;
  const liveNetwork = deps.networkAccess ?? agentRuntime.networkAccess;
  const liveAgentId = deps.agentId ?? process.env.CODEX_AGENT_ID ?? "codex";
  const liveWorkspaceRoot = workdir ?? process.env.CODEX_WORKDIR ?? "";
  const live: BridgeDeps = {
    ...deps,
    channel: deps.channel ?? channelFromEnv(),
    workdir,
    codexHome,
    sandbox: liveSandbox,
    networkAccess: liveNetwork,
    // 관리자 설정의 grant 범위는 팀원별 workspaceRoot 산출과 일치시킨다. 설정 grant로도 Tier-D의 우선 거절을 우회하지 않는다.
    permissionContext: deps.permissionContext ?? {
      workspaceRoot: liveWorkspaceRoot,
      grants: codexConfiguredGrants(liveAgentId, liveSandbox, liveNetwork, liveWorkspaceRoot),
    },
    // 라이브에서는 1:1 세션을 team.db 에 기억한다(재시작 넘어 맥락 유지).
    // agentId 를 실어 보낸다 — 안 실으면 handleMessage 가 같은 식을 다시 계산해,
    //   runBridge({agentId}) 로 부를 때 두 값이 갈린다. 그러면 steer 가 등록 안 된 id 를 찾아 늘 실패한다.
    agentId: liveAgentId,
    reactionInbox: deps.reactionInbox ?? createReactionInbox(),
    dmSessions: deps.dmSessions ?? makeChatSessionStore(liveAgentId, defaultTeamDbPath()),
    sendMessage: deps.sendMessage ?? tgSend(token),
    editMessage: deps.editMessage ?? tgEdit(token),
    reactMessage: deps.reactMessage ?? tgReact(token),
  };
  // cogs 승인 대기 — DB 가 진실, 서버 신호·카드 누름·만료 타이머는 다시 보는 계기.
  const cogsApprovals = live.channel?.kind === "b3chat"
    ? createBridgeCogsApprovals({ agentId: liveAgentId, openDb: () => openDb(defaultTeamDbPath()) })
    : null;
  // cogs 채널만 정책을 본다. 턴마다 원본을 다시 읽어 축소가 다음 턴에 바로 적용된다(풀은 도장이 바뀌면 다시 띄운다).
  if (live.channel?.kind === "b3chat" && !live.cogsRunFor) {
    const registryPath = process.env.TEAM_AGENT_REGISTRY?.trim() || DEFAULT_AGENT_REGISTRY;
    // 정책 팀원의 승인 요청 → 주인 1:1 방 카드 → 결정 → 응답 하나.
    if (cogsApprovals && !live.onCogsApproval) {
      const roomId = live.channel.ownerChat ?? null;
      const approver = createCogsCodexApprover({
        agentId: liveAgentId, roomId, processGen: cogsApprovals.processGen, cwd: workdir,
        openDb: () => openDb(defaultTeamDbPath()),
        currentStamp: () => currentCogsStamp(registryPath, liveAgentId),
        waiters: cogsApprovals.waiters,
        // 요청마다 기한을 건다 — 끝나지 않는 전송이 승인 대기를 붙잡지 않게.
        sendCard: (input) => sendApprovalCard(TG_API, token, roomId ?? "", input,
          ((url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })) as typeof fetch,
          { agentId: liveAgentId }),
      });
      live.onCogsApproval = approver.approve;
    }
    live.cogsRunFor = () => {
      const list = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<{ id?: string; cogs_permissions?: unknown }>;
      const entry = list.find((a) => a?.id === liveAgentId);
      if (!entry) return { mode: "blocked", reason: "agent_not_found" };
      return resolveCogsCodexRun(readPolicy(entry.cogs_permissions, "codex"), workdir);
    };
  }
  let offset = 0;
  let ownBotId: number | undefined;
  let readyMarked = false;
  const pidFile = process.env.CODEX_BRIDGE_PID_FILE ?? "";
  console.log(`[codex-bridge] 시작(long-poll). workdir=${workdir ?? "(none)"}`);
  // 첫 getUpdates는 새 메시지가 없으면 30초 기다려 28초 활성화 한도를 넘으므로 토큰·도달성을 확인하는 getMe 직후 ready를 기록한다. 실패하면 첫 poll 응답 기록으로 폴백한다.
  try {
    const me = await fetch(`${TG_API}/bot${token}/getMe`);
    const mj = (await me.json()) as { ok?: boolean; result?: { id?: number } };
    if (mj.ok === true && typeof mj.result?.id === "number") ownBotId = mj.result.id;
    if (mj.ok === true && !readyMarked) {
      readyMarked = writeBridgeReadyMarker(pidFile);
      if (readyMarked) console.log(`[codex-bridge] ready marker(getMe): ${pidFile}`);
    }
  } catch (e) {
    console.error(`[codex-bridge] getMe 실패(토큰/네트워크?) — getUpdates 후 marker 폴백: ${e instanceof Error ? e.message : e}`);
  }
  // 폴링 루프는 턴을 기다리지 않아야 실행 도중 입력·콜백을 계속 받는다.
  // 턴은 팀원 단위 공유 클라이언트의 상태 덮어쓰기를 막도록 직렬화한다. 현재 never 정책은 승인창을 만들지 않는다.
  const turns = createSerialTurnQueue((e) => {
    console.error(`[codex-bridge] 턴 처리 실패: ${e instanceof Error ? e.message : e}`);
  });

  // 서버가 담당자를 정한 그룹 턴도 같은 대기열에 넣어 1:1과 겹치지 않게 한다. 수신 리액션은 해당 팀원 봇으로 붙여 누가 받았는지 드러낸다.
  const windowHandle = await startBridgeWindow({
    agentId: liveAgentId,
    pidFile,
    log: (line) => console.log(line),
    ...(cogsApprovals ? { onControl: cogsApprovals.onControl } : {}),
    enqueue: (r) => {
      const chatId = Number(r.groupId);
      if (!Number.isFinite(chatId)) {
        console.log(`[codex-bridge] 창구 요청 무시: groupId 가 숫자가 아니다 msg=${r.messageId}`);
        return;
      }
      // 첫 인사(앱 [팀원 추가]) — 팀장 방에만, 평소 1:1 처리 그대로(같은 세션·같은 봇). 첫 접촉 표시도 거기서 남는다.
      if (r.kind === "greeting") {
        const owner = Number(channelFromEnv().ownerChat ?? NaN);
        if (chatId !== owner) {
          console.log(`[codex-bridge] 창구 인사 무시: 팀장 방이 아니다 msg=${r.messageId}`);
          return;
        }
        turns.enqueue(async () => {
          const res = await handleMessage(chatId, r.body, undefined, live, undefined, "window", false);
          console.log(`[codex-bridge] 창구 인사 → ${res.detail}`);
        });
        return;
      }
      const tgMsgId = r.origTgMessageId ? Number(r.origTgMessageId) : undefined;
      if (live.channel?.kind !== "b3chat" && tgMsgId !== undefined && Number.isFinite(tgMsgId)) {
        void live.reactMessage?.(chatId, tgMsgId, "👀");
      }
      turns.enqueue(() => runGroupTurn({ deps: live, agentId: liveAgentId, repoRoot: REPO_ROOT, chatId, tgMsgId, req: r }));
    },
  });
  if (windowHandle) {
    // 신호 처리기를 달면 Node 의 기본 종료가 사라진다.
    //   bridge window 만 닫고 끝내면 폴 루프가 계속 돌아 SIGTERM 으로 안 죽는다 —
    //   launchd 재기동이 SIGKILL 까지 기다리게 된다. 치우고 직접 나간다.
    const stop = () => {
      // 202는 접수만 보장하므로 종료 때 남은 턴 수를 기록해 접수 후 미실행을 드러낸다. 큐를 비우느라 종료를 지연시키지는 않는다.
      // process.exit는 버퍼를 비우지 않는다. 현재 stdout 일반파일의 동기 기록에 의존하므로 wrapper에 tee 같은 파이프를 넣으면 이 마지막 로그가 유실될 수 있다.
      const left = turns.pendingCount();
      if (left > 0) console.log(`[codex-bridge] 종료 — ★큐에 남은 턴 ${left}건은 돌지 않는다★`);
      try {
        cogsApprovals?.close();
        windowHandle.close();
      } catch {
        /* 정리 실패가 종료를 막지 않는다 */
      }
      process.exit(0);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }

  for (;;) {
    try {
      // A temporary getMe failure must not permanently disable author verification.
      if (live.channel?.kind === "b3chat" && ownBotId === undefined) {
        const me = await fetch(`${TG_API}/bot${token}/getMe`);
        const identity = await me.json() as { ok?: boolean; result?: { id?: number } };
        if (identity.ok !== true || typeof identity.result?.id !== "number") throw new Error("reaction author identity unavailable");
        ownBotId = identity.result.id;
      }
      const res = await fetch(bridgeUpdatesUrl(TG_API, token, offset));
      const j = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
      if (j.ok === true && live.channel?.kind === "b3chat") writeBridgeReadyMarker(`${pidFile}.poll`);
      if (j.ok === true && !readyMarked) {
        readyMarked = writeBridgeReadyMarker(pidFile);
        if (readyMarked) console.log(`[codex-bridge] ready marker: ${pidFile}`);
      }
      for (const u of j.result ?? []) {
        const allowFrom = currentCogsAllowlist(live.channel!, seededAllowFrom, liveAgentId, process.env.TEAM_AGENT_REGISTRY);
        if (u.update_id < offset) continue;
        offset = u.update_id + 1;
        // Correlate cogs ingress without logging message bodies, URLs or credentials.
        const logUpdate = (result: string) => {
          if (live.channel?.kind === "b3chat") console.log(`[cogs-update] ${JSON.stringify({agent_id:liveAgentId,update_id:u.update_id,result})}`);
        };
        logUpdate("received");
        if (u.message_reaction) {
          logUpdate("reaction_dispatched");
          const reaction = u.message_reaction;
          void routeReactionUpdate(u.update_id, reaction, {
            channel: live.channel!, allowFrom, ownBotId, inbox: live.reactionInbox!,
            route: {
              isRunning: isTurnRunningFor,
              captureSteer: () => captureActiveTurnSteer(liveAgentId),
              steer: async () => false,
              enqueue: run => turns.enqueue(run),
            },
            runTurn: async (input, ref) => { await handleMessage(reaction.chat.id, input, undefined, live, undefined, "poll", isGroupChat(reaction.chat), undefined, ref); },
          }).catch(e => console.error("[codex-bridge] reaction route failed:", String(e)));
          continue;
        }
        // 승인 버튼은 이 방에서 처리한다. 요청은 서버가 이 봇으로 띄우고, 누르는 것은 여기서 받는다
        //   (getUpdates 는 봇당 한 프로세스만 가능하므로 폴링을 하는 브리지가 콜백도 맡는다).
        // 콜백 예외가 폴 루프를 죽이면 안 된다 — 죽으면 그 뒤 메시지도 안 받는다.
        if (u.callback_query) {
          try {
            await dispatchApprovalCallback(token, u.callback_query, {
              channelKind: live.channel?.kind, allowFrom, apiBase: TG_API, agentId: liveAgentId,
              registryPath: process.env.TEAM_AGENT_REGISTRY?.trim() || DEFAULT_AGENT_REGISTRY,
              dbPath: defaultTeamDbPath(),
            });
            cogsApprovals?.afterCallback();
            logUpdate("callback_processed");
          }
          catch (e) { logUpdate("callback_failed"); console.error(`[codex-bridge] 승인 콜백 처리 실패: ${e instanceof Error ? e.message : e}`); }
          continue;
        }
        const msg = u.message;
        const chatId = msg?.chat.id;
        const messageId = msg?.message_id;
        // 사진은 text 없이 caption만 올 수 있으므로 본문 없음으로 메시지를 건너뛰지 않는다.
        const decided = decideDmMessage(msg);
        if (chatId === undefined || !decided.handle) { logUpdate("unsupported_message"); continue; }
        const { text, hasMedia } = decided;
	        // 발신자 게이트(fail-closed): 허용 목록이 비어 있거나 미포함이면 무시한다.
	        if (!isAllowedChat(allowFrom, chatId)) {
            logUpdate("sender_not_allowed");
	          if (allowFrom.size === 0 && !warnedNoAllowlist) {
	          warnedNoAllowlist = true;
	            console.warn("[codex-bridge] ⛔ CODEX_ALLOW_FROM 미설정 — fail-closed 로 모든 발신자를 차단합니다. 런처 시드 or 영입 시 오너 chat_id 확보 필요.");
	          } else {
	            console.warn(`[codex-bridge] ⛔ 미허용 발신자 chat ${chatId} 무시(allowlist). text=${text.slice(0, 40)}`);
	          }
	          continue;
	        }
        console.log(`[codex-bridge] ← chat ${chatId}: ${text.slice(0, 60)}`);
        // 같은 대화의 실행 턴에는 steer하고 turnId가 아직 없으면 새 턴으로 폴백한다. 폴 루프는 steer도 기다리지 않아 입력·콜백 수신을 막지 않는다.
        let receipt: Promise<number | null> | undefined;
        void routeIncoming(chatId, text, {
          receive: live.channel?.kind === "b3chat" ? () => (receipt = sendCogsReceipt(chatId, messageId, live.sendMessage!)) : undefined,
          isRunning: isTurnRunningFor,
          // 도중에 붙인 그림도 그 작업 안으로 넣는다. 여기서 내려받아도 폴 루프는 안 막힌다 —
          //   위에서 routeIncoming 을 기다리지 않기 때문이다(await 를 붙이면 승인 버튼이 다시 막힌다).
          captureSteer: () => captureConversationSteer(chatId, {
            isRunning: isTurnRunningFor,
            captureSend: () => captureActiveTurnSteer(liveAgentId),
            inbox: live.reactionInbox!,
            fetchAttachments: hasMedia && msg ? () => downloadDmAttachmentsSafe(token, msg) : null,
          }),
          steer: async () => false,
          enqueue: (run) => turns.enqueue(run),
          runTurnFor: async () => {
            const r = await handleMessage(chatId, text, messageId, live, hasMedia && msg
              ? () => downloadDmAttachmentsSafe(token, msg)
              : undefined, "poll", isGroupChat(msg?.chat), receipt);
            logUpdate(r.ok ? "turn_complete" : "turn_failed");
            console.log(`[codex-bridge] → ${r.detail}: ${r.reply.slice(0, 60)}`);
          },
        }).then((route) => {
          logUpdate(route);
          console.log(`[codex-bridge] ↳ ${route === "steered" ? "진행 중 작업에 전달" : "새 작업으로"}: ${text.slice(0, 40)}`);
        });
      }
    } catch (e) {
      console.error("[codex-bridge] poll 오류:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (import.meta.main) void runBridge();

export function configuredCogsModel(home: string): string | undefined {
  try {
    return modelLine(readFileSync(`${home}/config.toml`, "utf-8")) ?? undefined;
  } catch { return undefined; }
}

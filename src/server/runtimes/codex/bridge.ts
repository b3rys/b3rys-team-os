/**
 * codex runtime — 채널 I/O 브리지 (M2).
 *
 * 역할(claude의 per-agent 텔레그램 봇 브리지 대응): codex 팀원의 봇으로 들어온 메시지를
 *   ① 접수 즉시 👀 리액션(TEAM-OS §4) → ② "작업 중…" 동적 메시지(codex 턴이 느리니 진행 표시)
 *   → ③ runCodexTurn(두뇌) → ④ 작업중 메시지를 답으로 교체(editMessageText)
 * 채널 발신·리액션·진행표시는 *브리지가* 책임지고, 두뇌(codex)는 답 텍스트만 생성한다.
 *
 * 텔레그램: getUpdates long-poll + sendMessage/setMessageReaction/editMessageText.
 * 슬랙: outbound 답 게시는 lib/slack.postMessage 재사용(inbound 캡처·라우팅은 team-collab 공통 — 런타임 중립).
 * 채팅별 codex thread(resume sessionId)로 멀티턴 맥락 유지.
 */
import { runCodexTurn, type CodexTurnOptions, type CodexTurnResult } from "./runner";
import {
  attachmentNote, attachmentsOrFailure, decideDmMessage, downloadDmAttachmentsSafe,
  type DmAttachments, type DmMessageMedia,
} from "./dmMedia";
import { createSerialTurnQueue } from "./serialTurnQueue";
import { startBridgeWindow, groupTurnCall } from "./bridgeWindow";
import { makeChatSessionStore, NOOP_DM_SESSION_STORE, type DmSessionStore } from "./dmSessionStore";
import { toMarkdownV2, splitForTelegram, toPlain } from "./telegramMarkdown";
import { steerActiveTurn } from "./activeTurns";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../../lib/registry";
import { appendAuditFile } from "../../lib/auditFile";
import { consumeGroupReply, ensureOutboxDir, groupReplyPath, outboxDir } from "./groupOutbox";
import type { CodexSandboxMode } from "../../types";
import type { PermissionContext } from "../../lib/permissionGate";
import { codexRuntimePreflight, codexConfiguredGrants } from "./permissions";
import { appendLine, renderBubble, fits, EDIT_MIN_INTERVAL_MS, type ProgressLine } from "./progressLines";

export interface BridgeDeps {
  /** codex 한 턴 구동(기본 runCodexTurn — 테스트 mock). */
  runTurn?: (opts: CodexTurnOptions) => Promise<CodexTurnResult>;
  /** 텔레그램 발신 → 보낸 message_id 반환(작업중 메시지 교체용). */
  sendMessage?: (chatId: number, text: string) => Promise<number | null>;
  /** 텔레그램 메시지 편집(작업중 → 답). */
  editMessage?: (chatId: number, messageId: number, text: string) => Promise<boolean>;
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
}

/**
 * ★지금 어느 대화의 턴이 도는 중인가.★
 *
 * 도는 중에 사람이 또 말하면 ★그 턴에 끼워 넣어야★ 한다(codex turn/steer). 새 턴으로 줄을 세우면
 * 하던 일이 끝날 때까지 답이 없어 ★못 듣는 것처럼 보인다.★ 실제로 그렇게 보였다 —
 * 로그에는 메시지가 다 들어와 있는데 답이 없었다(2026-08-19 실측).
 *
 * 등록부(activeTurns)는 ★팀원 단위★ 라 어느 대화의 턴인지 모른다. 그래서 여기서 대화를 함께 기억한다 —
 * 다른 대화의 말을 남의 턴에 끼워 넣으면 안 된다.
 */
let runningTurnChatId: number | null = null;

/**
 * 도는 턴의 진행 줄에 한 줄 얹는 통로.
 * ★밀어 넣었다는 것을 사람이 봐야 한다★ — 안 보이면 들어갔는지 모른 채 같은 말을 다시 하게 된다.
 * 턴이 도는 동안에만 채워져 있다.
 */
let noteIntoRunningTurn: ((line: string) => void) | null = null;

/**
 * 진행 중 작업에 밀어 넣을 문구.
 * 버스 쪽(buildSteerText)과 같은 모양으로 둔다 — 받는 쪽(codex)이 같은 형식을 이미 읽고 있다.
 * ★"반영해서 계속하라 · 답할 때 이 말에도 답하라" 를 명시★ 하지 않으면 조용히 무시될 수 있다.
 */
/**
 * ★중간 개입에 첨부를 실어 보낸다.★
 *
 * 폴 루프 안 클로저로 두면 시험이 못 닿는다 — 리뷰에서 ★첨부를 통째로 무시해도 초록★ 이었다.
 * 실사용 경로다: 작업을 시켜놓고 도는 중에 사진을 보내면 여기로 온다.
 * 여기서 그림이 빠지면 codex 는 글자만 받고 "무슨 그림?" 이라 답한다 —
 * ★사람은 보냈는데, 못 봤다는 사실조차 안 남는다.★ 이 파일이 고치려던 결함과 같은 모양이다.
 */
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

/**
 * ★들어온 말을 어디로 보낼지 정하고 실행한다.★
 *
 * 폴 루프 안에 두면 시험이 못 닿는다 — 실제로 그래서 두 계약이 ★지워도 초록★ 이었다:
 *   ① 밀어 넣기가 실패하면 새 작업으로 되돌린다(조용히 삼키지 않는다)
 *   ② 밀어 넣었으면 진행 줄에 남긴다(안 보이면 들어갔는지 모른 채 같은 말을 다시 한다)
 * 둘 다 이 기능이 존재하는 이유라, ★지켜지는지 시험이 봐야 한다.★
 */
export interface IncomingRouteDeps {
  isRunning: (chatId: number) => boolean;
  steer: (text: string) => Promise<boolean>;
  note: (line: string) => void;
  enqueue: (run: () => Promise<void>) => void;
  runTurnFor: () => Promise<void>;
  react?: () => void;
}

export type IncomingRoute = "steered" | "newTurn";

export async function routeIncoming(
  chatId: number,
  text: string,
  d: IncomingRouteDeps,
): Promise<IncomingRoute> {
  if (d.isRunning(chatId)) {
    d.react?.();
    // ★던져도 말을 잃지 않는다★ — 연결이 끊기면 steer 는 성공/실패가 아니라 예외로 끝난다.
    //   그때 그냥 올려보내면 이 말은 새 작업으로도 안 가고 사라진다.
    const injected = await d.steer(buildDmSteerText(text)).catch((e) => {
      console.warn(`[codex-bridge] 전달 중 오류 → 새 작업으로: ${String(e)}`);
      return false;
    });
    if (injected) {
      d.note(`받음: ${text}`);
      return "steered";
    }
    // ★번호가 아직 없어 못 넣었다 — 여기서 멈추면 그 말은 아무 데도 안 간다.★
  }
  d.enqueue(d.runTurnFor);
  return "newTurn";
}

/** 시험·진단용 — 지금 그 대화의 턴이 도는 중인가. */
export function isTurnRunningFor(chatId: number): boolean {
  return runningTurnChatId === chatId;
}

// 채팅별 codex thread(resume sessionId) → 같은 대화 맥락 유지.
const chatThreads = new Map<number, string>();
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DEFAULT_AGENT_REGISTRY = resolve(REPO_ROOT, "agents.json");

// 첫 접촉(영입 후 첫 인사) 판정을 ★영속★ 마커로 한다.
//   과거엔 인메모리 chatThreads(세션 캐시)가 비면 "첫 접촉"으로 봤는데, 이 캐시는 서버 재시작마다
//   날아가서 이미 합류한 팀원(devon·lui…)이 재시작 후 첫 wake마다 신입처럼 영입인사를 반복했다.
//   마커(파일)는 재시작·새 스레드에도 남으므로 "여태 한 번이라도 인사했나"를 정확히 판정한다.
//   env override = 테스트 격리(라이브 var/ 안 건드림). 재영입 시 워크스페이스 정리로 마커도 사라져 재인사=의도대로.
function firstContactMarker(agentId: string): string {
  const dir = process.env.B3OS_FIRST_CONTACT_DIR ?? resolve(REPO_ROOT, "var/first-contact");
  return resolve(dir, `${agentId}.done`);
}
function hasGreetedFirstContact(agentId: string): boolean {
  try { return existsSync(firstContactMarker(agentId)); } catch { return false; }
}
function markGreetedFirstContact(agentId: string): void {
  try {
    const p = firstContactMarker(agentId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "greeted\n");
  } catch { /* best-effort — 실패해도 대화는 진행 */ }
}

export const DEFAULT_WORKING_TEXT = "⏳ 작업 중…";
export const SCHEDULE_UNSUPPORTED_TEXT =
  "아직 이 런타임에는 one-shot 예약 기능이 연결되어 있지 않습니다. 현재 대화 턴에서 기다리지는 않겠습니다.";
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

function formatScheduleJob(job: Record<string, unknown>): string {
  const id = typeof job.id === "string" ? job.id : "(unknown)";
  const target = typeof job.target_agent_id === "string" ? job.target_agent_id : "(unknown)";
  const nextRunAt = typeof job.next_run_at === "string" ? job.next_run_at : "(unknown)";
  const status = typeof job.status === "string" ? job.status : "(unknown)";
  const title = typeof job.title === "string" ? job.title : "(untitled)";
  return [
    "예약 등록 완료",
    `- job_id: ${id}`,
    `- 대상: ${target}`,
    `- 실행 예정: ${nextRunAt} UTC`,
    `- 상태: ${status}`,
    `- 제목: ${title}`,
    `- 취소: POST /api/schedules/${id}/cancel`,
  ].join("\n");
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
    return `${result.stdout.trim()}\n- 등록 경로: bridge host-side schedule-reminder.ts\n\n대기하지 않고 예약 등록 후 턴을 종료합니다.`;
  }
  let error = "unknown";
  try {
    const parsed = JSON.parse(result.stderr || result.stdout || "{}") as { error?: unknown; status?: unknown };
    error = typeof parsed.error === "string" ? parsed.error : typeof parsed.status === "number" ? `status_${parsed.status}` : error;
  } catch {
    error = (result.stderr || result.stdout || error).trim().slice(0, 200);
  }
  return ["스케줄러 예약에 실패했습니다.", `- error: ${error || "unknown"}`, "예약됐다고 처리하지 않았습니다."].join("\n");
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
    return [
      "스케줄러 예약에 실패했습니다.",
      `- status: ${res.status}`,
      `- error: ${typeof json.error === "string" ? json.error : "unknown"}`,
      "예약됐다고 처리하지 않았습니다.",
    ].join("\n");
  }
  return `${formatScheduleJob(json.job as Record<string, unknown>)}\n- 등록 경로: Codex CLI structured request → bridge host-side schedule tool\n\n대기하지 않고 예약 등록 후 턴을 종료합니다.`;
}

// ★team-comm owner-gate: 그룹서 owner 아닌데 native로 답하는 것 방지.
//   authority = /api/route (findRouteByTgMessageId + shouldSuppress) — bridge는 판단 안 하고 조회만.
//   에러/race → null(fail-open: false drop 방지, Codex 적대리뷰 §5).
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

/**
 * ★bridge window(그룹) 턴 한 건을 돌린다.★ 호출부를 시험할 수 있게 떼어 뒀다.
 *
 * ★서버는 팀원 대신 말하지 않는다★ (hermes 와 같은 계약 · 실측):
 *   전에는 이 경로도 `handleMessage` 의 텔레그램 발신을 그대로 탔다 — 방에는 떴지만
 *   ★버스에는 아무 기록이 없었다.★ 같은 방에서 claude 팀원의 답은 남고 이쪽만 0건이었다.
 *   그룹 native 차단은 ★들어오는 쪽★ 만 막는다 — 나가는 쪽은 여기서 막는다.
 *
 * ★실패를 조용히 두지 않는다★: 발신을 뗐으므로 에러 문구도 같이 사라진다 —
 *   사람 화면에서 "도는 중" 과 "죽었다" 가 같아진다. 리액션은 발신이 아니라 계약을 안 깨므로
 *   👀 를 ⚠️ 로 바꿔 남긴다. ★반환 실패와 예외 실패를 같은 모양으로★ 남긴다(둘 다 실패다).
 *
 * ★`ok` 가 아니라 `turnOk` 를 본다★: `ok` 는 "텔레그램에 보냈나" 라서 이 경로에선 항상 false 다.
 *   그걸로 판정하면 ★성공할 때마다 실패로 읽는다.★
 */
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
  // ★자리를 못 만들면 턴을 돌리지 않는다★ — 돌려봐야 답을 받을 데가 없고,
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
  // ★한 번만 부른다★ — 발신을 떼는 것과 답 보내는 명령을 넣는 것은 한 쌍이다.
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
    // ★던져도 자리를 비운다★ — 안 지우면 다음 턴이 이번 답을 자기 답으로 읽는다.
    consume(replyPath, outboxDir(ctx.repoRoot, ctx.agentId));
    audit("turn_completed_no_autopost", req.messageId, {
      agent_id: ctx.agentId, thread_id: req.threadId, turn_ok: false, chars: 0, replied: false,
      detail: `threw:${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`,
    });
    return;
  }
  // ★답은 턴의 stdout 이 아니라 팀원이 쓴 파일에서 온다.★ 안 썼으면 안 보낸다.
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
    // ★"턴이 됐나" 와 "답을 했나" 와 "운반됐나" 는 서로 다른 값이다★ — 한 칸에 뭉치면 판정이 거짓이 된다.
    //   턴이 성공했는데 답 파일이 없는 것은 ★고장이 아니라 "답 안 함"★ 이다(오너가 아니었을 수 있다).
    replied: out.kind === "reply",
    delivered,
    // ★send_failed 는 이 경로의 기대값이다★ — 텔레그램 발신을 뗐으므로. 실패 사유로 적으면 전부 거짓값이 된다.
    detail: !res.turnOk ? res.detail : deliverDetail || (out.kind === "reply" ? "turn_ok" : `no_reply:${out.kind}`),
  });
  // ★경고는 "고장" 에만 붙인다★ — 답을 안 한 것은 고장이 아니다. 운반 실패는 고장이다.
  if (!res.turnOk || deliverDetail) warn();
}

/**
 * ★브리지가 답을 버스로 운반한다 — 서버 입구에 직접 넣는다.★
 *
 * `send.sh` 도 결국 이 입구로 POST 한다. 셸을 거치면 ★발신자를 현재 디렉터리·tmux 로 추측하는 층★ 이
 * 하나 더 붙는데, 브리지의 디렉터리는 어느 팀원의 작업폴더도 아니고 launchd 아래라 tmux 도 없다.
 * 그 조건에서 해석은 실패하고(fail-closed) 발신이 죽는다 — 실측: 팀원 작업폴더가 아닌 cwd 는
 * tmux 없이 전부 exit 1 이다. 조용한 오배송이 아니라 시끄러운 실패다.
 * 브리지는 이 턴의 주인을 알고 있으므로 `from_agent_id` 로 그대로 싣는다 — 추측할 자리가 없어진다.
 *
 * 하위 프로세스·임시 파일·환경변수가 전부 사라진다.
 *
 * 본문은 ★셸을 안 지나므로★ 따옴표·백틱·`$` 가 해석될 자리가 없다.
 */
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
    // ★사유를 버리지 않는다★ — 버리면 다음 실패도 "운반 실패" 넉 자로만 남아 같은 조사를 반복한다.
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

export async function handleMessage(
  chatId: number,
  text: string,
  messageId: number | undefined,
  deps: BridgeDeps = {},
  /**
   * ★첨부는 여기서 내려받는다 — 폴 루프가 아니다.★
   * 루프에서 받으면 내려받는 동안 다음 업데이트를 못 읽어, #334 에서 고친 ★승인 버튼 막힘★ 이 되살아난다.
   * 함수로 넘겨 이 턴 안에서 받게 한다(시험에서는 통신 없이 대신 넣는다).
   */
  fetchAttachments?: () => Promise<DmAttachments>,
  /**
   * ★어느 입구로 들어왔나.★ 그룹 native 차단은 ★폴링 입구★ 에 거는 것이다 —
   *   그 입구엔 오너 판정이 없어서 남을 부른 메시지에도 답했다(실측 2026-08-24).
   *   `"window"` 는 서버(capture)가 오너를 정한 뒤 bridge window 로 넣은 것이라 그 차단을 지나지 않는다.
   *   ★플래그로 게이트를 끄는 게 아니라, 게이트가 애초에 그 입구의 것이다.★
   */
  ingress: "poll" | "window" = "poll",
): Promise<{ ok: boolean; turnOk: boolean; reply: string; detail: string }> {
  // ★브리지도 app-server 로 간다.★
  //   전에는 브리지만 옛 exec 경로였다 — 그래서 ★사람이 직접 말 거는 길에만★ 그때까지의 개선
  //   (중간 개입 · 프로세스 상주 · 서브에이전트 생존 · 승인창)이 하나도 안 붙어 있었다.
  //   ★그중 승인창은 지금 안 쓴다★ — 실행 정책이 "never" 라 codex 가 묻지 않는다. 나머지는 그대로 유효하다.
  //   버스는 app-server, 직접 대화는 exec 로 갈라져 있던 것이 구멍이었다.
  const runTurn = deps.runTurn ?? defaultBridgeCaller();
  const registerReminder = deps.registerScheduleReminder ?? registerScheduleMarker;
  const send = deps.sendMessage ?? (async () => null);
  const edit = deps.editMessage ?? (async () => false);
  const react = deps.reactMessage ?? (async () => false);
  const workingText = deps.workingText ?? DEFAULT_WORKING_TEXT;

  // ★team-comm group native deny: 그룹(chatId<0) native 처리를 막는다.
  //   ★enforcement = gate 결과와 무관하게 그룹 전체 drop★ — capture→bus가 owner를 이미 처리하므로(runInjection이
  //   route targets 에만 주입) native 가 또 답하면 이중응답. gate는 shadow/audit(effective 권위 기록)용으로만.
  //   env flag 2개 분리, 둘 다 off 기본 = ★라이브 영향 0(byte-level 불변)★. shadow=drop 없이 audit만.
  // ★이 브리지가 '누구' 인지는 한 곳에서만 정한다★.
  //   같은 식이 아래 네 곳에 흩어져 있었다. 그중 하나라도 빠지면 ★남의 신원으로 도는데★
  //   그게 승인 요청의 주인으로도 쓰인다 — 실제로 dex 요청 4건이 codex 앞으로 기록됐다.
  const selfAgentId = deps.agentId ?? process.env.CODEX_AGENT_ID ?? "codex";

  if (ingress === "poll" && chatId < 0 && messageId !== undefined) {
    const shadowOn = process.env.CODEX_GROUP_NATIVE_DENY_SHADOW === "true";
    // ★기본값 = 켜짐★ (제품 결정 2026-08-24): 그룹은 다른 런타임과 같이 capture→bus 로만 받는다.
    //   native 가 그룹에 직접 답하면 ★자기 앞으로 온 것이 아닌 호출에도 답한다★ — 실측: 그룹에서
    //   다른 팀원을 @멘션한 두 건을 이 브리지가 집어 빈 응답을 냈다. owner 판정은 capture→bus 가 한다.
    //   끄려면 명시적으로 "false" 를 준다. ★미설정은 켜짐이다★ — 새 팀원이 설정을 빠뜨려도 안전한 쪽이 기본이다.
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

  // ① 접수 즉시 👀 (TEAM-OS §4 visible ack)
  if (messageId !== undefined) void react(chatId, messageId, "👀");

  const scheduleRequest = isOneShotScheduleRequest(text);

  // One-shot reminders must be scheduled out-of-band. If the schedule tool is not
  // explicitly enabled, fail fast instead of letting Codex sleep inside the current
  // turn and block the polling loop.
  if (scheduleRequest && !scheduleToolEnabled(deps)) {
    const sent = await send(chatId, SCHEDULE_UNSUPPORTED_TEXT);
    return {
      ok: sent !== null,
      // ★bridge window 경로에서는 실패다★: 여기서는 안내 문구를 ★발신으로★ 전하는데,
      //   그 경로는 발신을 뗐다 — 그러면 ★답 0건 · 경고 없음 · 성공 기록★ 이 되어
      //   사람도 기록도 "잘 됐다" 로 읽는다. 아무것도 전달되지 않았으므로 turnOk 는 거짓이다.
      //   1:1 은 실제로 보내므로 `ok` 로 판정되어 영향이 없다.
      turnOk: false,
      reply: SCHEDULE_UNSUPPORTED_TEXT,
      detail: sent !== null ? "schedule_unsupported" : "send_failed",
    };
  }

  // ★예약 등록은 LLM 판단으로만★: 이전엔 여기서 키워드(isOneShotScheduleRequest) 매치만으로
  // buildDirectScheduleRequest → 즉시 등록하고 턴을 종료했다. 그 결과 "3분뒤 메시지가 안왔네" 같은 ★불평·질문★도
  // 시간패턴+행동패턴만 있으면 자동 예약돼버림(LLM이 의도를 판단하지 못함). GD 지적대로 이건 파싱이지 판단이 아니다.
  // → direct-register 경로 제거. isOneShotScheduleRequest 는 아래 ③에서 scheduleToolPrompt(도구 안내)를 주입하는
  //   '힌트'로만 쓰이고, 실제 등록은 LLM이 진짜 예약 요청이라 판단해 SCHEDULE_MARKER 를 낼 때만 일어난다(아래 ④ extractScheduleMarker).
  //   즉 "예약해달라"는 판단은 codex(LLM)가 하고, 브릿지는 등록 실행만 한다.

  // ② "작업 중…" 동적 메시지(codex 턴이 수초~수분이라 진행 표시) — message_id 확보해 나중에 교체.
  const workingMsgId = await send(chatId, workingText);

  // ③ 두뇌 호출(채팅별 thread resume로 맥락 유지)
  //   ★인메모리 지도가 비어 있으면 저장된 것을 본다★ — 그 지도는 재시작마다 비고,
  //   그때 사람 쪽에서는 앞 대화를 잊은 것으로 보인다(2026-08-18 실측: 브리지가 codex_session_map 을
  //   참조하지 않아 1:1 대화만 맥락이 끊겼다. 버스로 온 일은 그 표를 써서 이어졌다).
  const sessions = deps.dmSessions ?? NOOP_DM_SESSION_STORE;
  let prior = chatThreads.get(chatId);
  if (prior === undefined) {
    prior = sessions.get(chatId);
    if (prior !== undefined) chatThreads.set(chatId, prior); // 다음 턴부터는 메모리에서 바로
  }
  const toolAwareText = scheduleRequest
    ? scheduleToolPrompt({
        text,
        agentId: selfAgentId,
        teamBaseUrl: deps.teamBaseUrl ?? process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7878/team",
        repoRoot: deps.repoRoot ?? process.env.B3OS_REPO_ROOT ?? REPO_ROOT,
      })
    : text;
  // 첫 접촉(여태 한 번도 인사 안 한 신입) = 영입 후 첫 응답 → 인사 + OT 받은 것 언급하며 시작.
  //   판정은 ★영속 마커★(재시작에도 남음) — 인메모리 prior(세션 resume용)와 분리해, 이미 합류한 팀원이
  // 재시작 후 재소개하지 않게 한다. prior는 아래 resumeSessionId 로만 쓴다.
  const greetAgentId = selfAgentId;
  const greetedBefore = hasGreetedFirstContact(greetAgentId);
  const promptText = greetedBefore
    ? toolAwareText
    : `[이번이 이 대화의 첫 응답입니다. 먼저 짧게 인사하고, OT(팀 미션·규칙·역할·팀 스킬)를 받아 팀에 합류했음을 한 줄로 밝힌 뒤 본론에 답하세요.]\n\n${toolAwareText}`;
  // ★첨부를 여기서 내려받는다.★ 진행 표시가 이미 떠 있는 자리라 사람은 기다리는 줄 안다.
  //   실패해도 턴을 죽이지 않는다 — 사람이 보낸 것을 말없이 없애지 않고, 무슨 일이 났는지 본문에 적는다.
  // ★실패를 무엇으로 바꾸는지는 attachmentsOrFailure 한 곳에만 있다.★
  //   전에는 여기 인라인 catch 가 같은 객체를 ★문자 하나까지 똑같이★ 다시 만들고 있었다 —
  //   그래서 "한 함수로 모았다" 는 내 설명이 코드와 달랐다(리뷰 지적). 다음 사람이 한쪽만 고치면 갈린다.
  //   ★인라인 catch 를 그냥 지우면 안 된다★ — 이 함수는 넘겨받은 것을 부르는 자리라
  //   던지는 것이 오면 턴이 통째로 죽는다(시험이 잡았다). 그래서 지우는 대신 같은 정의를 쓴다.
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
    const errText = toMarkdownV2("⚠️ 권한 게이트가 이 Codex 런타임 실행을 막았습니다. 설정 승인이 필요합니다.");
    if (workingMsgId !== null) await edit(chatId, workingMsgId, errText);
    else await send(chatId, errText);
    return { ok: false, turnOk: false, reply: "", detail: `permission_${preflight.tier}:${preflight.rule}` };
  }
  // ★진행 표시★ — codex 가 도구를 시작할 때마다 오는 줄을 모아 "작업 중…" 메시지를 고쳐 쓴다.
  //   창이 없는 런타임이라 이게 없으면 사람 눈에는 몇 분간 문구 하나만 남는다.
  //   자르기·넘김 기준은 hermes 실구현 값을 쓴다. 편집 간격만 2초다(제품 결정: 2026-08-18 · progressLines.ts 주석).
  let bubbleId = workingMsgId;          // 지금 고쳐 쓰는 메시지
  let lines: ProgressLine[] = [];       // 그 메시지에 담긴 줄
  let lastEditAt = 0;                   // 마지막 편집 시각
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editing = false;                  // 편집 진행 중이면 다음 것을 겹쳐 치지 않는다
  let dirty = false;                    // 아직 화면에 안 나간 줄이 있나
  let inFlightEdit: Promise<void> | null = null; // 지금 날아가 있는 편집(답을 쓰기 전에 기다린다)

  const flush = async (): Promise<void> => {
    if (editing || !dirty || bubbleId === null) return;
    editing = true;
    dirty = false;
    lastEditAt = Date.now();
    // ★MarkdownV2 로 보낼 것이면 여기서 이스케이프한다.★
    //   진행 버블은 `renderBubble` 이 만든 ★순수 텍스트★ 인데 그대로 parse_mode=MarkdownV2 로 나갔다.
    //   그래서 `-`·`.` 같은 예약문자가 있는 줄마다 400 이 났고(실측 ★156건★: `-` 49 · `.` 2 …),
    //   매번 평문으로 재전송해서 ★같은 편집을 두 번씩★ 했다. 화면은 멀쩡했지만 호출이 2배였다.
    //   최종 답은 이미 `toMarkdownV2` 를 타고 있었다(:769) — ★버블만 빠져 있었다.★
    const text = toMarkdownV2(renderBubble(headLine, lines));
    const work = (async () => {
      const ok = await edit(chatId, bubbleId as number, text);
      if (!ok) {
        // ★편집이 안 되면 그 버블은 그대로 두고 새 버블을 연다.★ 이미 보낸 줄을 지우지 않는다.
        const fresh = await send(chatId, text);
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
    // ★편집 중에 들어온 줄은 여기서 다시 예약한다.★ 안 하면 타이머는 이미 소진돼 있어
    //   뒤에 줄이 더 오지 않는 한 마지막 줄이 화면에 영영 안 나간다.
    if (dirty) schedule();
  };

  const schedule = (): void => {
    if (editTimer !== null || bubbleId === null) return;
    const wait = Math.max(0, EDIT_MIN_INTERVAL_MS - (Date.now() - lastEditAt));
    editTimer = setTimeout(() => {
      editTimer = null;
      void flush();
    }, wait);
  };

  // ★상태는 한 자리에서 교체된다★ — 쌓지 않는다. 실제 작업만 아래에 쌓인다.
  let headLine = workingText;
  const onStatus = (line: string): void => {
    if (bubbleId === null || line === headLine) return;
    headLine = line;
    dirty = true;
    schedule();
  };

  const onActivity = (line: string, itemId?: string): void => {
    if (bubbleId === null) return;
    const next = appendLine(lines, line, undefined, itemId);
    if (next === lines) return; // 빈 줄이라 담을 것이 없다
    if (!fits(headLine, next)) {
      // ★한도에 닿으면 지금 버블은 남기고 새 버블로 넘어간다★ — 어디까지 했는지가 사라지지 않는다.
      lines = appendLine([], line);
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

  runningTurnChatId = chatId;
  // 밖(폴 루프)에서 진행 줄에 한 줄 얹을 수 있게 연다. 항목 id 를 매번 새로 주어 줄이 쌓이게 한다.
  let noteSeq = 0;
  noteIntoRunningTurn = (line: string) => onActivity(line, `note-${++noteSeq}`);
  let result: CodexTurnResult;
  try {
    result = await runTurn({
      prompt: promptWithMedia,
      // ★그림은 본문이 아니라 입력으로 간다★ — 경로를 적어주면 codex 는 바이트로 읽을 뿐 보지 못한다.
      imagePaths: attachments?.imagePaths,
      agentId: selfAgentId, // ★필수★ — 승인 요청의 주인이 된다
      onActivity,
      onStatus,

      resumeSessionId: prior,
      codexHome: deps.codexHome,
      cwd: deps.workdir,
      sandbox: deps.sandbox,
      networkAccess: deps.networkAccess,
      writableRoots: deps.workdir ? [deps.workdir] : [],
    });
  } finally {
    // ★던지고 나가도 반드시 지운다.★ 안 지우면 그 대화는 영영 "도는 중" 으로 남아
    //   이후 모든 말이 끼어들기로 가고, 끼어들 턴이 없어 아무 데도 안 간다.
    runningTurnChatId = null;
    noteIntoRunningTurn = null;
  }

  // ★예약된 편집이 답을 덮어쓰지 못하게 먼저 끈다.★ 끄지 않으면 답을 쓴 뒤 진행 줄이 다시 올라온다.
  if (editTimer !== null) { clearTimeout(editTimer); editTimer = null; }
  dirty = false;
  // ★이미 날아간 편집은 취소할 수 없다★ — 끝나기를 기다린 뒤에 답을 쓴다.
  //   기다리지 않으면 그 응답이 답보다 늦게 도착해 답이 진행 줄로 덮인다.
  if (inFlightEdit !== null) { try { await inFlightEdit; } catch { /* 표시 실패가 답을 막지 않는다 */ } }

  if (result.sessionId) {
    chatThreads.set(chatId, result.sessionId);
    sessions.save(chatId, result.sessionId); // 재시작 넘어 기억한다
  }

  if (!result.ok || !result.reply) {
    // ★턴이 실패한 것과 세션이 죽은 것은 다르다.★ (2026-08-19 실측 — 팀장님 관측)
    //   전에는 실패하면 무조건 지웠다. 그런데 ★appserver_timeout 은 세션이 멀쩡한데 턴만 오래 걸린 것★ 이라,
    //   지우고 나면 ★바로 직전에 한 얘기까지 통째로 잊는다.★ 실제로 그렇게 보였다:
    //   "방금 니가 보낸 메시지에 있는 말이야??? 왜 본인이 방금 말한걸 기억을 못하지?"
    //   게다가 바로 위에서 이 sessionId 를 ★저장한 직후★ 다 — 저장하고 곧바로 지우고 있었다.
    //   ★thread 번호가 살아 있으면 그 대화는 이어받을 수 있다★ — 그때는 지우지 않는다.
    //   진짜로 못 이어받는 경우(resume 실패)는 클라이언트가 새 thread 로 떨어지고,
    //   그 새 번호가 위에서 저장되므로 ★스스로 낫는다★ — 여기서 지울 일이 아니다.
    if (!result.sessionId) {
      chatThreads.delete(chatId);
      sessions.clear(chatId); // 이번 턴에서 쓸 수 있는 thread 를 못 얻었다 = 그 세션은 못 쓴다
    } else {
      console.warn(`[codex-bridge] 턴 실패했지만 세션은 유지한다(thread 살아 있음): ${result.detail ?? "사유 없음"}`);
    }
    const errText = toMarkdownV2("⚠️ 일시적으로 응답을 만들지 못했어요. 잠시 후 다시 시도해 주세요.");
    // ★마지막 버블에 쓴다★ — 넘김이 일어났으면 첫 버블에 쓸 경우 오류가 진행 줄 위로 올라간다.
    if (bubbleId !== null) await edit(chatId, bubbleId, errText);
    else await send(chatId, errText);
    return { ok: false, turnOk: false, reply: "", detail: `codex_turn_failed:${result.detail}` };
  }
  // 성공 턴에서 첫 인사를 했다면 영속 마커를 남긴다 → 다음부터(재시작·새 스레드 포함) 재소개 안 함.
  if (!greetedBefore) markGreetedFirstContact(greetAgentId);
  let reply = result.reply;
  if (scheduleRequest && scheduleToolEnabled(deps)) {
    const marker = extractScheduleMarker(result.reply);
    if (marker) {
      reply = await registerReminder(marker, {
        agentId: selfAgentId,
        teamBaseUrl: deps.teamBaseUrl ?? process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7878/team",
      });
    }
  }

  // ④ 작업중 메시지를 답으로 교체(편집). 작업중 메시지가 없거나 편집 실패 시 신규 발신.
  //   ★교체 대상은 지금 쓰고 있는 마지막 버블이다.★ 진행 줄이 길어 새 버블로 넘어갔다면
  //   첫 버블에 답을 쓰면 답이 진행 줄 ★위★ 에 나타나고, 마지막 버블은 "작업 중" 인 채 남는다.
  //   ★모델이 쓴 Markdown 을 텔레그램 표기로 옮긴다★ — 원문 그대로 보내면 별표·백틱이 글자로 보인다.
  //   길이는 ★변환 뒤 UTF-16 기준★ 으로 나눈다. 이스케이프가 붙으면서 늘어나기 때문에
  //   원문이 한도 이하여도 변환 후 넘을 수 있다.
  const parts = splitForTelegram(toMarkdownV2(reply));
  let delivered = false;
  const first = parts[0] as string;
  if (bubbleId !== null) delivered = await edit(chatId, bubbleId, first);
  if (!delivered) {
    const newId = await send(chatId, first);
    delivered = newId !== null;
  }
  // 남은 조각은 이어서 보낸다 — 자르지 않는다.
  for (const rest of parts.slice(1)) {
    const id = await send(chatId, rest);
    if (id === null) { delivered = false; break; }
  }
  // ★`ok` 와 `turnOk` 는 다른 질문에 답한다★ (리뷰 지적 — 한 이름에 두 뜻이 들어 있었다).
  //   `ok` = 텔레그램에 ★보냈나★ · `turnOk` = 턴이 ★됐나★.
  //   bridge window 경로는 발신을 일부러 뗐으므로 `ok` 는 ★항상 false★ 다 — 거기서 `ok` 로 실패를 판정하면
  //   ★성공할 때마다 실패로 읽는다.★ 그 경로는 `turnOk` 를 본다.
  return { ok: delivered, turnOk: true, reply, detail: delivered ? "delivered" : "send_failed" };
}

/** 테스트/리셋용 — 채팅 thread 맥락 비우기. */
export function resetChatThreads(): void {
  chatThreads.clear();
}

// ── 라이브 텔레그램 I/O (토큰 필요 — 봇별 CODEX_BOT_TOKEN) ─────────────────────────
const TG_API = "https://api.telegram.org";

/** 텔레그램 발신 → 보낸 message_id 반환(작업중 메시지 교체용). */
/**
 * ★fetchFn 을 받는 이유★: 폴백(MarkdownV2 거부 → 표시 걷고 재전송)은 ★실패했을 때만 도는 분기★ 라
 * 주입 없이는 시험에서 한 번도 실행되지 않는다. 정말 필요한 순간에 처음 돌면 거기서 또 틀려도
 * 알 방법이 없고, 그 결과가 ★답이 통째로 사라짐★ — 이 코드가 막으려던 바로 그 상황이다.
 */
export function tgSend(token: string, fetchFn: typeof fetch = fetch): NonNullable<BridgeDeps["sendMessage"]> {
  let lastReason = "";
  const post = async (body: Record<string, unknown>): Promise<number | null> => {
    const res = await fetchFn(`${TG_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { ok?: boolean; result?: { message_id?: number }; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (j.ok && j.result?.message_id != null) return j.result.message_id;
    lastReason = tgFailureReason(j); // ★사유를 들고 있는다★ — 없으면 왜 막혔는지 영영 모른다
    return null;
  };
  return async (chatId, text) => {
    try {
      const id = await post({ chat_id: chatId, text, parse_mode: "MarkdownV2" });
      if (id !== null) return id;
      // ★MarkdownV2 로 거부되면 표시를 걷어내고 한 번 더.★ 이스케이프 한 곳이 어긋났다고
      //   답이 통째로 사라지면 안 된다.
      // ★흔적을 남긴다★ — 조용히 재시도하면 "한 번도 안 돌았다" 와 "매번 돌고 있다" 가
      //   로그에서 같은 모양이라, 표시가 계속 깨지고 있어도 아무도 모른다.
      //   ★원인은 단정하지 않는다★ — post 는 표시 거부만이 아니라 429·chat not found·비-JSON 응답에도
      //   null 을 낸다. "표시 때문" 이라고 적으면 rate limit 인데 이스케이프를 뒤지게 된다.
      //   (그런 경우엔 재전송도 같은 이유로 실패한다 — 로그만 남고 답은 여전히 안 간다.)
      console.warn(`[codex-bridge] 1차 전송 실패(MarkdownV2) → 순수 텍스트로 재전송: ${lastReason}`);
      const retried = await post({ chat_id: chatId, text: toPlain(text) });
      if (retried === null) console.warn(`[codex-bridge] ★재전송도 실패 — 이 답은 안 나간다★: ${lastReason}`);
      return retried;
    } catch {
      return null;
    }
  };
}

/** 텔레그램 메시지 편집(작업중 → 답). */
/** 폴백을 시험할 수 있게 fetchFn 을 받는다 — tgSend 주석 참조. */
/**
 * ★텔레그램이 왜 거절했는지를 남긴다.★
 *
 * 전에는 "재전송했다" 만 적었다. 그래서 라이브에서 한 턴에 20번 넘게 편집이 막히는데도
 * ★rate limit 인지 · 글자 모양 때문인지 · 내용이 그대로라 막힌 건지 구별이 안 됐다★ —
 * 그 상태로 고치면 고쳐졌는지도 모른다(2026-08-19 실측: 작업중 메시지가 둘로 갈라지는 현상).
 *
 * `description` 은 그대로 찍어도 안전하다 — 토큰이 안 실린다(#355 리뷰에서 확인).
 * `retry_after` 를 함께 찍으면 ★rate limit 인지 한 번에 갈린다.★
 */
export function tgFailureReason(j: { description?: string; error_code?: number; parameters?: { retry_after?: number } }): string {
  const retry = j.parameters?.retry_after;
  return [
    j.error_code !== undefined ? `code=${j.error_code}` : "",
    j.description ? `desc=${j.description}` : "",
    retry !== undefined ? `retry_after=${retry}s` : "",
  ].filter(Boolean).join(" · ") || "사유 없음(응답에 description 이 없다)";
}

export function tgEdit(token: string, fetchFn: typeof fetch = fetch): NonNullable<BridgeDeps["editMessage"]> {
  const post = async (body: Record<string, unknown>): Promise<{ ok: boolean; reason: string }> => {
    const res = await fetchFn(`${TG_API}/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { ok?: boolean; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    return j.ok === true ? { ok: true, reason: "" } : { ok: false, reason: tgFailureReason(j) };
  };
  return async (chatId, messageId, text) => {
    try {
      const first = await post({ chat_id: chatId, message_id: messageId, text, parse_mode: "MarkdownV2" });
      if (first.ok) return true;
      console.warn(`[codex-bridge] 1차 편집 실패(MarkdownV2) → 순수 텍스트로 재전송: ${first.reason}`);
      const second = await post({ chat_id: chatId, message_id: messageId, text: toPlain(text) });
      // ★둘 다 막히면 여기서 새 버블이 열린다★ — 화면이 갈라지는 그 순간이라 반드시 남긴다.
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
    chat: { id: number };
    text?: string;
    /** ★사진에 달린 설명★ — 사진 메시지는 text 가 아니라 caption 으로 온다. */
    caption?: string;
    /**
     * ★인용 답장의 원문.★ 사람이 앞 메시지를 집어 답하면 새 글자만 오고 ★무엇을 집었는지는 안 온다.★
     * 그룹방 경로는 이미 싣고 있었다(7군데) — ★1:1 만 0군데였다.★ 또 같은 축이다.
     */
    reply_to_message?: { text?: string; caption?: string; from?: { username?: string; first_name?: string } };
    /** ★같은 그림의 여러 크기★ (썸네일·중간·원본). 장수가 아니다 — 여러 장은 메시지가 나뉘어 온다. */
    photo?: DmMessageMedia["photo"];
    document?: DmMessageMedia["document"];
  };
  callback_query?: TgCallbackQuery;
}

interface TgCallbackQuery {
  id: string;
  data?: string;
  from?: { id: number };
  message?: { message_id: number; chat: { id: number } };
}

/**
 * ★이 브리지가 쓸 두뇌 — app-server 하나뿐이다.★
 *
 * > "그게 무슨 fallback 이야. 기능을 퇴보시키는 거지.. app server 로 돌게 해야지.
 * >  exec 방식은 deprecate 해. 자꾸 fallback 이런걸로 유지하지 마."
 *
 * 전에는 준비에 실패하면 `codex exec` 로 떨어뜨렸다. 그건 ★말은 통하지만 기능이 사라진 상태★ 다 —
 * 중간 개입도, 서브에이전트 생존도 없다. 그리고 ★조용해서 아무도 모른다.★
 * (그때 같이 적었던 "승인창" 은 지금 실행 정책이 "never" 라 app-server 쪽에도 없다.)
 * 그래서 떨어뜨리지 않는다. 준비가 안 되면 ★그 자리에서 시끄럽게 실패★ 시킨다.
 */
export function defaultBridgeCaller(): (o: CodexTurnOptions) => Promise<CodexTurnResult> {
  const { openDb } = require("../../db/migrate") as typeof import("../../db/migrate");
  const { makeAppServerCaller } = require("./appServerRunner") as typeof import("./appServerRunner");
  return makeAppServerCaller(openDb(defaultTeamDbPath()));
}

/**
 * team.db 경로 — ★환경변수에 기대지 않는다.★
 *
 * 실제로 그래서 승인 버튼이 죽었다(2026-08-12): `B3OS_REPO_ROOT ?? "."` 로 잡았는데
 * 브리지 프로세스에는 ★그 변수가 없어서★ cwd(팀원 작업폴더)의 team.db 를 찾았고,
 * 매 탭마다 "unable to open database file" 로 던져 ★답을 못 보냈다★ → 사람 화면엔 '로딩중' 만.
 * 이 파일 위치에서 저장소 루트를 세는 쪽이 환경과 무관하다.
 */
export function defaultTeamDbPath(): string {
  return process.env.B3OS_TEAM_DB ?? join(import.meta.dir, "..", "..", "..", "..", "team.db");
}

/**
 * ★승인 버튼을 이 팀원 방에서 처리한다.★
 *
 * 요청 자체는 서버가 이 봇으로 띄운다(appServerPopup.sendApprovalToMemberRoom).
 * getUpdates 는 봇당 한 프로세스만 가능하므로, 폴링을 하는 ★브리지가 콜백을 맡는다.★
 */
export async function handleApprovalCallback(
  token: string,
  cb: TgCallbackQuery,
  allowFrom: Set<number>,
  deps: { dbPath?: string; fetchFn?: typeof fetch } = {},
): Promise<"decided" | "ignored" | "stale" | "unauthorized"> {
  const doFetch = deps.fetchFn ?? fetch;
  const answer = (text: string, alert = false) =>
    doFetch(`${TG_API}/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: cb.id, text, show_alert: alert }),
    }).catch(() => undefined);

  const m = /^(pg1|pgs|pga|pgd):((?:apr|prm)_[a-f0-9]+)$/.exec(cb.data ?? "");
  if (!m) return "ignored";

  // 발신자 게이트 — 메시지와 같은 규칙(fail-closed).
  const fromId = cb.from?.id;
  if (fromId === undefined || !isAllowedChat(allowFrom, fromId)) {
    await answer("권한 없음", true);
    return "unauthorized";
  }

  const { openDb } = await import("../../db/migrate");
  const { decidePermissionRequest, getPermissionRequest } = await import("../../lib/permissionGate");
  const db = openDb(deps.dbPath ?? defaultTeamDbPath());
  try {
    const id = m[2]!;
    const row = getPermissionRequest(db, id);
    // ★이미 지난 요청은 지난 대로 알린다★ — 눌렀는데 아무 반응이 없으면 사람은 다시 누른다.
    if (!row || row.status !== "pending") {
      await answer(row ? `이미 처리됨(${row.status})` : "만료되었거나 없는 요청입니다");
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
      : m[1] === "pgs" ? "allow_session"   // ★이 세션 동안만★ — 지속 허가를 남기지 않는다
      : m[1] === "pga" ? "allow_always"
      : "deny";

    // ★'항상 허용' 은 codex 설정 파일에 쓴다.★
    //   우리 DB 에 영구 권한을 쌓지 않는다 — 그건 취소 경로가 없었다. 설정은 사람이 열어서 지울 수 있다.
    if (decision === "allow_always") {
      const target = (row as { target?: string }).target;
      // ★target 이 경로일 때만 설정에 쓴다.★ (2026-08-13 — 하네스 적대 검증에서 잡힘)
      //   `targetForOperation` 은 ★shell 작업의 target 을 "명령 문자열" 로 만든다.★ 그대로 넘기면
      //   `dirname("sudo whoami")` = "." · `dirname("rm -rf /Users/…/b3rys-team-os")` = "rm -rf /Users/…/Development"
      //   같은 ★쓰레기 값이 writable_roots 에 박힌다.★ 설정 파일은 사람이 읽는 유일한 기록이라
      //   거기에 거짓이 들어가면 안 된다. ⇒ 절대경로 하나(공백 없음)만 통과시킨다.
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
    if (!res.ok) { await answer(res.error ?? "실패", true); return "ignored"; }
    await answer(
      decision === "allow_once" ? "한번 허용"
      : decision === "allow_session" ? "이 세션 동안 허용"
      : decision === "allow_always" ? "항상 허용"
      : "거절",
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
	  // 발신자 게이트(allowlist, fail-closed): claude access.json allowFrom / openclaw ownerAllowFrom 와 동일 목적.
	  // 텔레그램은 봇 @username 아는 누구나 DM 가능 → 게이트 없으면 임의 사용자가 이 봇 정체성으로 codex 턴(quota/비용) 소진.
	  // CODEX_ALLOW_FROM=comma-sep chat_id (오너 DM·팀그룹, 런처가 자동 시드). 그 외 발신자 무시+audit. 미설정 시 전체 차단.
	  // ★복구는 dashboard/launchd/env 경로에서 해야 한다. in-band DM 복구를 위해 전체 허용하지 않는다.
  // ★chat_id(1:1 DM=user.id) 기반 — DM 게이트 정확. 그룹(chat.id 음수)은 팀원 공유라 외부인 그룹편입 시 from.id 2차체크 필요(P2).
  const allowFrom = parseAllowFrom(process.env.CODEX_ALLOW_FROM);
  let warnedNoAllowlist = false;
  const liveSandbox = deps.sandbox ?? agentRuntime.sandbox;
  const liveNetwork = deps.networkAccess ?? agentRuntime.networkAccess;
  const liveAgentId = deps.agentId ?? process.env.CODEX_AGENT_ID ?? "codex";
  const liveWorkspaceRoot = workdir ?? process.env.CODEX_WORKDIR ?? "";
  const live: BridgeDeps = {
    ...deps,
    workdir,
    codexHome,
    sandbox: liveSandbox,
    networkAccess: liveNetwork,
    // ★관리자 설정(agents.json codex_sandbox/network)을 permissionGate grant로 seed★.
    // 미주입 시 preflight가 workspace-write/network를 매 턴 tier-a "ask"로 차단 → Dex 구조적 실행불가
    // (2026-07-05 GD 테스트에서 "덱스 있어?"조차 dead-end로 발견). Tier-D(danger-full-access)는 이 grant로도
    // 통과 못 함(hardDeny가 grant보다 우선). scope는 preflight의 workspaceRoot 산출과 동일 값으로 맞춤.
    permissionContext: deps.permissionContext ?? {
      workspaceRoot: liveWorkspaceRoot,
      grants: codexConfiguredGrants(liveAgentId, liveSandbox, liveNetwork, liveWorkspaceRoot),
    },
    // 라이브에서는 1:1 세션을 team.db 에 기억한다(재시작 넘어 맥락 유지).
    // ★agentId 를 실어 보낸다★ — 안 실으면 handleMessage 가 같은 식을 다시 계산해,
    //   runBridge({agentId}) 로 부를 때 두 값이 갈린다. 그러면 steer 가 등록 안 된 id 를 찾아 늘 실패한다.
    agentId: liveAgentId,
    dmSessions: deps.dmSessions ?? makeChatSessionStore(liveAgentId, defaultTeamDbPath()),
    sendMessage: deps.sendMessage ?? tgSend(token),
    editMessage: deps.editMessage ?? tgEdit(token),
    reactMessage: deps.reactMessage ?? tgReact(token),
  };
  let offset = 0;
  let readyMarked = false;
  const pidFile = process.env.CODEX_BRIDGE_PID_FILE ?? "";
  console.log(`[codex-bridge] 시작(long-poll). workdir=${workdir ?? "(none)"}`);
  // ★ready marker를 첫 long-poll 응답이 아니라 getMe 직후 즉시 기록 — 대기 메시지 없는 새 봇은 첫
  //   getUpdates(timeout=30)가 ~30s 뒤 반환이라 marker도 ~30s 뒤였고, 활성화 게이트(28s)가 그보다 짧아
  // 건강한 브리지를 '미기동'으로 오판했다(BUG5, GD 맥북테스트 2026-07-03). getMe는 즉시 반환+토큰/도달성
  //   검증이라 '폴링 진입=ready'로 안전. getMe 실패 시엔 아래 getUpdates-후-marker 폴백이 그대로 커버.
  try {
    const me = await fetch(`${TG_API}/bot${token}/getMe`);
    const mj = (await me.json()) as { ok?: boolean };
    if (mj.ok === true && !readyMarked) {
      readyMarked = writeBridgeReadyMarker(pidFile);
      if (readyMarked) console.log(`[codex-bridge] ready marker(getMe): ${pidFile}`);
    }
  } catch (e) {
    console.error(`[codex-bridge] getMe 실패(토큰/네트워크?) — getUpdates 후 marker 폴백: ${e instanceof Error ? e.message : e}`);
  }
  // ★턴을 여기서 기다리지 않는다★ — 기다리면 턴이 도는 동안 getUpdates 를 못 부르고,
  //   승인 팝업은 턴 도중에만 떴으므로 버튼 입력이 영영 안 들어왔다(과거 on-request 시절 ·
  //   지금은 정책이 "never" 라 팝업 자체가 없다 · 실측 2026-08-18: 승인 6건 중
  //   8건이 연속으로 만료됐고(2026-08-13 11:35 ~ 08-18 11:18) 그중 6건이 300~302초 =
  //   턴 하드 타임아웃 300초. 사람이 누른 기록은 6건 있었으나 그 결정이 codex 로 전달된 건은 0건).
  //   ★직렬이다★ — 겹쳐 돌리면 app-server 클라이언트(팀원 단위 공유)의 turn 상태가 덮어써진다.
  const turns = createSerialTurnQueue((e) => {
    console.error(`[codex-bridge] 턴 처리 실패: ${e instanceof Error ? e.message : e}`);
  });

  // ★그룹 턴은 서버(capture)가 bridge window 로 넣는다★ — 오너 판정은 거기서 이미 끝났다.
  //   같은 `turns` 큐를 타므로 ★한 팀원 한 턴★ 불변식이 유지된다(1:1 과 겹치지 않는다).
  //   리액션은 ★이 봇으로★ 단다 — 팀 op 봇이 달면 "누가 받았는지" 가 안 보인다(리뷰 지적).
  const windowHandle = await startBridgeWindow({
    agentId: liveAgentId,
    pidFile,
    log: (line) => console.log(line),
    enqueue: (r) => {
      const chatId = Number(r.groupId);
      if (!Number.isFinite(chatId)) {
        console.log(`[codex-bridge] 창구 요청 무시: groupId 가 숫자가 아니다 msg=${r.messageId}`);
        return;
      }
      const tgMsgId = r.origTgMessageId ? Number(r.origTgMessageId) : undefined;
      if (tgMsgId !== undefined && Number.isFinite(tgMsgId)) {
        void live.reactMessage?.(chatId, tgMsgId, "👀");
      }
      turns.enqueue(() => runGroupTurn({ deps: live, agentId: liveAgentId, repoRoot: REPO_ROOT, chatId, tgMsgId, req: r }));
    },
  });
  if (windowHandle) {
    // ★신호 처리기를 달면 Node 의 기본 종료가 사라진다★.
    //   bridge window 만 닫고 끝내면 폴 루프가 계속 돌아 ★SIGTERM 으로 안 죽는다★ —
    //   launchd 재기동이 SIGKILL 까지 기다리게 된다. 치우고 ★직접 나간다.★
    const stop = () => {
      // ★종료에 물려 사라지는 턴을 기록에 남긴다★.
      //   bridge window 는 202(접수)까지만 답한다. 이미 접수돼 큐에 든 턴은 여기서 프로세스가 끝나며
      //   ★확정적으로 사라지는데, 안 돌았다는 기록이 어디에도 없다★ —
      //   ★보낸 쪽은 갔다고 믿고 받는 쪽은 온 적이 없는★, 이 bridge window가 고치려는 그 실패 모양이다.
      //   막지는 않는다(비우려면 종료가 늘어진다). 남은 개수를 남겨 나중에 읽히게 한다.
      //   ★이 줄이 남는 이유는 조건부다★: `process.exit(0)` 은 ★버퍼를 안 비우고★
      //   나간다. 지금 살아남는 것은 stdout 이 ★일반 파일★ 이라 Node 가 동기로 쓰기 때문이다
      //   (`launcher.ts` — plist 의 `StandardOutPath` 가 파일이고, wrapper 의 `exec bun` 뒤에 파이프가 없다).
      //   ★wrapper 에 `| tee` 같은 파이프를 하나 붙이면 stdout 이 파이프(비동기)가 되어 이 줄이 잘린다★ —
      //   "안 돌았다" 를 증명하려고 넣은 기록이 바로 그 순간 같이 사라진다.
      const left = turns.pendingCount();
      if (left > 0) console.log(`[codex-bridge] 종료 — ★큐에 남은 턴 ${left}건은 돌지 않는다★`);
      try {
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
      const res = await fetch(`${TG_API}/bot${token}/getUpdates?timeout=30&offset=${offset}&allowed_updates=["message","callback_query"]`);
      const j = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
      if (j.ok === true && !readyMarked) {
        readyMarked = writeBridgeReadyMarker(pidFile);
        if (readyMarked) console.log(`[codex-bridge] ready marker: ${pidFile}`);
      }
      for (const u of j.result ?? []) {
        offset = u.update_id + 1;
        // ★승인 버튼은 이 방에서 처리한다.★ 요청은 서버가 이 봇으로 띄우고, 누르는 것은 여기서 받는다
        //   (getUpdates 는 봇당 한 프로세스만 가능하므로 폴링을 하는 브리지가 콜백도 맡는다).
        // ★콜백 예외가 폴 루프를 죽이면 안 된다★ — 죽으면 그 뒤 메시지도 안 받는다.
        if (u.callback_query) {
          try { await handleApprovalCallback(token, u.callback_query, allowFrom); }
          catch (e) { console.error(`[codex-bridge] 승인 콜백 처리 실패: ${e instanceof Error ? e.message : e}`); }
          continue;
        }
        const msg = u.message;
        const chatId = msg?.chat.id;
        const messageId = msg?.message_id;
        // ★사진 메시지는 text 가 없다 — 설명은 caption 으로 온다.★
        //   전에는 여기서 text 만 보고 걸렀다. 그래서 ★사진만 보낸 메시지는 통째로 버려졌다★ —
        //   로그에도 안 남아 "무시당했다" 로 보였다(팀장님 관측: "이미지 첨부하면 못 읽는다").
        const decided = decideDmMessage(msg);
        if (chatId === undefined || !decided.handle) continue;
        const { text, hasMedia } = decided;
	        // 발신자 게이트(fail-closed): 허용 목록이 비어 있거나 미포함이면 무시한다.
	        if (!isAllowedChat(allowFrom, chatId)) {
	          if (allowFrom.size === 0 && !warnedNoAllowlist) {
	          warnedNoAllowlist = true;
	            console.warn("[codex-bridge] ⛔ CODEX_ALLOW_FROM 미설정 — fail-closed 로 모든 발신자를 차단합니다. 런처 시드 or 영입 시 오너 chat_id 확보 필요.");
	          } else {
	            console.warn(`[codex-bridge] ⛔ 미허용 발신자 chat ${chatId} 무시(allowlist). text=${text.slice(0, 40)}`);
	          }
	          continue;
	        }
        console.log(`[codex-bridge] ← chat ${chatId}: ${text.slice(0, 60)}`);
        // ★도는 중인 작업이 있으면 그 안으로 밀어 넣는다.★ 새 턴으로 줄을 세우면 하던 일이 끝날
        //   때까지 답이 없어 ★못 듣는 것처럼 보인다★ — 실제로 그렇게 보였다(2026-08-19 실측:
        //   메시지 4건이 전부 로그에 들어와 있는데 답이 없었다).
        //   turn/steer 는 turnId 를 요구하므로 ★막 시작해 번호가 아직 없으면 실패★ 한다. 그때는 아래로 내려가
        //   지금처럼 새 턴이 된다 — 실패를 조용히 삼키지 않는다.
        // ★루프는 여기서도 기다리지 않는다★ — 기다리면 승인 버튼이 다시 막힌다.
        void routeIncoming(chatId, text, {
          isRunning: isTurnRunningFor,
          // ★도중에 붙인 그림도 그 작업 안으로 넣는다.★ 여기서 내려받아도 폴 루프는 안 막힌다 —
          //   위에서 routeIncoming 을 기다리지 않기 때문이다(await 를 붙이면 승인 버튼이 다시 막힌다).
          steer: (t) => steerWithAttachments(t, {
            fetchAttachments: hasMedia && msg ? () => downloadDmAttachmentsSafe(token, msg) : null,
            steer: (body, imagePaths) => steerActiveTurn(liveAgentId, body, imagePaths),
          }),
          note: (line) => {
            // 턴이 방금 끝났으면 통로가 닫혀 있다 — 그때는 남기지 않는다.
            //   ★닫힌 뒤에 남기면 답을 쓴 자리에 진행 줄이 덮인다.★ 유실이 아니라 안전 쪽이다.
            noteIntoRunningTurn?.(line);
          },
          enqueue: (run) => turns.enqueue(run),
          runTurnFor: async () => {
            const r = await handleMessage(chatId, text, messageId, live, hasMedia && msg
              ? () => downloadDmAttachmentsSafe(token, msg)
              : undefined);
            console.log(`[codex-bridge] → ${r.detail}: ${r.reply.slice(0, 60)}`);
          },
          react: () => { if (messageId !== undefined) void live.reactMessage?.(chatId, messageId, "👀"); },
        }).then((route) => {
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

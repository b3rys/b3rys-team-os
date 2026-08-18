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
import { createSerialTurnQueue } from "./serialTurnQueue";
import { makeDmSessionStore, NOOP_DM_SESSION_STORE, type DmSessionStore } from "./dmSessionStore";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../../lib/registry";
import { appendAuditFile } from "../../lib/auditFile";
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
 * 텔레그램 메시지 1건 처리(순수 로직 — 토큰 불필요, mock 테스트 가능).
 * 흐름: 👀 리액션 → "작업 중…" 게시 → codex 턴 → 작업중 메시지를 답으로 교체(편집 실패 시 신규 발신).
 */
export async function handleMessage(
  chatId: number,
  text: string,
  messageId: number | undefined,
  deps: BridgeDeps = {},
): Promise<{ ok: boolean; reply: string; detail: string }> {
  // ★브리지도 app-server 로 간다.★
  //   전에는 브리지만 옛 exec 경로였다 — 그래서 ★사람이 직접 말 거는 길에만★ 그때까지의 개선
  //   (중간 개입 · 프로세스 상주 · 서브에이전트 생존 · 승인창)이 하나도 안 붙어 있었다.
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
  // ★이 브리지가 '누구' 인지는 한 곳에서만 정한다★ (리뷰 지적).
  //   같은 식이 아래 네 곳에 흩어져 있었다. 그중 하나라도 빠지면 ★남의 신원으로 도는데★
  //   그게 승인 요청의 주인으로도 쓰인다 — 실제로 dex 요청 4건이 codex 앞으로 기록됐다.
  const selfAgentId = deps.agentId ?? process.env.CODEX_AGENT_ID ?? "codex";

  if (chatId < 0 && messageId !== undefined) {
    const shadowOn = process.env.CODEX_GROUP_NATIVE_DENY_SHADOW === "true";
    const enforceOn = process.env.CODEX_GROUP_NATIVE_DENY === "true";
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
        return { ok: true, reply: "", detail: "group_native_denied" };
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
    const errText = "⚠️ 권한 게이트가 이 Codex 런타임 실행을 막았습니다. 설정 승인이 필요합니다.";
    if (workingMsgId !== null) await edit(chatId, workingMsgId, errText);
    else await send(chatId, errText);
    return { ok: false, reply: "", detail: `permission_${preflight.tier}:${preflight.rule}` };
  }
  // ★진행 표시★ — codex 가 도구를 시작할 때마다 오는 줄을 모아 "작업 중…" 메시지를 고쳐 쓴다.
  //   창이 없는 런타임이라 이게 없으면 사람 눈에는 몇 분간 문구 하나만 남는다.
  //   간격·자르기·넘김 기준은 hermes 실구현 값을 그대로 쓴다(progressLines.ts 주석).
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
    const text = renderBubble(workingText, lines);
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

  const onActivity = (line: string): void => {
    if (bubbleId === null) return;
    const next = appendLine(lines, line);
    if (next === lines) return; // 빈 줄이라 담을 것이 없다
    if (!fits(workingText, next)) {
      // ★한도에 닿으면 지금 버블은 남기고 새 버블로 넘어간다★ — 어디까지 했는지가 사라지지 않는다.
      lines = appendLine([], line);
      dirty = true;
      void (async () => {
        const fresh = await send(chatId, renderBubble(workingText, lines));
        if (fresh !== null) { bubbleId = fresh; dirty = false; lastEditAt = Date.now(); }
      })();
      return;
    }
    lines = next;
    dirty = true;
    schedule();
  };

  const result = await runTurn({
    prompt: promptText,
    agentId: selfAgentId, // ★필수★ — 승인 요청의 주인이 된다
    onActivity,

    resumeSessionId: prior,
    codexHome: deps.codexHome,
    cwd: deps.workdir,
    sandbox: deps.sandbox,
    networkAccess: deps.networkAccess,
    writableRoots: deps.workdir ? [deps.workdir] : [],
  });
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
    // self-heal: 턴 실패(만료·손상 세션 포함) 시 thread 초기화 → 다음 턴은 새 세션(죽은 sessionId resume 반복 stuck 방지).
    chatThreads.delete(chatId);
    sessions.clear(chatId); // ★죽은 세션을 저장해두면 재시작 후에도 계속 그것으로 resume 한다★
    const errText = "⚠️ 일시적으로 응답을 만들지 못했어요. 잠시 후 다시 시도해 주세요.";
    // ★마지막 버블에 쓴다★ — 넘김이 일어났으면 첫 버블에 쓸 경우 오류가 진행 줄 위로 올라간다.
    if (bubbleId !== null) await edit(chatId, bubbleId, errText);
    else await send(chatId, errText);
    return { ok: false, reply: "", detail: `codex_turn_failed:${result.detail}` };
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
  let delivered = false;
  if (bubbleId !== null) delivered = await edit(chatId, bubbleId, reply);
  if (!delivered) {
    const newId = await send(chatId, reply);
    delivered = newId !== null;
  }
  return { ok: delivered, reply, detail: delivered ? "delivered" : "send_failed" };
}

/** 테스트/리셋용 — 채팅 thread 맥락 비우기. */
export function resetChatThreads(): void {
  chatThreads.clear();
}

// ── 라이브 텔레그램 I/O (토큰 필요 — 봇별 CODEX_BOT_TOKEN) ─────────────────────────
const TG_API = "https://api.telegram.org";

/** 텔레그램 발신 → 보낸 message_id 반환(작업중 메시지 교체용). */
function tgSend(token: string): NonNullable<BridgeDeps["sendMessage"]> {
  return async (chatId, text) => {
    try {
      const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      const j = (await res.json()) as { ok?: boolean; result?: { message_id?: number } };
      return j.ok && j.result?.message_id != null ? j.result.message_id : null;
    } catch {
      return null;
    }
  };
}

/** 텔레그램 메시지 편집(작업중 → 답). */
function tgEdit(token: string): NonNullable<BridgeDeps["editMessage"]> {
  return async (chatId, messageId, text) => {
    try {
      const res = await fetch(`${TG_API}/bot${token}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
      });
      const j = (await res.json()) as { ok?: boolean };
      return j.ok === true;
    } catch {
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
  message?: { message_id: number; chat: { id: number }; text?: string };
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
 * 중간 개입도, 서브에이전트 생존도, 승인창도 없다. 그리고 ★조용해서 아무도 모른다.★
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

  const m = /^(pg1|pga|pgd):((?:apr|prm)_[a-f0-9]+)$/.exec(cb.data ?? "");
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
    const decision = m[1] === "pg1" ? "allow_once" : m[1] === "pga" ? "allow_always" : "deny";

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
    await answer(decision === "allow_once" ? "한번 허용" : decision === "allow_always" ? "항상 허용" : "거절");
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
    dmSessions: deps.dmSessions ?? makeDmSessionStore(liveAgentId, defaultTeamDbPath()),
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
  //   승인 팝업은 턴 도중에만 뜨므로 버튼 입력이 영영 안 들어온다(실측 2026-08-18: 승인 6건 중
  //   8건이 연속으로 만료됐고(2026-08-13 11:35 ~ 08-18 11:18) 그중 6건이 300~302초 =
  //   턴 하드 타임아웃 300초. 사람이 누른 기록은 6건 있었으나 그 결정이 codex 로 전달된 건은 0건).
  //   ★직렬이다★ — 겹쳐 돌리면 app-server 클라이언트(팀원 단위 공유)의 turn 상태가 덮어써진다.
  const turns = createSerialTurnQueue((e) => {
    console.error(`[codex-bridge] 턴 처리 실패: ${e instanceof Error ? e.message : e}`);
  });

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
        const text = u.message?.text;
        const chatId = u.message?.chat.id;
        const messageId = u.message?.message_id;
        if (!text || chatId === undefined) continue;
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
        // ★턴은 하나씩 돈다(직렬).★ 루프는 기다리지 않고 다음 업데이트로 간다 — 그래야 승인 버튼이 들어온다.
        turns.enqueue(async () => {
          const r = await handleMessage(chatId, text, messageId, live);
          console.log(`[codex-bridge] → ${r.detail}: ${r.reply.slice(0, 60)}`);
        });
      }
    } catch (e) {
      console.error("[codex-bridge] poll 오류:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (import.meta.main) void runBridge();

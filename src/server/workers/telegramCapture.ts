import type { AgentRecord, WsEvent } from "../types";
import type { Database } from "bun:sqlite";
import { routeTeamMessageHybrid } from "../lib/teamRouter";
import { setGroupOwner, getGroupOwners } from "../lib/groupOwner";
import { appendAuditFile } from "../lib/auditFile";
import { injectPrompt } from "../lib/tmuxInject";
import { injectOpenclawTelegramTurn } from "../lib/openclawBridge";
import { recordReportDelivery } from "../bus/deliveryRecord";
import { postTelegramAsHermes, reactTelegramAsHermes, runHermesTeamTurn } from "../lib/hermesBridge";
import { teamContextForAgent } from "../lib/teamContextPolicy";
import { hasCapability } from "../lib/capabilities";
import { aliasesFor } from "../lib/teamRouter";
import { telegramChannel } from "../channels/telegram";
import { insertMessage, recentThreadMessages, acceptInbound, ensureThread } from "../db/inboxQueries";
import { applyActivityAutoAck } from "../bus/ackClose";
import { listApprovals, listActions, getApproval, setApprovalStatus, approveByTrustedTap, isExecutionEnabled, enqueueApproval, getNormalApprovers, canApproveTier } from "../lib/approvals";
import { setAgentEnabled, isAgentOff, restartAgent, restartAll, stopAll } from "../lib/agentControl";
import { listStatuses, getStatus } from "../db/queries";
import { classifyHealth } from "../lib/health";
import { storeTelegramMedia, type StoredMedia, type TelegramMediaRef } from "../lib/mediaStore";
import { BODY_MAX_CHARS, buildDedupeKey } from "../../shared/envelopeSchema";
import { getCaptureToken, isRouterEnabled, getCaptureGroupId, getLocale } from "../lib/captureConfig";
import { pick, type Locale } from "../lib/i18n";
import { rememberCaptureNonBotSender, rememberDiscoveredGroup } from "../lib/telegramLeadDetection";
import { decidePermissionRequest, getPermissionRequest, listPermissionRequests } from "../lib/permissionGate";

// 승인 시스템 v2(OWNER 2026-07-08) — 신청자 알림 문구(순수·i18n). 승인/거절/보류 3종, 결정 승인자 명시 →
// 신청자가 그 승인자에게 직접 문의. 재요청 "방법"은 명시 안 함(OWNER 심플·신청자가 알아서).
export function approvalApprovedNotice(title: string, approver: string, locale: Locale): string {
  return pick(locale,
    `✅ 승인·처리됨 — ${title}\n승인: ${approver}`,
    `✅ Approved & done — ${title}\nBy: ${approver}`);
}
export function approvalRejectedNotice(title: string, approver: string, locale: Locale): string {
  return pick(locale,
    `❌ 승인 거절 — ${title}\n거절: ${approver}\n사유·재요청은 ${approver}에게 문의하세요.`,
    `❌ Rejected — ${title}\nBy: ${approver}\nAsk ${approver} for the reason or to re-request.`);
}
export function approvalDeferredNotice(title: string, approverHint: string, locale: Locale): string {
  return pick(locale,
    `⏳ 승인 보류 — ${title}\n10분 내 미승인으로 자동 보류됐어요.\n승인 담당: ${approverHint}\n${approverHint}에게 문의하거나 다시 올려주세요.`,
    `⏳ Approval deferred — ${title}\nAuto-deferred: no response within 10 min.\nApprovers: ${approverHint}\nAsk ${approverHint} or re-submit.`);
}

// 승인 v2(OWNER 2026-07-08 토큰절약): 머지 승인은 풀 전원 알림이 아니라 ★한 명에게만 배정★(4명 중복분석=토큰낭비).
//   살아있는(agent_status != offline) 승인자 우선, id 해시로 분산 배정(상태없는 라운드로빈 근사). 다 죽었으면
//   풀 전체에서 배정(신청자가 나중에 수동 재배정). 배정된 1명만 리뷰 → 토큰 1인분.
export function pickMergeApprover(db: Database, pool: string[], seed: string): string | undefined {
  if (!pool.length) return undefined;
  const live = pool.filter((a) => { const s = getStatus(db, a); return s && s.state !== "offline"; });
  const cands = live.length ? live : pool;
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return cands[h % cands.length];
}

// 전용 캡처봇 토큰 — var/secrets/capture.bot-token(0600) → 없으면 env(CAPTURE_BOT_TOKEN) fallback.
// (P0) UI(Settings▸시스템OP)로 설정 가능. 변경 적용은 워커 재init(restartCapture). 없으면 워커 inert — 라이브 흐름 안 건드림.
// ★let (const 아님): startTelegramCapture 재init(대시보드 토큰/그룹 저장) 마다 파일에서 다시 읽어 갱신한다.
//   const 로 두면 모듈 로드 시 1회만 평가돼, 재init 해도 옛 토큰/그룹으로 폴링(자동적용 no-op). OWNER 2026-07-19 하네스 BLOCKER 수정.
let TOKEN = getCaptureToken();
// 대상 그룹 (현재 supergroup). 비우면 모든 그룹. (P0) var/capture-group-id.txt → env fallback. 재init 시 갱신(아래 start 진입부).
let GROUP_ID = getCaptureGroupId() ?? "";
// injection 킬스위치 — 이제 *라이브 읽기*(isRouterEnabled(deps.db)). UI 토글 즉시 반영, 재시작 불요. (P0)
// OFF면 결정 로깅만(shadow). store(setting router_enabled) 우선, 없으면 env(ROUTER_ENABLED) fallback.
const OFFSET_PATH = process.env.CAPTURE_OFFSET_PATH ?? `${process.cwd()}/logs/telegram-capture-offset.txt`;
export function mediaUrlBase(): string {
  const publicBase = (process.env.TEAM_PUBLIC_BASE_URL ?? process.env.TEAM_BASE_URL ?? "").replace(/\/$/, "");
  const basePath = (process.env.BASE_PATH ?? "/team").replace(/\/$/, "");
  return `${publicBase}${basePath}/media`;
}

type BusAttachment = {
  kind: "path" | "url";
  value: string;
  note?: string;
};

interface CaptureDeps {
  agents: () => AgentRecord[];
  db: Database;
  broadcast?: (e: WsEvent) => void;
}

interface TgUpdate {
  update_id: number;
  message?: {
    text?: string;
    caption?: string;
    message_id?: number;
    chat?: { id?: number; type?: string };
    from?: { id?: number | string; is_bot?: boolean; username?: string; first_name?: string };
    reply_to_message?: { text?: string; from?: { username?: string; first_name?: string } };
    photo?: Array<{
      file_id: string;
      file_unique_id?: string;
      width?: number;
      height?: number;
      file_size?: number;
    }>;
    document?: {
      file_id: string;
      file_unique_id?: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number; is_bot?: boolean; first_name?: string };
    message?: { message_id?: number; chat?: { id?: number; type?: string } };
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readStoredOffset(): Promise<number | undefined> {
  try {
    const raw = (await Bun.file(OFFSET_PATH).text()).trim();
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function storeOffset(nextOffset: number): Promise<void> {
  try {
    await Bun.write(OFFSET_PATH, `${nextOffset}\n`);
  } catch (e) {
    console.error("[capture] offset persist failed:", (e as Error).message);
  }
}

async function primeOffsetFromTelegram(): Promise<number> {
  try {
    const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=0&offset=-1&allowed_updates=["message"]`;
    const res = await fetch(url);
    const data = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
    const last = data.result?.at(-1);
    const nextOffset = last ? last.update_id + 1 : 0;
    await storeOffset(nextOffset);
    return nextOffset;
  } catch (e) {
    console.error("[capture] offset prime failed:", (e as Error).message);
    return 0;
  }
}

export function shouldUseNativeCodexOpenclawPath(
  text: string,
  agent: AgentRecord,
  replyToAgentId?: string,
): boolean {
  if (!hasCapability(agent, "native_routing")) return false;
  if (replyToAgentId === agent.id) return true;
  // native(openclaw plugin) 경로가 직접 잡는 명시 @멘션 토큰 — agents.json 별칭에서 생성(실명 X).
  // 경계 lookahead 유지(조사 비포함): "@member가 ..." 는 native 가 못 잡으므로 false(기존 동작 보존).
  const nativeMentions = aliasesFor(agent).map((a) => (a.startsWith("@") ? a : "@" + a));
  return nativeMentions.some((mention) => {
    const escaped = mention.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[\\s,.:;!?])${escaped}(?=[\\s,.:;!?]|$)`, "i").test(text);
  });
}

export function telegramOriginMeta(chatId: string, messageId?: string): Record<string, unknown> | undefined {
  if (!messageId) return undefined;
  return {
    telegram: {
      chat_id: chatId,
      message_id: messageId,
      source: "capture",
    },
  };
}

export function telegramOriginDedupeKey(chatId: string, messageId?: string): string | null {
  return messageId ? `telegram:${chatId}:${messageId}` : null;
}

export function bestPhoto(
  photos: NonNullable<NonNullable<TgUpdate["message"]>["photo"]> | undefined,
): NonNullable<NonNullable<TgUpdate["message"]>["photo"]>[number] | undefined {
  return photos?.slice().sort((a, b) => {
    const as = a.file_size ?? ((a.width ?? 0) * (a.height ?? 0));
    const bs = b.file_size ?? ((b.width ?? 0) * (b.height ?? 0));
    return bs - as;
  })[0];
}

export function telegramMediaRefs(msg: NonNullable<TgUpdate["message"]>): TelegramMediaRef[] {
  const refs: TelegramMediaRef[] = [];
  const photo = bestPhoto(msg.photo);
  if (photo) {
    refs.push({
      kind: "photo",
      file_id: photo.file_id,
      file_unique_id: photo.file_unique_id,
      file_size: photo.file_size,
      width: photo.width,
      height: photo.height,
      mime_type: "image/jpeg",
    });
  }
  // 모든 document 첨부를 캡처(이미지 한정 게이트 제거 — OWNER 2026-07-03: 일반 사용자가
  // .md·pdf 등 문서를 팀방에 올려 담당자에게 전달하는 건 기본 기능). 다운로드는 텔레그램
  // getFile 20MB 상한으로 자연 제한. 저장 후 media URL/경로로 에이전트에 노출(실행 아님·열람용).
  const doc = msg.document;
  if (doc) {
    refs.push({
      kind: "document",
      file_id: doc.file_id,
      file_unique_id: doc.file_unique_id,
      file_name: doc.file_name,
      mime_type: doc.mime_type,
      file_size: doc.file_size,
    });
  }
  return refs;
}

export function isImageDocument(doc: NonNullable<NonNullable<TgUpdate["message"]>["document"]>): boolean {
  if (doc.mime_type?.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif)$/i.test(doc.file_name ?? "");
}

async function captureMedia(msg: NonNullable<TgUpdate["message"]>, msgId?: string): Promise<StoredMedia[]> {
  const media: StoredMedia[] = [];
  if (!TOKEN) return media;
  for (const ref of telegramMediaRefs(msg)) {
    try {
      media.push(await storeTelegramMedia(TOKEN, ref, { urlBase: mediaUrlBase() }));
    } catch (e) {
      appendAuditFile("capture", "telegram_media_store_failed", ref.file_id, {
        chat_id: GROUP_ID,
        message_id: msgId ?? null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return media;
}

function mediaAttachments(media: StoredMedia[]): BusAttachment[] {
  return media.map((m) => ({
    kind: "url",
    value: m.url_path,
    note: `${m.kind}:${m.media_id}${m.mime_type ? `; mime=${m.mime_type}` : ""}${m.file_size ? `; bytes=${m.file_size}` : ""}`,
  }));
}

export function findExistingTelegramOriginMessage(
  db: Database,
  chatId: string,
  messageId?: string,
): string | null {
  if (!messageId) return null;
  const dedupeKey = telegramOriginDedupeKey(chatId, messageId);
  const row = db
    .prepare(
      `SELECT id FROM message
       WHERE dedupe_key = ?
          OR (
            json_extract(meta_json, '$.telegram.chat_id') = ?
            AND json_extract(meta_json, '$.telegram.message_id') = ?
          )
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(dedupeKey, chatId, messageId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * 텔레그램 그룹 → 라우터 캡처 브리지 (라이브 통합 Stage 1 자동화).
 * 전용 캡처봇 토큰으로 getUpdates 롱폴 → 그룹 메시지를 routeTeamMessageHybrid 에 넣어
 * 누가 답할지 결정 + audit 로깅. injection 은 ROUTER_ENABLED 시에만(현재 OFF=shadow).
 * 봇 발신 메시지는 무시(루프 방지). 토큰 없으면 비활성.
 */
// 답장 원문 작성자(봇 username)를 agent id 로 매핑. @멘션 없을 때 라우터가 owner 로 씀.
// OWNER 본인/외부 메시지에 대한 답장이면 매칭 없음 → undefined (reply-owner 미적용).
// (2026-06-06 split: startTelegramCapture 클로저 → 모듈 함수. agents 를 인자로 받는 것 외 동작 동일.)
export function replyAuthorAgentId(fromUsername: string | undefined, agents: AgentRecord[]): string | undefined {
  if (!fromUsername) return undefined;
  // P3 신원 seam: 채널 어댑터로 위임. channel_identities.telegram 우선 → legacy telegram_bot_username 폴백.
  // resolveAgentId는 @·대소문자 정규화가 동일 → 기존 .find()와 byte-동일 결과(폴백 경로). null→undefined 변환.
  return telegramChannel.resolveAgentId(fromUsername, agents) ?? undefined;
}

export function applyTelegramBotActivityAutoAck(
  db: Database,
  opts: {
    chatId: string;
    messageId?: string;
    from?: { is_bot?: boolean; username?: string };
    agents: AgentRecord[];
  },
): { agentId: string | null; acked: number } {
  if (!opts.from?.is_bot) return { agentId: null, acked: 0 };
  const agentId = replyAuthorAgentId(opts.from.username, opts.agents);
  if (!agentId) return { agentId: null, acked: 0 };
  const triggerMessageId = telegramOriginDedupeKey(opts.chatId, opts.messageId) ?? `telegram:${opts.chatId}:bot-activity`;
  const res = applyActivityAutoAck(db, agentId, triggerMessageId);
  return { agentId, acked: res.acked };
}

// ── 슬래시 명령(팀op 운영성 응답, OWNER 2888) formatter — 순수 DB read ───────────
// (2026-06-06 split: 클로저 → 모듈 함수, db/agents 인자화. 동작 동일.)
type TaskRow = { lane: string; title: string; owner: string | null };
export function allTasks(db: Database): TaskRow[] {
  return db
    .prepare("SELECT lane, title, owner FROM task ORDER BY lane, sort_order")
    .all() as TaskRow[];
}
function byLane(rows: TaskRow[], lane: string): TaskRow[] {
  return rows.filter((r) => (r.lane || "plan") === lane);
}
function taskLine(t: TaskRow): string {
  return `· ${t.title}${t.owner ? ` — @${t.owner}` : ""}`;
}
export function fmtBoard(db: Database): string {
  const locale = getLocale(db);
  const rows = allTasks(db);
  const out = [pick(locale, "📋 칸반 작업 보드", "📋 Kanban task board")];
  const labels: Array<[string, string]> = [["plan", pick(locale, "📝 계획", "📝 Plan")], ["doing", pick(locale, "🔧 실행 중", "🔧 Doing")], ["done", pick(locale, "✅ 완료", "✅ Done")]];
  for (const [k, label] of labels) {
    const items = byLane(rows, k);
    out.push(`\n${label} (${items.length})`);
    const show = k === "done" ? items.slice(-5) : items;
    for (const t of show) out.push(taskLine(t));
    if (k === "done" && items.length > 5) out.push(pick(locale, `  …외 ${items.length - 5}건`, `  …and ${items.length - 5} more`));
    if (!items.length) out.push("  —");
  }
  return out.join("\n");
}
export function fmtReview(db: Database): string {
  const locale = getLocale(db);
  const doing = byLane(allTasks(db), "doing");
  if (!doing.length) return pick(locale, "🔍 실행 중 과제 없음 — 계획 단계 과제를 착수하거나 새 과제를 받으세요.", "🔍 No tasks in progress — start a planned task or take a new one.");
  return [pick(locale, "🔍 실행 중 과제 — 각 owner는 '다음 액션'을 확인하세요", "🔍 Tasks in progress — each owner, check your 'next action'"), ...doing.map(taskLine)].join("\n");
}
export function fmtDigest(db: Database): string {
  const locale = getLocale(db);
  const rows = allTasks(db);
  const p = byLane(rows, "plan").length, d = byLane(rows, "doing").length, c = byLane(rows, "done").length;
  const doing = byLane(rows, "doing");
  return [pick(locale, `🗒️ 오늘 스냅샷 — 계획 ${p} · 실행중 ${d} · 완료 ${c}`, `🗒️ Today's snapshot — plan ${p} · doing ${d} · done ${c}`), ...(doing.length ? ["", pick(locale, "실행 중:", "Doing:"), ...doing.map(taskLine)] : [])].join("\n");
}
export function fmtStatus(db: Database, agents: AgentRecord[]): string {
  const locale = getLocale(db);
  const rows = allTasks(db);
  return [
    pick(locale, "🛰️ 운영 상태", "🛰️ Operational status"),
    pick(locale, "· team-collab: 정상 (API 응답 중)", "· team-collab: healthy (API responding)"),
    pick(locale, `· 등록 에이전트: ${agents.length}명`, `· Registered agents: ${agents.length}`),
    pick(locale, `· 과제: 실행중 ${byLane(rows, "doing").length} / 완료 ${byLane(rows, "done").length}`, `· Tasks: doing ${byLane(rows, "doing").length} / done ${byLane(rows, "done").length}`),
  ].join("\n");
}
// /menu — OWNER 승인 대기 목록 + 액션 카탈로그. (2026-06-10) Stage 1: 표시만, 승인은 대시보드(인증)에서.
export function fmtMenu(db: Database): string {
  const locale = getLocale(db);
  const owner = pick(locale, "팀장", "the team lead");
  const pending = listApprovals(db, "pending");
  const out = [pick(locale, `🔐 ${owner} 승인 메뉴`, `🔐 ${owner} approval menu`)];
  if (pending.length) {
    out.push(pick(locale, `\n⏳ 승인 대기 (${pending.length})`, `\n⏳ Pending approval (${pending.length})`));
    for (const r of pending) out.push(`· ${r.title}  〈${r.id}〉`);
  } else {
    out.push(pick(locale, "\n⏳ 승인 대기 — 없음", "\n⏳ Pending approval — none"));
  }
  out.push(pick(locale, "\n🧰 승인 가능 액션", "\n🧰 Available actions"));
  for (const a of listActions()) {
    const mark = a.danger === "high" ? "⚠" : "·";
    out.push(`${mark} ${a.label}  (${a.key})`);
  }
  const exec = process.env.APPROVAL_EXECUTION_ENABLED === "1" ? "ON" : pick(locale, "OFF(1단계: 승인만)", "OFF (stage 1: approve only)");
  out.push(pick(locale, `\n실행: ${exec}`, `\nExecution: ${exec}`));
  out.push(pick(locale, "승인은 대시보드(인증)에서 PIN으로 — 텔레그램에 PIN 입력 금지(채팅에 남음).", "Approve from the dashboard (authenticated) with a PIN — do NOT type the PIN into Telegram (it stays in chat)."));
  return out.join("\n");
}

export function startTelegramCapture(deps: CaptureDeps): () => void {
  // ★재init 마다 토큰/그룹을 파일에서 다시 읽는다★ — 대시보드 저장(setCaptureToken/setCaptureGroupId) 후
  //   restartCapture()가 이 함수를 재호출하면 새 값으로 갱신돼 서버 재시작 없이 즉시 적용된다(하네스 BLOCKER 수정).
  TOKEN = getCaptureToken();
  GROUP_ID = getCaptureGroupId() ?? "";
  if (!TOKEN) {
    console.log("[capture] disabled — CAPTURE_BOT_TOKEN 미설정 (inert)");
    return () => {};
  }
  // 라우터 LLM(exaone) 상주 — cold-start(~9s) 제거. 재부팅/재시작마다 재핀 (OWNER 결정 2026-05-24).
  void (async () => {
    const url = process.env.TEAM_ROUTER_OLLAMA_URL ?? "http://127.0.0.1:11434/api/chat";
    const model = process.env.TEAM_ROUTER_MODEL ?? "exaone3.5:2.4b";
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "warmup" }], stream: false, keep_alive: -1 }),
      });
      console.log(`[capture] router model ${model} 상주 (keep_alive=-1)`);
    } catch (e) {
      console.error("[capture] model warmup failed:", (e as Error).message);
    }
  })();
  let offset = 0;
  let stopped = false;
  // ★in-flight getUpdates 롱폴(timeout=25s)을 stop() 에서 즉시 끊기 위한 abort★ — 이게 없으면 restartCapture 시
  //   옛 루프가 25s 롱폴에 블록된 채 새 루프가 떠 같은 토큰 2폴러 → 텔레그램 409(conflict)·메시지 드롭. OWNER 2026-07-19 하네스 MAJOR 수정.
  const captureAbort = new AbortController();
  // 간이 sticky: 직전 담당을 기억. 멀티 @owner 뒤 후속은 여러 owner가 유지되어야 한다.
  // 2026-06-05(OWNER 2798): 재시작 시 DB 영속 owner 로 seed. 이전엔 []로 시작해서 setGroupOwner(쓰기)만
  // 하고 DB값을 안 읽어, 재시작 직후 무-@멘션 메시지가 sticky 를 잃고 default_step(codex)으로 빠졌다.
  // (DB 저장은 됐는데 capture 워커가 안 읽던 갭.) initGroupOwnerStore 가 먼저 호출되므로 값이 있다.
  let activeAssigneeIds: string[] = getGroupOwners();

  function withReplyContext(text: string, replyText?: string): string {
    if (!replyText) return text;
    return text + "\n\n[reply_to_message]\n" + replyText;
  }

  // ── 슬래시 명령(팀op 운영성 응답, OWNER 2888) ───────────────────────────────
  // 팀op 봇 / 메뉴(/board·/digest·/review·/status)을 받으면 에이전트 라우팅 대신
  // 여기서 직접 운영 데이터를 읽어 팀op 봇으로 답한다(대화형 아님 = TEAM-OS §8 운영성 메시징 OK).
  // formatter(fmt*)·replyAuthorAgentId 는 모듈 함수로 추출됨(2026-06-06 split) — 아래는 위임만.
  const SLASH_CMDS = ["/menu", "/board", "/digest", "/review", "/status", "/approve", "/onoff"];
  // 승인 탭 인가: env allowlist + Settings 자동감지 lead_telegram_id(setting) 둘 다 허용.
  const APPROVAL_ALLOW = (process.env.APPROVAL_ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  function approvalAllowedIds(): string[] {
    let detected: string | null = null;
    try {
      const row = deps.db.prepare("SELECT value FROM setting WHERE key = 'lead_telegram_id'").get() as { value: string } | undefined;
      detected = row?.value?.trim() ?? null;
    } catch { /* best-effort */ }
    return [...new Set([...APPROVAL_ALLOW, ...(detected ? [detected] : [])])];
  }
  async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      return await r.json().catch(() => ({}));
    } catch (e) { console.error(`[capture] tg ${method} failed:`, (e as Error).message); return {}; }
  }
  async function sendViaTeamOp(text: string, replyTo?: string, chatId: string = GROUP_ID): Promise<void> {
    await tg("sendMessage", { chat_id: chatId, text, ...(replyTo ? { reply_to_message_id: Number(replyTo) } : {}) });
  }
  // 승인 v2 알림 발송(OWNER 2026-07-08): 대상이 telegram:<id> → 텔레그램 DM / 에이전트 id → 팀버스 dm(읽기전용 통지).
  //   ★Devon 리뷰 #4: 이 dm 이 팀원 세션을 자동 wake·답장 유발하지 않는 근거 = source:"system" —
  //   dispatcher pendingDispatch 가 source IN(agent,user)만 wake 큐에 올림(inbox/dispatch.ts). system 은 제외.
  //   (unread inbox 항목만 남음 = 통지라 OK.) best-effort — 실패해도 배정/승인/거절엔 영향 없음.
  async function notifyBus(target: string, text: string): Promise<void> {
    try {
      if (!target || target === "system") return;
      const tgm = /^telegram:(\d+)$/.exec(target);
      if (tgm) { await tg("sendMessage", { chat_id: tgm[1], text }); return; }
      const agentId = target.trim().toLowerCase();
      const { thread_id } = ensureThread(deps.db, { from_agent_id: "system", to_agent_id: agentId, type: "dm", body: text });
      insertMessage(deps.db, {
        thread_id, from_agent_id: "system", to_agent_id: agentId, type: "dm", body: text,
        source: "system", hop_count: 0, priority: "normal",
      } as any); // Devon 리뷰 #4: wake 안 나는 건 source:"system"(dispatcher가 agent/user만 wake). expected_response 는 no-op라 제거.
    } catch (e) { console.error("[capture] notifyBus failed:", (e as Error).message); }
  }
  function approvalParams(row: { params_json: string }): Record<string, string> {
    try {
      const v = JSON.parse(row.params_json);
      return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, string> : {};
    } catch {
      return {};
    }
  }
  // /approve — 승인 대기 항목을 [✅승인][❌거절] 인라인 버튼으로. PIN 없이 OWNER 탭=인증(2026-06-10 OWNER).
  async function sendApproveMenu(replyTo?: string, chatId: string = GROUP_ID): Promise<void> {
    const locale = getLocale(deps.db);
    const owner = pick(getLocale(deps.db), "팀장", "the team lead");
    const pending = listApprovals(deps.db, "pending");
    const approvalPermIds = new Set(pending.map((r) => approvalParams(r).permission_request_id).filter(Boolean));
    const pendingPerms = listPermissionRequests(deps.db, "pending").filter((r) => !approvalPermIds.has(r.id));
    const execNote = isExecutionEnabled() ? pick(locale, "탭하면 즉시 실행됩니다.", "Tapping runs it immediately.") : pick(locale, "실행 OFF — 탭하면 승인만(실행 안 함).", "Execution OFF — tapping only approves (does not run).");
    if (!pending.length && !pendingPerms.length) {
      await sendViaTeamOp(pick(locale, `🔐 ${owner} 승인 대기 — 없음.\n\n등록 액션: `, `🔐 ${owner} pending approvals — none.\n\nRegistered actions: `) + listActions().map((a) => a.key).join(", "), replyTo, chatId);
      return;
    }
    await sendViaTeamOp(pick(locale, `🔐 ${owner} 승인 대기 — 액션 ${pending.length}건 · 권한 ${pendingPerms.length}건\n${execNote}`, `🔐 ${owner} pending approvals — actions ${pending.length} · permissions ${pendingPerms.length}\n${execNote}`), replyTo, chatId);
    for (const r of pending) {
      if (r.action_key === "permission_gate") {
        const params = approvalParams(r);
        const pr = params.permission_request_id ? getPermissionRequest(deps.db, params.permission_request_id) : undefined;
        await tg("sendMessage", {
          chat_id: chatId,
          text: pick(locale,
            `⚠ 권한 요청\n${pr ? `${pr.runtime}${pr.agent_id ? `/${pr.agent_id}` : ""} · ${pr.action}\n${pr.target}` : r.title}`,
            `⚠ Permission request\n${pr ? `${pr.runtime}${pr.agent_id ? `/${pr.agent_id}` : ""} · ${pr.action}\n${pr.target}` : r.title}`),
          reply_markup: { inline_keyboard: [[
            { text: pick(locale, "1회 허용", "Allow once"), callback_data: `pg1:${r.id}` },
            { text: pick(locale, "항상 허용", "Always allow"), callback_data: `pga:${r.id}` },
            { text: pick(locale, "거절", "Deny"), callback_data: `pgd:${r.id}` },
          ]] },
        });
        continue;
      }
      const danger = listActions().find((a) => a.key === r.action_key)?.danger === "high" ? "⚠ " : "";
      await tg("sendMessage", {
        chat_id: chatId,
        text: `${danger}${r.title}\n〈${r.action_key}〉`,
        reply_markup: { inline_keyboard: [[
          { text: pick(locale, "✅ 승인", "✅ Approve"), callback_data: `apv:${r.id}` },
          { text: pick(locale, "❌ 거절", "❌ Reject"), callback_data: `rej:${r.id}` },
        ]] },
      });
    }
    for (const r of pendingPerms) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: pick(locale,
          `🛂 권한 요청\n${r.runtime}${r.agent_id ? `/${r.agent_id}` : ""} · ${r.action}\n${r.target}`,
          `🛂 Permission request\n${r.runtime}${r.agent_id ? `/${r.agent_id}` : ""} · ${r.action}\n${r.target}`),
        reply_markup: { inline_keyboard: [[
          { text: pick(locale, "1회 허용", "Allow once"), callback_data: `pg1:${r.id}` },
          { text: pick(locale, "항상 허용", "Always allow"), callback_data: `pga:${r.id}` },
          { text: pick(locale, "거절", "Deny"), callback_data: `pgd:${r.id}` },
        ]] },
      });
    }
  }
  // ★새 승인/권한 요청은 생성 즉시 OWNER op DM에 버튼과 함께 push — /approve 눌러야만 보이던 문제 fix(OWNER 2026-07-06). /approve는 놓친 것 재리스팅 fallback으로 유지.
  //   폴러 매 사이클 호출. in-memory 중복방지(재시작 시 현재 pending 1회 재push = OWNER가 어차피 봐야 할 것).
  const pushedApprovalKeys = new Set<string>();
  async function pushNewApprovals(): Promise<void> {
    const gdDm = approvalAllowedIds()[0]; // OWNER user id = op DM chat_id(1:1). 없으면 push 안 함(fail-safe).
    if (!gdDm) return;
    const locale = getLocale(deps.db);
    const pending = listApprovals(deps.db, "pending");
    const approvalPermIds = new Set(pending.map((r) => approvalParams(r).permission_request_id).filter(Boolean));
    const pendingPerms = listPermissionRequests(deps.db, "pending").filter((r) => !approvalPermIds.has(r.id));
    const permButtons = (id: string) => ({ inline_keyboard: [[
      { text: pick(locale, "1회 허용", "Allow once"), callback_data: `pg1:${id}` },
      { text: pick(locale, "항상 허용", "Always allow"), callback_data: `pga:${id}` },
      { text: pick(locale, "거절", "Deny"), callback_data: `pgd:${id}` },
    ]] });
    for (const r of pending) {
      const key = `apr:${r.id}`;
      if (pushedApprovalKeys.has(key)) continue;
      pushedApprovalKeys.add(key);
      if (r.action_key === "permission_gate") {
        const params = approvalParams(r);
        const pr = params.permission_request_id ? getPermissionRequest(deps.db, params.permission_request_id) : undefined;
        await tg("sendMessage", { chat_id: gdDm, text: pick(locale, `🔔 새 권한 요청\n${pr ? `${pr.runtime}${pr.agent_id ? `/${pr.agent_id}` : ""} · ${pr.action}\n${pr.target}` : r.title}`, `🔔 New permission request\n${pr ? `${pr.runtime}${pr.agent_id ? `/${pr.agent_id}` : ""} · ${pr.action}\n${pr.target}` : r.title}`), reply_markup: permButtons(r.id) });
        continue;
      }
      if (r.action_key === "merge_to_main") {
        // ★코드 머지 승인 = OWNER 아닌 승인자 '한 명'에게 배정(피어리뷰, OWNER 2026-07-08). OWNER op DM push 스킵.
        //   전원 알림은 4명 중복분석=토큰낭비 → 살아있는 1명(author 제외)에게만 배정·알림. 그 사람이 안 하면
        //   신청자가 수동 재배정(defer 없음). deploy 등 일반 승인은 아래 OWNER push 그대로.
        const pool = getNormalApprovers(deps.db).filter((a) => a !== (approvalParams(r).author || r.requested_by).toLowerCase());
        const author = (approvalParams(r).author || r.requested_by).toLowerCase();
        const assignee = pickMergeApprover(deps.db, pool, r.id);
        if (assignee) {
          await notifyBus(assignee, pick(locale,
            `🔔 머지 승인 요청 — ${r.title}\n올린이: ${author}\n당신에게 배정됐어요. 검토 후 승인/거절 부탁드립니다.`,
            `🔔 Merge approval needed — ${r.title}\nBy: ${author}\nAssigned to you. Please review & approve/reject.`));
        }
        continue;
      }
      const danger = listActions().find((a) => a.key === r.action_key)?.danger === "high" ? "⚠ " : "";
      await tg("sendMessage", { chat_id: gdDm, text: pick(locale, `🔔 새 승인 요청\n${danger}${r.title}\n〈${r.action_key}〉`, `🔔 New approval request\n${danger}${r.title}\n〈${r.action_key}〉`), reply_markup: { inline_keyboard: [[
        { text: pick(locale, "✅ 승인", "✅ Approve"), callback_data: `apv:${r.id}` },
        { text: pick(locale, "❌ 거절", "❌ Reject"), callback_data: `rej:${r.id}` },
      ]] } });
    }
    for (const r of pendingPerms) {
      const key = `perm:${r.id}`;
      if (pushedApprovalKeys.has(key)) continue;
      pushedApprovalKeys.add(key);
      await tg("sendMessage", { chat_id: gdDm, text: pick(locale, `🔔 새 권한 요청\n${r.runtime}${r.agent_id ? `/${r.agent_id}` : ""} · ${r.action}\n${r.target}`, `🔔 New permission request\n${r.runtime}${r.agent_id ? `/${r.agent_id}` : ""} · ${r.action}\n${r.target}`), reply_markup: permButtons(r.id) });
    }
  }
  // /onoff — 팀원 서킷브레이커. 한 메시지 + 멤버당 1줄(팀원 많아도 짧게). 🔴정지/🟢기동/🔄재시작/🆕새세션.
  function onoffMenuText(status?: string): string {
    const locale = getLocale(deps.db);
    const execNote = isExecutionEnabled() ? pick(locale, "탭=즉시 적용", "tap = applied immediately") : pick(locale, "⚠ 실행 OFF — 탭해도 적용 안 됨(APPROVAL_EXECUTION_ENABLED=1 필요)", "⚠ Execution OFF — tapping does not apply (needs APPROVAL_EXECUTION_ENABLED=1)");
    return pick(locale,
      `🛑 팀원 onoff (서킷브레이커)\n🟢 작동중 · ⚫ 다운(세션 죽음 · 🔄로 복구) · 🔴 정지=끄기 · 🔄 재시작(컨텍스트 유지) · 🆕 새 세션(비움 · claude만) · 정지된 팀원은 탭해서 기동\n${execNote}${status ? `\n\n${status}` : ""}`,
      `🛑 Member onoff (circuit breaker)\n🟢 Running · ⚫ Down (session dead · 🔄 to recover) · 🔴 Stop=turn off · 🔄 Restart (keeps context) · 🆕 Fresh session (clears · claude only) · tap a stopped member to start\n${execNote}${status ? `\n\n${status}` : ""}`);
  }
  // 한 메시지용 키보드: [전체재시작] + 멤버당 1줄. 켜짐=[🟢이름, 🔄, (claude)🆕] / 정지=[🔴이름 — 🟢기동].
  function onoffKeyboard(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
    const locale = getLocale(deps.db);
    const ctl = ["openclaw", "claude_channel", "hermes_agent", "codex"];
    const agents = deps.agents().filter((a: any) => ctl.includes(a.runtime));
    // 실제 생존상태 반영(OWNER 2026-07-08): /onoff 는 제어(토글) 메뉴라 초록/빨강이 "의도적 정지 여부"만 표시했다.
    //   → agent_status 를 classifyHealth 로 분류해, 켜져있는데 실제로 죽은(livenessLevel=danger, 예: 세션 offline)
    //   팀원은 ⚫(다운)으로 구분 표시. blocked/idle(정상 활동·게이트웨이 대기)은 danger 아니라 🟢 유지.
    const statusMap = new Map(listStatuses(deps.db).map((s) => [s.agent_id, s]));
    const rows: Array<Array<{ text: string; callback_data: string }>> = [
      [{ text: pick(locale, "🔄 전체 재시작 (정지 제외 · 복구 코디 마지막)", "🔄 Restart all (excludes stopped · recovery coordinator last)"), callback_data: "rsall" }],
      // 🔴 전체 정지 — 비상 서킷브레이커(복구 코디 제외 전원 정지). 오탭 방지로 stall 콜백이 확인 1번 받는다.
      [{ text: pick(locale, "🔴 전체 정지 (복구 코디 제외 · 확인)", "🔴 Stop all (excludes recovery coordinator · confirm)"), callback_data: "stall" }],
    ];
    for (const a of agents) {
      const off = isAgentOff(a.id);
      if (off) {
        rows.push([{ text: pick(locale, `🔴 ${a.display_name} — 🟢 기동`, `🔴 ${a.display_name} — 🟢 start`), callback_data: `on:${a.id}:${a.runtime}` }]);
      } else {
        // 켜진 팀원: 🟢/⚫이름=상태(탭하면 힌트만, 정지 안 함) + 🔴정지=명시적 정지 버튼(따로) + 🔄재시작 + 🆕새세션.
        //   ★기존엔 🟢이름 탭이 곧 정지였는데 "상태표시"로 보여 OWNER가 못 알아봄 → 정지를 별도 버튼으로 분리(OWNER 2026-07-08).
        //   🟢=작동중 / ⚫=켜짐이지만 실제 다운(세션 죽음) — 제어토글은 ON인데 런타임이 죽은 경우(예: Ames offline).
        const st = statusMap.get(a.id);
        const down = st ? classifyHealth(st, a).livenessLevel === "danger" : false;
        const statText = down ? `⚫ ${a.display_name}${pick(locale, " (다운)", " (down)")}` : `🟢 ${a.display_name}`;
        const row = [
          { text: statText, callback_data: `stat:${a.id}` },
          { text: pick(locale, "🔴 정지", "🔴 Stop"), callback_data: `off:${a.id}:${a.runtime}` },
          { text: "🔄", callback_data: `rs:${a.id}:${a.runtime}` },
        ];
        // 🆕 새 세션은 claude_channel 만(openclaw/hermes 는 게이트웨이라 세션개념 없음).
        if (a.runtime === "claude_channel") row.push({ text: "🆕", callback_data: `rsf:${a.id}:${a.runtime}` });
        rows.push(row);
      }
    }
    return { inline_keyboard: rows };
  }
  async function sendOnoffMenu(replyTo?: string, chatId: string = GROUP_ID): Promise<void> {
    await tg("sendMessage", {
      chat_id: chatId,
      text: onoffMenuText(),
      ...(replyTo ? { reply_to_message_id: Number(replyTo) } : {}),
      reply_markup: onoffKeyboard(),
    });
  }
  // Internal release deployment command is intentionally not included in the public build.
  // @all confirm (2026-06-18, OWNER): @all/전체멘션은 즉시 fan-out 하지 않고 OWNER 승인을 받는다(오발송 방지).
  //   broadcast_marker 감지 → 주입 보류 + pending 저장 + ✅/❌ 버튼 → OWNER ✅ 시 runInjection 재실행.
  const pendingBroadcasts = new Map<string, {
    decision: any; roster: any; deliveryBody: string; media: any;
    threadId: string; origTgMessageId?: string; teamContext: string; text: string;
  }>();
  async function sendBroadcastConfirm(pid: string, text: string, targetCount: number, replyTo?: string): Promise<void> {
    const locale = getLocale(deps.db);
    const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
    await tg("sendMessage", {
      chat_id: GROUP_ID,
      text: pick(locale, `⚠️ 전체(@all) 메시지예요 — 팀원 ${targetCount}명에게 보낼까요?\n\n"${preview}"`, `⚠️ This is an @all message — send to ${targetCount} member(s)?\n\n"${preview}"`),
      ...(replyTo ? { reply_to_message_id: Number(replyTo) } : {}),
      reply_markup: { inline_keyboard: [[
        { text: pick(locale, "✅ 전송", "✅ Send"), callback_data: `bcapv:${pid}` },
        { text: pick(locale, "❌ 취소", "❌ Cancel"), callback_data: `bcrej:${pid}` },
      ]] },
    });
  }
  async function handleCallback(cb: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
    const locale = getLocale(deps.db);
    const data = cb.data ?? "";
    const fromId = cb.from?.id != null ? String(cb.from.id) : "";
    const chatId = cb.message?.chat?.id != null ? String(cb.message.chat.id) : "";
    const mid = cb.message?.message_id;
    appendAuditFile("capture", "callback_query", data, { from: fromId, chat: chatId });
    // ★fail-closed 인가(danger:high 공통): non-bot + GROUP_ID 설정+정확일치 + allowlist 설정+id일치. GROUP_ID나 allowlist가 비면 "권한 미구성"으로 deny(과거 empty=all-allow fail-open → 그룹 2번째 사람이 deploy/restart 가능하던 갭. Codex·Devon·하네스 만장일치, OWNER 2026-07-02). 라이브 .env엔 APPROVAL_ALLOWED_USER_IDS=OWNER id 설정됨.
    const isAuthorized = (): boolean => {
      const allow = approvalAllowedIds();
      // allowlist(=OWNER id)는 항상 필수. 그 위에서 팀 그룹(GROUP_ID) 또는 OWNER 본인 DM(private + chat.id===from.id, 1:1)만 허용.
      // op 봇 방(DM)에서 운영 메뉴를 쓰기 위한 확장(OWNER 2026-07-06). DM은 1:1이라 "그룹 2번째 사람" fail-open 갭이 없음.
      if (cb.from?.is_bot || allow.length === 0 || !allow.includes(fromId)) return false;
      const inGroup = GROUP_ID !== "" && chatId === GROUP_ID;
      const inOwnerDm = cb.message?.chat?.type === "private" && chatId === fromId;
      return inGroup || inOwnerDm;
    };

    // Public build: release deployment callback removed.

    // @all 전체전송 승인/취소 콜백 (bcapv:<pid> / bcrej:<pid>)
    const bc = /^(bcapv|bcrej):(.+)$/.exec(data);
    if (bc) {
      if (!isAuthorized()) { await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "권한 없음", "Not authorized"), show_alert: true }); appendAuditFile("capture", "callback_denied", data, { from: fromId }); return; }
      const approve = bc[1] === "bcapv", pid = bc[2]!;
      const pending = pendingBroadcasts.get(pid);
      if (!pending) { await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "만료된 요청이에요", "Expired request"), show_alert: true }); if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: pick(locale, "⌛ 만료된 전체전송 요청", "⌛ Expired broadcast request") }); return; }
      pendingBroadcasts.delete(pid);
      if (!approve) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "취소됨", "Cancelled") });
        if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: pick(locale, "❌ 전체전송 취소됨", "❌ Broadcast cancelled") });
        appendAuditFile("capture", "broadcast_rejected", pid, { from: fromId });
        return;
      }
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "전송 중…", "Sending…") });
      if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: pick(locale, `✅ 전체전송 승인 — 팀원 ${pending.decision.targetAgentIds.length}명에게 전송`, `✅ Broadcast approved — sending to ${pending.decision.targetAgentIds.length} member(s)`) });
      appendAuditFile("capture", "broadcast_approved", pid, { from: fromId, targets: pending.decision.targetAgentIds });
      await runInjection(pending.decision, pending.roster, pending.deliveryBody, pending.media, pending.threadId, pending.origTgMessageId, pending.teamContext, pending.text);
      return;
    }

    // permission gate 콜백 (pg1/pga/pgd:<approval_id 또는 legacy request_id>) — Tier D는 lib에서 재평가해 override 차단.
    const pg = /^(pg1|pga|pgd):((?:apr|prm)_[a-f0-9]+)$/.exec(data);
    if (pg) {
      if (!isAuthorized()) { await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "권한 없음", "Not authorized"), show_alert: true }); appendAuditFile("capture", "callback_denied", data, { from: fromId }); return; }
      const refId = pg[2]!;
      const approval = refId.startsWith("apr_") ? getApproval(deps.db, refId) : undefined;
      const id = approval ? approvalParams(approval).permission_request_id : refId;
      if (!id) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "권한 요청 연결 없음", "Permission request link missing"), show_alert: true });
        appendAuditFile("capture", "permission_decide_failed", refId, { from: fromId, error: "missing_permission_request_id" });
        return;
      }
      const row = getPermissionRequest(deps.db, id);
      if (!row || row.status !== "pending") {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: row ? pick(locale, `이미 처리됨(${row.status})`, `Already handled (${row.status})`) : pick(locale, "항목 없음", "No such item") });
        if (mid) await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] } });
        return;
      }
      const decision = pg[1] === "pg1" ? "allow_once" : pg[1] === "pga" ? "allow_always" : "deny";
      const res = decidePermissionRequest(deps.db, id, decision, {
        approver: "OWNER",
        provenance: { surface: "telegram", approver_telegram_id: fromId, callback_data: data },
      });
      if (!res.ok) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: res.error ?? "failed", show_alert: true });
        appendAuditFile("capture", "permission_decide_failed", id, { from: fromId, error: res.error });
        return;
      }
      if (approval) setApprovalStatus(deps.db, approval.id, decision === "deny" ? "rejected" : "approved");
      const label = decision === "allow_once" ? pick(locale, "1회 허용", "Allowed once") : decision === "allow_always" ? pick(locale, "항상 허용", "Always allowed") : pick(locale, "거절", "Denied");
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: label });
      if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: `✅ ${label}\n${row.runtime}${row.agent_id ? `/${row.agent_id}` : ""} · ${row.action}\n${row.target}` });
      return;
    }

    // onoff 콜백 (on:<id>:<runtime> / off:<id>:<runtime>)
    const oo = /^(on|off):([a-z0-9_-]+):([a-z_]+)$/.exec(data);
    if (oo) {
      if (!isAuthorized()) { await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "권한 없음", "Not authorized"), show_alert: true }); appendAuditFile("capture", "callback_denied", data, { from: fromId }); return; }
      const want = oo[1] === "on", agentId = oo[2]!, runtime = oo[3]!;
      const verb = want ? pick(locale, "기동", "start") : pick(locale, "정지", "stop");
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, `${agentId} ${verb} 처리 중…`, `${agentId} ${verb} in progress…`) });
      if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: onoffMenuText(pick(locale, `⏳ ${agentId} ${verb} 중…`, `⏳ ${agentId} ${verb} in progress…`)), reply_markup: onoffKeyboard() });
      const res = await setAgentEnabled(agentId, runtime, want);
      appendAuditFile("capture", res.ok ? "onoff_done" : "onoff_failed", agentId, { want, runtime, detail: res.detail });
      const nowOff = isAgentOff(agentId);
      if (mid) await tg("editMessageText", {
        chat_id: chatId, message_id: mid,
        text: onoffMenuText(`${res.ok ? (nowOff ? pick(locale, "🔴 정지됨", "🔴 Stopped") : pick(locale, "🟢 켜짐", "🟢 On")) : pick(locale, "⚠ 실패", "⚠ Failed")}  ${agentId} — ${res.detail}`),
        reply_markup: onoffKeyboard(),
      });
      return;
    }

    // 🟢 상태 버튼 콜백 (stat:<id>) — 상태 표시 전용. 정지는 옆의 🔴 정지 버튼(off:)이 한다. 탭하면 힌트만.
    const stt = /^stat:([a-z0-9_-]+)$/.exec(data);
    if (stt) {
      const agentId = stt[1]!;
      const st = getStatus(deps.db, agentId);
      const agent = deps.agents().find((a: any) => a.id === agentId);
      const down = st ? classifyHealth(st, agent).livenessLevel === "danger" : false;
      const hint = down
        ? pick(locale, `⚫ ${agentId} 다운(세션 죽음) — 🔄로 복구, 🔴로 정지 처리`, `⚫ ${agentId} down (session dead) — 🔄 to recover, 🔴 to mark stopped`)
        : pick(locale, `🟢 ${agentId} 작동중 — 끄려면 옆의 🔴 정지를 누르세요`, `🟢 ${agentId} running — tap 🔴 Stop next to it to stop`);
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: hint });
      return;
    }

    // 🔴 전체 정지 콜백 (stall → 확인 → stall:go 실행 / stall:no 취소) — 복구 코디·이미 정지 제외 전원 정지(비상).
    if (data === "stall") {
      if (!isAuthorized()) { await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "권한 없음", "Not authorized"), show_alert: true }); appendAuditFile("capture", "callback_denied", data, { from: fromId }); return; }
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
      if (mid) await tg("editMessageText", {
        chat_id: chatId, message_id: mid,
        text: pick(locale, "🔴 전체 정지 — 복구 코디(bill)·이미 정지된 팀원 제외하고 전원 즉시 정지합니다. 정말 실행할까요?", "🔴 Stop all — stops everyone except the recovery coordinator (bill) & already-stopped. Proceed?"),
        reply_markup: { inline_keyboard: [[
          { text: pick(locale, "✅ 전체 정지 실행", "✅ Stop all"), callback_data: "stall:go" },
          { text: pick(locale, "❌ 취소", "❌ Cancel"), callback_data: "stall:no" },
        ]] },
      });
      return;
    }
    if (data === "stall:no") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "취소됨", "Cancelled") });
      if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: onoffMenuText(pick(locale, "❌ 전체 정지 취소됨", "❌ Stop-all cancelled")), reply_markup: onoffKeyboard() });
      return;
    }
    if (data === "stall:go") {
      if (!isAuthorized()) { await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "권한 없음", "Not authorized"), show_alert: true }); appendAuditFile("capture", "callback_denied", data, { from: fromId }); return; }
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "전체 정지 중…", "Stopping all…") });
      if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: pick(locale, "⏳ 전체 정지 중…", "⏳ Stopping all…") });
      const ctl = ["openclaw", "claude_channel", "hermes_agent", "codex"];
      const members = deps.agents().filter((a: any) => ctl.includes(a.runtime)).map((a: any) => ({ id: a.id, runtime: a.runtime, capabilities: a.capabilities ?? [] }));
      const results = await stopAll(members);
      appendAuditFile("capture", "stop_all", "*", { results });
      const lines = results.map((r) => `${r.ok ? "✅" : "⚠"} ${r.id} — ${r.detail}`).join("\n");
      if (mid) await tg("editMessageText", {
        chat_id: chatId, message_id: mid,
        text: onoffMenuText(pick(locale, `🔴 전체 정지 결과\n${lines}`, `🔴 Stop-all results\n${lines}`)),
        reply_markup: onoffKeyboard(),
      });
      return;
    }

    // 전체 재시작 콜백 (rsall) — member·정지 팀원 제외, openclaw 게이트웨이 1회.
    if (data === "rsall") {
      if (!isAuthorized()) { await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "권한 없음", "Not authorized"), show_alert: true }); appendAuditFile("capture", "callback_denied", data, { from: fromId }); return; }
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "전체 재시작 중…", "Restarting all…") });
      if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: pick(locale, "⏳ 전체 재시작 중… (openclaw 게이트웨이는 1~2분 깜빡)", "⏳ Restarting all… (the openclaw gateway blinks for 1–2 min)") });
      const ctl = ["openclaw", "claude_channel", "hermes_agent", "codex"];
      const members = deps.agents().filter((a: any) => ctl.includes(a.runtime)).map((a: any) => ({ id: a.id, runtime: a.runtime, capabilities: a.capabilities ?? [] }));
      const results = await restartAll(members);
      appendAuditFile("capture", "restart_all", "*", { results });
      const lines = results.map((r) => `${r.ok ? "✅" : "⚠"} ${r.id} — ${r.detail}`).join("\n");
      if (mid) await tg("editMessageText", {
        chat_id: chatId, message_id: mid,
        text: onoffMenuText(pick(locale, `🔄 전체 재시작 결과\n${lines}`, `🔄 Restart-all results\n${lines}`)),
        reply_markup: onoffKeyboard(),
      });
      return;
    }

    // 팀원 1명 재시작 콜백 — rs:(컨텍스트 유지·--resume) / rsf:(새 세션·--fresh, 컨텍스트 비움).
    const rs = /^(rs|rsf):([a-z0-9_-]+):([a-z_]+)$/.exec(data);
    if (rs) {
      if (!isAuthorized()) { await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "권한 없음", "Not authorized"), show_alert: true }); appendAuditFile("capture", "callback_denied", data, { from: fromId }); return; }
      const fresh = rs[1] === "rsf", agentId = rs[2]!, runtime = rs[3]!;
      const label = fresh ? pick(locale, "새 세션(컨텍스트 비움)", "fresh session (clears context)") : pick(locale, "재시작", "restart");
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, `${agentId} ${label} 처리 중…`, `${agentId} ${label} in progress…`) });
      if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: onoffMenuText(pick(locale, `⏳ ${agentId} ${label} 중…`, `⏳ ${agentId} ${label} in progress…`)), reply_markup: onoffKeyboard() });
      const res = await restartAgent(agentId, runtime, fresh);
      appendAuditFile("capture", res.ok ? (fresh ? "restart_fresh_done" : "restart_done") : "restart_failed", agentId, { runtime, fresh, detail: res.detail });
      if (mid) await tg("editMessageText", {
        chat_id: chatId, message_id: mid,
        text: onoffMenuText(`${res.ok ? (fresh ? pick(locale, "🆕 새 세션 완료", "🆕 Fresh session done") : pick(locale, "🔄 재시작됨", "🔄 Restarted")) : pick(locale, "⚠ 실패", "⚠ Failed")}  ${agentId} — ${res.detail}`),
        reply_markup: onoffKeyboard(),
      });
      return;
    }

    const m = /^(apv|rej):(apr_[a-f0-9]+)$/.exec(data);
    if (!m) { await tg("answerCallbackQuery", { callback_query_id: cb.id }); return; }
    // ★fail-closed 인가 = isAuthorized()로 통일(GROUP_ID 또는 OWNER private DM, allowlist 필수). DM에서도 승인/배포 실행되게(OWNER 2026-07-06). 하네스 검증: DM은 1:1+allowlist라 fail-open 갭 없음.
    if (!isAuthorized()) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "권한 없음", "Not authorized"), show_alert: true });
      appendAuditFile("capture", "callback_denied", data, { from: fromId });
      return;
    }
    const verb = m[1]!, id = m[2]!;
    const row = getApproval(deps.db, id);
    if (!row || row.status !== "pending") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: row ? pick(locale, `이미 처리됨(${row.status})`, `Already handled (${row.status})`) : pick(locale, "항목 없음", "No such item") });
      if (mid) await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] } });
      return;
    }
    if (verb === "rej") {
      setApprovalStatus(deps.db, id, "rejected");
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "거절됨", "Rejected") });
      if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: pick(locale, `❌ 거절됨 — ${row.title}`, `❌ Rejected — ${row.title}`) });
      return;
    }
    // Approve + (when execution ON) run. May take time, so answer the callback first.
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: pick(locale, "승인 — 처리 중…", "Approved — in progress…") });
    if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: pick(locale, `⏳ 승인됨, 실행 중 — ${row.title}`, `⏳ Approved, running — ${row.title}`) });
    const res = await approveByTrustedTap(deps.db, id, fromId);
    // 표시는 실제 실행결과(res.executed) 기준 — autoExec(merge_to_main 등)는 전역 OFF 여도 실행되므로
    // 전역 플래그로 'OFF' 표시하면 오판. (Codex 리뷰 2026-07-08)
    let final: string;
    if (res.executed && res.ok) final = pick(locale, `✅ 완료 — ${row.title}\n${(res.output ?? "").slice(-500)}`, `✅ Done — ${row.title}\n${(res.output ?? "").slice(-500)}`);
    else if (res.executed) final = pick(locale, `⚠ 실패 — ${row.title}\n${(res.error ?? res.output ?? "").slice(-500)}`, `⚠ Failed — ${row.title}\n${(res.error ?? res.output ?? "").slice(-500)}`);
    else final = pick(locale, `✅ 승인됨 (실행 안 함) — ${row.title}`, `✅ Approved (not executed) — ${row.title}`);
    if (mid) await tg("editMessageText", { chat_id: chatId, message_id: mid, text: final });
  }
  // targetChat = 메뉴/응답을 띄울 chat(그룹 기본, op 봇 DM이면 그 DM). OWNER 2026-07-06 op 방 배선.
  async function handleSlashCommand(text: string, msgId?: string, targetChat: string = GROUP_ID): Promise<boolean> {
    const cmd = (text.trim().split(/\s+/)[0] ?? "").replace(/@\S+$/, "").toLowerCase();
    if (!SLASH_CMDS.includes(cmd)) return false;
    if (cmd === "/approve") {
      await sendApproveMenu(msgId, targetChat);
      appendAuditFile("capture", "slash_command", cmd, { msg: msgId ?? null, chat: targetChat });
      return true;
    }
    if (cmd === "/onoff") {
      await sendOnoffMenu(msgId, targetChat);
      appendAuditFile("capture", "slash_command", cmd, { msg: msgId ?? null, chat: targetChat });
      return true;
    }
    const body =
      cmd === "/menu" ? fmtMenu(deps.db) : // ★/menu 배선 — 승인대기+액션카탈로그+실행상태(하네스/Steve: fmtMenu가 데드코드였음). OWNER 2026-07-02
      cmd === "/board" ? fmtBoard(deps.db) :
      cmd === "/review" ? fmtReview(deps.db) :
      cmd === "/digest" ? fmtDigest(deps.db) :
      fmtStatus(deps.db, deps.agents());
    await sendViaTeamOp(body, msgId, targetChat);
    appendAuditFile("capture", "slash_command", cmd, { msg: msgId ?? null, chat: targetChat });
    return true;
  }

  async function handle(
    text: string,
    replyText?: string,
    replyToAgentId?: string,
    origTgMessageId?: string,
    media: StoredMedia[] = [],
  ): Promise<void> {
    const originDuplicate = findExistingTelegramOriginMessage(deps.db, GROUP_ID, origTgMessageId);
    if (originDuplicate) {
      appendAuditFile("capture", "telegram_origin_duplicate_skip", originDuplicate, {
        chat_id: GROUP_ID,
        message_id: origTgMessageId,
        text: text.slice(0, 120),
      });
      return;
    }
    const roster = deps.agents();
    const decision = await routeTeamMessageHybrid(text, roster, {
      activeAssigneeIds,
      replyToAgentId,
    });
    const deliveryBody = withReplyContext(text, replyText);
    const threadId = `tg-${GROUP_ID}`;
    // 가시성 Stage C: 깨우기 전 공유 버스의 최근 팀 맥락(최대 10건/6h)을 모은다 — 현재 메시지 적재 전 = 직전 맥락.
    let teamContext = "";
    try {
      const recent = recentThreadMessages(deps.db, threadId, 10, 6);
      if (recent.length) {
        teamContext = recent
          .map((m) => `[${m.from_agent_id}] ${m.body.slice(0, 200).replace(/\n/g, " ")}`)
          .join("\n");
      }
    } catch (e) {
      console.error("[capture] team context fetch failed:", (e as Error).message);
    }
    // 가시성 Stage A: OWNER 그룹 메시지를 공유 버스 스레드에 적재 → 모든 에이전트가 같은 맥락을 읽음.
    // (에이전트는 다른 봇의 텔레그램 메시지를 못 보므로 버스가 유일한 공유 뷰.) 실패해도 라우팅/injection 은 진행.
    // 라우터 결정에 따라 메시지 타입과 수신자를 결정:
    //  - 단일 대상 → type: "dm", to_agent_id: targets[0] (recipient 1행만)
    //  - 다중/broadcast → type: "broadcast", to_agent_id: "broadcast", explicit_recipients: targets
    //    (0명이면 버스 감사 기록용 broadcast, recipient 행 없음)
    try {
      const routeTargets = decision.outcome === "route" || decision.outcome === undefined
        ? decision.targetAgentIds
        : [];
      const isSingleTarget = routeTargets.length === 1;
      const msgType: "dm" | "broadcast" = isSingleTarget ? "dm" : "broadcast";
      const toAgentId: string = isSingleTarget ? (routeTargets[0] as string) : "broadcast";
      const originDedupeKey = telegramOriginDedupeKey(GROUP_ID, origTgMessageId);
      const dedupeKey = originDedupeKey ?? buildDedupeKey("user", toAgentId, deliveryBody.slice(0, BODY_MAX_CHARS));
      // dedupe(300s) + ensureThread + insertMessage + broadcast → 공통 acceptInbound (P2 ChannelAdapter).
      // 텔레그램 특화(origin dedupe_key·route/telegram meta·media attachments·broadcast explicit_recipients)는 env로 전달.
      const accepted = acceptInbound(
        deps.db,
        {
          thread_id: threadId,
          from_agent_id: "user",
          to_agent_id: toAgentId,
          type: msgType,
          body: deliveryBody.slice(0, BODY_MAX_CHARS),
          source: "user",
          hop_count: 0,
          priority: "normal",
          dedupe_key: dedupeKey,
          // telegram origin(원본 msg_id) + 라우팅 결정(reason/targets)을 함께 적재 →
          // owner-gate 훅이 telegram message_id로 조회해 reply/sticky 까지 반영된 결정을 그대로 쓴다(reply-blindness 보완).
          meta: {
            ...(telegramOriginMeta(GROUP_ID, origTgMessageId) ?? {}),
            route: { reason: decision.reason, targets: decision.targetAgentIds },
            ...(media.length ? { media } : {}),
          },
          ...(media.length ? { attachments: mediaAttachments(media) } : {}),
          // For broadcast: only create recipient rows for the decided targets (not all agents).
          ...(isSingleTarget ? {} : { explicit_recipients: routeTargets }),
        },
        { dedupeWindowSec: 300, broadcast: deps.broadcast },
      );
      if (!accepted.ok) {
        appendAuditFile("capture", "telegram_dedupe_skip", accepted.duplicate, {
          dedupe_key: dedupeKey,
          chat_id: GROUP_ID,
          message_id: origTgMessageId ?? null,
          text: text.slice(0, 120),
        });
        return;
      }
    } catch (e) {
      console.error("[capture] bus persist failed:", (e as Error).message);
    }
    // sticky 상태 갱신
    if (decision.outcome === "closure" || decision.shouldResetThread) activeAssigneeIds = [];
    // @all/전체멘션(broadcast_marker)은 '이번 메시지'만 전원 fan-out 하고, sticky(다음 무멘션 담당)는
    // 바꾸지 않는다 → 다음 무멘션은 @all 이전 owner 로 복귀(OWNER 2026-06-18, Bill+Codex 합의). 일회성 전체 호출.
    if (decision.outcome === "route" && decision.targetAgentIds.length > 0 && decision.reason !== "broadcast_marker") {
      activeAssigneeIds = [...new Set(decision.targetAgentIds)];
    }
    // owner-gate 훅(/api/route)이 무-@멘션 메시지에도 sticky 기준 owner 판정을 적용하도록 공유.
    setGroupOwner(activeAssigneeIds);
    appendAuditFile("capture", "route_decision", text.slice(0, 200), {
      outcome: decision.outcome,
      targets: decision.targetAgentIds,
      reason: decision.reason,
      intent: decision.intent,
      suggested: decision.suggested,
      needsOwnerConfirm: decision.needsOwnerConfirm,
      activeAssigneeId: activeAssigneeIds[0] ?? null,
      activeAssigneeIds,
      injection_enabled: isRouterEnabled(deps.db),
      reply_context: replyText ? replyText.slice(0, 300) : null,
      reply_to_agent: replyToAgentId ?? null,
    });

    // injection: 결정된 봇을 깨운다 (ROUTER_ENABLED ON 시). 안전 규칙:
    //  - outcome=route 만 (closure/ask_owner 는 깨우지 않음)
    //  - bill 도 주입 대상(2026-06-02 requireMention=true 전환 — specialist 와 동일하게 owned 만 받음)
    //  - codex도 @member 같은 alias 호출은 gateway session injection (실제 @bot_username 은 plugin 처리라 skip)
    //  - openclaw agent 는 gateway session injection
    //  - 메시지에 그 봇 @username 이 있으면 plugin 이 이미 전달하므로 skip (이중전달 방지)
    //  - 봇 발신 메시지는 loop 위해 이미 상위에서 무시됨
    if (isRouterEnabled(deps.db) && decision.outcome === "route" && decision.targetAgentIds.length > 0) {
      if (decision.reason === "broadcast_marker") {
        // @all 보류 — 주입하지 않고 OWNER 승인 버튼을 띄운다(오발송 방지).
        const pid = `bcast-${Date.now()}`;
        pendingBroadcasts.set(pid, { decision, roster, deliveryBody, media, threadId, origTgMessageId, teamContext, text });
        appendAuditFile("capture", "broadcast_held", pid, { targets: decision.targetAgentIds, text: text.slice(0, 120) });
        await sendBroadcastConfirm(pid, text, decision.targetAgentIds.length, origTgMessageId);
      } else {
        await runInjection(decision, roster, deliveryBody, media, threadId, origTgMessageId, teamContext, text);
      }
    }
  }

  // 주입 루프 추출(2026-06-18, @all confirm 준비) — 정상 라우팅과 @all 승인 후 재실행이 같은 코드를 쓰도록 함수화.
  // 동작 보존: 호출부 조건/본문 변경 없음.
  async function runInjection(
    decision: any,
    roster: any,
    deliveryBody: string,
    media: any,
    threadId: string,
    origTgMessageId: string | undefined,
    teamContext: string,
    text: string,
  ): Promise<void> {
      for (const id of decision.targetAgentIds) {
        // 빌-제외 해제(2026-06-02): member requireMention=true 전환 → owned 무-@멘션(sticky/default/reply/@별칭)을
        // capture 가 specialist 처럼 tmux 주입한다. @username(@example_dev_bot) 멘션은 아래에서 plugin 처리로 skip → 이중전달 없음.
        const agent = roster.find((a: any) => a.id === id);
        if (!agent) {
          console.log(`[capture] inject skip ${id} (unknown agent)`);
          appendAuditFile("capture", "injection_skip", id, { reason: "unknown_agent", text: text.slice(0, 120) });
          continue;
        }
        // 2026-06-04 단일입구(single ingress) 전환: codex native-path skip 제거.
        // 이전엔 @member/Codex-답장이면 OpenClaw native 가 처리하라고 capture 주입을 skip 했는데,
        // native 경로엔 owner-gate 가 없어 reply_to_bot implicit 활성화로 @member owner 메시지에도 codex 가 반응했다.
        // → B: codex OpenClaw groupPolicy 'open'→'disabled'(native 그룹 처리 off) 와 한 쌍으로,
        //   이제 codex 의 모든 owner 케이스(@member/Codex-답장/sticky)를 capture 가 라우터 owner 판정 후 bridge 로만 주입한다.
        //   owner 가 codex 가 아니면(예: @member) targetAgentIds 에 codex 없음 → 미주입(=침묵).
        // @username 멘션은 Telegram plugin 이 해당 봇 세션에 직접 전달하므로 capture 가 skip(이중전달 방지).
        // 단 codex(openclaw)는 단일입구 전환으로 native(plugin) 그룹 처리를 disabled 했으므로 plugin 경로가 없다 →
        // codex 의 @example_openclaw_bot 멘션도 capture(bridge)가 직접 주입해야 orphan 되지 않는다.
        const uname = agent.telegram_bot_username?.replace(/^@/, "").toLowerCase();
        // native_routing agent(codex)는 plugin 그룹 처리가 disabled → @username 멘션도 capture 가 직접 주입.
        // 그 외 agent 는 plugin 이 직접 전달하므로 capture skip(이중전달 방지).
        if (!hasCapability(agent, "native_routing") && uname && text.toLowerCase().includes("@" + uname)) {
          console.log(`[capture] inject skip ${id} (@username 멘션 — plugin 처리)`);
          appendAuditFile("capture", "injection_skip", id, { reason: "telegram_mention_plugin_path", text: text.slice(0, 120) });
          continue;
        }
        const messageId = `tg-${Date.now()}`;
        const scopedTeamContext = teamContextForAgent(id, teamContext);
        const locale = getLocale(deps.db);
        if (agent.runtime === "claude_channel" && agent.tmux_session) {
          const ok = await injectPrompt({
            session: agent.tmux_session,
            fromLabel: `${pick(locale, "팀장", "the team lead")} (${pick(locale, "그룹 라우터", "group router")})`,
            locale,
            threadId,
            messageId,
            origTgMessageId,
            body: deliveryBody,
            attachments: mediaAttachments(media),
            source: "telegram",
            kind: "group", // ★봉투 kind★ (2026-07-15) — 단톡방 라우터 경로(팀원은 broadcast 로 답). openclaw injectOpenclawTelegramTurn kind="group" 와 대칭
            agentId: id,
            teamContext: scopedTeamContext,
          });
          // ★★injectPrompt 는 boolean 이 아니라 {ok:boolean} ★객체★ 다 (하네스 리뷰 2026-07-14) ★★
          //   `const ok = await injectPrompt(...)` 를 `ok ? "ok" : "fail"` 로 검사했다.
          //   ★객체는 {ok:false} 여도 참★ → ★"fail" 이 영원히 안 찍혔다.★
          //   감사로그에 `"ok":{"ok":true}` 가 4번 박혀 있다 — ★주입 실패가 한 번도 기록된 적이 없다.★
          //   (같은 버그가 routes/slack.ts 에도 있어 tmux_inject_failed 가 도달 불가능이었다)
          console.log(`[capture] injected tmux → ${id}: ${ok.ok ? "ok" : "fail(session?)"}`);
          appendAuditFile("capture", "injection", id, {
            mode: "tmux", ok: ok.ok, maybePartial: ok.maybePartial ?? false, text: text.slice(0, 120),
          });
          continue;
        }
        if (agent.runtime === "openclaw") {
          appendAuditFile("capture", "injection", id, { mode: "openclaw", ok: "queued", async: true, text: text.slice(0, 120) });
          void (async () => {
            try {
              const ok = await injectOpenclawTelegramTurn({
                agent,
                groupId: GROUP_ID,
                threadId: `tg-${GROUP_ID}`,
                messageId,
                // ★배달 기록 — 이 통로가 빠져 있었다.★ (2026-07-12)
                //   팀장이 단톡방에서 부르면 telegramCapture 가 ★직접 주입★한다 — ★wakeDispatcher 를 안 지난다.★
                //   내 배선이 전부 wakeDispatcher 안에 있어서 ★이 경로의 답은 서버에 기록이 0건★ 이었다.
                //   ★"관측할 수 없으면 검증할 수 없다"를 증명한 코드가 정작 자기 통로를 안 셌다.★
                onDelivered: (info) => {
                  recordReportDelivery(deps.db, {
                    actor: id, channel: "telegram_group", recipient: info.groupId,
                    threadId, refId: messageId, body: info.text, ok: info.ok,
                    error: info.ok ? null : "telegram_send_failed",
                  });
                },
                locale,
                body: deliveryBody,
                attachments: mediaAttachments(media),
                teamContext: scopedTeamContext,
                origTgMessageId,
              });
              console.log(`[capture] injected openclaw → ${id}: ${ok ? "ok" : "fail"}`);
              appendAuditFile("capture", "injection", id, { mode: "openclaw", ok, async: true, text: text.slice(0, 120) });
            } catch (e) {
              const error = e instanceof Error ? e.message : String(e);
              console.log(`[capture] openclaw inject failed → ${id}: ${error}`);
              appendAuditFile("capture", "openclaw_inject_failed", id, { error, text: text.slice(0, 120) });
            }
          })();
          continue;
        }
        if (agent.runtime === "hermes_agent") {
          console.log(`[capture] injected hermes one-shot → ${id}: queued`);
          appendAuditFile("capture", "injection", id, { mode: "hermes_agent", ok: true, async: true, text: text.slice(0, 120) });
          void (async () => {
            if (origTgMessageId) {
              const reacted = await reactTelegramAsHermes(agent, GROUP_ID, origTgMessageId);
              appendAuditFile("hermes_bridge", reacted ? "telegram_reacted" : "telegram_react_failed", messageId, {
                agent_id: id,
                chat_id: GROUP_ID,
                message_id: origTgMessageId,
              });
            }
            try {
              const reply = await runHermesTeamTurn({
                agent,
                threadId,
                messageId,
                body: deliveryBody,
                fromLabel: `${pick(locale, "팀장", "the team lead")} (${pick(locale, "그룹 라우터", "group router")})`,
                // ★여기는 단톡방이다 — 답은 ★방★ 에 간다.★ (OWNER 2026-07-14)
                //   fromLabel 은 사람이 읽는 ★이름표★("팀장 (그룹 라우터)")지 팀원 id 가 아니다.
                //   주입문이 그걸로 주소를 지어내면 `send.sh --to 팀장 (그룹 라우터)` 같은 헛것이 나온다.
                //   ★부르는 쪽이 사실을 넘긴다.★ 팀장님이 방에서 불렀으니 답도 방에 온다.
                replyRoute: { kind: "group" },
                locale,
                teamContext: scopedTeamContext,
                // 턴 상한은 안 넘긴다 — 기본값(HERMES_TURN_TIMEOUT_MS) 한 곳에 맡긴다 (OWNER 2026-07-15).
              });
              // ★[B] — 서버는 팀원 대신 말하지 않는다.★ (OWNER 2026-07-13: "팀원한테 맡겨. 다 빼.")
              //
              // ═══ 이 통로가 제일 아팠다 ═══
              //   팀장이 단톡방에서 @멘션하면 ★여기가 hermes 를 직접 돌리고 stdout 을 방에 게시★했다.
              //   ★wakeDispatcher 를 안 지나서★ 거기 달아둔 가드가 아무 소용이 없었다 →
              //   ★"OWNER CSO HERMES: [NO_REPLY]" 가 팀장 단톡방에 문자 그대로 찍혔다.★ (2026-07-13 라이브)
              //
              // ═══ 지금 ═══
              //   ★턴 본문은 그 팀원의 메모다. 아무 데도 안 간다.★
              //   방에 말하려면 hermes 가 ★직접★ 보낸다: send.sh --to broadcast --thread <이 그룹 thread>
              //   → routes/inbox.ts 가 단톡방으로 릴레이한다. ★"보낸 것만 말한 것이다."★
              appendAuditFile("hermes_bridge", "turn_completed_no_autopost", messageId, {
                agent_id: id, chars: reply.length,   // ★본문은 안 남긴다 — 말한 게 아니라 메모다★
              });
            } catch (e) {
              appendAuditFile("hermes_bridge", "oneshot_failed", messageId, {
                agent_id: id,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          })();
          continue;
        }
        console.log(`[capture] inject skip ${id} (no supported injection path)`);
        appendAuditFile("capture", "injection_skip", id, { reason: "no_supported_path", text: text.slice(0, 120) });
      }
  }

  // 봇 명령어 목록 등록 → 텔레그램 입력창 / 메뉴 자동완성에 표시(setMyCommands). 시작 시 1회.
  async function registerCommands(): Promise<void> {
    const locale = getLocale(deps.db);
    const commands = [
      { command: "menu", description: pick(locale, "메뉴 — 승인대기·액션·실행상태", "Menu — pending approvals·actions·exec state") },
      { command: "onoff", description: pick(locale, "팀원 정지/기동/재시작 (서킷브레이커 — 폭주 시 즉시 정지)", "Stop/start/restart a member (circuit breaker — immediate stop on runaway)") },
      { command: "approve", description: pick(locale, "승인 대기 항목 처리", "Handle pending approvals") },
      { command: "board", description: pick(locale, "과제 칸반 현황", "Task kanban status") },
      { command: "review", description: pick(locale, "리뷰 현황", "Review status") },
      { command: "digest", description: pick(locale, "다이제스트", "Digest") },
      { command: "status", description: pick(locale, "팀 상태 요약", "Team status summary") },
    ];
    // ★ 그룹 채팅 자동완성은 all_group_chats / 특정 chat scope 가 default 보다 우선한다. default 만 갱신하면
    //   예전에 등록된 그룹 scope 목록이 남아 새 명령(onoff)이 그룹에서 안 뜬다(2026-06-11 OWNER 발견). → 셋 다 등록.
    await tg("setMyCommands", { commands });
    await tg("setMyCommands", { commands, scope: { type: "all_group_chats" } });
    // ★op 봇 DM(private) 슬래시 메뉴 — 퍼블릭 사용자가 팀 그룹 없이 op 봇 방만으로 운영 메뉴 접근(OWNER 2026-07-06).
    await tg("setMyCommands", { commands, scope: { type: "all_private_chats" } });
    if (GROUP_ID) await tg("setMyCommands", { commands, scope: { type: "chat", chat_id: Number(GROUP_ID) } });
  }
  async function loop(): Promise<void> {
    offset = (await readStoredOffset()) ?? await primeOffsetFromTelegram();
    await registerCommands();
    console.log(`[capture] started — group=${GROUP_ID} injection=${isRouterEnabled(deps.db) ? "ON" : "OFF(shadow)"} offset=${offset}`);
    while (!stopped) {
      try {
        const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=25&offset=${offset}&allowed_updates=["message","callback_query"]`;
        const res = await fetch(url, { signal: captureAbort.signal });
        const data = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
        for (const upd of data.result ?? []) {
          offset = upd.update_id + 1;
          if (upd.callback_query) { await handleCallback(upd.callback_query); await storeOffset(offset); continue; }
          const msg = upd.message;
          if (!msg) continue;
          const msgChatId = String(msg.chat?.id ?? "");
          const fromIdMsg = String(msg.from?.id ?? "");
          const isGroupMsg = GROUP_ID !== "" && msgChatId === GROUP_ID;
          // op 봇 방(OWNER 1:1 DM)에서 운영 슬래시 메뉴 허용(OWNER 2026-07-06). fail-closed: non-bot + private + chat.id===from.id(1:1) + allowlist(=OWNER).
          const isOwnerDm = !msg.from?.is_bot && msg.chat?.type === "private" && msgChatId === fromIdMsg && fromIdMsg !== "" && approvalAllowedIds().includes(fromIdMsg);
          // ★첫 세팅 그룹 자동발견★ — 아직 그룹이 설정되지 않았는데(shadow) 그룹 메시지를 봤다면 그 chat 을
          //   기록해 둔다. 그래야 detect-group 이 (getUpdates 경합 없이) 그룹 chat_id 를 꺼내 System OP 를
          //   구성할 수 있다. 기록만 하고 ingest/injection 은 하지 않는다(그룹 미설정이므로).
          if (GROUP_ID === "" && !msg.from?.is_bot) {
            try { rememberDiscoveredGroup(deps.db, msg.chat, new Date().toISOString()); } catch { /* best-effort */ }
          }
          if (!isGroupMsg && !isOwnerDm) continue;
          const msgId = msg.message_id != null ? String(msg.message_id) : undefined;
          if (msg.from?.is_bot) {
            const res = applyTelegramBotActivityAutoAck(deps.db, {
              chatId: GROUP_ID,
              messageId: msgId,
              from: msg.from,
              agents: deps.agents(),
            });
            if (res.agentId) {
              appendAuditFile("capture", "telegram_bot_activity_auto_ack", res.agentId, {
                chat_id: GROUP_ID,
                message_id: msgId ?? null,
                acked: res.acked,
              });
            }
            await storeOffset(offset);
            continue; // 봇 발신은 ingest/injection 하지 않음 — 루프 방지
          }
          rememberCaptureNonBotSender(deps.db, msg.from);
          const media = await captureMedia(msg, msgId);
          const text = msg.text ?? msg.caption ?? (media.length ? "[media]" : "");
          if (!text) { await storeOffset(offset); continue; }
          // 슬래시 명령은 팀op 가 직접 운영성 응답 → 에이전트 라우팅 스킵. 메뉴는 호출한 chat(그룹 or op DM)에 뜬다.
          if (msg.text && await handleSlashCommand(msg.text, msgId, isGroupMsg ? GROUP_ID : msgChatId)) { await storeOffset(offset); continue; }
          // op 봇 DM은 운영 슬래시 전용 — 팀 버스로 ingest 하지 않는다(그룹 메시지만 팀 라우팅).
          if (isOwnerDm) { await storeOffset(offset); continue; }
          const replyToAgentId = replyAuthorAgentId(msg.reply_to_message?.from?.username, deps.agents());
          await handle(text, msg.reply_to_message?.text, replyToAgentId, msgId, media);
          await storeOffset(offset);
        }
        // 새 승인/권한 요청을 OWNER op DM에 즉시 push(매 폴 사이클). 독립 try/catch로 폴러 격리(하네스 Q6: push 경로 DB 오류가 메인 폴 사이클 못 흔들게).
        try { await pushNewApprovals(); } catch (e) { console.error("[capture] pushNewApprovals:", (e as Error).message); }
      } catch (e) {
        if (stopped) break; // stop()의 abort로 fetch가 끊긴 정상 종료 — 에러 로깅·sleep 없이 즉시 탈출(이중폴 창 제거).
        console.error("[capture] poll error:", (e as Error).message);
        await sleep(3000);
      }
    }
  }

  void loop();
  return () => {
    stopped = true;
    try { captureAbort.abort(); } catch { /* best-effort — in-flight 롱폴 즉시 취소 */ }
  };
}

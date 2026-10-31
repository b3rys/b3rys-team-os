import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentRecord, WsEvent } from "../types";
import { acceptInbound } from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { cogsInbox, cogsToken, cogsCall, cogsDownloadFile, type CogsInbox } from "../lib/cogsRelay";
import { REPO_ROOT } from "../lib/personaTemplates";
import { injectPrompt, type InjectPromptOptions } from "../lib/tmuxInject";
import { getLocale } from "../lib/captureConfig";
import { isAgentOff } from "../lib/agentControl";
import { startCogsTyping } from "../lib/cogsTyping";

interface Deps {
  db: Database;
  agents: () => AgentRecord[];
  broadcast: (event: WsEvent) => void;
  inject?: typeof injectPrompt;
  startTyping?: typeof startCogsTyping;
  intervalMs?: number;
}

/**
 * 받을 방 종류. 1:1 은 방 자체가 그 사람이라 지금처럼 받는다.
 * 단체방은 허용한 사람(팀장)의 말만 — 같은 방의 다른 사람 말을 팀장 지시로 올리지 않는다.
 * 누가 받을지(멘션·답장·이름)는 cogs 서버가 그 봇에게 배달한 것으로 정해져 온다. AI DM 방 등 다른 종류는 받지 않는다.
 */
export function acceptsChat(config: { allow_senders: string[] }, chatType: unknown, senderId: unknown): boolean {
  if (chatType === "private") return true;
  if (chatType === "group") return senderId != null && config.allow_senders.includes(String(senderId));
  return false;
}

/** cogs `cogs_gap` update 값(`from_update_id`·`to_update_id`·`reason`)만 받아들인다. 모양이 다르면 null. reason 은 `overflow`/`unknown` 둘뿐. */
export function cogsGap(value: unknown): { from: number; to: number; reason: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const from = v.from_update_id, to = v.to_update_id;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || (from as number) > (to as number)) return null;
  // reason 은 원격 문자열이라 그대로 남기지 않는다(토큰·본문이 섞여도 audit·로그로 새지 않게). 아는 값만 고정 코드로.
  return { from: from as number, to: to as number, reason: v.reason === "overflow" ? "overflow" : "unknown" };
}

export interface CogsAttachmentRef { file_id: string; kind: string; name: string; mime: string; size: number }

const FILE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const clean = (v: unknown, max: number) => typeof v === "string" ? v.replace(/[\r\n\[\]]+/g, " ").trim().slice(0, max) : "";

/**
 * 메시지에 붙은 첨부 목록. cogs 는 `cogs_attachments` 에 전부 싣고, 텔레그램식 photo·document·voice 는 첫 첨부만 싣는다.
 * cogs_attachments 가 있으면 그것을, 없으면 텔레그램식 필드를 읽는다. file_id 모양이 다르면 버린다.
 */
export function cogsAttachments(m: any): CogsAttachmentRef[] {
  const out: CogsAttachmentRef[] = [];
  const push = (id: unknown, kind: string, name: unknown, mime: unknown, size: unknown) => {
    if (typeof id === "string" && FILE_ID_RE.test(id)) {
      out.push({ file_id: id, kind: clean(kind, 20) || "file", name: clean(name, 80), mime: clean(mime, 80), size: Number.isSafeInteger(size) ? size as number : 0 });
    }
  };
  if (Array.isArray(m?.cogs_attachments)) {
    for (const a of m.cogs_attachments) push(a?.file_id, String(a?.kind ?? ""), a?.name, a?.mime, a?.size);
    return out;
  }
  if (Array.isArray(m?.photo) && m.photo.length) {
    const p = m.photo.at(-1); push(p?.file_id, "photo", "", "", p?.file_size);
  }
  for (const kind of ["document", "video", "audio", "voice"]) {
    const d = m?.[kind]; if (d) push(d.file_id, kind, d.file_name, d.mime_type, d.file_size);
  }
  return out;
}

const MIME_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
  "image/heic": ".heic", "video/mp4": ".mp4", "video/quicktime": ".mov", "audio/mp4": ".m4a", "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg", "application/pdf": ".pdf", "text/plain": ".txt" };
function attachmentExt(a: CogsAttachmentRef): string {
  return MIME_EXT[a.mime.toLowerCase()] ?? a.name.match(/\.[A-Za-z0-9]{1,8}$/)?.[0]?.toLowerCase() ?? ".bin";
}
function attachmentDir(agentId: string): string {
  return process.env.COGS_ATTACHMENT_DIR ? join(process.env.COGS_ATTACHMENT_DIR, agentId) : join(REPO_ROOT, "var", "cogs-inbox", agentId);
}
const SAFE_DOWNLOAD_CODES = ["cogs_api_failed", "cogs_file_path_invalid", "cogs_file_too_large", "cogs_file_download_failed"];

/**
 * 첨부를 받아 로컬 경로를 본문 줄로 만든다. 받지 못한 첨부도 줄을 남긴다 — 조용히 사라지지 않게.
 * 파일 이름은 원래 이름을 쓰지 않고 봇 연결(identity) 앞 12자 + update 번호로 짓는다(원격 문자열이 경로가 되지 않게,
 *   update 번호는 연결마다 따로 세므로 다른 연결의 같은 번호가 지난 첨부를 덮지 않게).
 */
async function attachmentLines(deps: Deps, agentId: string, config: CogsInbox, token: string, identity: string, updateId: number,
  atts: CogsAttachmentRef[], signal: AbortSignal): Promise<string[]> {
  const max = Number(process.env.COGS_ATTACHMENT_MAX_BYTES ?? 50 * 1024 * 1024);
  const lines: string[] = [];
  for (const [i, a] of atts.entries()) {
    const label = `[첨부 ${i + 1}/${atts.length}: ${[a.kind, a.mime, a.name].filter(Boolean).join(" · ")}`;
    try {
      const dir = attachmentDir(agentId);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `${identity.slice(0, 12)}-${updateId}-${i + 1}${attachmentExt(a)}`);
      const size = await cogsDownloadFile(config, token, a.file_id, dest, max, signal);
      lines.push(`${label} · ${size} bytes → ${dest}]`);
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = error instanceof Error && SAFE_DOWNLOAD_CODES.includes(error.message) ? error.message : "cogs_file_download_failed";
      appendAudit(deps.db, "system", "cogs_attachment_failed", null, { agent_id: agentId, kind: a.kind, reason });
      lines.push(`${label} — 받지 못함 (${reason})]`);
    }
  }
  return lines;
}

/** One server owns polling. Offsets survive restart without storing bot tokens. */
export function createCogsPoller(deps: Deps) {
  const abort = new AbortController();
  let busy = false;
  async function pollOnce(): Promise<void> {
    if (busy || abort.signal.aborted) return;
    busy = true;
    const bots = new Set<string>();
    try {
      for (const agent of deps.agents()) {
        if (abort.signal.aborted) break;
        if (isAgentOff(agent.id)) continue;
        try {
          const config = cogsInbox(agent);
          if (!config) continue;
          const token = cogsToken(config);
          const identity = createHash("sha256").update(`${config.api_base}\n${token}`).digest("hex");
          if (bots.has(identity)) throw new Error("cogs_duplicate_bot");
          bots.add(identity);
          const key = `cogs_offset:${identity}`;
          const row = deps.db.query("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | null;
          let offset = Number(row?.value ?? 0);
          const updates = await cogsCall(config, token, "getUpdates", { offset, timeout: 0 }, abort.signal);
          if (!Array.isArray(updates)) throw new Error("cogs_updates_invalid");
          for (const update of updates) {
            if (abort.signal.aborted) return;
            if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
            // cogs 는 봇 큐가 넘치면 오래된 update 를 지우고 그 범위를 cogs_gap 한 건으로 알린다. 다시 받을 수 없으니
            //   유실 범위를 남겨 사람이 알 수 있게 하고, offset 은 그대로 넘긴다(같은 gap 을 다시 받지 않는다).
            const gap = cogsGap(update.cogs_gap);
            if (gap) {
              const lost = gap.to - gap.from + 1;
              appendAudit(deps.db, "system", "cogs_updates_lost", null, { agent_id: agent.id, from_update_id: gap.from, to_update_id: gap.to, lost, reason: gap.reason });
              console.warn(`[cogsPoll] ${agent.id}: cogs 큐가 넘쳐 update ${gap.from}~${gap.to}(${lost}건)를 받지 못했습니다 (${gap.reason})`);
            }
            const m = update.message;
            // 사진·영상·파일만 온 메시지도 넘긴다. 글은 text, 첨부 메시지면 caption 에 있다.
            const text = typeof m?.text === "string" ? m.text : typeof m?.caption === "string" ? m.caption : "";
            const atts = m ? cogsAttachments(m) : [];
            if (m && config.allow_from.includes(String(m.chat?.id)) && acceptsChat(config, m.chat?.type, m.from?.id) &&
                !m.from?.is_bot && m.from?.id != null && (text.trim() || atts.length) && Number.isSafeInteger(m.message_id)) {
              const lines = atts.length ? await attachmentLines(deps, agent.id, config, token, identity, update.update_id, atts, abort.signal) : [];
              if (abort.signal.aborted) return;
              const content = [text, ...lines].filter((l) => l.trim()).join("\n");
              const group = m.chat.type === "group";
              const thread = `cogs-${createHash("sha256").update(`${agent.id}:${identity}:${m.chat.id}`).digest("hex").slice(0, 24)}`;
              const accepted = acceptInbound(deps.db, {
                thread_id: thread, from_agent_id: "user", to_agent_id: agent.id, type: "dm", source: "user",
                body: content, priority: "normal", hop_count: 0, dedupe_key: `cogs:${identity}:${update.update_id}`,
                meta: { cogs: { agent_id: agent.id, chat_id: String(m.chat.id), message_id: m.message_id,
                  from: { id: String(m.from.id), name: m.from.first_name }, ...(group ? { chat_type: "group" } : {}) } },
              }, { dedupeWindowSec: 86400, broadcast: deps.broadcast });
              const messageId = accepted.ok ? accepted.stored.id : accepted.duplicate;
              const opts: InjectPromptOptions = {
                session: agent.tmux_session!, agentId: agent.id, source: "cogs", kind: "cogs", locale: getLocale(deps.db),
                fromLabel: `cogs:${m.from.id}`, threadId: thread, messageId,
                // 단체방은 주인 판단(멘션 > 답장 원글 작성자)에 쓰도록 답장 대상 작성자를 같이 적는다.
                body: `[cogs ${group ? "group " : ""}chat_id=${m.chat.id}, sender_id=${m.from.id}${group && m.reply_to_message?.from?.first_name ? `, reply_to=${String(m.reply_to_message.from.first_name).slice(0, 40)}` : ""}]\n${content}`, hopCount: 0,
              };
              const injected = await (deps.inject ?? injectPrompt)(opts);
              if (abort.signal.aborted) return;
              appendAudit(deps.db, "system", injected.ok ? "cogs_inject_ok" : "cogs_inject_failed", messageId, { agent_id: agent.id, maybePartial: !!injected.maybePartial });
              // 넣었으면 답이 나갈 때까지 그 방에 '입력 중'을 보낸다(lib/cogsTyping). 못 넣었으면 일하는 중이 아니다.
              if (injected.ok || injected.maybePartial) (deps.startTyping ?? startCogsTyping)(agent.id, String(m.chat.id), config, token, { replyToMessageId: m.message_id });
              if (!injected.ok && !injected.maybePartial) break; // retry the same update; no second DB insertion
            }
            offset = update.update_id + 1;
            deps.db.query("INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(offset));
          }
        } catch (error) {
          const safeCodes = ["cogs_bridge_polling_conflict", "cogs_duplicate_bot", "cogs_inbox_invalid", "cogs_requires_claude_tmux", "cogs_token_unavailable", "cogs_api_failed", "cogs_updates_invalid"];
          const reason = error instanceof Error && safeCodes.includes(error.message) ? error.message : "cogs_poll_error";
          if (!abort.signal.aborted) appendAudit(deps.db, "system", "cogs_poll_failed", null, { agent_id: agent.id, reason });
        }
      }
    } finally { busy = false; }
  }
  return { pollOnce, stop: () => abort.abort() };
}

export function startCogsPoll(deps: Deps): () => void {
  const poller = createCogsPoller(deps);
  const timer = setInterval(() => void poller.pollOnce(), deps.intervalMs ?? 3000);
  void poller.pollOnce();
  return () => { clearInterval(timer); poller.stop(); };
}

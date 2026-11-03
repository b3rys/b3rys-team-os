import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentRecord, WsEvent } from "../types";
import { acceptInbound } from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { cogsInbox, cogsRoomAllowed, cogsToken, cogsCall, cogsDownloadFile, type CogsInbox } from "../lib/cogsRelay";
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

/** long polling 한 번에 cogs 서버가 새 update 를 기다려 주는 최대 초(서버 상한 50). 새 말이 오면 그 즉시 돌아온다. */
export const COGS_LONG_POLL_SEC = 25;

/** 한 번 받은 결과. ok=다시 바로 묻는다 · wait=잠깐 쉬고 다시 · stop=이 팀원은 더 받지 않는다(설정 없음·꺼짐·중복). */
type PollResult = "ok" | "wait" | "stop";

/** One server owns polling. Offsets survive restart without storing bot tokens. */
export function createCogsPoller(deps: Deps) {
  const abort = new AbortController();
  let busy = false;

  /**
   * 팀원 한 명의 봇에서 update 를 받아 넣는다. claim 은 같은 봇을 두 팀원이 받지 않게 막는다.
   * longPollSec>0 이면 서버가 새 말을 기다리는 동안 설정이 바뀌거나 팀원이 꺼질 수 있어, 돌아온 뒤 다시 확인하고 아니면 넣지 않는다.
   */
  async function pollAgent(agent: AgentRecord, claim: (identity: string) => boolean, longPollSec: number): Promise<PollResult> {
    if (isAgentOff(agent.id)) return "stop";
    try {
      let config = cogsInbox(agent);
      if (!config) return "stop";
      const token = cogsToken(config);
      const identity = createHash("sha256").update(`${config.api_base}\n${token}`).digest("hex");
      if (!claim(identity)) throw new Error("cogs_duplicate_bot");
      const key = `cogs_offset:${identity}`;
      const row = deps.db.query("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | null;
      let offset = Number(row?.value ?? 0);
      const updates = await cogsCall(config, token, "getUpdates", { offset, timeout: longPollSec }, abort.signal,
        longPollSec > 0 ? (longPollSec + 10) * 1000 : undefined);
      if (!Array.isArray(updates)) throw new Error("cogs_updates_invalid");
      if (longPollSec > 0 && updates.length) {
        const current = deps.agents().find((a) => a.id === agent.id);
        const fresh = current && !isAgentOff(agent.id) ? cogsInbox(current) : null;
        // 같은 봇(주소와 토큰 내용으로 만든 identity)일 때만 넣는다. 아니면 offset 을 넘기지 않아 다음에 맞는 설정으로 다시 받는다.
        if (!fresh || createHash("sha256").update(`${fresh.api_base}\n${cogsToken(fresh)}`).digest("hex") !== identity) return "stop";
        // 넣는 곳(tmux 세션 등)도 기다리는 사이 바뀌었을 수 있으니 지금 기록을 쓴다.
        agent = current!; config = fresh;
      }
      for (const update of updates) {
        if (abort.signal.aborted) return "ok";
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
        if (m && cogsRoomAllowed(config, m.chat?.id) && acceptsChat(config, m.chat?.type, m.from?.id) &&
            !m.from?.is_bot && m.from?.id != null && (text.trim() || atts.length) && Number.isSafeInteger(m.message_id)) {
          const lines = atts.length ? await attachmentLines(deps, agent.id, config, token, identity, update.update_id, atts, abort.signal) : [];
          if (abort.signal.aborted) return "ok";
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
          if (abort.signal.aborted) return "ok";
          appendAudit(deps.db, "system", injected.ok ? "cogs_inject_ok" : "cogs_inject_failed", messageId, { agent_id: agent.id, maybePartial: !!injected.maybePartial });
          // 넣었으면 답이 나갈 때까지 그 방에 '입력 중'을 보낸다(lib/cogsTyping). 못 넣었으면 일하는 중이 아니다.
          if (injected.ok || injected.maybePartial) (deps.startTyping ?? startCogsTyping)(agent.id, String(m.chat.id), config, token, { replyToMessageId: m.message_id });
          if (!injected.ok && !injected.maybePartial) return "wait"; // retry the same update; no second DB insertion
        }
        offset = update.update_id + 1;
        deps.db.query("INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(offset));
      }
      return "ok";
    } catch (error) {
      const safeCodes = ["cogs_bridge_polling_conflict", "cogs_duplicate_bot", "cogs_inbox_invalid", "cogs_requires_claude_tmux", "cogs_token_unavailable", "cogs_api_failed", "cogs_updates_invalid"];
      const reason = error instanceof Error && safeCodes.includes(error.message) ? error.message : "cogs_poll_error";
      if (!abort.signal.aborted) appendAudit(deps.db, "system", "cogs_poll_failed", null, { agent_id: agent.id, reason });
      return error instanceof Error && error.message === "cogs_duplicate_bot" ? "stop" : "wait";
    }
  }

  /** 모든 팀원을 한 번씩, 기다리지 않고(timeout 0) 차례로 받는다. */
  async function pollOnce(): Promise<void> {
    if (busy || abort.signal.aborted) return;
    busy = true;
    const bots = new Set<string>();
    try {
      for (const agent of deps.agents()) {
        if (abort.signal.aborted) break;
        await pollAgent(agent, (identity) => !bots.has(identity) && !!bots.add(identity), 0);
      }
    } finally { busy = false; }
  }

  /**
   * 팀원마다 따로 long polling 을 돈다 — 한 팀원이 기다리는 동안 다른 팀원 말이 막히지 않게.
   * 새로 받을 팀원이 생기면 시작하고, 설정이 없어지거나 꺼지면 그 팀원 고리는 끝난다(다음 확인 때 다시 시작될 수 있다).
   */
  const running = new Set<string>();
  const owners = new Map<string, string>(); // 봇 identity → 받는 팀원 id
  function supervise(longPollSec = COGS_LONG_POLL_SEC, waitMs = deps.intervalMs ?? 3000): void {
    if (abort.signal.aborted) return;
    for (const agent of deps.agents()) {
      if (running.has(agent.id) || isAgentOff(agent.id) || agent.cogs_inbox == null) continue;
      running.add(agent.id);
      void (async () => {
        const claim = (identity: string) => {
          const owner = owners.get(identity);
          if (owner && owner !== agent.id) return false;
          for (const [id, who] of owners) if (who === agent.id && id !== identity) owners.delete(id);
          owners.set(identity, agent.id); return true;
        };
        try {
          while (!abort.signal.aborted) {
            const current = deps.agents().find((a) => a.id === agent.id);
            if (!current) break;
            const result = await pollAgent(current, claim, longPollSec);
            if (result === "stop") break;
            if (result === "wait") await Bun.sleep(waitMs);
          }
        } finally {
          running.delete(agent.id);
          for (const [id, who] of owners) if (who === agent.id) owners.delete(id);
        }
      })();
    }
  }
  return { pollOnce, supervise, stop: () => abort.abort() };
}

export function startCogsPoll(deps: Deps): () => void {
  const poller = createCogsPoller(deps);
  const timer = setInterval(() => poller.supervise(), deps.intervalMs ?? 3000);
  poller.supervise();
  return () => { clearInterval(timer); poller.stop(); };
}

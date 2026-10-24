import { createCogsTmuxSupervisor } from "./cogsTmuxSupervisor";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AgentRecord, WsEvent } from "../types";
import { acceptInbound } from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { cogsInbox, cogsToken, cogsCall } from "../lib/cogsRelay";
import { injectPrompt, type InjectPromptOptions } from "../lib/tmuxInject";
import { getLocale } from "../lib/captureConfig";
import { isAgentOff } from "../lib/agentControl";

interface Deps {
  db: Database;
  agents: () => AgentRecord[];
  broadcast: (event: WsEvent) => void;
  inject?: typeof injectPrompt;
  intervalMs?: number;
  ensureSession?: (agent: AgentRecord) => Promise<boolean>;
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

/** One server owns polling. Offsets survive restart without storing bot tokens. */
export function createCogsPoller(deps: Deps) {
  const ensureSession = deps.ensureSession ?? createCogsTmuxSupervisor({onRecovery:(agent,ok) => {
    appendAudit(deps.db,"system", ok ? "cogs_tmux_recovered" : "cogs_tmux_recovery_failed",agent.id,{});
  }});
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
          if (!(await ensureSession(agent))) continue;
          const identity = createHash("sha256").update(`${config.api_base}\n${token}`).digest("hex");
          if (bots.has(identity)) throw new Error("cogs_duplicate_bot");
          bots.add(identity);
          const key = `cogs_offset:${identity}`;
          const row = deps.db.query("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | null;
          let offset = Number(row?.value ?? 0);
          const updates = await cogsCall(config, token, "getUpdates", { offset, timeout: 0 }, abort.signal);
          if (!Array.isArray(updates)) throw new Error("cogs_updates_invalid");
          deps.db.query("INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`cogs_poll_at:${agent.id}`,String(Date.now()));
          for (const update of updates) {
            if (abort.signal.aborted) return;
            if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
            const m = update.message;
            if (m && config.allow_from.includes(String(m.chat?.id)) && acceptsChat(config, m.chat?.type, m.from?.id) &&
                !m.from?.is_bot && m.from?.id != null && typeof m.text === "string" && m.text.trim() && Number.isSafeInteger(m.message_id)) {
              const group = m.chat.type === "group";
              const thread = `cogs-${createHash("sha256").update(`${agent.id}:${identity}:${m.chat.id}`).digest("hex").slice(0, 24)}`;
              const accepted = acceptInbound(deps.db, {
                thread_id: thread, from_agent_id: "user", to_agent_id: agent.id, type: "dm", source: "user",
                body: m.text, priority: "normal", hop_count: 0, dedupe_key: `cogs:${identity}:${update.update_id}`,
                meta: { cogs: { agent_id: agent.id, chat_id: String(m.chat.id), message_id: m.message_id,
                  from: { id: String(m.from.id), name: m.from.first_name }, ...(group ? { chat_type: "group" } : {}) } },
              }, { dedupeWindowSec: 86400, broadcast: deps.broadcast });
              const messageId = accepted.ok ? accepted.stored.id : accepted.duplicate;
              const opts: InjectPromptOptions = {
                session: agent.tmux_session!, agentId: agent.id, source: "cogs", kind: "cogs", locale: getLocale(deps.db),
                fromLabel: `cogs:${m.from.id}`, threadId: thread, messageId,
                // 단체방은 주인 판단(멘션 > 답장 원글 작성자)에 쓰도록 답장 대상 작성자를 같이 적는다.
                body: `[cogs ${group ? "group " : ""}chat_id=${m.chat.id}, sender_id=${m.from.id}${group && m.reply_to_message?.from?.first_name ? `, reply_to=${String(m.reply_to_message.from.first_name).slice(0, 40)}` : ""}]\n${m.text}`, hopCount: 0,
              };
              const injected = await (deps.inject ?? injectPrompt)(opts);
              if (abort.signal.aborted) return;
              appendAudit(deps.db, "system", injected.ok ? "cogs_inject_ok" : "cogs_inject_failed", messageId, { agent_id: agent.id, maybePartial: !!injected.maybePartial });
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

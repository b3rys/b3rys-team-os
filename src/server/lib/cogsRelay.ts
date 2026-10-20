import { readFileSync } from "node:fs";
import type { AgentRecord } from "../types";
import { memberChannel, readMemberChannel } from "./memberChannel";

export interface CogsMeta {
  agent_id: string;
  chat_id: string;
  message_id: number;
  from: { id: string; name?: string };
}
export interface CogsInbox { api_base: string; token_file: string; allow_from: string[] }

/** Invalid configurations fail closed; error text never includes credentials or remote bodies. */
export function cogsInbox(agent: AgentRecord): CogsInbox | null {
  const raw = agent.cogs_inbox;
  if (raw == null || agent.enabled === false) return null;
  if (agent.runtime !== "claude_channel" || !agent.tmux_session) throw new Error("cogs_requires_claude_tmux");
  if ((agent.channel ? memberChannel(agent) : readMemberChannel(agent.id)).kind === "b3chat") throw new Error("cogs_bridge_polling_conflict");
  try {
    const url = new URL(raw.api_base);
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw 0;
    if (typeof raw.token_file !== "string" || !raw.token_file.startsWith("/") ||
        !Array.isArray(raw.allow_from) || !raw.allow_from.length ||
        !raw.allow_from.every((id) => /^-?\d+$/.test(String(id)))) throw 0;
    return { api_base: url.href.replace(/\/+$/, ""), token_file: raw.token_file, allow_from: raw.allow_from.map(String) };
  } catch { throw new Error("cogs_inbox_invalid"); }
}

export function cogsToken(config: CogsInbox): string {
  try {
    const token = readFileSync(config.token_file, "utf8").trim();
    if (!token || /\s/.test(token)) throw 0;
    return token;
  } catch { throw new Error("cogs_token_unavailable"); }
}

export async function cogsCall(config: CogsInbox, token: string, method: string, body: unknown, signal?: AbortSignal): Promise<any> {
  try {
    const res = await fetch(`${config.api_base}/bot${encodeURIComponent(token)}/${method}`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    const data = await res.json() as { ok?: boolean; result?: unknown };
    if (!res.ok || data.ok !== true) throw 0;
    return data.result;
  } catch { throw new Error("cogs_api_failed"); }
}

export async function sendCogsReply(agent: AgentRecord | undefined, meta: CogsMeta, text: string): Promise<void> {
  if (!agent || agent.id !== meta.agent_id) throw new Error("cogs_reply_agent_mismatch");
  const config = cogsInbox(agent);
  if (!config || !config.allow_from.includes(meta.chat_id)) throw new Error("cogs_reply_not_allowed");
  const result = await cogsCall(config, cogsToken(config), "sendMessage", { chat_id: meta.chat_id, text, reply_to_message_id: meta.message_id });
  if (!Number.isSafeInteger(result?.message_id)) throw new Error("cogs_post_missing_id");
}

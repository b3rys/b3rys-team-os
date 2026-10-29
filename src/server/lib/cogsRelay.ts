import { readFileSync } from "node:fs";
import type { AgentRecord } from "../types";
import { memberChannel, readMemberChannel } from "./memberChannel";

export interface CogsMeta {
  agent_id: string;
  chat_id: string;
  message_id: number;
  from: { id: string; name?: string };
  /** 단체방에서 온 말이면 "group". 없으면 1:1. */
  chat_type?: "group";
}
export interface CogsInbox {
  api_base: string; token_file: string;
  /** 말을 받을 방 id(1:1 방·단체방). */
  allow_from: string[];
  /** 단체방에서 말을 받을 사람(cogs user id, 보통 팀장). 비어 있으면 단체방은 받지 않는다 — 1:1 은 방 자체가 그 사람이다. */
  allow_senders: string[];
}

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
    const senders = (raw as { allow_senders?: unknown }).allow_senders;
    if (senders !== undefined && (!Array.isArray(senders) || !senders.every((id) => /^\d+$/.test(String(id))))) throw 0;
    return { api_base: url.href.replace(/\/+$/, ""), token_file: raw.token_file, allow_from: raw.allow_from.map(String),
      allow_senders: (senders as unknown[] | undefined ?? []).map(String) };
  } catch { throw new Error("cogs_inbox_invalid"); }
}

export function cogsToken(config: CogsInbox): string {
  try {
    const token = readFileSync(config.token_file, "utf8").trim();
    if (!token || /\s/.test(token)) throw 0;
    return token;
  } catch { throw new Error("cogs_token_unavailable"); }
}

/** The request may have posted even though its acknowledgement was lost. */
export class CogsDeliveryUnknown extends Error {
  constructor() { super("cogs_delivery_unknown"); }
}

export async function cogsCall(config: Pick<CogsInbox, "api_base">, token: string, method: string, body: unknown, signal?: AbortSignal): Promise<any> {
  let res: Response;
  let data: { ok?: boolean; result?: unknown };
  try {
    res = await fetch(`${config.api_base}/bot${encodeURIComponent(token)}/${method}`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    data = await res.json() as typeof data;
  } catch {
    if (method === "sendMessage") throw new CogsDeliveryUnknown();
    throw new Error("cogs_api_failed");
  }
  // Only an explicit rejection proves that retrying cannot duplicate a post.
  if (data?.ok === false) throw new Error("cogs_api_failed");
  if (!res.ok || data?.ok !== true) {
    if (method === "sendMessage") throw new CogsDeliveryUnknown();
    throw new Error("cogs_api_failed");
  }
  return data.result;
}

/** 올라간 cogs 메시지 번호를 돌려준다(팀원끼리 대화 종료 보고에 쓴다). */
export async function sendCogsReply(agent: AgentRecord | undefined, meta: CogsMeta, text: string): Promise<number> {
  if (!agent || agent.id !== meta.agent_id) throw new Error("cogs_reply_agent_mismatch");
  const config = cogsInbox(agent);
  if (!config || !config.allow_from.includes(meta.chat_id)) throw new Error("cogs_reply_not_allowed");
  const result = await cogsCall(config, cogsToken(config), "sendMessage", { chat_id: meta.chat_id, text, reply_to_message_id: meta.message_id });
  if (!Number.isSafeInteger(result?.message_id)) throw new CogsDeliveryUnknown();
  return result.message_id;
}

/** 팀원이 받은 cogs 메시지에 자기 봇으로 리액션을 붙인다. 빈 문자열이면 지운다. cogs 는 봇당 한 개만 두어 다시 부르면 바뀐다. */
export async function setCogsReaction(agent: AgentRecord | undefined, meta: CogsMeta, emoji: string): Promise<void> {
  if (!agent || agent.id !== meta.agent_id) throw new Error("cogs_reaction_agent_mismatch");
  const config = cogsInbox(agent);
  if (!config || !config.allow_from.includes(meta.chat_id)) throw new Error("cogs_reaction_not_allowed");
  await cogsCall(config, cogsToken(config), "setMessageReaction", {
    chat_id: meta.chat_id, message_id: meta.message_id,
    // cogs 는 JSON 배열과 문자열 둘 다 받는다. 문자열로 보내 Telegram form 방식과도 같게 한다.
    reaction: JSON.stringify(emoji ? [{ type: "emoji", emoji }] : []),
  });
}

/** 이모지 하나(글자 묶음 1개)인가. 빈 값은 지우기라 따로 다룬다. 최종 판정은 cogs 서버가 한다. */
export function isSingleEmoji(value: string): boolean {
  if (!value || value.length > 32 || value.trim() !== value) return false;
  const parts = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)];
  return parts.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(value);
}

/** 첨부 하나를 받아 dest 에 쓴다. 실패는 고정 코드로만 던진다(원격 본문·주소·토큰을 오류에 싣지 않는다). */
export async function cogsDownloadFile(config: Pick<CogsInbox, "api_base">, token: string, fileId: string, dest: string,
  maxBytes: number, signal?: AbortSignal): Promise<number> {
  const info = await cogsCall(config, token, "getFile", { file_id: fileId }, signal);
  const path = info?.file_path;
  // cogs 는 "files/<file_id>" 를 준다. 경로를 벗어나는 값은 받지 않는다.
  if (typeof path !== "string" || !/^[A-Za-z0-9_\-./]+$/.test(path) || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error("cogs_file_path_invalid");
  }
  if (Number.isSafeInteger(info?.file_size) && info.file_size > maxBytes) throw new Error("cogs_file_too_large");
  let res: Response;
  try {
    res = await fetch(`${config.api_base}/file/bot${encodeURIComponent(token)}/${path}`, {
      redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
  } catch { throw new Error("cogs_file_download_failed"); }
  if (!res.ok || !res.body) throw new Error("cogs_file_download_failed");
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new Error("cogs_file_too_large");
  // 크기를 알리지 않거나 줄여 알린 응답도 있으니 읽는 중에 세고, 넘으면 그 자리에서 끊는다.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new Error("cogs_file_too_large"); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "cogs_file_too_large") throw error;
    throw new Error("cogs_file_download_failed");
  }
  await Bun.write(dest, new Blob(chunks as BlobPart[]));
  return total;
}

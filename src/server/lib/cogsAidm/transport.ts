import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AgentRecord, WsEvent } from "../../types";
import { cogsCall } from "../cogsRelay";
import { cogsIdentityOf } from "./api";
import { acceptInbound } from "../../db/inboxQueries";
import type { CogsIdentity } from "./relay";

export interface CogsAiOrigin {
  agent_id:string;peer_agent_id:string;chat_id:string;message_id:number;
  work_id:number;chain_id:string;hop:number;bus_seq:number;
}
export function validAiMessage(m:any): boolean {
  return m?.chat?.type === "ai_dm" && /^-?\d+$/.test(String(m.chat.id)) && m.from?.is_bot === true &&
    Number.isSafeInteger(m.from.id) && Number.isSafeInteger(m.message_id) && m.message_id>0 &&
    Number.isSafeInteger(m.work_id) && m.work_id>0 && typeof m.cogs_chain_id === "string" && m.cogs_chain_id.length>0 && m.cogs_chain_id.length<=200 &&
    Number.isSafeInteger(m.cogs_hop) && m.cogs_hop>=1 && m.cogs_hop<=4 && Number.isSafeInteger(m.bus_seq) && m.bus_seq>0 &&
    typeof m.text === "string" && !!m.text.trim();
}
/** Bind a bot identity to an enabled local roster member using authenticated getMe. */
export function createCogsPeerResolver(identityOf = cogsIdentityOf, now=Date.now) {
  const cache=new Map<string,{id:number;at:number}>();
  return async(receiver:AgentRecord,apiBase:string,senderId:number,roster:AgentRecord[]):Promise<string|null> => {
    for (const peer of roster) {
      if (peer.id === receiver.id || peer.enabled === false) continue;
      const identity=identityOf(peer);
      if (!identity || identity.apiBase.replace(/\/$/,"") !== apiBase.replace(/\/$/,"")) continue;
      const key=createHash("sha256").update(`${peer.id}\n${identity.apiBase}\n${identity.token}`).digest("hex");
      let known=cache.get(key);
      if (!known || now()-known.at>60_000) {
        try {
          const me=await cogsCall({api_base:identity.apiBase},identity.token,"getMe",{});
          if (!Number.isSafeInteger(me?.id) || me?.is_bot === false) continue;
          known={id:me.id,at:now()};cache.set(key,known);
        } catch {continue;}
      }
      if (known.id === senderId) return peer.id;
    }
    return null;
  };
}
export function acceptCogsAiMessage(db:Database,agent:AgentRecord,peer:string,m:any,identity:string,updateId:number,direct:boolean,broadcast?:(event:WsEvent)=>void) {
  if (!validAiMessage(m)) throw new Error("cogs_ai_invalid");
  const thread=`cogs-ai-${createHash("sha256").update(`${identity}:${m.chat.id}:${m.work_id}`).digest("hex").slice(0,24)}`;
  const origin:CogsAiOrigin={agent_id:agent.id,peer_agent_id:peer,chat_id:String(m.chat.id),message_id:m.message_id,
    work_id:m.work_id,chain_id:m.cogs_chain_id,hop:m.cogs_hop,bus_seq:m.bus_seq};
  const result=acceptInbound(db,{thread_id:thread,from_agent_id:peer,to_agent_id:agent.id,type:"dm",source:"agent",body:m.text,priority:"normal",
    hop_count:m.cogs_hop,dedupe_key:`cogs-ai:${identity}:${updateId}`,meta:{cogs_ai:origin,...(direct?{no_wake:true}:{})}},
    {dedupeWindowSec:86400,broadcast});
  return {thread,messageId:result.ok?result.stored.id:result.duplicate,origin};
}
export function findCogsAiOrigin(db:Database,actor:string,thread:string,message:string):CogsAiOrigin|null {
  const row=db.query("SELECT meta_json FROM message WHERE id=? AND thread_id=? AND source='agent' AND to_agent_id=?").get(message,thread,actor) as {meta_json:string}|null;
  try {const origin=JSON.parse(row?.meta_json ?? "null")?.cogs_ai;return origin?.agent_id===actor ? origin : null;} catch {return null;}
}
export async function sendCogsAiReply(identity:CogsIdentity,origin:CogsAiOrigin,text:string) {
  const key=createHash("sha256").update(JSON.stringify([origin.agent_id,origin.chat_id,origin.message_id,text])).digest("hex");
  const result=await cogsCall({api_base:identity.apiBase},identity.token,"sendMessage",{chat_id:origin.chat_id,work_id:origin.work_id,
    client_msg_id:`b3os-ai-${key}`,text,bus_seq:origin.bus_seq+1,cogs_chain_id:origin.chain_id,cogs_hop:origin.hop,no_wake:false});
  if (!Number.isSafeInteger(result?.message_id)) throw new Error("cogs_ai_reply_failed");
  return result.message_id as number;
}

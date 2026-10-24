import { findCogsAiOrigin, sendCogsAiReply } from "../../lib/cogsAidm/transport";
import { cogsIdentityOf } from "../../lib/cogsAidm/api";
import { ambientAgents } from "../../lib/registry";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { REPO_ROOT } from "../../lib/personaTemplates";

export function ownsCogsMessage(db: Database, agentId: string, thread: string, message: string): boolean {
  if (db.query(`SELECT 1 FROM message WHERE id=? AND thread_id=?
    AND (json_extract(meta_json,'$.cogs.agent_id')=? OR json_extract(meta_json,'$.cogs_ai.agent_id')=?)`).get(message,thread,agentId,agentId)) return true;
  try { return !!db.query(`SELECT 1 FROM message m
    WHERE m.id=? AND m.thread_id=? AND (m.to_agent_id=? OR EXISTS(SELECT 1 FROM message_recipient r WHERE r.message_id=m.id AND r.agent_id=?)) AND EXISTS(SELECT 1 FROM message origin WHERE origin.thread_id=m.thread_id
      AND origin.source='user' AND json_extract(origin.meta_json,'$.cogs.agent_id')=?)`).get(message,thread,agentId,agentId,agentId); } catch {return false;}
}

export async function main() {
  const actor = process.env.GD_AGENT_ID;
  if (!actor || !/^[a-z][a-z0-9_-]{1,31}$/.test(actor)) throw new Error("invalid_actor");
  const db = new Database(process.env.TEAM_DB_PATH ?? join(REPO_ROOT,"team.db"), {readonly:true});
  const server = new McpServer({name:"cogs_reply",version:"1.0.0"});
  const register = (server as {registerTool:(...args:unknown[])=>unknown}).registerTool.bind(server);
  register("reply", {description:"Reply to a cogs message received by this teammate, in its original room.",
    inputSchema:{thread_id:z.string().min(1).max(200),message_id:z.string().min(1).max(200),text:z.string().min(1).max(32000)}},
  async ({thread_id,message_id,text}: {thread_id:string;message_id:string;text:string}) => {
    if (!ownsCogsMessage(db,actor,thread_id,message_id)) return {isError:true,content:[{type:"text",text:"cogs_reply_not_owned"}]};
    const aiOrigin=findCogsAiOrigin(db,actor,thread_id,message_id);
    if (aiOrigin) {
      const identity=cogsIdentityOf(ambientAgents().find(a=>a.id===actor));
      if (!identity || !ambientAgents().some(a=>a.id===aiOrigin.peer_agent_id && a.enabled !== false)) return {isError:true,content:[{type:"text",text:"cogs_peer_unavailable"}]};
      try { await sendCogsAiReply(identity,aiOrigin,text);return {content:[{type:"text",text:"Reply submitted to original AI work."}]}; }
      catch {return {isError:true,content:[{type:"text",text:"cogs_ai_reply_failed"}]};}
    }
    const original=db.query("SELECT id FROM message WHERE thread_id=? AND source='user' AND json_extract(meta_json,'$.cogs.agent_id')=? ORDER BY created_at ASC LIMIT 1").get(thread_id,actor) as {id:string}|null;
    const replyTo=original?.id ?? message_id;
    const p = Bun.spawn(["bash",join(REPO_ROOT,"skills/b3os-team-inbox/scripts/send.sh"),"--to","broadcast","--thread",thread_id,"--in-reply-to",replyTo,"--body",text],
      {cwd:REPO_ROOT,env:{...process.env,GD_AGENT_ID:actor},stdout:"ignore",stderr:"ignore"});
    const code = await p.exited;
    return {isError:code!==0,content:[{type:"text",text:code===0 ? "Reply submitted to original cogs room." : "cogs_reply_failed"}]};
  });
  register("ask_teammate",{description:"Ask a registered teammate in the same cogs server about the received request. Keep its thread and original message ID.",
    inputSchema:{thread_id:z.string().min(1).max(200),message_id:z.string().min(1).max(200),peer:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),text:z.string().min(1).max(32000)}},
    async({thread_id,message_id,peer,text}:{thread_id:string;message_id:string;peer:string;text:string})=>{
      if (!ownsCogsMessage(db,actor,thread_id,message_id) || peer === actor) return {isError:true,content:[{type:"text",text:"cogs_request_not_owned"}]};
      const roster=ambientAgents(),self=cogsIdentityOf(roster.find(a=>a.id===actor)),other=cogsIdentityOf(roster.find(a=>a.id===peer));
      if (!self || !other || self.apiBase !== other.apiBase) return {isError:true,content:[{type:"text",text:"cogs_peer_unavailable"}]};
      const parent=db.query("SELECT hop_count FROM message WHERE id=?").get(message_id) as {hop_count:number};
      const p=Bun.spawn(["bash",join(REPO_ROOT,"skills/b3os-team-inbox/scripts/send.sh"),"--to",peer,"--thread",thread_id,"--in-reply-to",message_id,"--hop",String(parent.hop_count+1),"--body",text],
        {cwd:REPO_ROOT,env:{...process.env,GD_AGENT_ID:actor},stdout:"ignore",stderr:"ignore"});
      const code=await p.exited;return {isError:code!==0,content:[{type:"text",text:code===0?"Teammate request submitted.":"cogs_teammate_request_failed"}]};
    });
  await server.connect(new StdioServerTransport());
}
if (import.meta.main) await main();

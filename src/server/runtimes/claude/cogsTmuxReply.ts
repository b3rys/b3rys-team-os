import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { REPO_ROOT } from "../../lib/personaTemplates";

export function ownsCogsMessage(db: Database, agentId: string, thread: string, message: string): boolean {
  return !!db.query(`SELECT 1 FROM message WHERE id=? AND thread_id=?
    AND json_extract(meta_json,'$.cogs.agent_id')=?`).get(message,thread,agentId);
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
    const p = Bun.spawn(["bash",join(REPO_ROOT,"skills/b3os-team-inbox/scripts/send.sh"),"--to","broadcast","--thread",thread_id,"--in-reply-to",message_id,"--body",text],
      {cwd:REPO_ROOT,env:{...process.env,GD_AGENT_ID:actor},stdout:"ignore",stderr:"ignore"});
    const code = await p.exited;
    return {isError:code!==0,content:[{type:"text",text:code===0 ? "Reply submitted to original cogs room." : "cogs_reply_failed"}]};
  });
  await server.connect(new StdioServerTransport());
}
if (import.meta.main) await main();

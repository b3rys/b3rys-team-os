import { Hono } from "hono";
import type { AgentRecord } from "../types";
import { cogsInbox } from "../lib/cogsRelay";
import { isActive, updateCogsProgress } from "../lib/cogsTyping";
import { cogsActivityCode } from "../runtimes/codex/cogsActivity";

/** Build a kind-only item: even filenames, queries and shell executables stay local. */
export function progressCode(tool: string): string {
  const item = ["Read", "Glob", "Grep"].includes(tool) ? { type: "readFiles" }
    : ["Edit", "MultiEdit", "NotebookEdit"].includes(tool) ? { type: "fileChange" }
    : tool === "WebSearch" ? { type: "webSearch" }
    : tool === "WebFetch" ? { type: "webSearch", action: { type: "openPage" } }
    : { type: "mcpToolCall", name: tool === "TodoWrite" ? "update_plan" : tool === "Write" ? "write" : "tool" };
  return cogsActivityCode(item) ?? "tool";
}

export function createCogsProgressRoutes(agents: () => AgentRecord[]): Hono {
  const r = new Hono();
  r.post("/cogs/progress", async (c) => {
    // No auditing/logging of this request: it contains private tool input.
    if (process.env.B3OS_COGS_PROGRESS === "0") return c.json({ ok: true, accepted: false }, 202);
    let raw: any;
    try { raw = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid_json" }, 400); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || typeof raw.agent !== "string" || !/^[a-zA-Z0-9_-]+$/.test(raw.agent)
      || typeof raw.session_id !== "string" || !raw.session_id
      || typeof raw.tool_name !== "string" || !raw.tool_name || raw.tool_name.length > 512
      || !(typeof raw.chat_id === "string" && /^-?\d+$/.test(raw.chat_id))) {
      return c.json({ ok: false, error: "invalid_progress" }, 400);
    }
    const { agent: id, chat_id: chatId, tool_name: tool } = raw;
    if (!isActive(id, chatId)) return c.json({ ok: true, accepted: false }, 202);
    try {
      const agent = agents().find(a => a.id === id);
      const config = agent && cogsInbox(agent);
      if (!config || !config.allow_from.includes(chatId)) return c.json({ ok: true, accepted: false }, 202);
      const accepted = await updateCogsProgress(id, chatId, progressCode(tool));
      return c.json({ ok: true, accepted });
    } catch {
      // Neither parser details, remote errors nor raw tool data are reflected.
      return c.json({ ok: true, accepted: false }, 202);
    }
  });
  return r;
}

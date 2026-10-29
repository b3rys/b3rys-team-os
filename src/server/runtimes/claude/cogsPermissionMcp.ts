import { createServer, connect, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { PermissionCandidate, PermissionReply } from "./cogsPermissionGate";

const denied: PermissionReply = { behavior: "deny", message: "approval_transport_error" };
// Private local IPC only; the stdio child has no bridge credentials or database handle.
export async function startPermissionHost(approve: (input: PermissionCandidate) => Promise<PermissionReply>) {
  const dir = mkdtempSync(join(tmpdir(), "cogs-mcp-"));
  chmodSync(dir, 0o700);
  const path = join(dir, "gate.sock");
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let data = "", handled = false;
    socket.setTimeout(240_000, () => socket.destroy());
    socket.on("data", async chunk => {
      if (handled) return;
      data += chunk.toString();
      if (data.length > 1_000_000) { handled = true; socket.end(JSON.stringify(denied) + "\n"); return; }
      if (!data.includes("\n")) return;
      handled = true;
      let reply = denied;
      try { reply = await approve(JSON.parse(data.split("\n")[0]!)); } catch { /* deny */ }
      if (!socket.destroyed) socket.end(JSON.stringify(reply) + "\n");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
  } catch (error) { server.close(); rmSync(dir, {recursive:true,force:true}); throw error; }
  return { path, dir, close: () => { for (const socket of sockets) socket.destroy(); server.close(); rmSync(dir, {recursive:true,force:true}); } };
}
async function forward(path: string, input: unknown): Promise<PermissionReply> {
  return await new Promise(resolve => {
    const socket = connect(path); let data = "";
    socket.setTimeout(235_000, () => { socket.destroy(); resolve(denied); });
    socket.on("connect", () => socket.write(JSON.stringify(input) + "\n"));
    socket.on("data", chunk => { data += chunk.toString(); if (data.length > 1_100_000) { socket.destroy(); resolve(denied); } });
    socket.on("error", () => resolve(denied));
    socket.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(denied); } });
  });
}
if (import.meta.main) {
  const path = process.argv[2]!;
  for await (const line of createInterface({ input: process.stdin })) {
    let request: any;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    let result: unknown = {};
    if (request.method === "initialize") result = {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"cogs-permission",version:"1"}};
    else if (request.method === "tools/list") result = {tools:[{name:"ask",description:"Request owner permission for a file operation",inputSchema:{type:"object",properties:{tool_name:{type:"string"},input:{type:"object"},tool_use_id:{type:"string"}},required:["tool_name","input"]}}]};
    else if (request.method === "tools/call") {
      const reply = request.params?.name === "ask" ? await forward(path, request.params?.arguments) : denied;
      result = {content:[{type:"text",text:JSON.stringify(reply)}]};
    }
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result}) + "\n");
  }
}

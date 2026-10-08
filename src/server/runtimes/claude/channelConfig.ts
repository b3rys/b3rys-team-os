import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertChannelUsable, readMemberChannel, type MemberChannel } from "../../lib/memberChannel";
import descriptors from "./channel-descriptors.json";

export { descriptors as CLAUDE_CHANNELS };
export function claudeChannel(id: string, channel = readMemberChannel(id)) {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error(`invalid claude member id: ${id}`);
  assertChannelUsable(channel, id);
  return { ...descriptors[channel.kind], kind: channel.kind, channel };
}

/** Exclusive temporary file + rename. Never expose partial credentials or follow a stale temp symlink. */
export function atomicChannelWrite(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or creation failed */ }
  }
}

/** Preserve other project MCP servers; malformed files fail closed rather than being overwritten. */
export function prepareB3chatWorkspace(workspace: string, repoRoot: string, stateDir: string): void {
  const path = join(workspace, ".mcp.json");
  let data: any;
  try { data = JSON.parse(readFileSync(path, "utf8")); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; data = {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)
      || (data.mcpServers != null && (typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)))) {
    throw new Error("invalid workspace .mcp.json");
  }
  data.mcpServers = { ...data.mcpServers, b3chat: {
    command: "bun",
    args: ["run", "--cwd", join(repoRoot, "src/server/runtimes/claude/b3chat-channel"), "--shell=bun", "--silent", "start"],
    env: { B3CHAT_STATE_DIR: stateDir },
  } };
  atomicChannelWrite(path, JSON.stringify(data, null, 2) + "\n");
}

export function seedB3chatAccess(stateDir: string, channel: MemberChannel): void {
  assertChannelUsable(channel, "access");
  const path = join(stateDir, "access.json");
  let current: any = {};
  try { current = JSON.parse(readFileSync(path, "utf8")); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("invalid b3chat access.json");
  const groups: Record<string, unknown> = {};
  // The registry lists allowed room IDs, including positive-ID group rooms.
  // Require a mention by default; preserve any explicitly configured policy.
  for (const id of channel.allowFrom ?? []) groups[id] = current.groups?.[id] ?? { requireMention: true };
  // Registry is authoritative for static b3chat access. No Telegram pairing/group inheritance.
  atomicChannelWrite(path, JSON.stringify({ ...current, dmPolicy: "allowlist",
    allowFrom: channel.allowFrom ?? [], ownerChat: channel.ownerChat ?? undefined,
    groups, pending: {}, ackReaction: current.ackReaction ?? "👀",
  }, null, 2) + "\n");
}

if (import.meta.main) {
  const [id, workspace] = process.argv.slice(2);
  const d = claudeChannel(id!);
  if (workspace && d.kind === "b3chat") {
    const repo = new URL("../../../../..", import.meta.url).pathname.replace(/\/$/, "");
    const stateDir = `${process.env.HOME}/.claude/channels/b3chat-${id}`;
    prepareB3chatWorkspace(workspace, repo, stateDir);
    seedB3chatAccess(stateDir, d.channel);
  }
  console.log(d.kind);
}

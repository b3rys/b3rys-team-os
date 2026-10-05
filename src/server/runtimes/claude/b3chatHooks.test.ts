/** Execute deployed hooks with real descriptors; no user home or live channel state. */
import { afterEach, describe, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { copyChannelDescriptorFixture } from "./hookTestFixtures";

const execAsync = promisify(execFile);
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "b3chat-hooks-"));
  dirs.push(root);
  const home = join(root, "home");
  const hooks = join(home, "member/.claude/hooks");
  copyChannelDescriptorFixture(hooks);
  copyFileSync(join(import.meta.dir, "reply-guard.py"), join(hooks, "reply-guard.py"));
  copyFileSync(join(import.meta.dir, "../../../../hooks/telegram-owner-gate.py"), join(hooks, "telegram-owner-gate.py"));
  const state = join(root, "channels/b3chat-demis");
  mkdirSync(state, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH!, HOME: home, TMPDIR: tmpdir(),
    PYTHONDONTWRITEBYTECODE: "1", B3CHAT_STATE_DIR: state,
    B3OS_ROOT: root, OWNER_GATE_GROUP: "room-for-test",
    OWNER_GATE_ROUTE_URL: "http://127.0.0.1:1/route",
    REPLY_GUARD_RETRY_MS: "0",
  };
  const tp = join(root, "transcript.jsonl");
  return { root, hooks, env, tp };
}

const channel = (chatType?: string, source = "server:b3chat") =>
  `<channel source="${source}" chat_id="42" ${chatType ? `chat_type="${chatType}"` : ""} message_id="8199">@빌 이거 해줘</channel>`;
const user = (chatType?: string, source?: string) => ({
  type: "user", uuid: "b3chat-turn", timestamp: new Date(Date.now() - 5000).toISOString(),
  message: { role: "user", content: channel(chatType, source) },
});
const tool = (name: string) => ({
  type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input: { chat_id: "42", text: "답" } }] },
});
function transcript(f: ReturnType<typeof fixture>, events: unknown[]) {
  writeFileSync(f.tp, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}
function guard(f: ReturnType<typeof fixture>, toolName?: string, sid = "session-1") {
  return execFileSync("python3", [join(f.hooks, "reply-guard.py"), ...(toolName ? ["--mark"] : [])], {
    env: f.env, encoding: "utf-8",
    input: JSON.stringify({ transcript_path: f.tp, session_id: sid, tool_name: toolName }),
  });
}
function marks(f: ReturnType<typeof fixture>) {
  const path = join(f.root, ".reply-guard-sent.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
}

describe("b3chat reply guard — positive room IDs require chat_type", () => {
  test("private DM without a send blocks and names the b3chat reply tool", () => {
    const f = fixture();
    transcript(f, [user("private"), tool("Bash")]);
    const decision = JSON.parse(guard(f));
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("b3chat 1:1");
    expect(decision.reason).toContain("mcp__b3chat__reply");
    expect(decision.reason).not.toContain("mcp__plugin_telegram_telegram__reply");
  });
  for (const chatType of ["group", undefined]) {
    test(`positive ${chatType ?? "unspecified"} room permits owner silence`, () => {
      const f = fixture();
      transcript(f, [user(chatType)]);
      expect(guard(f)).toBe("");
    });
  }
  for (const name of ["mcp__b3chat__reply", "mcp__b3chat__edit_message"]) {
    test(`${name} in transcript satisfies a private DM`, () => {
      const f = fixture();
      transcript(f, [user("private"), tool(name)]);
      expect(guard(f)).toBe("");
      expect(readFileSync(join(f.root, ".reply-guard-decisions.log"), "utf-8")).toContain('"source": "transcript"');
    });
    test(`${name} mark satisfies a DM before transcript flush`, () => {
      const f = fixture();
      transcript(f, [user("private")]);
      expect(guard(f, name)).toBe("");
      expect(typeof marks(f)["session-1"]).toBe("number");
      expect(guard(f)).toBe("");
      expect(readFileSync(join(f.root, ".reply-guard-decisions.log"), "utf-8")).toContain('"source": "marker"');
    });
  }
  for (const name of ["mcp__plugin_telegram_telegram__reply", "mcp__plugin_telegram_telegram__edit_message", "mcp__b3chat__react", "Bash"]) {
    test(`${name} is neither a b3chat send nor a send mark`, () => {
      const f = fixture();
      transcript(f, [user("private"), tool(name)]);
      guard(f, name);
      expect(marks(f)).toEqual({});
      expect(JSON.parse(guard(f)).decision).toBe("block");
    });
  }
  test("b3chat takes precedence over inherited Telegram state", () => {
    const f = fixture();
    f.env.TELEGRAM_STATE_DIR = join(f.root, "channels/telegram-bill");
    transcript(f, [user("private"), tool("mcp__b3chat__reply")]);
    expect(guard(f)).toBe("");
    guard(f, "mcp__plugin_telegram_telegram__reply");
    expect(marks(f)).toEqual({});
  });
  test("a different session's mark cannot satisfy this DM", () => {
    const f = fixture();
    transcript(f, [user("private")]);
    guard(f, "mcp__b3chat__reply", "other-session");
    expect(JSON.parse(guard(f)).decision).toBe("block");
  });
});

async function router() {
  const seen: Array<{ text: string; self: string; tgMessageId: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ suppress: true, reason: "explicit_mention", targetAgentIds: ["bill"] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/route` };
}
async function ownerGate(f: ReturnType<typeof fixture>, prompt: string, url: string) {
  const child = execAsync("python3", [join(f.hooks, "telegram-owner-gate.py")], {
    env: { ...f.env, OWNER_GATE_ROUTE_URL: url }, encoding: "utf-8",
  });
  child.child.stdin?.end(JSON.stringify({ prompt }));
  return (await child).stdout;
}

describe("b3chat owner gate — scope and state identity", () => {
  test("private DM never asks even a suppressing router", async () => {
    const f = fixture();
    const r = await router();
    expect(await ownerGate(f, channel("private"), r.url)).toBe("");
    expect(r.seen).toEqual([]);
  });
  for (const chatType of ["group", undefined]) {
    test(`positive ${chatType ?? "unspecified"} room routes using b3chat state ID`, async () => {
      const f = fixture();
      const r = await router();
      expect(JSON.parse(await ownerGate(f, channel(chatType), r.url)).decision).toBe("block");
      expect(r.seen).toEqual([{ text: "@빌 이거 해줘", self: "demis", tgMessageId: "8199" }]);
    });
  }
  test("explicit self ID overrides state basename", async () => {
    const f = fixture();
    f.env.OWNER_GATE_SELF = "steve";
    const r = await router();
    expect(JSON.parse(await ownerGate(f, channel("group"), r.url)).decision).toBe("block");
    expect(r.seen.map((body) => body.self)).toEqual(["steve"]);
  });
  test("b3chat state ID precedes inherited Telegram state ID", async () => {
    const f = fixture();
    f.env.TELEGRAM_STATE_DIR = join(f.root, "channels/telegram-bill");
    const r = await router();
    expect(JSON.parse(await ownerGate(f, channel("group"), r.url)).decision).toBe("block");
    expect(r.seen.map((body) => body.self)).toEqual(["demis"]);
  });
  test("unknown state ID fails open without routing as somebody else", async () => {
    const f = fixture();
    f.env.B3CHAT_STATE_DIR = join(f.root, "channels/unknown");
    const r = await router();
    expect(await ownerGate(f, channel("group"), r.url)).toBe("");
    expect(r.seen).toEqual([]);
  });
  test("non-channel source never reaches the owner router", async () => {
    const f = fixture();
    const r = await router();
    expect(await ownerGate(f, channel("group", "server:unrelated"), r.url)).toBe("");
    expect(r.seen).toEqual([]);
  });
});

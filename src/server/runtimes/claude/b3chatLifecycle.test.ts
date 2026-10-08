// Import production modules only inside a subprocess whose entire data home is a scratch fixture.
// Never call service control: restart and fetch are local fakes; plist files are inert fixtures.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const SCRATCH = tmpdir();
const SOURCE_ROOT = resolve(import.meta.dir, "../../../..");

function runIsolated(body: string): void {
  mkdirSync(SCRATCH, { recursive: true });
  const root = mkdtempSync(join(SCRATCH, "b3chat-lifecycle-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const members = join(root, "members");
  for (const dir of [home, members, join(repo, "rules"), join(root, "tmp")]) mkdirSync(dir, { recursive: true });
  const registry = join(repo, "agents.json");
  writeFileSync(registry, JSON.stringify([
    { id: "fixture-chat", runtime: "claude_channel", channel: {
      kind: "b3chat", api_base: "https://b3chat.invalid/api", allow_from: ["12"], owner_chat: "12",
    } },
    { id: "fixture-tg", runtime: "claude_channel" },
  ]));
  writeFileSync(join(repo, "rules/TEAM-OS.md"), "# Isolated team rules\n");
  writeFileSync(join(repo, "rules/SKILLS.md"), "# Isolated skills\n");
  const script = join(root, "probe.ts");
  writeFileSync(script, `
    import assert from "node:assert/strict";
    import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
    import { dirname, join } from "node:path";
    const source = ${JSON.stringify(SOURCE_ROOT)};
    const home = process.env.HOME!;
    const repo = process.env.TEAM_COLLAB_ROOT!;
    const members = process.env.B3RYS_MEMBERS_ROOT!;
    const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
    const read = (path: string) => readFileSync(path, "utf8");
    const agent = { id: "fixture-chat", runtime: "claude_channel", display_name: "Fixture", role: "test",
      channel: { kind: "b3chat", api_base: "https://b3chat.invalid/api", allow_from: ["12"], owner_chat: "12" } } as any;
    // Deny accidental network use even in tests that do not expect getMe.
    globalThis.fetch = (async () => { throw new Error("unexpected network request"); }) as typeof fetch;
    ${body}
    console.log("isolated lifecycle assertions passed");
  `);
  try {
    const child = spawnSync(process.execPath, ["run", script], {
      cwd: root,
      // Allowlist, not inherited env: no live roots, token fallbacks, or Tier2 rollout flags.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home, TMPDIR: join(root, "tmp"), NODE_ENV: "test",
        TEAM_COLLAB_ROOT: repo, TEAM_AGENT_REGISTRY: registry,
        B3RYS_MEMBERS_ROOT: members, B3OS_TEST_MEMBERS_ROOT: members,
        TEAMOS_LAUNCHD_PREFIX: "test.b3chat-lifecycle", TEAMOS_POLLER_WAIT_MS: "0",
      },
      encoding: "utf8", timeout: 20_000,
    });
    if (child.error || child.status !== 0) {
      throw new Error(`isolated probe failed (${child.status}): ${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
    }
    expect(child.stdout.trim()).toBe("isolated lifecycle assertions passed");
    expect(child.stderr).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const seedEssentials = `
  const { claudeBridgePaths } = await import(source + "/src/server/runtimes/claude/launcher.ts");
  const { checkEssentialSettings } = await import(source + "/src/server/lib/runtimeEssentials.ts");
  const paths = claudeBridgePaths(agent.id);
  assert.equal(paths.stateDir, join(home, ".claude/channels/b3chat-fixture-chat"));
  assert.equal(paths.plist, join(home, "Library/LaunchAgents/test.b3chat-lifecycle.claude-telegram-fixture-chat.plist"));
  const oldToken = "7:" + "FAKE_OLD_".repeat(5);
  const newToken = "8:" + "FAKE_NEW_".repeat(5);
  const originalEnv = "# isolated fixture\\nB3CHAT_BOT_TOKEN=" + oldToken + "\\nB3CHAT_API_BASE=https://b3chat.invalid/api\\nCUSTOM_SETTING=keep-me\\n";
  put(paths.envFile, originalEnv);
  put(join(paths.stateDir, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["12"] }));
  // The subprocess itself is alive; no service is started or inspected.
  put(paths.botPid, String(process.pid));
  put(paths.plist, "inert fixture (never loaded)");
  const telegramEnv = join(home, ".claude/channels/telegram-fixture-chat/.env");
  const telegramBody = "TELEGRAM_BOT_TOKEN=FAKE_TELEGRAM_SENTINEL\\nTELEGRAM_API_BASE=https://api.telegram.org\\n";
  put(telegramEnv, telegramBody);
`;

const mockGetMe = `
  const { rotateBotToken } = await import(source + "/src/server/lib/rotateToken.ts");
  const requests: string[] = [];
  globalThis.fetch = (async (input: any) => {
    requests.push(String(input));
    assert.equal(String(input), "https://b3chat.invalid/api/bot" + newToken + "/getMe");
    return new Response(JSON.stringify({ ok: true, result: { username: "fixture_bot" } }));
  }) as typeof fetch;
`;

const assertPreserved = `
  assert.equal(read(telegramEnv), telegramBody);
  assert.equal(read(paths.envFile).replace(newToken, oldToken), originalEnv);
  assert.equal(statSync(paths.envFile).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(paths.stateDir).sort(), [".env", "access.json", "bot.pid"]);
  assert.equal(requests.length, 1);
`;

describe("Claude b3chat lifecycle — scratch HOME subprocesses", () => {
  test("access seeding allows configured group rooms with mention-only defaults", () => {
    runIsolated(`
      const { seedB3chatAccess, claudeChannel } = await import(source + "/src/server/runtimes/claude/channelConfig.ts");
      const state = join(home, "state");
      const path = join(state, "access.json");
      const channel = { ...claudeChannel(agent.id).channel, allowFrom: ["12", "40"] };
      seedB3chatAccess(state, channel);
      assert.deepEqual(JSON.parse(read(path)).groups, { "12": { requireMention: true }, "40": { requireMention: true } });
      put(path, JSON.stringify({ groups: { "40": { requireMention: true, allowFrom: ["1"] } } }));
      seedB3chatAccess(state, channel);
      assert.deepEqual(JSON.parse(read(path)).groups["40"], { requireMention: true, allowFrom: ["1"] });
      assert.deepEqual(JSON.parse(read(path)).allowFrom, ["12", "40"]);
      const once = read(path);
      seedB3chatAccess(state, channel);
      assert.equal(read(path), once);
    `);
  });

  test("essentials detect b3chat token/API/access/pid independently of Telegram", () => {
    runIsolated(seedEssentials + `
      const check = async () => await checkEssentialSettings(agent);
      assert.equal((await check()).ok, true);
      put(paths.envFile, "TELEGRAM_BOT_TOKEN=FAKE_WRONG_CHANNEL\\nB3CHAT_API_BASE=https://b3chat.invalid/api\\n");
      assert.deepEqual((await check()).missing, ["token:claude .env B3CHAT_BOT_TOKEN"]);
      put(paths.envFile, "B3CHAT_BOT_TOKEN=" + oldToken + "\\n");
      assert.deepEqual((await check()).missing, ["channel:claude .env B3CHAT_API_BASE"]);
      put(paths.envFile, originalEnv);
      put(join(paths.stateDir, "access.json"), "{}");
      assert.deepEqual((await check()).missing, ["allowFrom:claude access.json"]);
      put(join(paths.stateDir, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["12"] }));
      rmSync(paths.botPid);
      assert.deepEqual((await check()).missing, ["poller:claude bot.pid"]);
      put(paths.botPid, "not-a-pid");
      assert.deepEqual((await check()).missing, ["poller:claude bot.pid"]);
      put(paths.botPid, "0");
      assert.deepEqual((await check()).missing, ["poller:claude bot.pid"]);
      // Invalid OS pid cannot be alive; process.kill(pid, 0) sends no signal.
      put(paths.botPid, "999999999");
      assert.deepEqual((await check()).missing, ["poller:claude bot.pid not alive"]);
      put(paths.botPid, JSON.stringify({ pid: process.pid }));
      assert.equal((await check()).ok, true);
      rmSync(paths.plist);
      assert.deepEqual((await check()).missing, ["channel:claude LaunchAgent plist"]);
      assert.equal(read(telegramEnv), telegramBody);
    `);
  });

  test("rotation writes only fake b3chat token and preserves API config and Telegram store", () => {
    runIsolated(seedEssentials + mockGetMe + `
      let restarts = 0;
      const result = await rotateBotToken(async (id, runtime) => {
        restarts++;
        assert.equal(id, agent.id); assert.equal(runtime, "claude_channel");
        assert.equal(read(paths.envFile), originalEnv.replace(oldToken, newToken));
        return { ok: true, detail: "fake restart only" };
      }, "claude_channel", agent.id, agent, newToken);
      assert.equal(result.ok, true);
      assert.equal(result.bot_username, "fixture_bot");
      assert.equal(restarts, 1);
      assert.equal(read(paths.envFile), originalEnv.replace(oldToken, newToken));
      assert.ok(!JSON.stringify(result).includes(newToken));
    ` + assertPreserved);
  });

  test("failed fake restart rolls back b3chat token without touching API or Telegram", () => {
    runIsolated(seedEssentials + mockGetMe + `
      let restarts = 0;
      const result = await rotateBotToken(async () => {
        restarts++;
        assert.equal(read(paths.envFile), originalEnv.replace(oldToken, newToken));
        return { ok: false, detail: "injected restart failure" };
      }, "claude_channel", agent.id, agent, newToken);
      assert.equal(result.ok, false);
      assert.equal(result.error, "restart_failed_reverted");
      assert.equal(restarts, 1);
      assert.equal(read(paths.envFile), originalEnv);
      assert.ok(!JSON.stringify(result).includes(oldToken));
      assert.ok(!JSON.stringify(result).includes(newToken));
    ` + assertPreserved);
  });

  test("persona writer selects b3chat reply tools; Telegram defaults and SOUL stay unchanged", () => {
    runIsolated(`
      const { buildPersona, claudeCommsSection, SECTION_CLAUDE_COMMS } = await import(source + "/src/server/lib/personaTemplates.ts");
      const { renderLoadingFile, writeMemberPersona } = await import(source + "/src/server/lib/writeMemberPersona.ts");
      const input = { id: "fixture-chat", display_name: "Fixture", role: "test", runtime: "claude_channel" };
      const telegram = { ...input, id: "fixture-tg" };
      const chatWs = join(members, input.id);
      const tgWs = join(members, telegram.id);
      const soul = "# User-owned SOUL\\n맞춤 역할 · do not regenerate\\n";
      for (const ws of [chatWs, tgWs]) put(join(ws, "SOUL.md"), soul);
      assert.equal(claudeCommsSection(), SECTION_CLAUDE_COMMS);
      assert.equal(claudeCommsSection(false, "telegram"), SECTION_CLAUDE_COMMS);
      const tgBefore = renderLoadingFile(telegram).content;
      assert.equal(tgBefore, buildPersona(telegram));
      assert.ok(tgBefore.includes("mcp__plugin_telegram_telegram__reply"));
      assert.ok(!tgBefore.includes("mcp__b3chat__"));
      writeMemberPersona(telegram);
      const written = writeMemberPersona(input);
      assert.deepEqual(written.written, [join(chatWs, "CLAUDE.md")]);
      const chat = read(join(chatWs, "CLAUDE.md"));
      assert.equal(chat, renderLoadingFile(input).content);
      assert.ok(chat.includes("mcp__b3chat__reply"));
      assert.ok(!chat.includes("mcp__plugin_telegram_telegram__reply"));
      assert.ok(chat.includes("\\n@SOUL.md\\n"));
      assert.equal(read(join(tgWs, "CLAUDE.md")), tgBefore);
      assert.equal(renderLoadingFile(telegram).content, tgBefore);
      for (const ws of [chatWs, tgWs]) {
        assert.equal(read(join(ws, "SOUL.md")), soul);
        assert.ok(!existsSync(join(ws, "SOUL.md.bak")));
        assert.equal(readlinkSync(join(ws, "TEAM-OS.md")), join(repo, "rules/TEAM-OS.md"));
        assert.equal(readlinkSync(join(ws, "SKILLS.md")), join(repo, "rules/SKILLS.md"));
      }
      assert.deepEqual(writeMemberPersona(input).written, []);
      assert.equal(read(join(chatWs, "SOUL.md")), soul);
    `);
  });
});

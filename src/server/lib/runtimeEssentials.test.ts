import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { checkEssentialSettings, createRuntimeEssentialsRegistry, waitForEssentialSettings } from "./runtimeEssentials";

function tmpRoot(): { home: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "runtime-essentials-"));
  return { home: join(root, "home"), repo: join(root, "repo") };
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf-8");
}

describe("runtime essentials strategy registry", () => {
  test("unknown runtime → ok fail-open but explicit result shape", async () => {
    const r = await checkEssentialSettings({ id: "x", runtime: "future_runtime" } as any, {});
    expect(r).toEqual({ ok: true, missing: [], canAutoFix: false });
  });

  test("claude_channel checks token, allowFrom, live bot.pid, and plist", async () => {
    const { home, repo } = tmpRoot();
    const id = "steve";
    const stateDir = join(home, ".claude/channels", `telegram-${id}`);
    write(join(stateDir, ".env"), "TELEGRAM_BOT_TOKEN=123:abc\n");
    write(join(stateDir, "access.json"), JSON.stringify({ allowFrom: ["1"], groups: {} }));
    write(join(stateDir, "bot.pid"), "4242\n");
    write(join(home, "Library/LaunchAgents", `com.${process.env.USER || "local"}.claude-telegram-${id}.plist`), "<plist />");
    const registry = createRuntimeEssentialsRegistry({ home, repoRoot: repo, pidAlive: (pid) => pid === 4242 });
    const r = await checkEssentialSettings({ id, runtime: "claude_channel" } as any, registry);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test("claude_channel rejects stale pid even when bot.pid file exists", async () => {
    const { home, repo } = tmpRoot();
    const id = "steve";
    const stateDir = join(home, ".claude/channels", `telegram-${id}`);
    write(join(stateDir, ".env"), "TELEGRAM_BOT_TOKEN=123:abc\n");
    write(join(stateDir, "access.json"), JSON.stringify({ allowFrom: ["1"] }));
    write(join(stateDir, "bot.pid"), "9999\n");
    write(join(home, "Library/LaunchAgents", `com.${process.env.USER || "local"}.claude-telegram-${id}.plist`), "<plist />");
    const registry = createRuntimeEssentialsRegistry({ home, repoRoot: repo, pidAlive: () => false });
    const r = await checkEssentialSettings({ id, runtime: "claude_channel" } as any, registry);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("poller:claude bot.pid not alive");
  });

  test("codex uses wrapper CODEX_ALLOW_FROM and live ready pid", async () => {
    const { home, repo } = tmpRoot();
    const id = "cody";
    write(join(repo, "var/secrets", `${id}.bot-token`), "123:abc\n");
    write(join(repo, "var/codex-bridge", `${id}.pid`), "777\n");
    write(join(repo, "var/codex-bridge", `${id}-launch.sh`), 'export CODEX_ALLOW_FROM="1,-2"\n');
    write(join(home, "Library/LaunchAgents", `com.${process.env.USER || "local"}.codex-bridge-${id}.plist`), "<plist />");
    const registry = createRuntimeEssentialsRegistry({ home, repoRoot: repo, pidAlive: (pid) => pid === 777 });
    const r = await checkEssentialSettings({ id, runtime: "codex" } as any, registry);
    expect(r.ok).toBe(true);
  });

  test("codex fails when wrapper CODEX_ALLOW_FROM is empty even if server env has chat ids", async () => {
    const { home, repo } = tmpRoot();
    const id = "cody";
    const oldGd = process.env.GD_CHAT_ID;
    process.env.GD_CHAT_ID = "123";
    try {
      write(join(repo, "var/secrets", `${id}.bot-token`), "123:abc\n");
      write(join(repo, "var/codex-bridge", `${id}.pid`), JSON.stringify({ pid: 777, agentId: id }));
      write(join(repo, "var/codex-bridge", `${id}-launch.sh`), 'export CODEX_ALLOW_FROM=""\n');
      write(join(home, "Library/LaunchAgents", `com.${process.env.USER || "local"}.codex-bridge-${id}.plist`), "<plist />");
      const registry = createRuntimeEssentialsRegistry({ home, repoRoot: repo, pidAlive: (pid) => pid === 777 });
      const r = await checkEssentialSettings({ id, runtime: "codex" } as any, registry);
      expect(r.ok).toBe(false);
      expect(r.missing).toContain("allowFrom:codex CODEX_ALLOW_FROM seed");
    } finally {
      if (oldGd === undefined) delete process.env.GD_CHAT_ID;
      else process.env.GD_CHAT_ID = oldGd;
    }
  });

  test("codex fails when ready marker belongs to another agent", async () => {
    const { home, repo } = tmpRoot();
    const id = "cody";
    write(join(repo, "var/secrets", `${id}.bot-token`), "123:abc\n");
    write(join(repo, "var/codex-bridge", `${id}.pid`), JSON.stringify({ pid: 777, agentId: "other" }));
    write(join(repo, "var/codex-bridge", `${id}-launch.sh`), 'export CODEX_ALLOW_FROM="1"\n');
    write(join(home, "Library/LaunchAgents", `com.${process.env.USER || "local"}.codex-bridge-${id}.plist`), "<plist />");
    const registry = createRuntimeEssentialsRegistry({ home, repoRoot: repo, pidAlive: (pid) => pid === 777 });
    const r = await checkEssentialSettings({ id, runtime: "codex" } as any, registry);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("poller:codex pid agent mismatch");
  });

  test("openclaw checks configured tokenFile, ownerAllowFrom, and enabled account", async () => {
    const { home, repo } = tmpRoot();
    const id = "lui";
    const tokenFile = join(home, ".openclaw/credentials", `telegram-${id}-token.txt`);
    write(tokenFile, "123:abc\n");
    write(join(home, ".openclaw/openclaw.json"), JSON.stringify({
      channels: { telegram: { ownerAllowFrom: [1], accounts: { [id]: { enabled: true, tokenFile } } } },
    }));
    const registry = createRuntimeEssentialsRegistry({ home, repoRoot: repo });
    const r = await checkEssentialSettings({ id, runtime: "openclaw" } as any, registry);
    expect(r.ok).toBe(true);
  });

  test("codex openclaw accepts shared openclaw.env telegram token fallback", async () => {
    const { home, repo } = tmpRoot();
    write(join(home, ".openclaw/openclaw.env"), "TELEGRAM_BOT_TOKEN=123:abc\n");
    const registry = createRuntimeEssentialsRegistry({ home, repoRoot: repo });
    const r = await checkEssentialSettings({ id: "codex", runtime: "openclaw", openclaw_agent_id: "gd" } as any, registry);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test("openclaw fails empty ownerAllowFrom", async () => {
    const { home, repo } = tmpRoot();
    const id = "lui";
    const tokenFile = join(home, ".openclaw/credentials", `telegram-${id}-token.txt`);
    write(tokenFile, "123:abc\n");
    write(join(home, ".openclaw/openclaw.json"), JSON.stringify({
      channels: { telegram: { ownerAllowFrom: [], accounts: { [id]: { enabled: true, tokenFile } } } },
    }));
    const registry = createRuntimeEssentialsRegistry({ home, repoRoot: repo });
    const r = await checkEssentialSettings({ id, runtime: "openclaw" } as any, registry);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("allowFrom:openclaw ownerAllowFrom");
  });

  test("hermes checks profile env, auth, and LaunchAgent", async () => {
    const { home, repo } = tmpRoot();
    const id = "mes";
    write(join(home, ".hermes/profiles", id, ".env"), "TELEGRAM_BOT_TOKEN=123:abc\n");
    write(join(home, ".hermes/profiles", id, "auth.json"), "{}\n");
    write(join(home, "Library/LaunchAgents", `ai.hermes.gateway-${id}.plist`), "<plist />");
    const registry = createRuntimeEssentialsRegistry({ home, repoRoot: repo });
    const r = await checkEssentialSettings({ id, runtime: "hermes_agent" } as any, registry);
    expect(r.ok).toBe(true);
  });

  test("waitForEssentialSettings retries until strategy becomes ok", async () => {
    let calls = 0;
    const registry = {
      codex: {
        runtime: "codex",
        check: () => (++calls < 3
          ? { ok: false, missing: ["poller:codex ready pid"], canAutoFix: true }
          : { ok: true, missing: [], canAutoFix: false }),
      },
    };
    const r = await waitForEssentialSettings({ id: "cody", runtime: "codex" } as any, 1000, { intervalMs: 10, registry });
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCompactionMetricsReader, type CompactionMetrics } from "./monitoringStatus";

const NOW = Date.parse("2026-10-06T03:00:00Z");
const DAY = 86_400_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(cacheMs = 0) {
  const home = mkdtempSync(join(tmpdir(), "compaction-metrics-"));
  dirs.push(home);
  const registryPath = join(home, "agents.json");
  // A nonstandard workspace verifies that Claude's project path is not hardcoded.
  const workspace = join(home, "work/team-a");
  writeFileSync(registryPath, JSON.stringify([
    { id: "claude-a", runtime: "claude_channel", workspace_path: workspace },
    { id: "zero", runtime: "claude", workspace_path: "~/work/zero" },
    { id: "codex", runtime: "openclaw", openclaw_agent_id: "gd" },
    { id: "dex", runtime: "codex" },
    { id: "ames", runtime: "hermes_agent" },
  ]));
  const claude = join(home, ".claude/projects", workspace.replaceAll("/", "-"), "one.jsonl");
  const openclaw = join(home, ".openclaw/agents/gd/agent/codex-home/sessions/2026/10/06/one.jsonl");
  const codex = join(home, ".codex-agents/dex/sessions/2026/10/06/one.jsonl");
  let now = NOW;
  const read = createCompactionMetricsReader({ homeDir: home, registryPath, now: () => now, cacheMs });
  const write = (path: string, rows: unknown[], mtime = NOW) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rows.map((r) => typeof r === "string" ? r : JSON.stringify(r)).join("\n") + "\n");
    utimesSync(path, mtime / 1000, mtime / 1000);
  };
  return { home, registryPath, claude, openclaw, codex, read, write, setNow: (v: number) => { now = v; } };
}
const claudeRow = (at: number, pre: unknown = 100, post: unknown = 20) => ({
  type: "system", subtype: "compact_boundary", timestamp: new Date(at).toISOString(),
  compactMetadata: { trigger: "auto", preTokens: pre, postTokens: post, durationMs: 1000 },
});
const codexRow = (at: number, pre: unknown = 200) => ({
  type: "compacted", timestamp: new Date(at).toISOString(),
  payload: { latest_token_usage_record: { usage: { input_tokens: pre } } },
});
function member(m: CompactionMetrics, id: string, window: "window24h" | "window7d" = "window24h") {
  return m[window].find((s) => s.memberId === id)!;
}

describe("member compaction metrics", () => {
  test("inclusive 24h/7d boundaries, no old/future events, independent non-null averages", async () => {
    const f = fixture();
    f.write(f.claude, [claudeRow(NOW), claudeRow(NOW - DAY, 300, null), claudeRow(NOW - DAY - 1, 500, 60),
      claudeRow(NOW - 7 * DAY, 700, 100), claudeRow(NOW - 7 * DAY - 1), claudeRow(NOW + 1)]);
    const m = await f.read();
    expect(member(m, "claude-a")).toEqual({ memberId: "claude-a", count: 2, avgPreTokens: 200, avgPostTokens: 20, measured: true });
    expect(member(m, "claude-a", "window7d")).toEqual({ memberId: "claude-a", count: 4, avgPreTokens: 400, avgPostTokens: 60, measured: true });
    expect(member(m, "zero")).toEqual({ memberId: "zero", count: 0, avgPreTokens: null, avgPostTokens: null, measured: true });
    expect(member(m, "ames")).toEqual({ memberId: "ames", count: 0, avgPreTokens: null, avgPostTokens: null, measured: false });
    expect(m.window7d).toHaveLength(5);
  });

  test("OpenClaw agent id and native Codex homes, unknown post tokens", async () => {
    const f = fixture();
    f.write(f.openclaw, [codexRow(NOW, 240_000)]);
    f.write(f.codex, [codexRow(NOW - 2 * DAY, 160_000)]);
    const m = await f.read();
    expect(member(m, "codex")).toMatchObject({ count: 1, avgPreTokens: 240_000, avgPostTokens: null, measured: true });
    expect(member(m, "dex")).toMatchObject({ count: 0, measured: true });
    expect(member(m, "dex", "window7d")).toMatchObject({ count: 1, avgPreTokens: 160_000, avgPostTokens: null });
  });

  test("token averages retain fractional values", async () => {
    const f = fixture();
    f.write(f.claude, [claudeRow(NOW, 100, 20), claudeRow(NOW, 101, 21)]);
    expect(member(await f.read(), "claude-a")).toMatchObject({ avgPreTokens: 100.5, avgPostTokens: 20.5 });
  });

  test("broken lines, wrong types, missing timestamps and invalid tokens don't contaminate counts", async () => {
    const f = fixture();
    f.write(f.claude, ['{"subtype":"compact_boundary",broken', { ...claudeRow(NOW), type: "assistant" },
      { ...claudeRow(NOW), timestamp: "bad" }, claudeRow(NOW, -1, "200"),
      { type: "assistant", content: "x".repeat(150_000) }]);
    f.write(f.codex, ['{"type":"compacted",bad', { type: "event_msg", timestamp: new Date(NOW).toISOString(), payload: { type: "compacted" } },
      codexRow(NOW, null)]);
    const m = await f.read();
    expect(member(m, "claude-a")).toMatchObject({ count: 1, avgPreTokens: null, avgPostTokens: null });
    expect(member(m, "dex")).toMatchObject({ count: 1, avgPreTokens: null });
  });

  test("old mtime files aren't read; old date directory with recent mtime is read", async () => {
    const f = fixture();
    f.write(f.claude, [claudeRow(NOW)], NOW - 7 * DAY - 1000);
    const oldDir = join(f.home, ".codex-agents/dex/sessions/2020/01/01/old.jsonl");
    f.write(oldDir, [codexRow(NOW)]);
    const m = await f.read();
    expect(member(m, "claude-a").count).toBe(0);
    expect(member(m, "dex").count).toBe(1);
  });

  test("tilde workspace resolves against injected home; aged-out file cache no longer contributes", async () => {
    const f = fixture();
    const workspace = join(f.home, "work/zero");
    f.write(join(f.home, ".claude/projects", workspace.replaceAll("/", "-"), "zero.jsonl"), [claudeRow(NOW)]);
    expect(member(await f.read(), "zero").count).toBe(1);
    f.setNow(NOW + 7 * DAY + 1);
    expect(member(await f.read(), "zero", "window7d").count).toBe(0);
  });

  test("unchanged files aren't reopened; size and mtime changes each invalidate the cache", async () => {
    const f = fixture();
    f.write(f.claude, [claudeRow(NOW)]);
    const spy = spyOn(fs, "createReadStream");
    try {
      await f.read();
      expect(spy).toHaveBeenCalledTimes(1);
      await f.read();
      expect(spy).toHaveBeenCalledTimes(1);
      appendFileSync(f.claude, JSON.stringify(claudeRow(NOW)) + "\n");
      utimesSync(f.claude, NOW / 1000, NOW / 1000); // size changed, mtime unchanged
      expect(member(await f.read(), "claude-a").count).toBe(2);
      expect(spy).toHaveBeenCalledTimes(2);
      f.write(f.claude, [claudeRow(NOW, 900), claudeRow(NOW, 900)], NOW + 1000); // equal size, changed mtime
      expect(member(await f.read(), "claude-a").avgPreTokens).toBe(900);
      expect(spy).toHaveBeenCalledTimes(3);
      rmSync(f.claude);
      expect(member(await f.read(), "claude-a").count).toBe(0);
    } finally { spy.mockRestore(); }
  });

  test("5 min result TTL and concurrent reads coalesce; windows expire after refresh", async () => {
    const f = fixture(300_000);
    f.write(f.claude, [claudeRow(NOW - DAY)]);
    const spy = spyOn(fs, "createReadStream");
    try {
      const [a, b] = await Promise.all([f.read(), f.read()]);
      expect(a).toBe(b);
      expect(spy).toHaveBeenCalledTimes(1);
      f.write(f.claude, [claudeRow(NOW - DAY), claudeRow(NOW)]);
      f.setNow(NOW + 299_999);
      expect(member(await f.read(), "claude-a").count).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
      f.setNow(NOW + 300_000);
      expect(member(await f.read(), "claude-a").count).toBe(1);
      expect(member(await f.read(), "claude-a", "window7d").count).toBe(2);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });

  test("missing or malformed registry returns empty windows without throwing", async () => {
    const f = fixture();
    rmSync(f.registryPath);
    expect(await f.read()).toEqual({ window24h: [], window7d: [] });
    writeFileSync(f.registryPath, "broken");
    expect(await f.read()).toEqual({ window24h: [], window7d: [] });
  });
});

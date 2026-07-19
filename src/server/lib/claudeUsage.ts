// Claude Code usage aggregator.
//
// All claude_channel agents run under ONE shared Claude Max account (OWNER's), so the
// 5-hour rolling window and weekly limits are a SHARED pool — if the team collectively
// burns the budget, every Claude agent gets throttled together. This module reads each
// agent's Claude Code session logs (~/.claude/projects/<encoded-cwd>/*.jsonl), counts
// API responses + sums tokens within the 5h / 7d windows, and aggregates them.
//
// Caveat: Anthropic's actual limit metric (Max 5x ≈ 225 messages / 5h) is opaque and
// not present in the logs, so the "% of limit" shown is an ESTIMATE from request count.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentRecord } from "../types";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// Max 5x rolling-window message ceiling (approx, per Anthropic docs as of 2026-05).
export const MAX5X_REQUESTS_5H_CEILING = 225;

const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;

export interface AgentUsage {
  agent_id: string;
  requests_5h: number;
  requests_7d: number;
  tokens_5h: number; // input + output + cache (creation + read)
  tokens_7d: number;
  last_activity_at: string | null;
}

export interface ClaudePoolUsage {
  generated_at: string;
  ceiling_5h: number;
  total_requests_5h: number;
  total_tokens_5h: number;
  total_requests_7d: number;
  total_tokens_7d: number;
  pct_5h_estimate: number; // total_requests_5h / ceiling, capped at 100, ESTIMATE
  agents: AgentUsage[];
}

function encodeWorkspace(path: string): string {
  // Claude Code encodes the project cwd by replacing path separators with dashes.
  return path.replace(/\//g, "-");
}

interface UsageLine {
  type?: string;
  timestamp?: string;
  message?: { usage?: Record<string, number> };
}

function sumTokens(u: Record<string, number> | undefined): number {
  if (!u) return 0;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  return input + output + cacheCreate + cacheRead;
}

async function readAgentUsage(agent: AgentRecord, now: number): Promise<AgentUsage> {
  const empty: AgentUsage = {
    agent_id: agent.id,
    requests_5h: 0,
    requests_7d: 0,
    tokens_5h: 0,
    tokens_7d: 0,
    last_activity_at: null,
  };
  const dir = join(PROJECTS_DIR, encodeWorkspace(agent.workspace_path));
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return empty; // no projects dir for this agent (e.g., openclaw agents)
  }

  const cutoff7d = now - WINDOW_7D_MS;
  const cutoff5h = now - WINDOW_5H_MS;
  let lastActivity = 0;

  for (const f of files) {
    const full = join(dir, f);
    let mtime: number;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    // Skip files whose last write predates the 7d window entirely.
    if (mtime < cutoff7d) continue;

    let text: string;
    try {
      text = await Bun.file(full).text();
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line || line.indexOf('"usage"') === -1) continue;
      let parsed: UsageLine;
      try {
        parsed = JSON.parse(line) as UsageLine;
      } catch {
        continue;
      }
      if (parsed.type !== "assistant" || !parsed.message?.usage || !parsed.timestamp) continue;
      const t = Date.parse(parsed.timestamp);
      if (!Number.isFinite(t) || t < cutoff7d) continue;
      const tokens = sumTokens(parsed.message.usage);
      empty.requests_7d += 1;
      empty.tokens_7d += tokens;
      if (t >= cutoff5h) {
        empty.requests_5h += 1;
        empty.tokens_5h += tokens;
      }
      if (t > lastActivity) lastActivity = t;
    }
  }
  empty.last_activity_at = lastActivity > 0 ? new Date(lastActivity).toISOString() : null;
  return empty;
}

export async function claudePoolUsage(agents: AgentRecord[]): Promise<ClaudePoolUsage> {
  const now = Date.now();
  const claudeAgents = agents.filter((a) => a.runtime === "claude_channel");
  const perAgent = await Promise.all(claudeAgents.map((a) => readAgentUsage(a, now)));

  const total_requests_5h = perAgent.reduce((s, a) => s + a.requests_5h, 0);
  const total_tokens_5h = perAgent.reduce((s, a) => s + a.tokens_5h, 0);
  const total_requests_7d = perAgent.reduce((s, a) => s + a.requests_7d, 0);
  const total_tokens_7d = perAgent.reduce((s, a) => s + a.tokens_7d, 0);

  return {
    generated_at: new Date(now).toISOString(),
    ceiling_5h: MAX5X_REQUESTS_5H_CEILING,
    total_requests_5h,
    total_tokens_5h,
    total_requests_7d,
    total_tokens_7d,
    pct_5h_estimate: Math.min(100, Math.round((total_requests_5h / MAX5X_REQUESTS_5H_CEILING) * 100)),
    agents: perAgent.sort((a, b) => b.requests_5h - a.requests_5h),
  };
}

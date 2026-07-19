import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import type { AgentRecord } from "../types";
import { insertLogLine, pruneLogLines, recentLogLines } from "../db/queries";
import type { Broadcaster } from "./types";

const POLL_INTERVAL_MS = 1000;
const PRUNE_EVERY_TICKS = 60;

interface TailState {
  lastDigest: string;
  lastLines: string[];
  ticks: number;
}

async function capturePane(session: string): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", ["capture-pane", "-p", "-t", session, "-S", "-200"]);
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk.toString()));
    proc.on("error", () => resolve([]));
    proc.on("close", (code) => {
      if (code !== 0) return resolve([]);
      const lines = out.split("\n");
      while (lines.length && lines[lines.length - 1]?.trim() === "") lines.pop();
      resolve(lines);
    });
  });
}

function digest(lines: string[]): string {
  if (!lines.length) return "";
  return `${lines.length}:${lines[lines.length - 1]}`;
}

function diffNewLines(prev: string[], next: string[]): string[] {
  if (!prev.length) return next.slice(-50);
  const lastPrev = prev[prev.length - 1];
  const idx = next.lastIndexOf(lastPrev ?? "__NOPE__");
  if (idx < 0) return next.slice(-50);
  return next.slice(idx + 1);
}

export function startTmuxTail(
  db: Database,
  agents: AgentRecord[],
  broadcast: Broadcaster,
): () => void {
  const states = new Map<string, TailState>();
  const intervals: NodeJS.Timeout[] = [];

  for (const agent of agents) {
    if (agent.status_provider !== "claude_tmux" || !agent.tmux_session) continue;
    const session = agent.tmux_session;
    const initial = recentLogLines(db, agent.id, 200).map((l) => l.line);
    states.set(agent.id, { lastDigest: digest(initial), lastLines: initial, ticks: 0 });

    const tick = async () => {
      const state = states.get(agent.id);
      if (!state) return;
      const lines = await capturePane(session);
      const d = digest(lines);
      if (d === state.lastDigest) {
        state.ticks++;
        if (state.ticks % PRUNE_EVERY_TICKS === 0) pruneLogLines(db, agent.id);
        return;
      }
      const newLines = diffNewLines(state.lastLines, lines);
      const now = new Date().toISOString();
      for (const line of newLines) {
        if (!line) continue;
        insertLogLine(db, agent.id, line);
        broadcast({ type: "log_line", agent_id: agent.id, line, captured_at: now });
      }
      state.lastDigest = d;
      state.lastLines = lines;
      state.ticks++;
      if (state.ticks % PRUNE_EVERY_TICKS === 0) pruneLogLines(db, agent.id);
    };

    intervals.push(setInterval(() => void tick(), POLL_INTERVAL_MS));
  }

  return () => intervals.forEach((i) => clearInterval(i));
}

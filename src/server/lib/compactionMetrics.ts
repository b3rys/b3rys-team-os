import fs from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export interface CompactionMemberStat {
  memberId: string;
  count: number;
  avgPreTokens: number | null;
  avgPostTokens: number | null;
  measured: boolean;
}
export interface CompactionMetrics {
  window24h: CompactionMemberStat[];
  window7d: CompactionMemberStat[];
}
export interface CompactionReaderOptions {
  homeDir?: string;
  registryPath?: string;
  now?: () => number;
  cacheMs?: number;
}
type Event = { at: number; pre: number | null; post: number | null };
type Source = { path: string; kind: "claude" | "codex" };
const DAY_MS = 86_400_000;
export const COMPACTION_CACHE_MS = 300_000;

function tokenCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}
function safeSegment(v: unknown): v is string {
  return typeof v === "string" && /^[\w-]+$/.test(v);
}
function sourceFor(member: Record<string, unknown>, home: string): Source | null {
  if (member.runtime === "hermes_agent" || member.runtime === "hermes") return null;
  if (safeSegment(member.openclaw_agent_id)) {
    return { path: join(home, ".openclaw/agents", member.openclaw_agent_id, "agent/codex-home/sessions"), kind: "codex" };
  }
  if (member.runtime === "codex" && safeSegment(member.id)) {
    return { path: join(home, ".codex-agents", member.id, "sessions"), kind: "codex" };
  }
  if ((member.runtime === "claude_channel" || member.runtime === "claude") && typeof member.workspace_path === "string") {
    const workspace = member.workspace_path.startsWith("~/")
      ? join(home, member.workspace_path.slice(2)) : member.workspace_path;
    if (!isAbsolute(workspace)) return null;
    return { path: join(home, ".claude/projects", resolve(workspace).replaceAll("/", "-")), kind: "claude" };
  }
  return null;
}

// Directory traversal is depth-bounded and never follows symlinks. Only file mtime,
// not the date in its directory name, decides whether a rollout is read.
async function recentFiles(path: string, depth: number, since: number): Promise<string[]> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (e: any) { if (e?.code === "ENOENT") return []; throw e; }
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory() && depth > 0) files.push(...await recentFiles(child, depth - 1, since));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try { if ((await stat(child)).mtimeMs >= since) files.push(child); }
      catch (e: any) { if (e?.code !== "ENOENT") throw e; }
    }
  }
  return files;
}

async function readEvents(path: string, kind: Source["kind"]): Promise<Event[]> {
  const events: Event[] = [];
  const stream = fs.createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  // readline doesn't forward stream errors to its async iterator by itself.
  const onError = (error: Error) => lines.emit("error", error);
  stream.on("error", onError);
  try {
    for await (const line of lines) {
      if (!line.includes(kind === "claude" ? '"compact_boundary"' : '"compacted"')) continue;
      try {
        const row = JSON.parse(line);
        if (kind === "claude" ? row.type !== "system" || row.subtype !== "compact_boundary" : row.type !== "compacted") continue;
        const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
        if (!Number.isFinite(at)) continue;
        const pre = kind === "claude" ? row.compactMetadata?.preTokens
          : row.payload?.latest_token_usage_record?.usage?.input_tokens;
        events.push({ at, pre: tokenCount(pre), post: kind === "claude" ? tokenCount(row.compactMetadata?.postTokens) : null });
      } catch { /* Invalid or partially written JSONL lines are ignored. */ }
    }
  } finally {
    lines.close();
    stream.destroy();
    stream.off("error", onError);
  }
  return events;
}

/** Read-only reader. Each instance owns its file cache, result TTL and in-flight scan. */
export function createCompactionMetricsReader(options: CompactionReaderOptions = {}): () => Promise<CompactionMetrics> {
  const home = options.homeDir ?? homedir();
  const registryPath = options.registryPath ?? process.env.TEAM_AGENT_REGISTRY ?? join(import.meta.dir, "../../../agents.json");
  const clock = options.now ?? Date.now;
  const ttl = options.cacheMs ?? COMPACTION_CACHE_MS;
  const fileCache = new Map<string, { size: number; mtime: number; events: Event[] }>();
  let result: { at: number; body: CompactionMetrics } | null = null;
  let pending: Promise<CompactionMetrics> | null = null;

  async function scan(now: number): Promise<CompactionMetrics> {
    let members: Record<string, unknown>[];
    try {
      const raw = JSON.parse(await readFile(registryPath, "utf8"));
      // Only routing fields are accessed; credentials are never selected or returned.
      members = Array.isArray(raw) ? raw.filter((m) => m && typeof m.id === "string") : [];
    } catch { return { window24h: [], window7d: [] }; }
    const seen = new Set<string>();
    const window24h: CompactionMemberStat[] = [];
    const window7d: CompactionMemberStat[] = [];
    for (const member of members) {
      const source = sourceFor(member, home);
      let measured = source !== null;
      const events: Event[] = [];
      if (source) {
        try {
          for (const path of await recentFiles(source.path, source.kind === "codex" ? 3 : 0, now - 7 * DAY_MS)) {
            seen.add(path);
            const meta = await stat(path);
            let cached = fileCache.get(path);
            if (!cached || cached.size !== meta.size || cached.mtime !== meta.mtimeMs) {
              cached = { size: meta.size, mtime: meta.mtimeMs, events: await readEvents(path, source.kind) };
              fileCache.set(path, cached);
            }
            events.push(...cached.events);
          }
        } catch { measured = false; }
      }
      const aggregate = (since: number): CompactionMemberStat => {
        const selected = measured ? events.filter((e) => e.at >= since && e.at <= now) : [];
        const average = (key: "pre" | "post"): number | null => {
          const values = selected.map((e) => e[key]).filter((v): v is number => v !== null);
          return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        };
        return { memberId: member.id as string, count: selected.length, avgPreTokens: average("pre"), avgPostTokens: average("post"), measured };
      };
      window24h.push(aggregate(now - DAY_MS));
      window7d.push(aggregate(now - 7 * DAY_MS));
    }
    for (const path of fileCache.keys()) if (!seen.has(path)) fileCache.delete(path);
    return { window24h, window7d };
  }

  return async () => {
    const now = clock();
    if (result && now >= result.at && now - result.at < ttl) return result.body;
    if (pending) return pending;
    pending = scan(now).then((body) => { result = { at: now, body }; return body; }).finally(() => { pending = null; });
    return pending;
  };
}

export const readCompactionMetrics = createCompactionMetricsReader();

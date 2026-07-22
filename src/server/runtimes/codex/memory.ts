import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRecord } from "../../types";

export type CodexMemoryRefSource = "team_search" | "skill" | "MEMORY";

export interface CodexMemoryRef {
  source: CodexMemoryRefSource;
  ref: string;
  summary: string;
}

export interface CodexMemoryRefOptions {
  maxPersonalLines?: number;
  maxTeamRefs?: number;
}

export function buildCodexMemoryRefs(
  db: Database,
  agent: AgentRecord,
  query: string,
  opts: CodexMemoryRefOptions = {},
): CodexMemoryRef[] {
  return [
    ...personalMemoryRefs(agent, opts.maxPersonalLines ?? 6),
    ...teamSearchMemoryRefs(db, query, opts.maxTeamRefs ?? 3),
  ];
}

export function personalMemoryRefs(agent: AgentRecord, maxLines = 6): CodexMemoryRef[] {
  const workspace = typeof agent.workspace_path === "string" ? agent.workspace_path.trim() : "";
  if (!workspace) return [];
  const path = join(workspace, "MEMORY.md");
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"))
    .filter((line) => !/^#\s*memory/i.test(line))
    .slice(0, maxLines);
  if (lines.length === 0) return [];

  return [
    {
      source: "MEMORY",
      ref: "MEMORY.md",
      summary: truncateForEnvelope(lines.join(" / "), 700),
    },
  ];
}

export function teamSearchMemoryRefs(db: Database, query: string, maxRefs = 3): CodexMemoryRef[] {
  const terms = query
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 6);
  const likeTerms = terms.length ? terms : ["codex", "runtime"];
  const where = likeTerms.map(() => `(title LIKE ? OR content LIKE ? OR source_ref LIKE ?)`).join(" OR ");
  const params = likeTerms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`]);

  const rows = db
    .prepare(
      `SELECT source_ref, title, content
       FROM team_search_chunk
       WHERE source_type IN ('rule', 'doc', 'task')
         AND NOT (${rawMemorySourceRefSql()})
         AND (${where})
       ORDER BY
         CASE WHEN source_ref LIKE '%SHARED.md%' THEN 0 ELSE 1 END,
         indexed_at DESC
       LIMIT ?`,
    )
    .all(...params, maxRefs) as Array<{ source_ref: string; title: string; content: string }>;

  const fallbackRows =
    rows.length > 0
      ? rows
      : (db
          .prepare(
            `SELECT source_ref, title, content
             FROM team_search_chunk
             WHERE source_type IN ('rule', 'doc')
               AND NOT (${rawMemorySourceRefSql()})
               AND (source_ref LIKE '%SHARED.md%' OR title LIKE '%memory%' OR content LIKE '%MEMORY.md%')
             ORDER BY
               CASE WHEN source_ref LIKE '%SHARED.md%' THEN 0 ELSE 1 END,
               indexed_at DESC
             LIMIT ?`,
          )
          .all(maxRefs) as Array<{ source_ref: string; title: string; content: string }>);

  return fallbackRows.map((row) => ({
    source: "team_search" as const,
    ref: row.source_ref,
    summary: truncateForEnvelope(`${row.title}: ${row.content.replace(/\s+/g, " ")}`, 700),
  }));
}

function truncateForEnvelope(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function rawMemorySourceRefSql(): string {
  return [
    `source_ref = 'MEMORY.md'`,
    `source_ref LIKE 'MEMORY.md:%'`,
    `source_ref LIKE 'MEMORY.md#%'`,
    `source_ref LIKE '%/MEMORY.md'`,
    `source_ref LIKE '%/MEMORY.md:%'`,
    `source_ref LIKE '%/MEMORY.md#%'`,
  ].join(" OR ");
}

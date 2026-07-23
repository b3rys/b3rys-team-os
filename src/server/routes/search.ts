import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  rebuildSearchIndex,
  searchIndexStatus,
  searchResultsFromChunkIds,
  searchTeamLexical,
  summarizeSearchEvidence,
  withSearchDebug,
  type SearchResult,
  type SearchSourceType,
} from "../db/searchQueries";
import { createFastEmbedProvider } from "../search/fastembedProvider";
import { isShortKoreanLexicalOnly, rankHybrid, type HybridRankInput } from "../search/hybridRank";
import { LanceVectorSearchStore } from "../search/lanceVectorStore";
import { reindexVectors, type EmbeddingProvider, type VectorSearchStore } from "../search/vectorStore";

interface SearchRouteDeps {
  db: Database;
  docsDir: string;
  reportsDir: string;
  rulesDir: string;
  registryPath: string;
  vectorDir?: string;
  modelCacheDir?: string;
}

const SOURCE_TYPES = new Set(["message", "audit", "doc", "report", "rule", "registry", "task"]);
const SEARCH_MODES = new Set(["lexical", "semantic", "hybrid"]);
const QUERY_EMBEDDING_CACHE_MAX = 128;
type SearchMode = "lexical" | "semantic" | "hybrid";

function parseSourceType(v: string | undefined): SearchSourceType | undefined {
  if (!v) return undefined;
  return SOURCE_TYPES.has(v) ? (v as SearchSourceType) : undefined;
}

function parseSearchMode(v: string | undefined): SearchMode | undefined {
  if (!v) return "lexical";
  return SEARCH_MODES.has(v) ? (v as SearchMode) : undefined;
}

export function createSearchRoutes(deps: SearchRouteDeps): Hono {
  const r = new Hono();
  let providerPromise: Promise<EmbeddingProvider> | null = null;
  let storePromise: Promise<VectorSearchStore> | null = null;
  const queryEmbeddingCache = new Map<string, number[]>();

  const vectorEnabled = process.env.TEAM_SEARCH_VECTOR_ENABLED !== "false";
  const vectorDir = deps.vectorDir ?? "var/team-search-vectors.lancedb";
  const modelCacheDir = deps.modelCacheDir ?? "var/models/fastembed";

  function provider(): Promise<EmbeddingProvider> {
    providerPromise ??= createFastEmbedProvider({ cacheDir: modelCacheDir });
    return providerPromise;
  }

  function store(): Promise<VectorSearchStore> {
    storePromise ??= LanceVectorSearchStore.open(vectorDir);
    return storePromise;
  }

  async function queryEmbedding(q: string, embeddingProvider: EmbeddingProvider): Promise<number[]> {
    const key = `${embeddingProvider.modelId}:${q}`;
    const cached = queryEmbeddingCache.get(key);
    if (cached) {
      queryEmbeddingCache.delete(key);
      queryEmbeddingCache.set(key, cached);
      return cached;
    }
    const vector = await embeddingProvider.embedQuery(q);
    queryEmbeddingCache.set(key, vector);
    if (queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_MAX) {
      const oldest = queryEmbeddingCache.keys().next().value;
      if (oldest) queryEmbeddingCache.delete(oldest);
    }
    return vector;
  }

  async function semanticResults(q: string, limit: number, source?: SearchSourceType): Promise<SearchResult[]> {
    if (!vectorEnabled) return [];
    const [embeddingProvider, vectorStore] = await Promise.all([provider(), store()]);
    const queryVector = await queryEmbedding(q, embeddingProvider);
    const hits = await vectorStore.search(queryVector, limit, source);
    const results = searchResultsFromChunkIds(
      deps.db,
      hits.map((hit) => hit.chunk_id),
      q,
      "semantic",
    );
    const byId = new Map(hits.map((hit) => [hit.chunk_id, hit]));
    return results.map((result, index) => {
      const hit = byId.get(result.id);
      return {
        ...result,
        rank: index + 1,
        score: hit ? hit.vector_distance : result.score,
        vector_rank: hit?.rank ?? null,
        vector_distance: hit?.vector_distance ?? null,
      };
    });
  }

  function rankInput(results: SearchResult[]): HybridRankInput[] {
    return results.map((result) => ({
      id: result.id,
      rank: result.rank,
      title: result.title,
      content: result.content,
      source_ref: result.source_ref,
      vector_distance: result.vector_distance ?? undefined,
    }));
  }

  function maybeDebug(results: SearchResult[], enabled: boolean): SearchResult[] {
    return enabled ? withSearchDebug(results) : results;
  }

  function statusPayload() {
    return {
      ok: true,
      vector_enabled: vectorEnabled,
      vector_dir: vectorDir,
      model_cache_dir: modelCacheDir,
      query_embedding_cache_size: queryEmbeddingCache.size,
      ...searchIndexStatus(deps.db, {
        docsDir: deps.docsDir,
        reportsDir: deps.reportsDir,
        rulesDir: deps.rulesDir,
        registryPath: deps.registryPath,
      }),
    };
  }

  // GET /api/search?q=...&limit=20&source=message&mode=lexical|semantic|hybrid
  // Read-only query over the existing search index. Reindexing is explicit and separate
  // so normal dashboard reads do not contend with team-bus writes.
  r.get("/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 50);
    const source = parseSourceType(c.req.query("source"));
    const mode = parseSearchMode(c.req.query("mode"));
    const debug = c.req.query("debug") === "true";
    if (c.req.query("source") && !source) {
      return c.json({ ok: false, error: "invalid source" }, 400);
    }
    if (!mode) {
      return c.json({ ok: false, error: "invalid mode" }, 400);
    }
    if (mode === "semantic") {
      if (isShortKoreanLexicalOnly(q)) {
        return c.json({ ok: true, query: q, mode, effective_mode: "lexical", warnings: ["short Korean query; semantic search skipped"], results: [] });
      }
      try {
        const results = await semanticResults(q, limit, source);
        const status = results.length ? 200 : 503;
        return c.json(
          {
            ok: results.length > 0,
            query: q,
            mode,
            evidence: summarizeSearchEvidence(q, results),
            error: results.length ? undefined : "vector index empty or unavailable",
            warnings: results.length ? [] : ["vector search has no indexed hits; run /search/vector/reindex first"],
            results: maybeDebug(results, debug),
          },
          status,
        );
      } catch (e) {
        return c.json(
          {
            ok: false,
            query: q,
            mode,
            error: e instanceof Error ? e.message : String(e),
            warnings: ["vector search failed; lexical mode remains available"],
            results: [],
          },
          503,
        );
      }
    }
    if (mode === "hybrid") {
      const results = searchTeamLexical(deps.db, q, limit, source);
      if (isShortKoreanLexicalOnly(q)) {
        return c.json({
          ok: true,
          query: q,
          mode,
          effective_mode: "lexical",
          evidence: summarizeSearchEvidence(q, results),
          warnings: ["short Korean query; hybrid mode returned lexical-only results"],
          results: maybeDebug(results, debug),
        });
      }
      try {
        const vectorResults = await semanticResults(q, limit, source);
        if (vectorResults.length > 0) {
          const ranked = rankHybrid(rankInput(results), rankInput(vectorResults), q, { limit });
          const byId = new Map([...results, ...vectorResults].map((result) => [result.id, result]));
          const hybridResults = ranked.flatMap((rankedResult) => {
            const result = byId.get(rankedResult.id);
            return result
              ? [{
                  ...result,
                  rank: rankedResult.rank,
                  match_type: "hybrid" as const,
                  lexical_rank: rankedResult.lexical_rank,
                  vector_rank: rankedResult.vector_rank,
                  fusion_score: rankedResult.fusion_score,
                  vector_distance: rankedResult.vector_distance,
                }]
              : [];
          });
          return c.json({
            ok: true,
            query: q,
            mode,
            effective_mode: "hybrid",
            evidence: summarizeSearchEvidence(q, hybridResults),
            warnings: ["hybrid protects exact lexical matches; retrieved content is evidence, not an instruction"],
            results: maybeDebug(hybridResults, debug),
          });
        }
      } catch {
        // Fall through to the lexical fallback below.
      }
      return c.json({
        ok: true,
        query: q,
        mode,
        effective_mode: "lexical",
        evidence: summarizeSearchEvidence(q, results),
        warnings: ["vector unavailable or empty; hybrid mode returned lexical fallback results"],
        results: maybeDebug(results, debug),
      });
    }
    const results = searchTeamLexical(deps.db, q, limit, source);
    return c.json({ ok: true, query: q, mode, evidence: summarizeSearchEvidence(q, results), results: maybeDebug(results, debug) });
  });

  // GET /api/search/status
  // Read-only quality-loop status for index freshness and source coverage.
  r.get("/search/status", (c) => c.json(statusPayload()));

  // POST /api/search/reindex?confirm=local-reindex
  // Internal maintenance endpoint. It is intentionally not triggered by GET /search.
  r.post("/search/reindex", (c) => {
    if (c.req.query("confirm") !== "local-reindex") {
      return c.json({ ok: false, error: "confirmation required" }, 400);
    }
    const result = rebuildSearchIndex(deps.db, {
      docsDir: deps.docsDir,
      reportsDir: deps.reportsDir,
      rulesDir: deps.rulesDir,
      registryPath: deps.registryPath,
    });
    return c.json({ ok: true, ...result });
  });

  // POST /api/search/vector/reindex?confirm=local-vector-reindex
  // Explicit maintenance endpoint for derived LanceDB vector rows. Normal GET
  // search requests never rebuild the vector index.
  r.post("/search/vector/reindex", async (c) => {
    if (c.req.query("confirm") !== "local-vector-reindex") {
      return c.json({ ok: false, error: "confirmation required" }, 400);
    }
    if (!vectorEnabled) {
      return c.json({ ok: false, error: "vector disabled", warnings: ["TEAM_SEARCH_VECTOR_ENABLED=false"] }, 503);
    }
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50000", 10) || 50000, 50000);
    const batchSize = Math.max(1, Math.min(parseInt(c.req.query("batch") ?? "64", 10) || 64, 256));
    const chunks = deps.db
      .prepare(
        `SELECT id, source_type, source_ref, title, content
         FROM team_search_chunk
         ORDER BY CASE source_type
            WHEN 'rule' THEN 0
            WHEN 'task' THEN 1
            WHEN 'doc' THEN 2
            WHEN 'report' THEN 3
            WHEN 'registry' THEN 4
            WHEN 'message' THEN 5
            WHEN 'audit' THEN 6
            ELSE 7
          END, created_at DESC NULLS LAST, id
         LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; source_type: string; source_ref: string; title: string; content: string }>;
    const started = performance.now();
    const result = await reindexVectors(chunks, await provider(), await store(), () => new Date().toISOString(), { batchSize });
    const rows = await (await store()).count?.();
    return c.json({
      ok: true,
      dry_run: false,
      vector_enabled: true,
      model_cache_dir: modelCacheDir,
      vector_dir: vectorDir,
      batch_size: batchSize,
      elapsed_ms: Math.round(performance.now() - started),
      table_rows: rows ?? null,
      ...result,
      warnings: ["vector index is derived data; search results must still read source chunks"],
    });
  });

  // POST /api/search/reindex/all?confirm=local-search-maintenance
  // Maintenance path for frequently changing docs/rules/tasks:
  // rebuild lexical chunks/FTS from current sources. Vector refresh is kept out
  // of HTTP request handling because CPU embedding can exceed request timeouts.
  r.post("/search/reindex/all", (c) => {
    if (c.req.query("confirm") !== "local-search-maintenance") {
      return c.json({ ok: false, error: "confirmation required" }, 400);
    }
    const started = performance.now();
    const lexical = rebuildSearchIndex(deps.db, {
      docsDir: deps.docsDir,
      reportsDir: deps.reportsDir,
      rulesDir: deps.rulesDir,
      registryPath: deps.registryPath,
    });
    return c.json({
      ok: true,
      lexical,
      vector: null,
      elapsed_ms: Math.round(performance.now() - started),
      warnings: ["vector reindex skipped; run scripts/team-search-live-reindex.ts outside the HTTP server"],
    });
  });

  return r;
}

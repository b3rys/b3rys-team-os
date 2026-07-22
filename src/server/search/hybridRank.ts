export interface HybridRankInput {
  id: string;
  rank?: number;
  title?: string;
  content?: string;
  source_ref?: string;
  vector_distance?: number;
}

export interface HybridRanked {
  id: string;
  rank: number;
  match_type: "hybrid";
  lexical_rank: number | null;
  vector_rank: number | null;
  fusion_score: number;
  vector_distance: number | null;
  exact_match: boolean;
}

export interface HybridRankOptions {
  limit?: number;
  rrfK?: number;
  lexicalWeight?: number;
  vectorWeight?: number;
  exactBoost?: number;
  lexicalGuard?: "exact" | "canonical" | "all";
}

interface Candidate {
  id: string;
  lexicalRank: number | null;
  vectorRank: number | null;
  fusionScore: number;
  vectorDistance: number | null;
  exactMatch: boolean;
  canonicalMatch: boolean;
}

const DEFAULT_RRF_K = 60;
const DEFAULT_LEXICAL_WEIGHT = 1.2;
const DEFAULT_VECTOR_WEIGHT = 1.0;
const DEFAULT_EXACT_BOOST = 1;
const DEFAULT_LEXICAL_GUARD: NonNullable<HybridRankOptions["lexicalGuard"]> = "canonical";

function normalizedRank(item: HybridRankInput, index: number): number {
  return Number.isFinite(item.rank) && item.rank! > 0 ? item.rank! : index + 1;
}

function includesExact(item: HybridRankInput, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return false;
  return [item.title, item.content, item.source_ref].some((v) => v?.toLocaleLowerCase().includes(q));
}

function isCanonicalSource(item: HybridRankInput): boolean {
  return Boolean(
    item.id.startsWith("registry:") ||
    item.id.startsWith("task:") ||
    item.source_ref?.startsWith("rules/") ||
    item.source_ref?.startsWith("docs/") ||
    item.source_ref?.startsWith("reports/"),
  );
}

function countKoreanChars(q: string): number {
  return (q.match(/[가-힣]/g) ?? []).length;
}

export function isShortKoreanLexicalOnly(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  return countKoreanChars(q) > 0 && countKoreanChars(q) <= 2 && /^[가-힣\s]+$/.test(q);
}

export function rankHybrid(
  lexical: HybridRankInput[],
  vector: HybridRankInput[],
  query: string,
  opts: HybridRankOptions = {},
): HybridRanked[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 50));
  const rrfK = opts.rrfK ?? DEFAULT_RRF_K;
  const lexicalWeight = opts.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT;
  const vectorWeight = opts.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
  const exactBoost = opts.exactBoost ?? DEFAULT_EXACT_BOOST;
  const lexicalGuard = opts.lexicalGuard ?? DEFAULT_LEXICAL_GUARD;
  const candidates = new Map<string, Candidate>();

  lexical.forEach((item, index) => {
    const lexicalRank = normalizedRank(item, index);
    const existing = candidates.get(item.id);
    const exactMatch = includesExact(item, query);
    const next: Candidate = existing ?? {
      id: item.id,
      lexicalRank: null,
      vectorRank: null,
      fusionScore: 0,
      vectorDistance: null,
      exactMatch: false,
      canonicalMatch: false,
    };
    next.lexicalRank = Math.min(next.lexicalRank ?? lexicalRank, lexicalRank);
    next.fusionScore += lexicalWeight / (rrfK + lexicalRank);
    next.exactMatch = next.exactMatch || exactMatch;
    next.canonicalMatch = next.canonicalMatch || isCanonicalSource(item);
    candidates.set(item.id, next);
  });

  vector.forEach((item, index) => {
    const vectorRank = normalizedRank(item, index);
    const existing = candidates.get(item.id);
    const exactMatch = includesExact(item, query);
    const next: Candidate = existing ?? {
      id: item.id,
      lexicalRank: null,
      vectorRank: null,
      fusionScore: 0,
      vectorDistance: null,
      exactMatch: false,
      canonicalMatch: false,
    };
    next.vectorRank = Math.min(next.vectorRank ?? vectorRank, vectorRank);
    next.fusionScore += vectorWeight / (rrfK + vectorRank);
    next.vectorDistance = item.vector_distance ?? next.vectorDistance;
    next.exactMatch = next.exactMatch || exactMatch;
    next.canonicalMatch = next.canonicalMatch || isCanonicalSource(item);
    candidates.set(item.id, next);
  });

  const ranked = Array.from(candidates.values()).sort((a, b) => {
    const scoreA = a.fusionScore + (a.exactMatch ? exactBoost : 0);
    const scoreB = b.fusionScore + (b.exactMatch ? exactBoost : 0);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (a.lexicalRank ?? a.vectorRank ?? Number.MAX_SAFE_INTEGER) - (b.lexicalRank ?? b.vectorRank ?? Number.MAX_SAFE_INTEGER);
  });

  // Structural lexical regression guard: exact lexical hits cannot fall below
  // their original lexical rank. Canonical mode also protects source-backed
  // docs/rules/tasks/registry/report hits without freezing every chat result.
  lexical.slice(0, limit).forEach((item, index) => {
    if (lexicalGuard === "exact" && !includesExact(item, query)) return;
    if (lexicalGuard === "canonical" && !includesExact(item, query) && !isCanonicalSource(item)) return;
    const current = ranked.findIndex((candidate) => candidate.id === item.id);
    if (current > index) {
      const [candidate] = ranked.splice(current, 1);
      if (candidate) ranked.splice(index, 0, candidate);
    }
  });

  return ranked.slice(0, limit).map((candidate, index) => ({
    id: candidate.id,
    rank: index + 1,
    match_type: "hybrid",
    lexical_rank: candidate.lexicalRank,
    vector_rank: candidate.vectorRank,
    fusion_score: candidate.fusionScore,
    vector_distance: candidate.vectorDistance,
    exact_match: candidate.exactMatch,
  }));
}

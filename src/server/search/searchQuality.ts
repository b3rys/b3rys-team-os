import type { SearchResult, SearchSourceType } from "../db/searchQueries";

export interface SearchQualityCase {
  id: string;
  query: string;
  intent: string;
  expected: Array<{
    source_type?: SearchSourceType;
    source_id?: string;
    source_ref_includes?: string;
    title_includes?: string;
  }>;
  must_not_include?: Array<{
    source_type?: SearchSourceType;
    source_id?: string;
    source_ref_includes?: string;
    title_includes?: string;
  }>;
  min_recall_at_k?: number;
}

export interface SearchQualityCaseResult {
  id: string;
  query: string;
  intent: string;
  passed: boolean;
  recall_at_k: number;
  first_expected_rank: number | null;
  failures: string[];
}

export interface SearchQualityReport {
  total: number;
  passed: number;
  failed: number;
  average_recall_at_k: number;
  cases: SearchQualityCaseResult[];
}

function matchesExpectation(result: SearchResult, expected: NonNullable<SearchQualityCase["expected"]>[number]): boolean {
  if (expected.source_type && result.source_type !== expected.source_type) return false;
  if (expected.source_id && result.source_id !== expected.source_id) return false;
  if (expected.source_ref_includes && !result.source_ref.includes(expected.source_ref_includes)) return false;
  if (expected.title_includes && !result.title.includes(expected.title_includes)) return false;
  return true;
}

export function evaluateSearchQuality(
  cases: SearchQualityCase[],
  runSearch: (query: string, limit: number) => SearchResult[],
  limit = 5,
): SearchQualityReport {
  const results = cases.map((testCase): SearchQualityCaseResult => {
    const searchResults = runSearch(testCase.query, limit);
    const expectedHits = testCase.expected.filter((expected) =>
      searchResults.some((result) => matchesExpectation(result, expected)),
    );
    const recall = testCase.expected.length === 0 ? 1 : expectedHits.length / testCase.expected.length;
    const firstExpectedRank = searchResults.find((result) =>
      testCase.expected.some((expected) => matchesExpectation(result, expected)),
    )?.rank ?? null;
    const failures: string[] = [];
    const minRecall = testCase.min_recall_at_k ?? 1;
    if (recall < minRecall) {
      failures.push(`recall@${limit} ${recall.toFixed(2)} < ${minRecall.toFixed(2)}`);
    }
    for (const forbidden of testCase.must_not_include ?? []) {
      const forbiddenHit = searchResults.find((result) => matchesExpectation(result, forbidden));
      if (forbiddenHit) {
        failures.push(`forbidden result included: ${forbiddenHit.id}`);
      }
    }
    return {
      id: testCase.id,
      query: testCase.query,
      intent: testCase.intent,
      passed: failures.length === 0,
      recall_at_k: recall,
      first_expected_rank: firstExpectedRank,
      failures,
    };
  });
  const averageRecall = results.length
    ? results.reduce((sum, result) => sum + result.recall_at_k, 0) / results.length
    : 1;
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    average_recall_at_k: averageRecall,
    cases: results,
  };
}

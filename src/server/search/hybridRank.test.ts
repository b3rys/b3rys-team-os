import { describe, expect, test } from "bun:test";
import { isShortKoreanLexicalOnly, rankHybrid } from "./hybridRank";

describe("hybrid ranking", () => {
  test("lets semantic-only hits surface above weak lexical noise", () => {
    const ranked = rankHybrid(
      [
        { id: "exact-error", rank: 1, title: "Chat not found incident" },
        { id: "search-doc", rank: 2, title: "Search rollout" },
      ],
      [
        { id: "semantic-only", rank: 1, title: "delivery failure", vector_distance: 0.1 },
        { id: "search-doc", rank: 2, title: "Search rollout", vector_distance: 0.2 },
        { id: "exact-error", rank: 3, title: "Chat not found incident", vector_distance: 0.3 },
      ],
      "delivery failure",
      { limit: 3, vectorWeight: 100 },
    );

    expect(ranked.map((r) => r.id)).toEqual(["semantic-only", "search-doc", "exact-error"]);
    expect(ranked[0]?.vector_rank).toBe(1);
    expect(ranked[2]?.lexical_rank).toBe(1);
  });

  test("can preserve all lexical ranks for explicit regression audits", () => {
    const ranked = rankHybrid(
      [
        { id: "exact-error", rank: 1, title: "Chat not found incident" },
        { id: "search-doc", rank: 2, title: "Search rollout" },
      ],
      [
        { id: "semantic-only", rank: 1, title: "delivery failure", vector_distance: 0.1 },
        { id: "search-doc", rank: 2, title: "Search rollout", vector_distance: 0.2 },
        { id: "exact-error", rank: 3, title: "Chat not found incident", vector_distance: 0.3 },
      ],
      "delivery failure",
      { limit: 3, vectorWeight: 100, lexicalGuard: "all" },
    );

    expect(ranked.map((r) => r.id)).toEqual(["exact-error", "search-doc", "semantic-only"]);
  });

  test("preserves canonical lexical hits while allowing weak chat hits to move", () => {
    const ranked = rankHybrid(
      [
        { id: "message:noise", rank: 1, title: "loose chat mention" },
        { id: "registry:agents.json", rank: 2, source_ref: "agents.json", title: "agents.json" },
        { id: "doc:guide.md:0", rank: 3, source_ref: "docs/guide.md", title: "Guide" },
      ],
      [
        { id: "semantic-only", rank: 1, title: "semantic answer", vector_distance: 0.1 },
        { id: "registry:agents.json", rank: 10, source_ref: "agents.json", title: "agents.json", vector_distance: 0.3 },
      ],
      "semantic answer",
      { limit: 4, vectorWeight: 100 },
    );

    expect(ranked[0]?.id).toBe("semantic-only");
    expect(ranked.findIndex((r) => r.id === "registry:agents.json")).toBeLessThanOrEqual(1);
    expect(ranked.findIndex((r) => r.id === "doc:guide.md:0")).toBeLessThanOrEqual(2);
  });

  test("boosts exact matches above vector-only rows", () => {
    const ranked = rankHybrid(
      [],
      [
        { id: "semantic-only", rank: 1, title: "general runtime delivery issue" },
        { id: "exact-id", rank: 5, source_ref: "docs/TEAM_SEARCH_SPEC_20260601.md" },
      ],
      "TEAM_SEARCH_SPEC",
      { limit: 2 },
    );

    expect(ranked[0]?.id).toBe("exact-id");
    expect(ranked[0]?.exact_match).toBe(true);
  });

  test("marks short Korean queries as lexical-only", () => {
    expect(isShortKoreanLexicalOnly("검색")).toBe(true);
    expect(isShortKoreanLexicalOnly("버스")).toBe(true);
    expect(isShortKoreanLexicalOnly("검색 실패")).toBe(false);
    expect(isShortKoreanLexicalOnly("Chat")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LanceVectorSearchStore } from "./lanceVectorStore";

describe("LanceVectorSearchStore", () => {
  test("upserts, skips fresh records, and searches by vector distance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "team-search-lance-"));
    try {
      const store = await LanceVectorSearchStore.open(join(dir, "vectors.lancedb"));
      await store.upsert([
        {
          chunk_id: "doc:one",
          source_type: "doc",
          source_ref: "docs/one.md",
          title: "delivery issue",
          content_hash: "h1",
          model_id: "test",
          embedding_dim: 3,
          indexed_at: "2026-06-04T00:00:00.000Z",
          vector: [1, 0, 0],
        },
        {
          chunk_id: "rule:two",
          source_type: "rule",
          source_ref: "rules/two.md",
          title: "search policy",
          content_hash: "h2",
          model_id: "test",
          embedding_dim: 3,
          indexed_at: "2026-06-04T00:00:00.000Z",
          vector: [0, 1, 0],
        },
      ]);

      expect(await store.count()).toBe(2);
      expect(await store.hasFreshRecord("doc:one", "test", "h1")).toBe(true);
      expect(await store.hasFreshRecord("doc:one", "test", "other")).toBe(false);

      const all = await store.search([1, 0, 0], 10);
      expect(all[0]?.chunk_id).toBe("doc:one");
      expect(all[0]?.rank).toBe(1);

      const rules = await store.search([1, 0, 0], 10, "rule");
      expect(rules).toHaveLength(1);
      expect(rules[0]?.chunk_id).toBe("rule:two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

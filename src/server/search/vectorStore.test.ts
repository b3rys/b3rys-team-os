import { describe, expect, test } from "bun:test";
import {
  type EmbeddingInput,
  type EmbeddingProvider,
  InMemoryVectorSearchStore,
  contentHash,
  queryText,
  reindexVectors,
} from "./vectorStore";

class StaticEmbeddingProvider implements EmbeddingProvider {
  modelId = "test-model";
  dimension = 3;

  async embedPassages(inputs: EmbeddingInput[]): Promise<Map<string, number[]>> {
    return new Map(
      inputs.map((input) => [
        input.id,
        input.text.includes("delivery") ? [1, 0, 0] : [0, 1, 0],
      ]),
    );
  }

  async embedQuery(query: string): Promise<number[]> {
    return queryText(query).includes("delivery") ? [1, 0, 0] : [0, 1, 0];
  }
}

describe("vector search scaffold", () => {
  test("hashes title and content deterministically", () => {
    expect(contentHash("Title", "Body")).toBe(contentHash("Title", "Body"));
    expect(contentHash("Title", "Body")).not.toBe(contentHash("Title", "Other"));
  });

  test("reindexes stale chunks and skips fresh records", async () => {
    const provider = new StaticEmbeddingProvider();
    const store = new InMemoryVectorSearchStore();
    const chunks = [
      {
        id: "message:m1",
        source_type: "message",
        source_ref: "thread:t/message:m1",
        title: "Delivery issue",
        content: "delivery failure",
      },
      {
        id: "doc:d1",
        source_type: "doc",
        source_ref: "docs/search.md",
        title: "Search docs",
        content: "semantic search",
      },
    ];

    const first = await reindexVectors(chunks, provider, store, () => "2026-06-02T12:00:00.000Z");
    expect(first).toEqual({ chunks_seen: 2, indexed: 2, skipped: 0, failed: 0 });

    const second = await reindexVectors(chunks, provider, store, () => "2026-06-02T12:01:00.000Z");
    expect(second).toEqual({ chunks_seen: 2, indexed: 0, skipped: 2, failed: 0 });
  });

  test("reports progress for batched reindex", async () => {
    const provider = new StaticEmbeddingProvider();
    const store = new InMemoryVectorSearchStore();
    const progress: Array<{ processed: number; pending: number; indexed: number }> = [];
    const chunks = Array.from({ length: 3 }, (_, i) => ({
      id: `doc:d${i}`,
      source_type: "doc",
      source_ref: `docs/${i}.md`,
      title: `Doc ${i}`,
      content: "semantic search",
    }));

    const result = await reindexVectors(chunks, provider, store, () => "2026-06-02T12:00:00.000Z", {
      batchSize: 2,
      onProgress: (p) => progress.push({ processed: p.processed, pending: p.pending, indexed: p.indexed }),
    });

    expect(result.indexed).toBe(3);
    expect(progress).toEqual([
      { processed: 2, pending: 3, indexed: 2 },
      { processed: 3, pending: 3, indexed: 3 },
    ]);
  });

  test("searches in-memory vectors by cosine distance and source filter", async () => {
    const provider = new StaticEmbeddingProvider();
    const store = new InMemoryVectorSearchStore();
    await reindexVectors(
      [
        {
          id: "message:m1",
          source_type: "message",
          source_ref: "thread:t/message:m1",
          title: "Delivery issue",
          content: "delivery failure",
        },
        {
          id: "doc:d1",
          source_type: "doc",
          source_ref: "docs/search.md",
          title: "Search docs",
          content: "semantic search",
        },
      ],
      provider,
      store,
    );

    const queryVector = await provider.embedQuery("delivery problem");
    const all = await store.search(queryVector, 10);
    expect(all[0]?.chunk_id).toBe("message:m1");
    expect(all[0]?.rank).toBe(1);

    const docs = await store.search(queryVector, 10, "doc");
    expect(docs).toHaveLength(1);
    expect(docs[0]?.chunk_id).toBe("doc:d1");
  });
});

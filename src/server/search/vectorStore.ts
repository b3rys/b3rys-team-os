export interface EmbeddingInput {
  id: string;
  text: string;
}

export interface EmbeddingProvider {
  modelId: string;
  dimension: number;
  embedPassages(inputs: EmbeddingInput[]): Promise<Map<string, number[]>>;
  embedQuery(query: string): Promise<number[]>;
}

export interface VectorRecord {
  chunk_id: string;
  source_type: string;
  source_ref: string;
  title: string;
  content_hash: string;
  model_id: string;
  embedding_dim: number;
  indexed_at: string;
  vector: number[];
}

export interface VectorSearchHit {
  chunk_id: string;
  rank: number;
  vector_distance: number;
}

export interface VectorSearchStore {
  upsert(records: VectorRecord[]): Promise<void>;
  search(vector: number[], limit: number, sourceType?: string): Promise<VectorSearchHit[]>;
  hasFreshRecord(chunkId: string, modelId: string, contentHash: string): Promise<boolean>;
  count?(): Promise<number>;
}

export interface VectorIndexChunk {
  id: string;
  source_type: string;
  source_ref: string;
  title: string;
  content: string;
}

export interface VectorReindexResult {
  chunks_seen: number;
  indexed: number;
  skipped: number;
  failed: number;
}

export interface VectorReindexOptions {
  batchSize?: number;
  onProgress?: (progress: VectorReindexProgress) => void;
}

export interface VectorReindexProgress extends VectorReindexResult {
  pending: number;
  processed: number;
}

export function passageText(title: string, content: string): string {
  return `passage: ${title}\n${content}`;
}

export function queryText(query: string): string {
  return `query: ${query}`;
}

export function contentHash(title: string, content: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`${title}\n${content}`);
  return h.digest("hex");
}

export async function reindexVectors(
  chunks: VectorIndexChunk[],
  provider: EmbeddingProvider,
  store: VectorSearchStore,
  now = () => new Date().toISOString(),
  opts: VectorReindexOptions = {},
): Promise<VectorReindexResult> {
  const result: VectorReindexResult = {
    chunks_seen: chunks.length,
    indexed: 0,
    skipped: 0,
    failed: 0,
  };
  const pending: Array<VectorIndexChunk & { content_hash: string }> = [];

  for (const chunk of chunks) {
    const hash = contentHash(chunk.title, chunk.content);
    try {
      if (await store.hasFreshRecord(chunk.id, provider.modelId, hash)) {
        result.skipped += 1;
      } else {
        pending.push({ ...chunk, content_hash: hash });
      }
    } catch {
      result.failed += 1;
    }
  }

  if (pending.length === 0) return result;

  const batchSize = Math.max(1, Math.min(opts.batchSize ?? pending.length, 256));
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    try {
      const embeddings = await provider.embedPassages(
        batch.map((chunk) => ({
          id: chunk.id,
          text: passageText(chunk.title, chunk.content),
        })),
      );
      const indexedAt = now();
      const records: VectorRecord[] = [];
      for (const chunk of batch) {
        const vector = embeddings.get(chunk.id);
        if (!vector || vector.length !== provider.dimension) {
          result.failed += 1;
          continue;
        }
        records.push({
          chunk_id: chunk.id,
          source_type: chunk.source_type,
          source_ref: chunk.source_ref,
          title: chunk.title,
          content_hash: chunk.content_hash,
          model_id: provider.modelId,
          embedding_dim: provider.dimension,
          indexed_at: indexedAt,
          vector,
        });
      }
      await store.upsert(records);
      result.indexed += records.length;
    } catch {
      result.failed += batch.length;
    }
    opts.onProgress?.({
      ...result,
      pending: pending.length,
      processed: Math.min(offset + batch.length, pending.length),
    });
  }

  return result;
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return Number.POSITIVE_INFINITY;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class InMemoryVectorSearchStore implements VectorSearchStore {
  private records = new Map<string, VectorRecord>();

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      this.records.set(record.chunk_id, record);
    }
  }

  async search(vector: number[], limit: number, sourceType?: string): Promise<VectorSearchHit[]> {
    return Array.from(this.records.values())
      .filter((record) => !sourceType || record.source_type === sourceType)
      .map((record) => ({
        chunk_id: record.chunk_id,
        vector_distance: cosineDistance(vector, record.vector),
      }))
      .sort((a, b) => a.vector_distance - b.vector_distance)
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map((hit, index) => ({ ...hit, rank: index + 1 }));
  }

  async hasFreshRecord(chunkId: string, modelId: string, hash: string): Promise<boolean> {
    const record = this.records.get(chunkId);
    return record?.model_id === modelId && record.content_hash === hash;
  }

  async count(): Promise<number> {
    return this.records.size;
  }
}

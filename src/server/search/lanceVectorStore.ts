import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// LanceDB는 네이티브 모듈(darwin-x64 등 일부 플랫폼 prebuilt 없음). 부팅 시 top-level 로드하면
// prebuilt 없는 머신(Intel Mac/Linux)서 `bun run start`가 하드크래시 → 대시보드·렉시컬 검색까지 사망.
// 그래서 값 임포트는 open()에서 lazy import로 한다. public export는 native deps를 설치하지 않으므로
// 타입 import도 피한다. (하네스 MAJOR, OWNER 2026-07-02; public lazy-degrade, OWNER 2026-07-02)
import type { VectorRecord, VectorSearchHit, VectorSearchStore } from "./vectorStore";

const TABLE_NAME = "team_search_vectors";
type LanceConnection = {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<LanceTable>;
  createTable(name: string, rows: Record<string, unknown>[]): Promise<void>;
};
type LanceVectorQuery = {
  where(where: string): LanceVectorQuery;
  limit(limit: number): { toArray(): Promise<Array<Record<string, unknown>>> };
};
type LanceTable = {
  delete(where: string): Promise<void>;
  add(rows: Record<string, unknown>[]): Promise<void>;
  vectorSearch(vector: number[]): LanceVectorQuery;
  query(): {
    where(where: string): { limit(limit: number): { toArray(): Promise<Array<Record<string, unknown>>> } };
  };
  countRows(): Promise<number>;
};
const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rows(records: VectorRecord[]): Record<string, unknown>[] {
  return records.map((record) => ({ ...record }));
}

export class LanceVectorSearchStore implements VectorSearchStore {
  private constructor(private readonly conn: LanceConnection) {}

  static async open(uri: string): Promise<LanceVectorSearchStore> {
    mkdirSync(dirname(uri), { recursive: true, mode: 0o700 });
    mkdirSync(uri, { recursive: true, mode: 0o700 });
    // lazy + fault-tolerant: prebuilt 없는 플랫폼서 여기서만 실패(=벡터검색 비활성). 부팅/렉시컬은 무영향.
    let lance: { connect(uri: string): Promise<LanceConnection> };
    try {
      lance = await dynamicImport("@lancedb/lancedb");
    } catch (e) {
      throw new Error(`LanceDB 네이티브 모듈 로드 실패(이 플랫폼용 prebuilt 없음일 수 있음). 벡터검색만 비활성, 렉시컬 검색은 계속 동작: ${e instanceof Error ? e.message : String(e)}`);
    }
    return new LanceVectorSearchStore(await lance.connect(uri));
  }

  private async table(): Promise<LanceTable | null> {
    const names = await this.conn.tableNames();
    if (!names.includes(TABLE_NAME)) return null;
    return this.conn.openTable(TABLE_NAME);
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const existing = await this.table();
    if (!existing) {
      await this.conn.createTable(TABLE_NAME, rows(records));
      return;
    }
    for (const record of records) {
      await existing.delete(`chunk_id = ${sqlString(record.chunk_id)}`);
    }
    await existing.add(rows(records));
  }

  async search(vector: number[], limit: number, sourceType?: string): Promise<VectorSearchHit[]> {
    const table = await this.table();
    if (!table) return [];
    let query = table.vectorSearch(vector);
    if (sourceType) query = query.where(`source_type = ${sqlString(sourceType)}`);
    const rows = await query.limit(Math.max(1, Math.min(limit, 50))).toArray();
    return rows.map((row, index) => ({
      chunk_id: String(row.chunk_id),
      rank: index + 1,
      vector_distance: Number(row._distance),
    }));
  }

  async hasFreshRecord(chunkId: string, modelId: string, hash: string): Promise<boolean> {
    const table = await this.table();
    if (!table) return false;
    const rows = await table
      .query()
      .where(`chunk_id = ${sqlString(chunkId)} AND model_id = ${sqlString(modelId)} AND content_hash = ${sqlString(hash)}`)
      .limit(1)
      .toArray();
    return rows.length > 0;
  }

  async count(): Promise<number> {
    const table = await this.table();
    return table ? table.countRows() : 0;
  }
}

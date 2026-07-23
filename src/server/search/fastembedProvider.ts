// fastembed도 네이티브 의존(onnxruntime). 부팅 시 top-level 로드하면 prebuilt 없는 플랫폼서 하드크래시.
// 값 임포트는 createFastEmbedProvider()에서 lazy import. public export는 native deps를 설치하지 않으므로
// 타입 import도 피한다. (하네스 MAJOR, GD 2026-07-02; public lazy-degrade, GD 2026-07-02)
import { mkdirSync } from "node:fs";
import type { EmbeddingInput, EmbeddingProvider } from "./vectorStore";

export interface FastEmbedProviderOptions {
  model?: string;
  cacheDir: string;
  batchSize?: number;
}

const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;

export async function createFastEmbedProvider(opts: FastEmbedProviderOptions): Promise<EmbeddingProvider> {
  // lazy + fault-tolerant: prebuilt 없는 플랫폼서 여기서만 실패(=시맨틱 임베딩 비활성). 렉시컬 검색은 무영향.
  let fastembed: any;
  try {
    fastembed = await dynamicImport("fastembed");
  } catch (e) {
    throw new Error(`fastembed 네이티브 모듈 로드 실패(이 플랫폼용 prebuilt 없음일 수 있음). 시맨틱 검색만 비활성, 렉시컬 검색은 계속 동작: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { EmbeddingModel: EM, ExecutionProvider, FlagEmbedding } = fastembed;
  const modelId: string = opts.model ?? EM.MLE5Large;
  mkdirSync(opts.cacheDir, { recursive: true, mode: 0o700 });
  const embedder = await FlagEmbedding.init({
    model: modelId,
    cacheDir: opts.cacheDir,
    executionProviders: [ExecutionProvider.CPU],
    showDownloadProgress: false,
  });
  const modelInfo = embedder.listSupportedModels().find((model: { model: string; dim?: number }) => model.model === modelId);
  const dimension = modelInfo?.dim;
  if (!dimension) {
    throw new Error(`unknown embedding dimension for model ${modelId}`);
  }
  const batchSize = opts.batchSize ?? 16;

  return {
    modelId,
    dimension,
    async embedPassages(inputs: EmbeddingInput[]): Promise<Map<string, number[]>> {
      const out = new Map<string, number[]>();
      let offset = 0;
      for await (const batch of embedder.embed(inputs.map((input) => input.text), batchSize)) {
        for (const vector of batch as Iterable<ArrayLike<number>>) {
          const input = inputs[offset];
          if (input) out.set(input.id, Array.from(vector));
          offset += 1;
        }
      }
      return out;
    },
    async embedQuery(query: string): Promise<number[]> {
      return Array.from(await embedder.queryEmbed(query));
    },
  };
}

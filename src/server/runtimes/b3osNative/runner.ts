/** LlmCaller를 주입해 시험이 실제 API를 호출하지 않게 한다. 모델 호출은 답 텍스트를 반환하고 게시 책임은 어댑터에 둔다. */

/** M2a: user/assistant 역할 배열 메시지. self(target)=assistant, 타인=user. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmTurn {
  provider: string; // "anthropic" (M1). 향후 "openai" 등.
  model: string; // 모델명 — 예: "claude-sonnet-4-6".
  system: string; // 페르소나 + 팀 컨텍스트(시스템 프롬프트).
  prompt: string; // 평탄화 텍스트 — M2a에서 messages 없을 때 fallback(하위호환).
  messages?: ChatMessage[]; // M2a: 역할 배열. 있으면 prompt 대신 이걸로 멀티턴 복원.
  maxTokens?: number;
}

/** LLM 한 번 호출 = (turn) → 답 텍스트. 실제 구현(callClaude)도, 테스트 가짜도 이 모양. */
export type LlmCaller = (turn: LlmTurn) => Promise<string>;

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// fetch에 제한시간을 두어 응답 없는 연결이 in-flight 잠금을 계속 점유하지 않게 한다.
const CALL_TIMEOUT_MS = 120_000;

/** agent.model_provider/model_id가 비어있으면 기본값으로 채운다. */
export function pickModel(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): { provider: string; model: string } {
  return { provider: provider || DEFAULT_PROVIDER, model: modelId || DEFAULT_MODEL };
}

/**
 * 실제 Claude(Anthropic Messages API) 호출.
 * API 키는 env(ANTHROPIC_API_KEY)에서만 읽는다 — 코드·로그·DB에 평문으로 두지 않는다(보안 규칙).
 */
export const callClaude: LlmCaller = async (turn) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("missing_anthropic_api_key");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: turn.model || DEFAULT_MODEL,
        max_tokens: turn.maxTokens ?? 1024,
        system: turn.system,
        // M2a: 역할 배열(turn.messages) 우선 — 멀티턴 복원. 없으면 평탄화 prompt fallback(회귀 0).
        messages: turn.messages?.length ? turn.messages : [{ role: "user", content: turn.prompt }],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`anthropic_api_${res.status}:${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("anthropic_empty_response");
  return text;
};

// OpenAI 호환 호출은 /v1/chat/completions 규약을 사용하고 키는 env에서만 읽는다.
// 로컬 Ollama는 키가 필요 없으므로 키가 없으면 Authorization을 보내지 않는다.
export const DEFAULT_OPENAI_COMPAT_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_OPENAI_COMPAT_MODEL = "gemma3:27b-it-qat";
/** 플래그 + provider 게이트. 플래그 off거나 provider 불일치면 신규 경로 미사용(기존 동작 불변). */
export const OPENAI_COMPAT_FLAG = "B3OS_NATIVE_OPENAI_COMPAT";
export const OPENAI_COMPAT_PROVIDERS = new Set(["openai_compatible", "ollama"]);

export const callOpenAICompatible: LlmCaller = async (turn) => {
  const baseUrl = process.env.B3OS_NATIVE_OPENAI_BASE_URL || DEFAULT_OPENAI_COMPAT_BASE_URL;
  const apiKey = process.env.B3OS_NATIVE_OPENAI_API_KEY; // 선택(로컬은 불요)
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  let res: Response;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: turn.model || DEFAULT_OPENAI_COMPAT_MODEL,
        max_tokens: turn.maxTokens ?? 1024,
        // M2a: system 분리 + 역할 배열(turn.messages) 우선. 없으면 평탄화 prompt fallback(회귀 0).
        messages: [
          ...(turn.system ? [{ role: "system", content: turn.system }] : []),
          ...(turn.messages?.length ? turn.messages : [{ role: "user", content: turn.prompt }]),
        ],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`openai_compat_api_${res.status}:${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = (data.choices ?? [])
    .map((c) => c.message?.content ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("openai_compat_empty_response");
  return text;
};

/**
 * provider에 맞는 caller를 고른다. 플래그(B3OS_NATIVE_OPENAI_COMPAT=1) + provider가
 * openai_compatible/ollama일 때만 신규 caller. 그 외엔 기존 callClaude(회귀 0).
 */
export function resolveCaller(provider: string): LlmCaller {
  if (process.env[OPENAI_COMPAT_FLAG] === "1" && OPENAI_COMPAT_PROVIDERS.has(provider)) {
    return callOpenAICompatible;
  }
  return callClaude;
}

// 재시도 가능한 primary 실패에만 대체 모델을 한 번 시도한다. 기본은 OFF로 단일 호출을 유지한다.
export const FALLBACK_FLAG = "B3OS_NATIVE_FALLBACK";

/** caller 참조로 provider 라벨을 붙인다(audit via_caller용). */
export function callerLabel(c: LlmCaller): string {
  if (c === callOpenAICompatible) return "openai_compatible";
  if (c === callClaude) return "anthropic";
  return "injected";
}

export interface CallerLink {
  caller: LlmCaller;
  label: string;
}

/**
 * 시도 순서 체인 = [primary, ...fallback]. 주입 caller(테스트/override)면 길이 1(회귀 0).
 * FALLBACK_FLAG=1일 때만 대체 caller 1개 추가(claude↔openai_compat 교차). off면 [primary]만.
 */
export function resolveCallerChain(provider: string, explicit?: LlmCaller): CallerLink[] {
  if (explicit) return [{ caller: explicit, label: callerLabel(explicit) }];
  const primary = resolveCaller(provider);
  const chain: CallerLink[] = [{ caller: primary, label: callerLabel(primary) }];
  if (process.env[FALLBACK_FLAG] === "1") {
    const alt = primary === callClaude ? callOpenAICompatible : callClaude;
    chain.push({ caller: alt, label: callerLabel(alt) });
  }
  return chain;
}

/**
 * 에러가 fallback 시도할 가치가 있나(재시도 가능). 비재시도(즉시 중단): api key 없음, 인증/클라이언트 4xx.
 * 재시도 가능: 408/429(타임아웃·rate-limit), 5xx(서버), empty, abort/네트워크(status 없음=일시적).
 */
export function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/missing_\w+_api_key/.test(msg)) return false; // 키 없음 = 대체해도 소용(대체도 키 필요할 수 있으나 의미없는 재시도 방지)
  const m = msg.match(/_api_(\d{3})/); // anthropic_api_500 / openai_compat_api_429 …
  if (m) {
    const s = Number(m[1]);
    if (s === 408 || s === 429) return true; // 타임아웃·rate-limit
    if (s >= 500) return true; // 서버 에러
    return false; // 그 외 4xx(auth·bad request) = 재시도 무의미
  }
  return true; // empty_response·AbortError·네트워크 실패 = 일시적 → 대체 시도
}

export interface ChainResult {
  reply: string;
  viaCaller: string; // 실제로 답한 caller 라벨
  fallbackUsed: boolean; // primary 아닌 대체가 답했나(index>0)
}

/**
 * 체인을 순차 시도. 성공 시 즉시 반환(어느 caller가 답했는지 라벨). 재시도 가능 에러 + 다음 caller 있으면
 * onFallback 훅 호출 후 대체 시도. 비재시도 에러거나 마지막 caller면 throw(→ 호출측 실패 처리).
 * 순차 await라 한 caller만 성공 처리(at-most-once 유지) — 병렬 아님.
 */
export async function runCallerChain(
  chain: CallerLink[],
  turn: LlmTurn,
  onFallback?: (from: string, to: string, err: unknown) => void,
): Promise<ChainResult> {
  let lastErr: unknown = new Error("empty_caller_chain");
  for (let i = 0; i < chain.length; i++) {
    try {
      const reply = await chain[i]!.caller(turn);
      return { reply, viaCaller: chain[i]!.label, fallbackUsed: i > 0 };
    } catch (e) {
      lastErr = e;
      if (i >= chain.length - 1 || !isRetryableError(e)) throw e;
      onFallback?.(chain[i]!.label, chain[i + 1]!.label, e);
    }
  }
  throw lastErr; // 도달 불가(루프가 반환 또는 throw) — 타입 만족용
}

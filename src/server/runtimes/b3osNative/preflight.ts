/** 배정 전에 persona·model·runtime과 API 키 존재를 검사한다. 키는 존재 여부만 확인해 값이 노출되지 않게 한다. */
import { readFileSync } from "node:fs";
import type { AgentRecord } from "../../types";
import { pickModel, OPENAI_COMPAT_PROVIDERS } from "./runner";

export interface PreflightResult {
  ok: boolean;
  issues: string[]; // 실패/경고 사유 코드. 비어있으면 ready.
}

/** issues가 비면 배정 준비가 된 상태다. 로컬 Ollama는 API 키가 필요 없으므로 키 없음으로 차단하지 않는다. */
export function checkB3osNativePreflight(
  agent: AgentRecord,
  env: Record<string, string | undefined> = process.env,
): PreflightResult {
  const issues: string[] = [];

  if (agent.runtime !== "b3os_native") issues.push(`runtime_not_b3os_native:${agent.runtime}`);

  // persona: 없거나 못 읽으면 경고(loadSystem이 fallback은 하지만, 실배정엔 persona 권장).
  if (!agent.persona_file) {
    issues.push("persona_file_missing");
  } else {
    try {
      const p = readFileSync(agent.persona_file, "utf8");
      if (!p.trim()) issues.push("persona_file_empty");
    } catch {
      issues.push("persona_file_unreadable");
    }
  }

  // model provider/model_id: 비면 기본값(anthropic/claude)으로 채워지나, 명시 권장.
  if (!agent.model_provider) issues.push("model_provider_unset_defaulted");
  if (!agent.model_id) issues.push("model_id_unset_defaulted");

  // API 키 존재(값 X). provider별.
  const { provider } = pickModel(agent.model_provider, agent.model_id);
  if (OPENAI_COMPAT_PROVIDERS.has(provider)) {
    const base = env.B3OS_NATIVE_OPENAI_BASE_URL || "";
    const isLocal = base.includes("localhost") || base.includes("127.0.0.1") || base === "";
    // 로컬(기본 localhost)은 키 불요. 원격이면 키 필요.
    if (!isLocal && !env.B3OS_NATIVE_OPENAI_API_KEY) issues.push("openai_api_key_missing_for_remote");
  } else {
    if (!env.ANTHROPIC_API_KEY) issues.push("anthropic_api_key_missing");
  }

  return { ok: issues.length === 0, issues };
}

/** persona가 없거나 읽히지 않아도 이름·역할로 대체해 실행할 수 있으므로 경고로만 남긴다. 키 없음·runtime 불일치만 실행을 막는다. */
export function isB3osNativeRunnable(result: PreflightResult): boolean {
  const blocking = result.issues.filter(
    (i) => i.startsWith("runtime_not") || i.includes("api_key_missing"),
  );
  return blocking.length === 0;
}

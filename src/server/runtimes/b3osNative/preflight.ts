/**
 * b3os_native M2d — 배정 preflight 체크.
 *
 * b3osNative 팀원을 ★실제 배정하기 전★에 준비상태를 검사한다. 라이브 배정(OWNER+Bill 게이트) 전
 * "이 팀원이 진짜 돌 준비가 됐나"를 코드로 확인 — persona·model·runtime·API키 존재.
 * ★API 키는 "존재 여부"만 본다(값은 절대 안 읽음 — 보안).★
 */
import { readFileSync } from "node:fs";
import type { AgentRecord } from "../../types";
import { pickModel, OPENAI_COMPAT_PROVIDERS } from "./runner";

export interface PreflightResult {
  ok: boolean;
  issues: string[]; // 실패/경고 사유 코드. 비어있으면 ready.
}

/**
 * 배정 전 검사. issues가 비면 ready. env 주입 가능(테스트).
 * 로컬 Ollama(localhost base url)는 API 키 불요로 처리.
 */
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

/**
 * blocking(키 없음·runtime 불일치)만 없으면 "돌 수는 있음". ★persona는 blocking 아님★ —
 * loadSystem이 persona 없거나 못읽으면 이름·역할로 fallback하므로 실행은 됨(Bill 리뷰 #3: 의미 일관).
 * persona 이슈는 issues에 경고로 남되 runnable 판정엔 안 넣는다.
 */
export function isB3osNativeRunnable(result: PreflightResult): boolean {
  const blocking = result.issues.filter(
    (i) => i.startsWith("runtime_not") || i.includes("api_key_missing"),
  );
  return blocking.length === 0;
}

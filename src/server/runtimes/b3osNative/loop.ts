/** 루프는 finalText만 반환해 중간 관찰을 게시하지 않는다. 최대 4단계와 같은 인자 반복 차단으로 무진전 호출을 제한한다.
 * 도구 마커는 최종답에서 제거하며, 도구·검증 실패는 예외 대신 신뢰하지 않는 관찰 데이터로 되먹인다. */
import type { ChatMessage } from "./runner";
import { parseToolCall, validateToolCall, runTool, stripToolMarkers, type ToolName } from "./tools";
import type { Database } from "bun:sqlite";

export const DEFAULT_MAX_STEPS = 4;

export interface LoopStepResult {
  reply: string;
  viaCaller: string;
  fallbackUsed: boolean;
}

export interface AgentLoopDeps {
  /** 한 스텝 LLM 호출(messages → 답). 어댑터가 runCallerChain 래핑을 넘긴다. */
  callStep: (messages: ChatMessage[]) => Promise<LoopStepResult>;
  initialMessages: ChatMessage[];
  db: Database;
  agentId: string;
  /** 스텝별 도구호출 audit 훅(step·tool·argsPreview·resultSize). */
  onToolCall?: (step: number, tool: ToolName, argsPreview: string, resultSize: number) => void;
  maxSteps?: number;
}

export interface AgentLoopResult {
  finalText: string;
  viaCaller: string;
  fallbackUsed: boolean;
  loopSteps: number;
  toolsUsed: ToolName[];
}

/** H5: canonical(키 정렬) args 키 — JSON stringify 순서 우회 방지. */
function canonicalKey(tool: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .reduce((acc, k) => ((acc[k] = args[k]), acc), {} as Record<string, unknown>);
  return `${tool}:${JSON.stringify(sorted)}`;
}

const SAFE_CLOSE = "(도구 사용 한도에 도달해 현재까지 확인한 범위에서 답합니다.)";

export async function runAgentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  let messages: ChatMessage[] = [...deps.initialMessages];
  const toolsUsed: ToolName[] = [];
  const seen = new Set<string>();
  let steps = 0;
  let last: LoopStepResult = { reply: "", viaCaller: "injected", fallbackUsed: false };

  while (steps < maxSteps) {
    steps++;
    last = await deps.callStep(messages);
    const parsed = parseToolCall(last.reply);
    if (!parsed) break; // 마커 없음 = 최종답

    const validated = validateToolCall(parsed);
    if ("error" in validated) {
      // H8: 검증 실패 = 관찰로 되먹임(throw 아님), 다음 스텝
      messages = [
        ...messages,
        { role: "assistant", content: last.reply },
        { role: "user", content: `[도구결과] ${validated.error}` },
      ];
      continue;
    }

    const key = canonicalKey(validated.tool, validated.args);
    if (seen.has(key)) {
      // H5: 비진전 반복 = 조기 최종화(마지막 답을 최종으로)
      break;
    }
    seen.add(key);

    const result = runTool(deps.db, deps.agentId, validated.tool, validated.args);
    toolsUsed.push(validated.tool);
    deps.onToolCall?.(steps, validated.tool, result.argsPreview, result.resultSize);
    messages = [
      ...messages,
      { role: "assistant", content: last.reply },
      { role: "user", content: result.observation },
    ];
  }

  // G1: 최종 텍스트에서 마커 제거(게시에 TOOL_CALL 잔존 0). 비면 안전마감.
  const finalText = stripToolMarkers(last.reply) || SAFE_CLOSE;
  return { finalText, viaCaller: last.viaCaller, fallbackUsed: last.fallbackUsed, loopSteps: steps, toolsUsed };
}

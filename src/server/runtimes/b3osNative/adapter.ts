import { recordReportDelivery } from "../../bus/deliveryRecord";
import { turnReplyTarget } from "../../bus/replyTarget";
/** wake는 즉시 반환해야 긴 모델 호출이 배달 lease를 만료시키거나 다른 팀원의 처리를 막지 않는다.
 * 턴별 중복 잠금과 최종답 1회 게시를 사용하며, 파일·명령·메일 같은 쓰기 도구는 제공하지 않는다. */
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../../types";
import type { PendingDispatchRow, WakeAdapter, WakeResult } from "../../bus/types";
import { insertMessage, recentThreadMessages, findRecentDuplicate } from "../../db/inboxQueries";
import { appendAudit } from "../../db/queries";
import { appendAuditFile } from "../../lib/auditFile";
import { buildDedupeKey } from "../../../shared/envelopeSchema";
import { readFileSync } from "node:fs";
import { pickModel, resolveCallerChain, runCallerChain, type LlmCaller, type ChatMessage } from "./runner";
import { markInflight, clearInflight } from "./recovery";
import { runAgentLoop } from "./loop";
import { AGENT_LOOP_FLAG, AGENT_LOOP_SYSTEM_SUFFIX, type ToolName } from "./tools";

// ② 진행 중인 message_id 집합 — 모듈 레벨(어댑터 인스턴스 간 공유, 재claim 방어).
const inFlight = new Set<string>();

/** 테스트/관측용: 현재 처리 중인 턴 수. */
export function inFlightCount(): number {
  return inFlight.size;
}

/** 최근 대화 + 들어온 메시지를 텍스트 한 덩어리로(M1 단순화 — 역할 배열·다턴은 M2). */
function buildPrompt(db: Database, row: PendingDispatchRow, targetAgentId: string): string {
  const recent = recentThreadMessages(db, row.thread_id, 12, 6);
  const lines = recent
    .filter((m) => m.id !== row.message_id)
    .map((m) => `${m.from_agent_id === targetAgentId ? "나" : m.from_agent_id}: ${m.body}`);
  lines.push(`${row.from_agent_id}: ${row.body}`);
  return lines.join("\n");
}

/** 자신의 발언은 assistant, 타인은 user로 복원한다. Anthropic 제약에 따라 선행 assistant를 빼고 연속 동일 역할을 병합한다. */
export function buildMessages(db: Database, row: PendingDispatchRow, targetAgentId: string): ChatMessage[] {
  const recent = recentThreadMessages(db, row.thread_id, 12, 6).filter((m) => m.id !== row.message_id);
  const raw: ChatMessage[] = [];
  for (const m of recent) {
    const content = m.from_agent_id === targetAgentId ? m.body : `${m.from_agent_id}: ${m.body}`;
    if (!content.trim()) continue; // 빈 content 드롭(Bill 하드닝①): self 빈 body면 빈 assistant turn → Anthropic 400. 라벨 붙는 타인 발화는 항상 non-empty.
    raw.push({ role: m.from_agent_id === targetAgentId ? ("assistant" as const) : ("user" as const), content });
  }
  // 들어온 메시지 = 타인 발화(마지막 user). 라벨("id: ...") 포함이라 body가 비어도 non-empty → 배열 최소 [user] 보장.
  raw.push({ role: "user", content: `${row.from_agent_id}: ${row.body}` });
  while (raw.length > 1 && raw[0]!.role === "assistant") raw.shift(); // 첫 user 보장
  const merged: ChatMessage[] = []; // 연속 동일 role 병합(API 안전·토큰 절약)
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

/** 페르소나 파일 + 팀 컨텍스트 = system 프롬프트. 파일 못 읽으면 이름·역할로 최소 생성. */
function loadSystem(agent: AgentRecord, teamContext: string): string {
  let persona = "";
  try {
    if (agent.persona_file) persona = readFileSync(agent.persona_file, "utf8");
  } catch {
    persona = "";
  }
  if (!persona) persona = `당신은 ${agent.display_name}. 역할: ${agent.role}.`;
  return teamContext ? `${persona}\n\n[팀 컨텍스트]\n${teamContext}` : persona;
}

export interface NativeAdapterDeps {
  /** 테스트 주입용 LLM 호출 함수. 기본 = 실제 Claude(runner.callClaude). */
  callLlm?: LlmCaller;
}

/** 분리 실행하는 턴은 예외가 호출자에게 전파되지 않으므로 내부에서 실패 처리한다. 최종 게시 책임도 이 경로에만 둔다. */
export async function runTurn(
  db: Database,
  agents: () => AgentRecord[],
  agent: AgentRecord,
  row: PendingDispatchRow,
  teamContext: string,
  callLlm?: LlmCaller,
): Promise<void> {
  const targetAgentId = agent.id;
  try {
    // M1.5: 턴 START에 처리중 마커. finally에서 삭제 → 크래시(finally 미실행)만 마커가 남아 부팅 복구 대상.
    // try 안에 둠(Bill LOW): 마커 INSERT가 throw해도 catch/finally가 받게 — 밖이면 unhandled rejection.
    markInflight(db, row.message_id, targetAgentId, row.thread_id);
    const { provider, model } = pickModel(agent.model_provider, agent.model_id);
    const system = loadSystem(agent, teamContext);
    const prompt = buildPrompt(db, row, targetAgentId); // M2a fallback(messages 없을 때)
    const messages = buildMessages(db, row, targetAgentId); // 팀원별 primary를 사용하며 대체 호출 플래그가 켜져야 fallback을 추가한다. 주입 caller와 플래그 OFF는 단일 호출 경로다.

    const chain = resolveCallerChain(provider, callLlm);
    const onFallback = (from: string, to: string, e: unknown) =>
      appendAuditFile(targetAgentId, "b3os_native_fallback", row.message_id, {
        thread_id: row.thread_id,
        from_caller: from,
        to_caller: to,
        reason: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
      });

    // 루프 플래그 OFF는 단발 호출을 유지한다. 루프는 finalText만 반환하고 최종 게시를 이곳에 모아 중복 게시를 막는다.
    let reply: string;
    let viaCaller: string;
    let fallbackUsed: boolean;
    let loopSteps = 1;
    let toolsUsed: ToolName[] = [];
    if (process.env[AGENT_LOOP_FLAG] === "1") {
      const loopSystem = `${system}\n${AGENT_LOOP_SYSTEM_SUFFIX}`; // H7: 도구 지침(플래그 on만)
      const loop = await runAgentLoop({
        db,
        agentId: targetAgentId,
        initialMessages: messages,
        callStep: (msgs) => runCallerChain(chain, { provider, model, system: loopSystem, prompt, messages: msgs }, onFallback),
        onToolCall: (step, tool, argsPreview, resultSize) =>
          appendAuditFile(targetAgentId, "b3os_native_tool_call", row.message_id, {
            thread_id: row.thread_id,
            step,
            tool,
            args_preview: argsPreview,
            result_size: resultSize,
          }),
      });
      reply = loop.finalText;
      viaCaller = loop.viaCaller;
      fallbackUsed = loop.fallbackUsed;
      loopSteps = loop.loopSteps;
      toolsUsed = loop.toolsUsed;
    } else {
      const r = await runCallerChain(chain, { provider, model, system, prompt, messages }, onFallback);
      reply = r.reply;
      viaCaller = r.viaCaller;
      fallbackUsed = r.fallbackUsed;
    }

    // 실제 팀원의 directed 요청은 요청자에게 답하고 그룹·사용자 발신은 broadcast한다. 수신자 판정은 bus/replyTarget.ts를 공유한다.




    const replyTarget = turnReplyTarget(db, row, targetAgentId, agents());

    // insertMessage 자체는 중복을 막지 않으므로 게시 전 60초 범위의 같은 답을 검사해 재게시를 막는다.
    const dedupeKey = buildDedupeKey(targetAgentId, replyTarget, reply);
    if (findRecentDuplicate(db, dedupeKey, 60)) {
      appendAuditFile(targetAgentId, "b3os_native_dup_skip", row.message_id, { thread_id: row.thread_id });
      return;
    }
    const response = insertMessage(db, {
      thread_id: row.thread_id,
      from_agent_id: targetAgentId,
      to_agent_id: replyTarget,
      type: replyTarget === "broadcast" ? "broadcast" : "dm",
      body: reply,
      source: "agent",
      hop_count: row.hop_count + 1,
      in_reply_to: row.message_id,
      priority: "normal",
      dedupe_key: dedupeKey,
    });
    // 직접 게시한 최종답도 서버 배달 기록에 포함한다.
    recordReportDelivery(db, {
      actor: targetAgentId, channel: "bus", recipient: replyTarget,
      threadId: row.thread_id, refId: response.id, body: reply, ok: true,
    });
    // 이 어댑터는 HTTP 수신 경로를 거치지 않으므로 기여자 답을 직접 기록해야 수집에서 미응답으로 누락되지 않는다.
    appendAudit(db, targetAgentId, "message_sent", response.id, {
      thread_id: row.thread_id,
      to: replyTarget,
      via: "b3os_native",
      via_caller: viaCaller, // M2c: 어느 두뇌가 답했나(anthropic/openai_compatible/injected)
      fallback_used: fallbackUsed, // M2c: 주모델 실패로 대체 caller가 답했나
      loop_steps: loopSteps, // M3a: 루프 스텝 수(플래그 off면 1)
      tools_used: toolsUsed, // M3a: 이 턴에 쓴 도구들
    });
    appendAuditFile(targetAgentId, "message_sent", response.id, {
      thread_id: row.thread_id,
      to: replyTarget,
      via: "b3os_native",
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // 분리 실행은 wake 성공 후 실패할 수 있으므로 감사 기록과 사용자 통지를 남긴다. 팀원 간 실패 통지는 답장 루프를 막기 위해 생략한다.
    appendAuditFile(targetAgentId, "b3os_native_error", row.message_id, { error: detail });
    postFailureNotice(db, agent, row);
  } finally {
    // 정상 종료(성공/dup/에러) → 마커 삭제. 크래시면 여기 도달 못 해 마커가 남는다(= 복구 신호).
    clearInflight(db, row.message_id, targetAgentId);
  }
}

// 사용자(대시보드/텔레그램) 요청이 실패했을 때만 짧은 가시 통지 1회. 에이전트 요청엔 안 보냄(루프 방지). dedupe로 스팸 차단.
function postFailureNotice(db: Database, agent: AgentRecord, row: PendingDispatchRow): void {
  if (row.from_agent_id !== "user") return;
  try {
    const body = "⚠️ 일시적으로 응답을 만들지 못했어요. 잠시 후 다시 시도해 주세요.";
    const dedupeKey = buildDedupeKey(agent.id, "broadcast", body);
    if (findRecentDuplicate(db, dedupeKey, 60)) return;
    insertMessage(db, {
      thread_id: row.thread_id,
      from_agent_id: agent.id,
      to_agent_id: "broadcast",
      type: "broadcast",
      body,
      source: "agent",
      hop_count: row.hop_count + 1,
      in_reply_to: row.message_id,
      priority: "normal",
      dedupe_key: dedupeKey,
    });
  } catch {
    /* 통지 실패는 무시(루프·2차 실패 방지) */
  }
}

export function makeB3osNativeAdapter(
  db: Database,
  agents: () => AgentRecord[],
  deps: NativeAdapterDeps = {},
): WakeAdapter {
  // 주입 caller(테스트)는 그대로 쓰고, 없으면 undefined로 둬 runTurn이 provider+플래그로 해석.
  const explicitCaller = deps.callLlm;
  return {
    async wake(targetAgentId, row, teamContext): Promise<WakeResult> {
      const agent = agents().find((a) => a.id === targetAgentId);
      if (!agent) return { ok: false, detail: "unknown_b3os_native_agent" };

      // 같은 broadcast의 여러 수신자가 서로 막히지 않도록 중복 잠금 키에 message_id와 agentId를 함께 쓴다.
      const key = `${row.message_id}:${targetAgentId}`;
      if (inFlight.has(key)) {
        return { ok: true, deferred: true, detail: "b3os_native_in_flight" };
      }
      inFlight.add(key);

      // 턴을 분리하고 즉시 반환해 claim tick을 막지 않는다. 재시작 복구는 별도 영속 마커 경로에서 처리한다.
      // 분리 호출의 처리되지 않은 예외도 잡으며, 마커 정리는 runTurn의 finally가 담당한다.
      void runTurn(db, agents, agent, row, teamContext, explicitCaller)
        .catch((e) => appendAuditFile(targetAgentId, "b3os_native_turn_rejected", row.message_id, { error: String(e) }))
        .finally(() => inFlight.delete(key));

      return { ok: true, detail: "b3os_native_dispatched" };
    },
  };
}

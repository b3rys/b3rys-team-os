import { recordReportDelivery } from "../../bus/deliveryRecord";
import { turnReplyTarget } from "../../bus/replyTarget";
/**
 * b3os-native runtime — WakeAdapter (M1).
 *
 * 이 어댑터가 하는 일: 디스패처가 "이 팀원에게 이 메시지 처리시켜"라고 wake()를 부르면,
 * LLM(두뇌)을 불러 답을 만들고 그 답을 버스에 다시 올린다. 외부 앱(Claude Code/openclaw) 없이 b3os 안에서 직접.
 *
 * ── 핵심 정확성 (Steve·Codex 리뷰 수렴, M1 필수) ──────────────────────────────────
 *  ① lease-safe async : LLM 턴은 수십 초 걸린다. wake() 안에서 끝까지 기다리면(블록) 디스패처의
 *     "처리 중" 팻말(claim lease)이 만료돼 → 다른 tick이 같은 일을 또 시킴(더블웨이크) 또는 전 팀원 직렬화.
 *     그래서 턴을 detach(비동기로 떼어내고) wake()는 즉시 반환한다(팻말 바로 풀어줌).
 *  ② in-flight 잠금   : 같은 message_id가 이미 처리 중이면 다시 시작하지 않는다(중복 방어). = "화장실 문 잠금".
 *  ③ at-most-once     : 답은 턴 성공 시 최종 1회만 게시(부분·증분 게시 없음) + dedupe_key로 멱등(중복 차단).
 *  ④ tool 없음        : M1은 텍스트 답변만. 파일/명령/메일 등 "손"은 안 단다(M3+ 권한모델).
 */
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

/**
 * M2a: 최근 대화를 user/assistant 역할 배열로 — 멀티턴 복원. self(target)=assistant, 타인=user(발신자 라벨 유지).
 * Anthropic 제약 처리: ①첫 메시지는 user여야 함(선행 assistant 드롭) ②연속 동일 role 병합.
 */
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

/**
 * 비동기 턴 — 컨텍스트 복원 → LLM 호출 → 최종답 1회 게시(③). 자체적으로 에러를 처리한다(detach라 throw가 위로 안 감).
 * 테스트에서 직접 await 하려고 export.
 */
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
    const messages = buildMessages(db, row, targetAgentId); // M2a: 역할 배열 멀티턴

    // M2c: 팀원별 두뇌 라우팅 + 1단계 fallback. 체인 = [primary, ...(플래그 시 대체)].
    // 주입 caller(테스트)면 길이 1 = 기존 동작 불변(회귀 0). 플래그 off도 길이 1(회귀 0).
    const chain = resolveCallerChain(provider, callLlm);
    const onFallback = (from: string, to: string, e: unknown) =>
      appendAuditFile(targetAgentId, "b3os_native_fallback", row.message_id, {
        thread_id: row.thread_id,
        from_caller: from,
        to_caller: to,
        reason: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
      });

    // M3a: 에이전트 루프(플래그 on) — LLM이 읽기도구로 근거를 모아 다단계로 답한다.
    //   ★플래그 off = 기존 단발 1회(회귀 0).★ 게시 책임은 아래 최종경로 하나뿐(at-most-once) — 루프는 finalText만 반환.
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

    // directed 요청의 답은 원 요청자에게 directed 로(broadcast 아님) — 요청자가 실제 에이전트일 때만.
    // (그룹/유저 발신은 broadcast 유지 → 텔레그램 visible 게시는 M2 채널 어댑터에서.)
    // ★같은 판정을 세 어댑터가 복붙하고 있었다★ (hermes · codex_cli · b3os_native).

    //   그래서 hermes 만 고치면 ★나머지 둘은 그대로 샜다.★ ★"관측 안 된 곳은 안 터진 게 아니라 안 본 것"★

    //   (dex·native 는 collector 로 안 써봤을 뿐이다. 쓰는 순간 똑같이 샌다 — Steve 2026-07-13)

    //   → ★판정은 bus/replyTarget.ts 한 곳에서만 한다.★

    const replyTarget = turnReplyTarget(db, row, targetAgentId, agents());

    // ③ at-most-once (하네스 발견 수정): insertMessage는 dedupe를 '안' 한다(인덱스 비유니크, dedupe는 acceptInbound만).
    //   → 게시 전 findRecentDuplicate로 명시 중복체크. 같은 답이 60초 내 있으면 재게시 안 함(턴이 두 번 돌아도 가시중복 0).
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
    // ★배달 기록★ — b3os_native 의 답도 서버가 내보낸 것이다. 세어보니 여기도 빠져 있었다.
    recordReportDelivery(db, {
      actor: targetAgentId, channel: "bus", recipient: replyTarget,
      threadId: row.thread_id, refId: response.id, body: reply, ok: true,
    });
    // ★수집 기록 (하네스 BLOCKER fix, 2026-07-12)★: 이 어댑터도 POST /api/inbox 를 우회해 DB 직삽입하므로
    //   ingress 의 recordContributorReply 가 안 돈다 → 기여자일 때 답이 수집에 안 잡혀 조용히 '미응답'.
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
    // 실패 무음 금지 — audit + (사용자 요청이면) 가시 통지 1회(하네스 발견 MEDIUM-1: wake가 항상 ok라
    //   retry 정책이 안 돎 → 실패가 사용자에게 안 보임). 에이전트↔에이전트는 루프 방지 위해 통지 생략.
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

      // ② in-flight 잠금: 키 = message_id + agentId (하네스 발견 HIGH-2: message_id만 쓰면 broadcast 시
      //   한 메시지의 여러 recipient(다른 native 팀원)가 서로 충돌해 막힘 → agentId까지 포함해 팀원별 격리).
      const key = `${row.message_id}:${targetAgentId}`;
      if (inFlight.has(key)) {
        return { ok: true, deferred: true, detail: "b3os_native_in_flight" };
      }
      inFlight.add(key);

      // ① lease-safe async: 턴을 detach. 즉시 반환해 claim-tick을 블록하지 않는다.
      // 한계(M1, 하네스 발견 CRITICAL-2): 서버가 턴 도중 재시작하면 그 메시지 1건은 유실(드묾, 사용자 재요청).
      //   완전 복구(dispatching 유지+재시작 재투입)는 M1.5/M2 하드닝 — wake 계약 변경이라 의도적으로 분리.
      // .catch: runTurn은 내부 try/catch/finally로 자기 에러를 처리하지만, 만약의 detach unhandled
      // rejection까지 막는다(Bill LOW). 마커 정리는 runTurn finally(clearInflight)가 담당.
      void runTurn(db, agents, agent, row, teamContext, explicitCaller)
        .catch((e) => appendAuditFile(targetAgentId, "b3os_native_turn_rejected", row.message_id, { error: String(e) }))
        .finally(() => inFlight.delete(key));

      return { ok: true, detail: "b3os_native_dispatched" };
    },
  };
}

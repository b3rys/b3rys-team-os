/**
 * codex runtime — WakeAdapter.
 *
 * 디스패처가 wake()를 부르면 OpenAI Codex CLI(`codex exec`)를 에이전트 워크스페이스(cwd)에서 돌려 답을 만들고
 * 버스에 게시한다. 페르소나는 cwd의 AGENTS.md 자동로드(=룰로딩 블록이 그대로 두뇌 컨텍스트).
 *
 * 구조는 b3os_native 어댑터와 동일(lease-safe async detach · in-flight 잠금 · at-most-once 게시).
 * 차이: 두뇌가 API가 아니라 codex CLI(cwd 기반). 채널 발신(텔레그램/슬랙 visible 게시)은 채널 레이어가 담당(M2).
 */
import type { Database } from "bun:sqlite";
import type { AgentRecord, CodexSandboxMode } from "../../types";
import type { PendingDispatchRow, WakeAdapter, WakeResult } from "../../bus/types";
import { insertMessage, findRecentDuplicate } from "../../db/inboxQueries";
import { appendAudit } from "../../db/queries";
import { appendAuditFile } from "../../lib/auditFile";
import { buildDedupeKey } from "../../../shared/envelopeSchema";
import { isAgentOff } from "../../lib/agentControl";
import { clearRuntimeBlock, recordRuntimeBlock } from "../../lib/runtimeBlocks";
import { runCodexTurn, type CodexCaller } from "./runner";
import { makeAppServerCaller } from "./appServerRunner";
import type { PermissionContext } from "../../lib/permissionGate";
import { CodexTurnEnvelopeBuilder } from "./envelope";
import { codexRuntimePreflight, codexConfiguredGrants } from "./permissions";
import {
  CODEX_SURFACE_TEAM_BUS,
  CodexInflightStore,
  CodexRunArtifactStore,
  CodexSessionStore,
  sha256Short,
} from "./state";
import { steerActiveTurn } from "./activeTurns";
import { isTestRun } from "./appServerPopup";

const inFlight = new Set<string>();

function codexSandboxFor(agent: AgentRecord): CodexSandboxMode {
  return agent.codex_sandbox ?? "read-only";
}

function codexHomeFor(agent: AgentRecord): string | undefined {
  const home = process.env.HOME?.trim();
  return home ? `${home}/.codex-agents/${agent.id}` : undefined;
}

/** 테스트/관측용: 현재 처리 중인 턴 수. */
export function inFlightCount(): number {
  return inFlight.size;
}

export interface CodexAdapterDeps {
  /** 테스트 주입용 codex 호출 함수. 기본 = 실제 runCodexTurn. */
  callCodex?: CodexCaller;
  permissionContext?: PermissionContext;
  sessionStore?: CodexSessionStore;
  artifactStore?: CodexRunArtifactStore;
  inflightStore?: CodexInflightStore;
  /** ★답이 안 갔을 때 같은 세션에 재촉 1회.★ 기본: 라이브 켬 / 시험 끔(가드 시험이 호출 수를 센다). */
  nudgeOnUnsentReply?: boolean;
  envelopeBuilder?: CodexTurnEnvelopeBuilder;
}

/**
 * ★재촉 턴의 요청문.★ 같은 스레드·같은 세션을 이어가되 goal 만 바꾼다.
 * 버스에는 아무것도 안 들어간다 — 이건 서버가 그 팀원에게 직접 거는 한 턴이다.
 */
export const NUDGE_PROMPT = [
  "[미전송] 직전 턴의 답이 ★팀에 도착하지 않았다.★ 턴은 끝났는데 send.sh 를 실행하지 않았다.",
  "지금 ★그 답을 보내라.★ 새로 조사하지 말고, 이미 정리한 내용을 그대로 보내면 된다.",
].join("\n");

/**
 * ★그 팀원이 이 스레드에 실제로 무언가 보냈는가.★ (턴 시작 이후)
 * 서버가 대신 말하지 않기로 한 이상, ★안 보낸 것을 알아채는 장치★ 는 따로 있어야 한다.
 */
export function agentRepliedSince(db: Database, agentId: string, threadId: string, sinceUtc: string): boolean {
  try {
    const r = db
      .prepare(`SELECT 1 FROM message WHERE from_agent_id = ? AND thread_id = ? AND created_at >= ? LIMIT 1`)
      .get(agentId, threadId, sinceUtc);
    return Boolean(r);
  } catch {
    return true; // 조회 실패로 ★거짓 경고★ 를 내지 않는다
  }
}

/**
 * ★그 팀원이 ★이 요청에 대한 답★ 을 보냈나.★ (턴 시작 이후)
 *
 * `agentRepliedSince` 와 ★묻는 질문이 다르다★ — 저쪽은 "이 스레드에 뭐라도 보냈나" 이고,
 * 받는 사람도 그게 답인지도 안 본다. ★재촉 억제에는 그 폭이 안전하다★(오탐 = 재촉 한 번 안 함).
 * ★실패통지 억제에서는 오탐 비용이 뒤집힌다★ — 요청자가 ★답도 실패통지도 못 받는다.★
 *
 * 실제로 나는 오탐(빌 리뷰): 수집 fan-out 은 규칙상 ★같은 스레드★ 로 나간다. dex 가 그 스레드로
 * 팀원들에게 질문을 뿌린 뒤 턴이 빈 최종텍스트로 죽으면, 넓은 판정은 ★그 질문들을 '답' 으로 읽고★
 * 통지를 접는다 → 요청자는 영영 기다린다. ack 도 같은 모양이다.
 *
 * 그래서 ★요청자에게 갔거나(to), 그 요청에 달렸거나(in_reply_to)★ 만 답으로 센다.
 * 조회가 실패하면 ★false★ — ★모르면 알린다.★ (여기서 true 면 죽은 턴이 통째로 침묵이 된다)
 */
export function agentAnsweredRequest(
  db: Database,
  agentId: string,
  row: { message_id: string; thread_id: string; from_agent_id?: string | null },
  sinceUtc: string,
): boolean {
  try {
    const r = db
      .prepare(
        `SELECT 1 FROM message
           WHERE from_agent_id = ? AND created_at >= ?
             AND (in_reply_to = ? OR (thread_id = ? AND to_agent_id = ?))
           LIMIT 1`,
      )
      .get(agentId, sinceUtc, row.message_id, row.thread_id, row.from_agent_id ?? "");
    return Boolean(r);
  } catch {
    return false; // ★모르면 알린다★ — 조회 실패가 침묵으로 바뀌면 안 된다
  }
}

/**
 * ★진행 중 턴에 끼워 넣을 문장.★ 새 턴의 봉투를 통째로 넣지 않는다 —
 * 지금 하던 일의 맥락을 유지한 채 ★사람이 끼어든 말★ 로 읽히게 짧게 준다.
 */
export function buildSteerText(row: { from_agent_id?: string | null; body: string; message_id: string; thread_id: string }): string {
  const who = row.from_agent_id ?? "team lead";
  return [
    `[중간 메시지 — ${who}]`,
    row.body,
    "",
    `(thread=${row.thread_id} · in-reply-to=${row.message_id})`,
    "이 말을 반영해서 계속하라. 답할 때는 이 메시지에도 답해라.",
  ].join("\n");
}

/** 비동기 턴 — codex 호출 → 최종답 1회 게시. detach라 throw가 위로 안 감(자체 에러처리). */
export async function runTurn(
  db: Database,
  agents: () => AgentRecord[],
  agent: AgentRecord,
  row: PendingDispatchRow,
  teamContext: string,
  callCodex: CodexCaller,
  stores: {
    sessionStore: CodexSessionStore;
    artifactStore: CodexRunArtifactStore;
    inflightStore: CodexInflightStore;
    envelopeBuilder: CodexTurnEnvelopeBuilder;
    permissionContext?: PermissionContext;
  } = {
    sessionStore: new CodexSessionStore(db),
    artifactStore: new CodexRunArtifactStore(db),
    inflightStore: new CodexInflightStore(db),
    envelopeBuilder: new CodexTurnEnvelopeBuilder(db),
  },
  /**
   * ★답이 안 갔을 때 같은 세션에 재촉 1회를 걸지★ (기본 꺼짐).
   *
   * 기본을 끈 이유: 기존 시험들은 "턴당 codex 호출 1회" 를 전제로 가드를 세워놨다.
   * 켠 채로 두면 그 가드들이 재촉 호출까지 세면서 깨진다 — ★가드를 약하게 만들지 않는다.★
   * ★라이브(wake 경로)에서만 켠다.★ 재촉 동작 자체는 별도 시험이 덮는다.
   */
  nudgeOnUnsentReply = false,
): Promise<void> {
  const targetAgentId = agent.id;
  const conversationKey = row.thread_id;
  const taskId = taskIdFromRow(row);
  try {
    const turnStartedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    stores.inflightStore.mark(row.message_id, targetAgentId, row.thread_id);
    const priorSessionId = stores.sessionStore.get(targetAgentId, CODEX_SURFACE_TEAM_BUS, conversationKey);
    const sandbox = codexSandboxFor(agent);
    const preflight = codexRuntimePreflight(db, agent, sandbox, agent.codex_network_access ?? undefined, stores.permissionContext);
    if (preflight) {
      recordRuntimeBlock(targetAgentId, `codex permission blocked: ${preflight.rule} ${preflight.reason}`);
      appendAuditFile(targetAgentId, "codex_permission_blocked", row.message_id, preflight);
      stores.artifactStore.record({
        agentId: targetAgentId,
        messageId: row.message_id,
        threadId: row.thread_id,
        taskId,
        codexSessionId: priorSessionId ?? null,
        status: "failed",
        detail: `permission_${preflight.tier}:${preflight.rule}`,
        artifact: {
          surface: CODEX_SURFACE_TEAM_BUS,
          conversation_key: conversationKey,
          permission: preflight,
        },
      });
      postFailureNotice(db, agents, agent, row, `permission_${preflight.tier}:${preflight.rule}`);
      return;
    }
    const envelope = stores.envelopeBuilder.buildForBus({
      agent,
      row,
      teamContext,
      sandbox,
      networkAccess: agent.codex_network_access ?? undefined,
    });
    const prompt = stores.envelopeBuilder.toPrompt(envelope);
    stores.artifactStore.record({
      agentId: targetAgentId,
      messageId: row.message_id,
      threadId: row.thread_id,
      taskId,
      codexSessionId: priorSessionId ?? null,
      status: "started",
      artifact: {
        surface: CODEX_SURFACE_TEAM_BUS,
        conversation_key: conversationKey,
        envelope_hash: sha256Short(prompt),
        resume_used: Boolean(priorSessionId),
      },
    });
    const result = await callCodex({
      agentId: agent.id, // ★정체 명시★ — 팀원 스크립트가 tmux 세션으로 추측하지 않게
      cwd: agent.workspace_path ?? undefined,
      codexHome: codexHomeFor(agent),
      prompt,
      sandbox,
      networkAccess: agent.codex_network_access ?? undefined,
      writableRoots: agent.workspace_path ? [agent.workspace_path] : [],
      model: agent.model_id ?? undefined,
      resumeSessionId: priorSessionId,
    });
    if (!result.ok || !result.reply) {
      // ★답이 이미 나갔는데 "실패했다" 고 알리지 않는다.★ (2026-08-20 실측)
      //   팀원이 턴 안에서 팀버스 도구로 직접 답하면 런타임이 돌려주는 최종 텍스트는 비어 있다.
      //   그 턴을 실패로만 읽으면 ★요청자는 답을 받아 놓고 실패 통지를 함께 받는다★ — 같은 일을
      //   두 번 시키게 된다(실측: 답 03:32:22 도착 · 실패 통지 03:32:24, 재발송 아님).
      //   ★조용히 성공으로 바꾸지도 않는다★ — 최종 텍스트가 빈 것은 여전히 사실이라 기록에는 남긴다.
      const deliveredBySelf = agentAnsweredRequest(db, targetAgentId, row, turnStartedAt);
      recordRuntimeBlock(targetAgentId, `codex runtime failed: ${result.detail}`);
      appendAuditFile(targetAgentId, "codex_error", row.message_id, { detail: result.detail, delivered_by_self: deliveredBySelf });
      stores.artifactStore.record({
        agentId: targetAgentId,
        messageId: row.message_id,
        threadId: row.thread_id,
        taskId,
        codexSessionId: result.sessionId ?? priorSessionId ?? null,
        status: /timeout/i.test(result.detail) ? "timed_out" : "failed",
        elapsedMs: result.elapsedMs,
        // 통지를 접은 이유가 기록에 남아야 한다 — 안 남기면 '통지가 왜 없지' 를 다음 사람이 다시 판다.
        detail: deliveredBySelf ? `${result.detail} (notice_suppressed: agent_replied_on_bus)` : result.detail,
        artifact: {
          surface: CODEX_SURFACE_TEAM_BUS,
          conversation_key: conversationKey,
        },
      });
      if (!deliveredBySelf) postFailureNotice(db, agents, agent, row, result.detail);
      return;
    }
    if (result.sessionId) {
      stores.sessionStore.save({
        agentId: targetAgentId,
        surface: CODEX_SURFACE_TEAM_BUS,
        conversationKey,
        codexSessionId: result.sessionId,
        lastMessageId: row.message_id,
        lastTaskId: taskId ?? null,
      });
    }
    clearRuntimeBlock(targetAgentId);

    // ★같은 판정을 세 어댑터가 복붙하고 있었다★ (hermes · codex_cli · b3os_native).


    //   그래서 hermes 만 고치면 ★나머지 둘은 그대로 샜다.★ ★"관측 안 된 곳은 안 터진 게 아니라 안 본 것"★


    //   (dex·native 는 collector 로 안 써봤을 뿐이다. 쓰는 순간 똑같이 샌다 — Steve 2026-07-13)


    //   → ★판정은 bus/replyTarget.ts 한 곳에서만 한다.★


    // ★[B] — 서버는 팀원 대신 말하지 않는다.★
    //   예전엔 codex CLI 의 stdout 을 받아 ★서버가 버스에 "codex 가 말했다" 로 넣었다★ —
    //   ★dex 가 쓴 "[NO_REPLY]" 가 버스에 그대로 실렸다.★ (2026-07-13 수트 실측)
    //   ★이제 턴 본문은 메모다.★ 말하려면 dex 가 직접 POST /team/api/inbox 로 보낸다
    //   (오늘 수트에서 dex 가 이미 send.sh 로 팬아웃을 했다 — ★능력은 이미 있다★).
    appendAuditFile(targetAgentId, "turn_completed_no_autopost", row.message_id, {
      thread_id: row.thread_id, chars: result.reply.length,
    });

    // ★답이 팀에 도착했는지 확인한다 — 대신 말하지는 않는다.★ (2026-08-12)
    //   위 규칙(서버는 팀원 대신 말하지 않는다)은 그대로다. 다만 ★안 보낸 것을 아무도 모르는 것★ 은
    //   다른 문제다. 하루에 3건이 관측됐다: 답 없음 / 착수확인만 / 전송 0건.
    //   턴은 succeeded 였고 로그도 조용해서, 사람이 물어보기 전엔 아무도 몰랐다.
    //   → 도착 안 했으면 ★그 사실을 남기고 팀원 본인에게 한 번 알린다.★ 말은 본인이 한다.
    if (!agentRepliedSince(db, targetAgentId, row.thread_id, turnStartedAt)) {
      appendAuditFile(targetAgentId, "turn_completed_but_no_reply_sent", row.message_id, {
        thread_id: row.thread_id, chars: result.reply.length,
      });
      // ★runtimeBlock 을 쓰지 않는다★ — 그 칸은 '런타임이 막혔다' 는 뜻이고
      //   '성공 턴은 이전 블록을 지운다' 는 계약이 따로 있다(시험이 그걸 고정한다).
      //   여기 쓰면 그 계약과 싸운다. 사실만 남기고 로그로 드러낸다.
      console.error(`[codex] ${targetAgentId}: 턴은 끝났는데 ★답이 팀에 도착하지 않았다★ (thread=${row.thread_id}, msg=${row.message_id}, 본문 ${result.reply.length}자)`);
      // ★버스에는 아무것도 넣지 않는다★ — 서버가 한 마디도 하지 않는다는 계약(시험이 고정)을 지킨다.
      //   대신 ★같은 세션에서 한 턴 더 돌려★ 본인이 보내게 한다. 말은 여전히 본인이 한다.
      //   한 번만 한다(nudged 플래그) — 그 턴도 실패하면 또 도는 고리가 된다.
      // ★runTurn 을 다시 돌지 않는다★ — 그 경로에는 '한 요청 한 턴'·in-flight 잠금·아티팩트 계약이
      //   걸려 있어서 재진입하면 그 불변식들과 싸운다(시험 6건이 그걸 고정하고 있다).
      //   대신 ★같은 세션에 codex 호출만 한 번 더★ 건다. 버스에도 아무것도 안 넣는다.
      if (nudgeOnUnsentReply) {
        try {
          console.error(`[codex] ${targetAgentId}: 같은 세션에 재촉 1회 — 본인이 보내게 한다`);
          await callCodex({
            prompt: NUDGE_PROMPT,
            agentId: targetAgentId,
            cwd: agent.workspace_path ?? undefined,
            codexHome: codexHomeFor(agent),
            resumeSessionId: result.sessionId ?? priorSessionId ?? undefined,
          } as never);
        } catch { /* 재촉 실패가 원래 턴 결과를 바꾸지 않는다 */ }
      }
    }
    stores.artifactStore.record({
      agentId: targetAgentId,
      messageId: row.message_id,
      threadId: row.thread_id,
      taskId,
      codexSessionId: result.sessionId ?? priorSessionId ?? null,
      status: "succeeded",
      elapsedMs: result.elapsedMs,
      detail: result.detail,
      artifact: {
        surface: CODEX_SURFACE_TEAM_BUS,
        conversation_key: conversationKey,
      },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    recordRuntimeBlock(targetAgentId, `codex runtime failed: ${detail}`);
    appendAuditFile(targetAgentId, "codex_error", row.message_id, { error: detail });
    stores.artifactStore.record({
      agentId: targetAgentId,
      messageId: row.message_id,
      threadId: row.thread_id,
      taskId,
      status: "failed",
      detail,
      artifact: { surface: CODEX_SURFACE_TEAM_BUS, conversation_key: conversationKey },
    });
    postFailureNotice(db, agents, agent, row, detail);
  } finally {
    stores.inflightStore.clear(row.message_id, targetAgentId);
  }
}

/**
 * 턴이 죽었다는 사실을 ★시킨 사람에게★ 알린다. (codex 런타임 전용 — 이 파일 안에서만 쓴다)
 *
 * ★전에는 팀 리드(user)가 시킨 것만 알렸다.★ 팀원이 시킨 일이 죽으면 아무 신호가 없었다.
 *   2026-08-13 실측: dex 에게 위임한 4건이 승인창 5분 만료로 죽었는데 요청자에게 통지 0건이었고,
 *   요청자는 ★"dex 가 실행을 안 한다" 로 오진했다.★ 실패가 안 보이면 팀원으로 쓸 수 없다.
 *
 * ★가드를 지운 게 아니다★ — 그 가드가 막던 것은 "알리는 것" 이 아니라 ★"체인에 얹혀서 알리는 것"★ 이었다.
 *   예전 통지는 `in_reply_to` + `hop_count+1` 이라 체인 안에 들어갔고, 팀원 요청까지 열면
 *   hop 한도를 먹고 그게 다시 [전달 차단] 을 부른다. 그래서 통지를 ★체인 밖 모양★ 으로 바꾼 뒤 조건을 넓힌다.
 *   같은 4속성을 `wakeDispatcher.notifySenderOfBlock` 이 이미 쓰고 있다(그쪽은 루프가 안 난다):
 *     ① `source:"system"` — pingpong 검사는 source==='agent' 일 때만 돈다
 *     ② `in_reply_to` 없음 — parent 가 null = 체인 밖
 *     ③ `hop_count: 0` — hop 한도와 무관
 *     ④ dedupe 를 ★직접 SELECT★ 로 확인 — `insertMessage` 에 dedupe_key 만 넘기면 ★저장만 되고 안 막는다★
 *
 * 보내는 곳: 팀 리드가 시킨 것 → 그 방(기존 동작 유지) · 팀원이 시킨 것 → ★그 팀원에게만★ (방에 안 뿌린다)
 */
function postFailureNotice(
  db: Database,
  agents: () => AgentRecord[],
  agent: AgentRecord,
  row: PendingDispatchRow,
  reason?: string,
): void {
  const sender = row.from_agent_id;
  const fromLead = sender === "user";
  if (!fromLead) {
    // notifySenderOfBlock 과 같은 가드 — 자기 자신·플랫폼 발신·명부 밖에는 안 보낸다.
    if (!sender || sender === agent.id) return;
    if (sender === "system" || sender === "moderator") return;
    if (!agents().some((a) => a.id === sender)) return;
  }
  try {
    // ★플랫폼 공지는 팀원을 사칭하지 않는다★ (2026-07-13 — [B] 전환 중 발견)
    //   예전엔 from=<팀원>, source="agent" 로 넣어서 ★"그 팀원이 그렇게 말했다" 로 보였다.★
    //   ★그 팀원은 아무 말도 안 했다 — 턴이 죽은 것이다.★ 서버가 그의 입을 빌리면 안 된다.
    const why = reason ? ` (${reason.slice(0, 120)})` : "";
    const body = `⚠️ ${agent.display_name ?? agent.id} 의 응답이 실패했습니다${why}. 잠시 후 다시 시도해 주세요.`;
    // dedupe 는 ★받는 곳에 따라 기준이 다르다★ — 두 계약이 서로 다른 것을 막는다.
    // · 팀 리드 방(broadcast) = ★도배 방지★ 가 목적 → 본문 기준 60초 창(기존 계약 유지)
    //   · 팀원 1:1 = ★같은 실패를 두 번 안 알리기★ 가 목적 → ★message_id 기준★
    //     (본문 기준 60초를 쓰면 서로 다른 위임 두 건이 연속 실패했을 때 ★두 번째가 조용히 사라진다★)
    let dedupeKey: string;
    if (fromLead) {
      dedupeKey = buildDedupeKey("system", "broadcast", body);
      if (findRecentDuplicate(db, dedupeKey, 60)) return;
    } else {
      dedupeKey = `codex-fail-notice:${row.message_id}:${agent.id}`;
      // ★직접 SELECT★ — insertMessage 에 dedupe_key 만 넘기면 저장만 되고 막지는 않는다.
      if (db.prepare(`SELECT 1 FROM message WHERE dedupe_key = ? LIMIT 1`).get(dedupeKey)) return;
    }
    // ★모양도 받는 곳에 따라 다르다.★ 팀 리드 방은 기존 계약(hop 승계 · in_reply_to)을 그대로 둔다 —
    //   그 방의 통지는 원 메시지의 답으로 읽혀야 하고, hop 을 리셋하면 루프 차단선이 풀린다.
    //   팀원 1:1 은 ★체인 밖★ 이어야 한다(hop 0 · parent 없음). 그래야 통지가 hop 한도를 먹지 않고,
    //   그게 다시 [전달 차단] 을 부르는 연쇄가 생기지 않는다 — 이것이 예전에 팀원 통지를 막아둔 이유다.
    insertMessage(db, {
      thread_id: row.thread_id,
      from_agent_id: "system",
      to_agent_id: fromLead ? "broadcast" : sender,
      type: fromLead ? "broadcast" : "dm",
      body,
      source: "system",
      hop_count: fromLead ? row.hop_count + 1 : 0,
      ...(fromLead ? { in_reply_to: row.message_id } : {}),
      priority: "normal",
      dedupe_key: dedupeKey,
    });
  } catch {
    /* 통지 실패 무시 */
  }
}

function taskIdFromRow(row: PendingDispatchRow): string | undefined {
  try {
    const meta = row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : {};
    const value = meta.task_id ?? meta.taskId;
    if (typeof value === "string" && value.trim()) return value.trim();
  } catch {
    // Ignore malformed metadata.
  }
  return undefined;
}

export function makeCodexAdapter(
  db: Database,
  agents: () => AgentRecord[],
  deps: CodexAdapterDeps = {},
): WakeAdapter {
  // ★M6: B3OS_CODEX_APPSERVER=1 이면 app-server 런타임 사용(중간 인터럽트/steer+승인팝업 기반).★
  // 롤아웃 스위치(폴백 아님 — 제품 결정): 검증 전엔 exec, 검증 후 flag on. deps.callCodex가 최우선(테스트).
  // ★M5.3: flag on이면 db 주입한 app-server caller(ask→GD 팝업). flag off=exec. deps.callCodex 최우선(테스트).★
  // ★app-server 하나뿐이다.★
  //   플래그로 갈라두면 ★한쪽만 좋아지고 다른 쪽은 조용히 뒤처진다★ — 실제로 그랬다.
  const defaultCaller = makeAppServerCaller(db);
  const callCodex = deps.callCodex ?? defaultCaller;
  const stores = {
    sessionStore: deps.sessionStore ?? new CodexSessionStore(db),
    artifactStore: deps.artifactStore ?? new CodexRunArtifactStore(db),
    inflightStore: deps.inflightStore ?? new CodexInflightStore(db),
    envelopeBuilder: deps.envelopeBuilder ?? new CodexTurnEnvelopeBuilder(db),
    permissionContext: deps.permissionContext,
  };
  return {
    async wake(targetAgentId, row, teamContext): Promise<WakeResult> {
      const agent = agents().find((a) => a.id === targetAgentId);
      if (!agent) return { ok: false, detail: "unknown_codex_agent" };
      // off 명단 존중: codex 버스 어댑터는 in-process라 멈출 프로세스가 없으니, 디스패치 시 off면 응답 차단.
      // ok:true(no-retry) — 정지는 정상 상태지 실패 아님.
      if (isAgentOff(targetAgentId)) return { ok: true, detail: "codex_agent_off" };

      // ★동시성(concurrency) 잠금 = 팀원(agent) 단위 — 메시지(message_id) 단위가 아니다.★
      //   이유(Ames 교차검증 2026-07-24 + 코드 재검증): wake()는 아래서 runTurn을 detach(즉시 반환)하고,
      //   2026-07-16 dispatchRow '턴 완료까지 블록' 직렬화(wakeDispatcher)는 hermes/openclaw/claude만 커버하고
      //   ★codex는 빠져 있었다.★ 키가 message_id별이면 같은 agent에 '다른 메시지'가 오면 동시 턴 2개가 떠
      //   같은 Codex 세션을 동시 resume/기록 → 답 섞임·맥락 꼬임·중복 발신이 난다.
      //   → agent 단위 잠금으로 앞 턴이 끝날 때(아래 finally)까지 다음 턴을 defer(연기)해 '한 팀원=한 번에 한 턴'을 보장.
      //   (다른 런타임과 동일 계약. 공용 RuntimeTurnCoordinator 리팩터는 shared 코드라 별도 과제로 분리.)
      const key = targetAgentId;
      if (inFlight.has(key)) {
        // ★연기하기 전에 진행 중 턴에 끼워 넣어 본다.★
        //   연기만 하면 20번 뒤 blocked 로 ★메시지가 사라진다★ — 실측으로 확인했다.
        //   끼워 넣기에 성공하면 그 턴이 이어서 읽으므로 별도 턴이 필요 없다.
        const steered = await steerActiveTurn(targetAgentId, buildSteerText(row));
        if (steered) {
          appendAuditFile(targetAgentId, "codex_steered_into_turn", row.message_id, { thread_id: row.thread_id });
          return { ok: true, detail: "codex_steered" };
        }
        return { ok: true, deferred: true, detail: "codex_in_flight" };
      }
      inFlight.add(key);

      // ★관리자 설정(agents.json)을 grant로 seed(per-agent)★ — 미주입 시 preflight가 workspace-write/network를
      // 매 턴 tier-a "ask"로 차단해 버스 경로 Dex도 구조적 실행불가(2026-07-05 fix, 브릿지와 동일 근본).
      // ctx.workspaceRoot 미설정 → preflight가 agent.workspace_path 사용(per-agent 정확) + grant scope도 그에 맞춤.
      // deps.permissionContext 명시 시엔 그대로 존중. Tier-D는 이 grant로도 통과 못 함(hardDeny 우선).
      const turnStores = deps.permissionContext
        ? stores
        : {
            ...stores,
            permissionContext: {
              grants: codexConfiguredGrants(
                agent.id,
                codexSandboxFor(agent),
                agent.codex_network_access ?? undefined,
                agent.workspace_path,
              ),
            },
          };

      // lease-safe: 턴 detach, wake는 즉시 반환(claim-tick 블록 방지).
      void runTurn(db, agents, agent, row, teamContext, callCodex, turnStores, deps.nudgeOnUnsentReply ?? !isTestRun()).finally(() => inFlight.delete(key));
      return { ok: true, detail: "codex_dispatched" };
    },
  };
}

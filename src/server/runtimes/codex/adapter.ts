import { uiText } from "./uiStrings";
/** Codex 턴은 팀원 작업폴더의 규칙·설정으로 실행하며 wake를 즉시 반환하고 팀원 단위로 직렬화한다.
 * 턴 본문은 자동 게시하지 않고 명시적 발신을 사용한다. 채널 전달은 별도 레이어가 담당한다. */
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
  /** 답이 안 갔을 때 같은 세션에 재촉 1회. 기본: 라이브 켬 / 시험 끔(가드 시험이 호출 수를 센다). */
  nudgeOnUnsentReply?: boolean;
  envelopeBuilder?: CodexTurnEnvelopeBuilder;
}

/**
 * 재촉 턴의 요청문. 같은 스레드·같은 세션을 이어가되 goal 만 바꾼다.
 * 버스에는 아무것도 안 들어간다 — 이건 서버가 그 팀원에게 직접 거는 한 턴이다.
 */
export const NUDGE_PROMPT = [
  "[미전송] 직전 턴의 답이 ★팀에 도착하지 않았다.★ 턴은 끝났는데 send.sh 를 실행하지 않았다.",
  "지금 ★그 답을 보내라.★ 새로 조사하지 말고, 이미 정리한 내용을 그대로 보내면 된다.",
].join("\n");

/**
 * 그 팀원이 이 스레드에 실제로 무언가 보냈는가. (턴 시작 이후)
 * 서버가 대신 말하지 않기로 한 이상, 안 보낸 것을 알아채는 장치 는 따로 있어야 한다.
 */
export function agentRepliedSince(db: Database, agentId: string, threadId: string, sinceUtc: string): boolean {
  try {
    const r = db
      .prepare(`SELECT 1 FROM message WHERE from_agent_id = ? AND thread_id = ? AND created_at >= ? LIMIT 1`)
      .get(agentId, threadId, sinceUtc);
    return Boolean(r);
  } catch {
    return true; // 조회 실패로 거짓 경고 를 내지 않는다
  }
}

/** 같은 스레드의 발신만으로 답을 판정하면 fan-out·착수 확인이 실패 통지를 억제하므로 해당 요청과 수신자를 함께 확인한다.
 * 재촉 억제의 넓은 판정과 구분하며 조회 실패는 false로 두어 실제 실패가 침묵으로 끝나지 않게 한다. */
export function agentAnsweredRequest(
  db: Database,
  agentId: string,
  row: { message_id: string; thread_id: string; from_agent_id?: string | null },
  sinceUtc: string,
): boolean {
  try {
    const r = db
      .prepare(
        // in_reply_to를 단 fan-out도 있으므로 두 조회 갈래 모두 수신자를 제한한다.
        // 그룹으로 직접 보낸 정당한 답은 인정해야 답과 실패 통지가 함께 나가지 않는다.
        `SELECT 1 FROM message
           WHERE from_agent_id = ? AND created_at >= ?
             AND to_agent_id IN (?, 'broadcast')
             AND (in_reply_to = ? OR thread_id = ?)
           LIMIT 1`,
      )
      .get(agentId, sinceUtc, row.from_agent_id ?? "", row.message_id, row.thread_id);
    return Boolean(r);
  } catch {
    return false; // 모르면 알린다 — 조회 실패가 침묵으로 바뀌면 안 된다
  }
}

/**
 * 진행 중 턴에 끼워 넣을 문장. 새 턴의 봉투를 통째로 넣지 않는다 —
 * 지금 하던 일의 맥락을 유지한 채 사람이 끼어든 말 로 읽히게 짧게 준다.
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
  /** 미발신 재촉은 단일 호출을 전제한 시험을 유지하려고 기본 OFF로 둔다. 운영 wake 경로에서만 켜고 별도 시험으로 검증한다. */
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
      agentId: agent.id, // 정체 명시 — 팀원 스크립트가 tmux 세션으로 추측하지 않게
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
      // 도구로 직접 답한 턴은 최종 텍스트가 비어도 요청자에게 실패 통지를 중복 발송하지 않는다. 빈 최종 텍스트라는 실행 기록은 유지한다.
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

    // 수신자 판정은 bus/replyTarget.ts를 공유한다. 턴 본문은 자동 게시하지 않으며 팀원이 직접 HTTP 발신 경로로 보낸다.








    appendAuditFile(targetAgentId, "turn_completed_no_autopost", row.message_id, {
      thread_id: row.thread_id, chars: result.reply.length,
    });

    // 턴 성공과 실제 답장 전달은 별개이므로 미전송을 기록하고 본인에게 한 번 재촉한다. 서버가 답을 대신 게시하지 않는다.
    if (!agentRepliedSince(db, targetAgentId, row.thread_id, turnStartedAt)) {
      appendAuditFile(targetAgentId, "turn_completed_but_no_reply_sent", row.message_id, {
        thread_id: row.thread_id, chars: result.reply.length,
      });
      // runtimeBlock 을 쓰지 않는다 — 그 칸은 '런타임이 막혔다' 는 뜻이고
      //   '성공 턴은 이전 블록을 지운다' 는 계약이 따로 있다(시험이 그걸 고정한다).
      //   여기 쓰면 그 계약과 싸운다. 사실만 남기고 로그로 드러낸다.
      console.error(`[codex] ${targetAgentId}: 턴은 끝났는데 ★답이 팀에 도착하지 않았다★ (thread=${row.thread_id}, msg=${row.message_id}, 본문 ${result.reply.length}자)`);
      // 재촉은 같은 세션에서 한 번만 호출해 반복 실패 루프를 막는다.
      // runTurn 재진입은 잠금·아티팩트·한 요청 한 턴 계약과 충돌하므로 Codex 호출만 추가하고 자동 게시하지 않는다.
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

/** 사용자 요청 실패는 원래 방에, 팀원 요청 실패는 해당 요청자에게만 통지한다.
 * 팀원 통지는 system·부모 없음·hop 0으로 체인 밖에서 보내며 insertMessage 자체는 중복을 막지 않아 직접 조회로 중복을 막는다. */
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
    // 플랫폼 실패 공지는 팀원 발언으로 오인되지 않도록 system 신원으로 보낸다.
    const why = reason ? ` (${reason.slice(0, 120)})` : "";
    const body = uiText("codex_turn_failed",{agent:agent.display_name??agent.id,reason:why});
    // dedupe 는 받는 곳에 따라 기준이 다르다 — 두 계약이 서로 다른 것을 막는다.
    // · 팀 리드 방(broadcast) = 도배 방지 가 목적 → 본문 기준 60초 창(기존 계약 유지)
    //   · 팀원 1:1 = 같은 실패를 두 번 안 알리기 가 목적 → message_id 기준
    //     (본문 기준 60초를 쓰면 서로 다른 위임 두 건이 연속 실패했을 때 두 번째가 조용히 사라진다)
    let dedupeKey: string;
    if (fromLead) {
      dedupeKey = buildDedupeKey("system", "broadcast", body);
      if (findRecentDuplicate(db, dedupeKey, 60)) return;
    } else {
      dedupeKey = `codex-fail-notice:${row.message_id}:${agent.id}`;
      // 직접 SELECT — insertMessage 에 dedupe_key 만 넘기면 저장만 되고 막지는 않는다.
      if (db.prepare(`SELECT 1 FROM message WHERE dedupe_key = ? LIMIT 1`).get(dedupeKey)) return;
    }
    // 사용자 방 통지는 원 메시지의 답·hop을 승계해 루프 차단선을 유지한다.
    // 팀원 1:1 통지는 부모 없는 hop 0으로 보내 통지 자체가 원래 체인의 hop을 소모하지 않게 한다.
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
  // M6: B3OS_CODEX_APPSERVER=1 이면 app-server 런타임 사용(중간 인터럽트/steer+승인팝업 기반).
  // 롤아웃 스위치(폴백 아님 — 제품 결정): 검증 전엔 exec, 검증 후 flag on. deps.callCodex가 최우선(테스트).
  // M5.3: flag on이면 db 주입한 app-server caller(ask→GD 팝업). flag off=exec. deps.callCodex 최우선(테스트).
  // app-server 하나뿐이다.
  //   플래그로 갈라두면 한쪽만 좋아지고 다른 쪽은 조용히 뒤처진다 — 실제로 그랬다.
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

      // wake가 턴을 분리하므로 다른 메시지도 같은 팀원 세션을 동시에 resume할 수 있다. 팀원 단위 잠금으로 앞 턴 종료까지 연기해 답·맥락 혼선을 막는다.
      const key = targetAgentId;
      if (inFlight.has(key)) {
        // 연기하기 전에 진행 중 턴에 끼워 넣어 본다.
        //   연기만 하면 20번 뒤 blocked 로 메시지가 사라진다 — 실측으로 확인했다.
        //   끼워 넣기에 성공하면 그 턴이 이어서 읽으므로 별도 턴이 필요 없다.
        const steered = await steerActiveTurn(targetAgentId, buildSteerText(row));
        if (steered) {
          appendAuditFile(targetAgentId, "codex_steered_into_turn", row.message_id, { thread_id: row.thread_id });
          return { ok: true, detail: "codex_steered" };
        }
        return { ok: true, deferred: true, detail: "codex_in_flight" };
      }
      inFlight.add(key);

      // 관리자 설정을 팀원별 grant로 시드하되 명시적으로 주입한 permissionContext는 보존한다.
      // workspaceRoot가 없으면 해당 팀원의 작업폴더를 사용하며, 이 grant로도 hardDeny를 우회하지 않는다.
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

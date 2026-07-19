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
  envelopeBuilder?: CodexTurnEnvelopeBuilder;
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
): Promise<void> {
  const targetAgentId = agent.id;
  const conversationKey = row.thread_id;
  const taskId = taskIdFromRow(row);
  try {
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
      postFailureNotice(db, agent, row);
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
      recordRuntimeBlock(targetAgentId, `codex runtime failed: ${result.detail}`);
      appendAuditFile(targetAgentId, "codex_error", row.message_id, { detail: result.detail });
      stores.artifactStore.record({
        agentId: targetAgentId,
        messageId: row.message_id,
        threadId: row.thread_id,
        taskId,
        codexSessionId: result.sessionId ?? priorSessionId ?? null,
        status: /timeout/i.test(result.detail) ? "timed_out" : "failed",
        elapsedMs: result.elapsedMs,
        detail: result.detail,
        artifact: {
          surface: CODEX_SURFACE_TEAM_BUS,
          conversation_key: conversationKey,
        },
      });
      postFailureNotice(db, agent, row);
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


    // ★[B] — 서버는 팀원 대신 말하지 않는다.★ (OWNER 2026-07-13: "팀원한테 맡겨. 다 빼.")
    //   예전엔 codex CLI 의 stdout 을 받아 ★서버가 버스에 "codex 가 말했다" 로 넣었다★ —
    //   ★dex 가 쓴 "[NO_REPLY]" 가 버스에 그대로 실렸다.★ (2026-07-13 수트 실측)
    //   ★이제 턴 본문은 메모다.★ 말하려면 dex 가 직접 POST /team/api/inbox 로 보낸다
    //   (오늘 수트에서 dex 가 이미 send.sh 로 팬아웃을 했다 — ★능력은 이미 있다★).
    appendAuditFile(targetAgentId, "turn_completed_no_autopost", row.message_id, {
      thread_id: row.thread_id, chars: result.reply.length,
    });
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
    postFailureNotice(db, agent, row);
  } finally {
    stores.inflightStore.clear(row.message_id, targetAgentId);
  }
}

/** 사용자 요청 실패 시에만 짧은 가시 통지 1회(에이전트 요청엔 안 보냄 — 루프 방지). dedupe로 스팸 차단. */
function postFailureNotice(db: Database, agent: AgentRecord, row: PendingDispatchRow): void {
  if (row.from_agent_id !== "user") return;
  try {
    // ★플랫폼 공지는 팀원을 사칭하지 않는다★ (2026-07-13 — [B] 전환 중 발견)
    //   예전엔 from=<팀원>, source="agent" 로 넣어서 ★"그 팀원이 그렇게 말했다" 로 보였다.★
    //   ★그 팀원은 아무 말도 안 했다 — 턴이 죽은 것이다.★ 서버가 그의 입을 빌리면 안 된다.
    //   (만료 통지·마감 알림이 이미 from="system" 인 것과 같은 원칙)
    const body = `⚠️ ${agent.display_name ?? agent.id} 의 응답이 실패했습니다. 잠시 후 다시 시도해 주세요.`;
    const dedupeKey = buildDedupeKey("system", "broadcast", body);
    if (findRecentDuplicate(db, dedupeKey, 60)) return;
    insertMessage(db, {
      thread_id: row.thread_id,
      from_agent_id: "system",
      to_agent_id: "broadcast",
      type: "broadcast",
      body,
      source: "system",
      hop_count: row.hop_count + 1,
      in_reply_to: row.message_id,
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
  // 롤아웃 스위치(폴백 아님 — OWNER 방침): 검증 전엔 exec, 검증 후 flag on. deps.callCodex가 최우선(테스트).
  // ★M5.3: flag on이면 db 주입한 app-server caller(ask→OWNER 팝업). flag off=exec. deps.callCodex 최우선(테스트).★
  const defaultCaller = process.env.B3OS_CODEX_APPSERVER === "1" ? makeAppServerCaller(db) : runCodexTurn;
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

      const key = `${row.message_id}:${targetAgentId}`;
      if (inFlight.has(key)) return { ok: true, deferred: true, detail: "codex_in_flight" };
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
      void runTurn(db, agents, agent, row, teamContext, callCodex, turnStores).finally(() => inFlight.delete(key));
      return { ok: true, detail: "codex_dispatched" };
    },
  };
}

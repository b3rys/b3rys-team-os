/** app-server를 CodexCaller로 제공하되 exec로 폴백하지 않는다. 준비·실행 오류는 ok:false로 반환해 실패 통지 경로에서 드러낸다.
 * 실행 경계는 Codex 설정·프로토콜로 정하며 런타임에 별도 판정층을 두지 않는다. */
import type { Database } from "bun:sqlite";
import { CodexAppServerClient, type ReviewDecision } from "./appServerClient";
import { requestApprovalPopup, PROCESS_INSTANCE } from "./appServerPopup";
import { CodexApprovalCorrelationStore } from "./state";
import { setActivityLine } from "../../db/queries";
import type { CodexCaller, CodexTurnResult, CodexTurnOptions } from "./runner";
import { registerActiveTurn, unregisterActiveTurn } from "./activeTurns";
import { acquireClient, dropClient } from "./clientPool";

/** 무응답 상한 600초는 Codex stream_idle_timeout_ms 기본 300초보다 길게 두어 자체 처리를 먼저 기다린다. 전체 작업 상한은 아니며 기존 env override는 유지한다.
 * 5회 재시도의 최악 침묵 약 1500초까지 보장하지 않는다. 재시도 중 진행 알림 여부는 미측정이며 timeout detail의 진행신호 수로 확인해야 한다.
 * 공식 설정에 턴 전체 상한이 없어 이 시계를 없애면 팀원 단위 직렬·공유 클라이언트의 멈춘 턴이 후속 작업을 계속 막을 수 있다. */
const TURN_TIMEOUT_MS = Number(process.env.B3OS_CODEX_APPSERVER_TIMEOUT_MS ?? 600_000);

/**
 * db 를 주입한 caller. db 는 승인이 아니라 턴 상관관계(orphan 정리) 용도로만 쓴다.
 * 옛 팝업 경로가 있던 자리 — 지금은 경계를 codex 설정이 정하므로 db 유무가 판정을 바꾸지 않는다.
 */
export function makeAppServerCaller(db: Database): CodexCaller {
  // Phase1 ③: 부팅/모드 활성 시 1회 orphan sweep — 이전 프로세스의 pending/decided 팝업을 orphaned로
  //   (재시작 후 옛 팝업이 새 turn에 재결합되지 않게). best-effort(스윕 실패가 caller 생성을 막지 않음).
  try { new CodexApprovalCorrelationStore(db).sweepOrphans(PROCESS_INSTANCE); } catch { /* best-effort */ }
  return (opts) => runViaAppServer(opts, db);
}

/** db 없는 기본 caller. 판정은 동일(codex 설정) — 턴 상관관계 정리만 안 한다. */
export const runCodexTurnViaAppServer: CodexCaller = (opts) => runViaAppServer(opts);

/** 최종 텍스트가 빈 완료는 성공과 다른 detail로 기록한다. 도구로 직접 발신하면 최종 텍스트가 비어도 답은 도착할 수 있어 실행 기록과 배달을 구분해야 한다. */
export function codexTurnDetail(status: string, finalText: string, detail?: string): string {
  const suffix = detail ? `: ${detail.slice(0, 300)}` : "";
  if (status === "completed") {
    // 완료 + 본문 있음 = 성공 / 완료 + 본문 없음 = 따로 이름을 가진 실패
    return finalText.trim().length > 0 ? "appserver_completed" : `appserver_completed_empty${suffix}`;
  }
  return `appserver_${status}${suffix}`;
}

/**
 * 클라이언트를 주입 가능하게 — startThread 에 실제로 무엇이 넘어가는지 재려면 대신 세울 자리가 필요하다.
 * opts 를 받는다 — 어느 팀원의 CODEX_HOME 으로 띄울지가 여기서 정해진다(안 넘기면 호스트 설정으로 돈다).
 */
export type AppServerClientFactory = (opts: CodexTurnOptions) => CodexAppServerClient;

/** 기본 팩토리 — 이 턴 주인의 CODEX_HOME 으로 app-server 를 띄운다(안 넘기면 호스트 설정으로 돈다). */
export const defaultAppServerClientFactory: AppServerClientFactory = (o) =>
  new CodexAppServerClient({ codexHome: o.codexHome });

export async function runViaAppServer(
  opts: CodexTurnOptions,
  db?: Database,
  makeClient: AppServerClientFactory = defaultAppServerClientFactory,
): Promise<CodexTurnResult> {
  const startedAt = nowMs();
  // cogs 정책이 깨졌거나 못 읽으면 넓혀서 돌지 않는다 — app-server 를 띄우지도 않는다.
  //   예전 권한으로 띄워 둔 app-server(살아 있는 서브 작업 포함)도 닫는다. 남기면 그 권한으로 계속 돈다.
  if (opts.cogsRun?.mode === "blocked") {
    dropClient(opts.agentId);
    return { ok: false, reply: "", detail: `cogs_policy_blocked: ${opts.cogsRun.reason}`.slice(0, 200), elapsedMs: 0 };
  }
  const run = runModeFor(opts);
  // 턴 뒤에도 서브에이전트가 살아 결과를 반환할 수 있도록 운영 클라이언트를 풀에 보존한다.
  // 주입한 시험 클라이언트는 다음 시험으로 상태가 새지 않도록 풀에 넣지 않는다.
  const pooled = makeClient === defaultAppServerClientFactory;
  const { client, reused } = pooled
    ? acquireClient(opts.agentId, () => makeClient(opts), run.poolKey)
    : { client: makeClient(opts), reused: false };
  // 팀원 ID는 로그·아티팩트·세션·승인 주인을 구분하므로 필수다. 기본 ID로 다른 실재 팀원의 기록을 만들지 않게 컴파일에서 누락을 막는다.
  try {
    if (!reused) await client.start(); // CLI 0.147.0은 모드 생략 시 readOnly·on-request이므로 thread/start·turn/start에 실행 모드를 명시한다. danger-full-access와 never는 다른 런타임과 같은 실행 모델을 위한 값이다.
// never는 사람 승인 단계를 만들지 않아 permissionGate·팝업·승인 기억 경로에 도달하지 않는다. on-request로 바꾸면 사람이 눌러야 하며 미응답은 약 300초 후 턴을 중단시킬 수 있다.
// 실행 범위를 좁힐 때는 sandbox를 사용한다. runtimeWorkspaceRoots는 experimentalApi가 필요해 턴 시작에 실패하므로 넘기지 않고 cwd를 사용한다.
    await client.startThread({
      cwd: opts.cwd,
      model: opts.model,
      resumeThreadId: opts.resumeSessionId, // resume ID로 멀티턴 맥락을 이어간다.
      approvalPolicy: run.approvalPolicy,
      sandbox: run.sandbox,
      approvalsReviewer: "user",
      ...(run.writableRoots ? { writableRoots: run.writableRoots } : {}),
      ...(run.networkAccess !== undefined ? { networkAccess: run.networkAccess } : {}),
    });
    const threadId = client.currentThreadId;
    // 진행 중 턴에 끼어들 수 있게 등록 — 이게 없으면 턴 도는 동안 온 메시지가 연기되다 사라진다
    //   (실측: 20번 연기 후 blocked. 턴도 답도 없었다.)
    registerActiveTurn(opts.agentId, client);
    const r = await client.runTurn(opts.prompt, {  // 그림은 아래 4번째 인자로 간다
      // 지금 무엇을 하는 중인지 보이게 한다. 창이 없는 런타임이라 이벤트로 직접 쓴다.
      onActivity: (line, itemId, item) => {
        // 두 수신처가 서로를 막지 않는다 — 대시보드 쓰기가 실패해도 채널 표시는 살고, 반대도 같다.
        if (db) {
          try { setActivityLine(db, opts.agentId, line); } catch { /* 표시가 턴을 막지 않는다 */ }
        }
        try { opts.onActivity?.(line, itemId, item); } catch { /* 채널 표시가 턴을 막지 않는다 */ }
      },
      onDelta: (text) => {
        try { opts.onDelta?.(text); } catch { /* Presentation does not interrupt the turn. */ }
      },
      onAnswerText: opts.onAnswerText ? (text) => {
        try { opts.onAnswerText?.(text); } catch { /* Presentation does not interrupt the turn. */ }
      } : undefined,
      onStatus: (line, item) => {
        try { opts.onStatus?.(line, item); } catch { /* 채널 표시가 턴을 막지 않는다 */ }
      },
      // 지금 이 콜백은 안 불린다 — 위에서 approvalPolicy 를 "never" 로 넘기므로 codex 가
      //   승인 요청을 보내지 않는다. 아래 코드와 appServerPopup 시험들은 도달하지 않는 상태 다.
      //   그 시험들이 계속 통과하는 것은 이 경로가 돈다는 뜻이 아니다.
      //   지우지 않는 이유: 되돌리기가 approvalPolicy 한 값이면 끝나야 한다.
      onApproval: async (req) => {
        // cogs 정책 팀원은 cogs 카드로만 묻는다. 처리기가 없거나 실패하면 거절(텔레그램 팝업·never 로 넘기지 않는다).
        if (opts.cogsRun?.mode === "enforced") {
          if (!opts.onCogsApproval) return "denied";
          try { return await opts.onCogsApproval(req); } catch { return "denied"; }
        }
        // Codex의 질문을 받으면 이 턴 주인의 방으로 전달하고 사람 결정을 반환한다. 자체 판정층·공용 op 방·고정 팀원 목적지를 사용하지 않는다.
        return db
          ? await requestApprovalPopup(db, req, opts.agentId, opts.cwd)
          : "denied"; // db 없는 caller 는 띄울 곳이 없다(테스트·도구 경로)
      },
    }, opts.timeoutMs ?? TURN_TIMEOUT_MS, opts.imagePaths);
    // Phase1 ③: 턴 종료 시 이 turn의 남은 pending/decided 팝업을 expire(cancel/interrupt/timeout 포함).
    //   늦게 도착한 승인은 finalizeApprovalDelivery의 CAS가 expired 상태를 보고 이미 거부하지만, 여기서 상태를
    //   확정 정리해 orphan 누적을 막는다. best-effort. (delivered/orphaned는 건드리지 않음.)
    if (db && threadId && r.turnId) {
      try { new CodexApprovalCorrelationStore(db).expireTurn(threadId, r.turnId); } catch { /* best-effort */ }
    }
    // 정상 완료한 프로세스만 재사용한다. 중단된 턴의 서브 작업이 남은 프로세스에 다음 턴을 넣으면 서로 간섭하므로 실패 시 폐기한다.
    if (pooled && r.status !== "completed") dropClient(opts.agentId);
    const ok = r.status === "completed" && (r.finalText.trim().length > 0 || opts.allowEmptyReply === true);
    // 실패 detail에 실제 오류 알림·stderr tail을 포함해 원인을 진단한다.
    const detail = codexTurnDetail(r.status, r.finalText, r.detail);
    return {
      ok,
      reply: r.finalText,
      sessionId: threadId ?? undefined,
      detail,
      elapsedMs: nowMs() - startedAt,
    };
  } catch (e) {
    // 에러로 끝난 프로세스는 치운다 — 반쯤 죽은 것을 다음 턴이 물려받으면 그 턴도 같이 죽는다.
    if (pooled) dropClient(opts.agentId);
    // 예외 정면 처리: 실패로 반환 → adapter가 실패통지(at-most-once 보존, 멈춤/유실 방지).
    return {
      ok: false,
      reply: "",
      detail: `appserver_error: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`,
      elapsedMs: nowMs() - startedAt,
    };
  } finally {
    // 턴이 끝나면 지운다 — 안 지우면 끝난 일을 계속 하고 있는 것처럼 보인다.
    if (db) { try { setActivityLine(db, opts.agentId, null); } catch { /* best-effort */ } }
    unregisterActiveTurn(opts.agentId, client);
    if (!pooled) client.close(); // 주입된 것은 우리가 만든 게 아니니 그 자리에서 닫는다
    // 풀에 있는 것은 닫지 않는다. 이 프로세스 안에서 서브에이전트가 아직 돌고 있을 수 있다.
    //   죽은 프로세스는 다음 턴에 acquireClient 가 알아서 새로 만든다.
  }
}

/**
 * 이번 턴의 실행 모드. cogs 정책이 적용된 팀원만 정책값을 쓰고, 나머지는 지금 그대로(never + danger-full-access).
 * poolKey 가 다르면 예전 app-server 를 다시 쓰지 않는다.
 */
export function runModeFor(opts: Pick<CodexTurnOptions, "cogsRun">): {
  approvalPolicy: string; sandbox: string; writableRoots?: string[]; networkAccess?: boolean; poolKey?: string;
} {
  const c = opts.cogsRun;
  if (c?.mode === "enforced") {
    return {
      approvalPolicy: c.approvalPolicy,
      sandbox: c.sandbox,
      ...(c.sandbox === "workspace-write" ? { writableRoots: c.writableRoots } : {}),
      ...(c.networkAccess !== undefined ? { networkAccess: c.networkAccess } : {}),
      poolKey: `cogs:${c.stamp}`,
    };
  }
  return { approvalPolicy: "never", sandbox: "danger-full-access" };
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

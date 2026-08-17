/**
 * M6 — app-server 기반 CodexCaller. 기존 adapter.runTurn(세션·at-most-once·reply·artifact 로직)에
 * ★caller만 갈아끼워★ dex가 app-server로 돌게 한다(runTurn 무변경 = 안전).
 *
 * GD 방침: exec 폴백 없음 → app-server 예외를 여기서 정면 처리(에러=ok:false로 실패통지 경로 태움).
 * ★승인 경계는 codex 설정(config.toml permission 프로파일)이 정한다★ — 우리 코드가 두 번째로 판정하지 않는다.
 * hermes·openclaw 와 같은 모양(자기 런타임 설정으로 자기 방에서 끝냄). ·08-12.
 */
import type { Database } from "bun:sqlite";
import { CodexAppServerClient, type ReviewDecision } from "./appServerClient";
import { requestApprovalPopup, PROCESS_INSTANCE } from "./appServerPopup";
import { CodexApprovalCorrelationStore } from "./state";
import { setActivityLine } from "../../db/queries";
import type { CodexCaller, CodexTurnResult, CodexTurnOptions } from "./runner";
import { registerActiveTurn, unregisterActiveTurn } from "./activeTurns";
import { acquireClient, dropClient } from "./clientPool";

const TURN_TIMEOUT_MS = Number(process.env.B3OS_CODEX_APPSERVER_TIMEOUT_MS ?? 300_000);

/**
 * db 를 주입한 caller. db 는 ★승인이 아니라★ 턴 상관관계(orphan 정리) 용도로만 쓴다.
 * 옛 팝업 경로가 있던 자리 — 지금은 경계를 codex 설정이 정하므로 db 유무가 판정을 바꾸지 않는다.
 */
export function makeAppServerCaller(db: Database): CodexCaller {
  // ★Phase1 ③: 부팅/모드 활성 시 1회 orphan sweep — 이전 프로세스의 pending/decided 팝업을 orphaned로
  //   (재시작 후 옛 팝업이 새 turn에 재결합되지 않게). best-effort(스윕 실패가 caller 생성을 막지 않음).★
  try { new CodexApprovalCorrelationStore(db).sweepOrphans(PROCESS_INSTANCE); } catch { /* best-effort */ }
  return (opts) => runViaAppServer(opts, db);
}

/** db 없는 기본 caller. 판정은 동일(codex 설정) — 턴 상관관계 정리만 안 한다. */
export const runCodexTurnViaAppServer: CodexCaller = (opts) => runViaAppServer(opts);

/**
 * ★클라이언트를 주입 가능하게★ — startThread 에 실제로 무엇이 넘어가는지 재려면 대신 세울 자리가 필요하다.
 * ★opts 를 받는다★ — 어느 팀원의 CODEX_HOME 으로 띄울지가 여기서 정해진다(안 넘기면 호스트 설정으로 돈다).
 */
export type AppServerClientFactory = (opts: CodexTurnOptions) => CodexAppServerClient;

/** 기본 팩토리 — ★이 턴 주인의 CODEX_HOME 으로★ app-server 를 띄운다(안 넘기면 호스트 설정으로 돈다). */
export const defaultAppServerClientFactory: AppServerClientFactory = (o) =>
  new CodexAppServerClient({ codexHome: o.codexHome });

export async function runViaAppServer(
  opts: CodexTurnOptions,
  db?: Database,
  makeClient: AppServerClientFactory = defaultAppServerClientFactory,
): Promise<CodexTurnResult> {
  const startedAt = nowMs();
  // ★프로세스를 턴보다 오래 살린다★ — spawn_agent 로 띄운 서브가 턴 종료 후에도 결과를 돌려준다.
  //   (실측 2026-08-12: 턴 끝에 닫아서 서브 3/4 가 완료 전에 죽었다.)
  // ★풀은 운영 관심사다★ — 클라이언트를 주입받은 경우(시험·측정)는 풀에 넣지 않는다.
  //   넣으면 한 시험의 가짜가 다음 시험으로 새어 나간다(실제로 2건이 그렇게 깨졌다).
  const pooled = makeClient === defaultAppServerClientFactory;
  const { client, reused } = pooled
    ? acquireClient(opts.agentId, () => makeClient(opts))
    : { client: makeClient(opts), reused: false };
  // ★이 턴이 누구인지는 계속 필수다★ — 승인 판정은 걷어냈지만 로그·아티팩트·세션이 전부 id 로 갈린다.
  //   전에는 "codex" 로 박혀 있었는데, 그건 ★실재하는 다른 팀원의 id★ 다(명부에 codex(openclaw)와
  //   dex(codex 런타임)가 따로 있다). 그래서 CodexTurnOptions.agentId 를 필수로 두어 컴파일이 막게 했다.
  try {
    if (!reused) await client.start(); // 살아있는 프로세스면 핸드셰이크를 다시 하지 않는다
    // ★codex 설정이 정하게 한다★.
    //
    //   여기서 sandbox·approvalPolicy 를 넘기면 ★CODEX_HOME 의 config.toml 을 덮어쓴다.★
    //   그러면 권한 프로필(파일 경로 deny 등)을 아무리 써놔도 효과가 없다 — 실측으로 확인했다:
    //     프로필만            → .env 읽기 차단됨
    //     + sandbox 를 넘기면  → 그냥 읽힘
    //
    //   ★runtimeWorkspaceRoots 도 빼야 한다.★ 그게 experimentalApi capability 를 요구해서
    //   지금 flag on 이 ★턴 시작도 못 하고 죽는 원인★ 이었다(2/2 재현). 실측 3종:
    //     전부 넘김 + caps null        → 거부(runtimeWorkspaceRoots requires experimentalApi)
    //     ★cwd 만 넘김 + caps null★    → 성공  ← 이 길로 간다
    //     roots + experimentalApi:true → 성공 (다른 길이지만 설정을 덮어쓰는 쪽으로 되돌아간다)
    //
    //   작업 폴더 범위는 cwd + config.toml 의 workspace_roots 가 정한다.
    await client.startThread({
      cwd: opts.cwd,
      model: opts.model,
      resumeThreadId: opts.resumeSessionId, // ★정확성 #1: 멀티턴 맥락 이어감(exec resume 동등)★
    });
    const threadId = client.currentThreadId;
    // ★진행 중 턴에 끼어들 수 있게 등록★ — 이게 없으면 턴 도는 동안 온 메시지가 연기되다 사라진다
    //   (실측: 20번 연기 후 blocked. 턴도 답도 없었다.)
    registerActiveTurn(opts.agentId, client);
    const r = await client.runTurn(opts.prompt, {
      // ★지금 무엇을 하는 중인지 보이게 한다.★ 창이 없는 런타임이라 이벤트로 직접 쓴다.
      onActivity: (line) => {
        if (!db) return;
        try { setActivityLine(db, opts.agentId, line); } catch { /* 표시가 턴을 막지 않는다 */ }
      },
      onApproval: async (req) => {
        // ★경계는 codex 설정이 정한다. 우리는 두 번째로 판정하지 않는다.★
        //   codex 가 물으면 그 물음을 ★그 팀원의 방★ 으로 옮기고, 사람이 누른 대로 돌려준다.
        //   판정은 codex 가, 전달만 우리가 한다. 터미널·앱에서 codex 를 쓸 때와 같은 모습이다.
        //
        //   전에는 여기서 judgeApproval 로 다시 판정하고, ask 면 ★op 방에 팝업★ 을 띄웠다.
        //   그게 두 가지를 동시에 망가뜨렸다:
        //     ① 팀원 승인이 ★op 방★ 에 떴다 — op 방은 시스템 알림 자리다.
        //        실측: permission_request 를 만든 팀원은 ★codex 런타임뿐★ (dex 5 · codex 4). 다른 팀원 0건.
        //        = 원래 사용성이 아니라 ★우리가 얹은 것★ 이었다.
        //     ② 사람이 안 누르면 턴이 끝나지 않아 ★dex 가 답을 못 했다.★
        //
        //   한때 여기서 무조건 거절한 적이 있다. 띄울 데가 없다는 이유였는데, 그건 옮겨온 게 아니라
        //   ★기능을 뺀 것★ 이었다 — 기본이 거절이면 승인창을 옮겨왔다고 할 수 없다.
        //
        //   목적지는 ★이 턴의 주인★ 에서 뽑는다. 상수로 박으면 다시 남의 방으로 간다.
        return db
          ? await requestApprovalPopup(db, req, opts.agentId, opts.cwd)
          : "denied"; // db 없는 caller 는 띄울 곳이 없다(테스트·도구 경로)
      },
    }, TURN_TIMEOUT_MS);
    // ★Phase1 ③: 턴 종료 시 이 turn의 남은 pending/decided 팝업을 expire(cancel/interrupt/timeout 포함).
    //   늦게 도착한 승인은 finalizeApprovalDelivery의 CAS가 expired 상태를 보고 이미 거부하지만, 여기서 상태를
    //   확정 정리해 orphan 누적을 막는다. best-effort. (delivered/orphaned는 건드리지 않음.)★
    if (db && threadId && r.turnId) {
      try { new CodexApprovalCorrelationStore(db).expireTurn(threadId, r.turnId); } catch { /* best-effort */ }
    }
    // ★정상 종료가 아니면 그 프로세스를 버린다.★ (2026-08-12 실측)
    //   상주로 바꾼 뒤 `appserver_interrupted` 가 났다 — 앞 턴의 서브에이전트가 아직 도는
    //   프로세스에 새 턴이 들어가면 서로 간섭한다. 재사용의 이득보다 ★턴 하나를 통째로 잃는★ 손해가 크다.
    //   완료된 턴만 프로세스를 남긴다(그 경우에만 서브가 안전하게 남는다).
    if (pooled && r.status !== "completed") dropClient(opts.agentId);
    const ok = r.status === "completed" && r.finalText.trim().length > 0;
    // ★#8 픽스: 실패면 detail에 실제 사유(에러 notification/stderr tail) 반영 — rate-limit 진단 가능.★
    const detail = ok ? "appserver_completed" : `appserver_${r.status}${r.detail ? `: ${r.detail.slice(0, 300)}` : ""}`;
    return {
      ok,
      reply: r.finalText,
      sessionId: threadId ?? undefined,
      detail,
      elapsedMs: nowMs() - startedAt,
    };
  } catch (e) {
    // ★에러로 끝난 프로세스는 치운다★ — 반쯤 죽은 것을 다음 턴이 물려받으면 그 턴도 같이 죽는다.
    if (pooled) dropClient(opts.agentId);
    // 예외 정면 처리: 실패로 반환 → adapter가 실패통지(at-most-once 보존, 멈춤/유실 방지).
    return {
      ok: false,
      reply: "",
      detail: `appserver_error: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`,
      elapsedMs: nowMs() - startedAt,
    };
  } finally {
    // 턴이 끝나면 지운다 — 안 지우면 ★끝난 일을 계속 하고 있는 것처럼★ 보인다.
    if (db) { try { setActivityLine(db, opts.agentId, null); } catch { /* best-effort */ } }
    unregisterActiveTurn(opts.agentId, client);
    if (!pooled) client.close(); // 주입된 것은 우리가 만든 게 아니니 그 자리에서 닫는다
    // ★풀에 있는 것은 닫지 않는다.★ 이 프로세스 안에서 서브에이전트가 아직 돌고 있을 수 있다.
    //   죽은 프로세스는 다음 턴에 acquireClient 가 알아서 새로 만든다.
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

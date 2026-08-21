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

/**
 * ★무응답 상한★ — 마지막 진행 신호 이후 이만큼 조용하면 그 턴을 끊는다(일한 시간이 아니다).
 *
 * ★300초가 아니라 600초인 이유★ (2026-08-20, dex 조사 · 빌 검산):
 * codex 자신의 보호도 ★같은 축(무수신)★ 이다 — `model_providers.<id>.stream_idle_timeout_ms` 기본 300초.
 * 우리 상한을 ★그와 같은 값★ 에 두면 codex 가 스스로 처리할 구간에서 우리가 먼저 끊는다.
 * 그래서 ★codex 자체 보호보다 길게★ 잡는다. 이름은 옛 env 를 그대로 둔다(운영 중 값 override 유지).
 *
 * ★단, 이 값이 codex 의 재시도 전체를 덮는다는 뜻은 아니다★ (빌 검산 — 내 처음 근거가 산술로 틀렸다):
 * `stream_max_retries` 기본 5회면 최악의 침묵 구간은 300×5 ≈ 1500초라 600초로는 못 덮는다.
 * ★갈림길은 "재시도 중에 우리에게 알림이 오는가" 하나다★ — 오면 시계가 리셋되니 300초로도 안 끊겼을 것이고,
 * 안 오면 600초도 부족하다. ★그걸 아직 안 쟀다.★ 앱서버 내부라 우리 코드로는 알 수 없다.
 * ★재는 법★: 재시도가 실제로 난 턴의 타임아웃 사유에 실리는 `진행신호 N건` 이 그대로 답이다.
 * 그 전까지 600 은 ★300보다 나은 값일 뿐, 충분하다고 주장하는 값이 아니다.★
 *
 * ★codex 에는 턴 전체 상한이 없다★(공식 Config Reference 에 turn_timeout 계열 키 없음) —
 * 즉 여기를 아예 없애면 멈춘 턴을 끊을 시계가 ★어디에도 없다.★ dex 는 턴이 팀원 단위로 직렬이고
 * app-server 클라이언트를 공유해서(`bridge.ts` 참조), 멈춘 턴이 남으면 ★그 팀원이 영구히 먹통★ 이 된다.
 */
const TURN_TIMEOUT_MS = Number(process.env.B3OS_CODEX_APPSERVER_TIMEOUT_MS ?? 600_000);

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
 * 턴 결과 detail 문자열. ★성공과 "완료했지만 최종 텍스트가 비었다" 는 다른 사건이다 — 다른 이름을 준다.★
 *
 * 2026-08-20 실측: dex 가 턴 안에서 팀버스 도구로 직접 답을 보내면 app-server 가 돌려주는 최종
 * 텍스트는 비어 있다. 그때 `ok=false` 인데 옛 식은 `appserver_${r.status}` = `appserver_completed`
 * 를 만들어 ★성공 detail 과 같은 문자열★ 이 됐다. 기록만 보고는 두 사건을 가를 수 없었다
 * (`codex_run_7a087419` status=failed detail=appserver_completed — 그 턴의 답은 정상 도착해 있었다).
 */
export function codexTurnDetail(status: string, finalText: string, detail?: string): string {
  const suffix = detail ? `: ${detail.slice(0, 300)}` : "";
  if (status === "completed") {
    // 완료 + 본문 있음 = 성공 / 완료 + 본문 없음 = ★따로 이름을 가진 실패★
    return finalText.trim().length > 0 ? "appserver_completed" : `appserver_completed_empty${suffix}`;
  }
  return `appserver_${status}${suffix}`;
}

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
    // ★실행 모드를 codex 프로토콜로 명시한다.★
    //
    //   ★안 넘기면 열리는 게 아니라 잠긴다.★ 실측(CLI 0.147.0 · 빈 CODEX_HOME · config 없음 ·
    //   thread/start 에 cwd·model 만 전달):
    //     → approvalPolicy "on-request" · sandbox { type: "readOnly" } · profile ":read-only"
    //   그래서 "우리 config 시딩만 지우면 codex 기본으로 열린다" 는 ★틀렸다.★ 명시해야 열린다.
    //
    //   sandbox 는 openclaw 가 넘기는 값과 같다(요구사항 파일 없음 → resolver 기본 mode=yolo):
    //     sandbox "danger-full-access" · approvalsReviewer "user"
    //     근거: openclaw config-fy-53tqM.js:269~272 · 279~282 · 306~309,
    //           thread-lifecycle-DSMv62L1.js:2224~2226 · 2402~2405
    //
    //   ★approvalPolicy 만 openclaw 와 다르게 "on-request" 다.★ 제품 결정: 위험한 실행은
    //   codex 가 판정해 물어보고, 그 물음을 채널로 옮겨 사람이 누른 대로 돌려준다.
    //   · "never" 는 승인 요청 자체를 보내지 않아 onApproval 이 한 번도 불리지 않는다.
    //   · sandbox 를 "workspace-write" 로 좁히면 샌드박스가 먼저 거부하고 모델이 승격을
    //     요청하지 않아 물어보는 단계가 사라진다(실측: docs/RUNTIME_ACCEPTANCE.md).
    //   즉 판정 단계가 살아있으려면 경계는 codex 가 쥐고 정책은 on-request 여야 한다.
    //
    //   ★이건 우리 승인 코드를 얹는 게 아니라 codex 정식 프로토콜로 실행 모드를 지정하는 것이다.★
    //   경계가 필요해지면 그때 codex 설정으로 넣는다 — 우리 판정층을 다시 만들지 않는다.
    //
    //   `runtimeWorkspaceRoots` 는 계속 안 넘긴다 — experimentalApi capability 를 요구해서
    //   넘기면 턴 시작도 못 하고 죽는다(2/2 재현). cwd 만으로 간다.
    await client.startThread({
      cwd: opts.cwd,
      model: opts.model,
      resumeThreadId: opts.resumeSessionId, // ★정확성 #1: 멀티턴 맥락 이어감(exec resume 동등)★
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    const threadId = client.currentThreadId;
    // ★진행 중 턴에 끼어들 수 있게 등록★ — 이게 없으면 턴 도는 동안 온 메시지가 연기되다 사라진다
    //   (실측: 20번 연기 후 blocked. 턴도 답도 없었다.)
    registerActiveTurn(opts.agentId, client);
    const r = await client.runTurn(opts.prompt, {  // 그림은 아래 4번째 인자로 간다
      // ★지금 무엇을 하는 중인지 보이게 한다.★ 창이 없는 런타임이라 이벤트로 직접 쓴다.
      onActivity: (line, itemId) => {
        // 두 수신처가 서로를 막지 않는다 — 대시보드 쓰기가 실패해도 채널 표시는 살고, 반대도 같다.
        if (db) {
          try { setActivityLine(db, opts.agentId, line); } catch { /* 표시가 턴을 막지 않는다 */ }
        }
        try { opts.onActivity?.(line, itemId); } catch { /* 채널 표시가 턴을 막지 않는다 */ }
      },
      onStatus: (line) => {
        try { opts.onStatus?.(line); } catch { /* 채널 표시가 턴을 막지 않는다 */ }
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
    }, TURN_TIMEOUT_MS, opts.imagePaths);
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
    const detail = codexTurnDetail(r.status, r.finalText, r.detail);
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

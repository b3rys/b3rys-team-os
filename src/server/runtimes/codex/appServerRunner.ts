/**
 * M6 — app-server 기반 CodexCaller. 기존 adapter.runTurn(세션·at-most-once·reply·artifact 로직)에
 * ★caller만 갈아끼워★ dex가 app-server로 돌게 한다(runTurn 무변경 = 안전).
 *
 * GD 방침: exec 폴백 없음 → app-server 예외를 여기서 정면 처리(에러=ok:false로 실패통지 경로 태움).
 * ★승인 경계는 codex 설정(config.toml permission 프로파일)이 정한다★ — 우리 코드가 두 번째로 판정하지 않는다.
 * hermes·openclaw 와 같은 모양(자기 런타임 설정으로 자기 방에서 끝냄). 팀 리드 2026-08-09·08-12.
 */
import type { Database } from "bun:sqlite";
import { CodexAppServerClient, type ReviewDecision } from "./appServerClient";
import { PROCESS_INSTANCE } from "./appServerPopup";
import { CodexApprovalCorrelationStore } from "./state";
import type { CodexCaller, CodexTurnResult, CodexTurnOptions } from "./runner";

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

/** ★클라이언트를 주입 가능하게★ — startThread 에 실제로 무엇이 넘어가는지 재려면 대신 세울 자리가 필요하다. */
export type AppServerClientFactory = () => CodexAppServerClient;

export async function runViaAppServer(
  opts: CodexTurnOptions,
  db?: Database,
  makeClient: AppServerClientFactory = () => new CodexAppServerClient(),
): Promise<CodexTurnResult> {
  const startedAt = nowMs();
  const client = makeClient();
  // ★이 턴이 누구인지는 계속 필수다★ — 승인 판정은 걷어냈지만 로그·아티팩트·세션이 전부 id 로 갈린다.
  //   전에는 "codex" 로 박혀 있었는데, 그건 ★실재하는 다른 팀원의 id★ 다(명부에 codex(openclaw)와
  //   dex(codex 런타임)가 따로 있다). 그래서 CodexTurnOptions.agentId 를 필수로 두어 컴파일이 막게 했다.
  try {
    await client.start();
    // ★codex 설정이 정하게 한다★ (팀 리드 2026-08-11: "codex 설정으로 돌게 해. 별도 우리 코드가 아닌").
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
    const r = await client.runTurn(opts.prompt, {
      onApproval: async (req) => {
        // ★경계는 codex 설정이 정한다. 우리는 두 번째로 판정하지 않는다.★ (GD 2026-08-09·08-12)
        //
        //   전에는 여기서 judgeApproval 로 다시 판정하고, ask 면 ★팀 리드 방에 팝업★ 을 띄웠다.
        //   그게 두 가지를 동시에 망가뜨렸다:
        //     ① 팀원 승인이 ★op 방★ 에 떴다 — op 방은 시스템 알림 자리다(GD: "팀원은 자기 방에 뜨지").
        //        실측: permission_request 를 만든 팀원은 ★codex 런타임뿐★ (dex 5 · codex 4). 다른 팀원 0건.
        //        = 원래 사용성이 아니라 ★우리가 얹은 것★ 이었다.
        //     ② 사람이 안 누르면 턴이 끝나지 않아 ★dex 가 답을 못 했다.★
        //
        //   hermes·openclaw 는 b3os 에 승인 배선이 ★아예 없다★ (런타임 디렉토리에 활성화 스크립트뿐).
        //   자기 설정으로 자기 방에서 끝낸다. codex 도 같은 모양으로 맞춘다.
        //
        // ★"다 허용" 이 아니다★ — 경계는 config.toml 의 permission 프로파일이 친다
        // (renderLockedDownCodexConfig: 작업 트리만 쓰기 · ~/.ssh·~/.aws · .env/*.key 류 deny).
        // `approval_policy = "never"` 라 codex 는 프로파일 밖을 ★묻지 않고 스스로 거절★ 한다.
        // 그래서 이 핸들러는 정상 설정에서는 ★호출조차 되지 않는다.★
        // 그럼에도 불려 왔다면 그 멤버 설정이 사람을 부르겠다고 한 것이고, 그 창구는 op 방이 아니라
        // ★그 팀원 방★ 이다 — 아직 없으므로 여기서 임의로 만들지 않고 codex 판단을 그대로 통과시킨다.
        //
        // ★조용히 넘기지는 않는다★ — 설정이 `never` 면 여기 안 온다. 왔다면 그 멤버 config.toml 이
        // 우리 seed 와 다르다는 뜻이라 로그로 드러낸다(조용한 통과 = 나중에 원인 못 찾는다).
        console.error(`[codex-appserver] ${opts.agentId}: codex 가 승인을 물었다(설정이 never 가 아님) → 통과: ${req.method}`);
        const decision: ReviewDecision = "approved";
        return decision;
      },
    }, TURN_TIMEOUT_MS);
    // ★Phase1 ③: 턴 종료 시 이 turn의 남은 pending/decided 팝업을 expire(cancel/interrupt/timeout 포함).
    //   늦게 도착한 승인은 finalizeApprovalDelivery의 CAS가 expired 상태를 보고 이미 거부하지만, 여기서 상태를
    //   확정 정리해 orphan 누적을 막는다. best-effort. (delivered/orphaned는 건드리지 않음.)★
    if (db && threadId && r.turnId) {
      try { new CodexApprovalCorrelationStore(db).expireTurn(threadId, r.turnId); } catch { /* best-effort */ }
    }
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
    // 예외 정면 처리: 실패로 반환 → adapter가 실패통지(at-most-once 보존, 멈춤/유실 방지).
    return {
      ok: false,
      reply: "",
      detail: `appserver_error: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`,
      elapsedMs: nowMs() - startedAt,
    };
  } finally {
    client.close();
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * M6 — app-server 기반 CodexCaller. 기존 adapter.runTurn(세션·at-most-once·reply·artifact 로직)에
 * ★caller만 갈아끼워★ dex가 app-server로 돌게 한다(runTurn 무변경 = 안전).
 *
 * GD 방침: exec 폴백 없음 → app-server 예외를 여기서 정면 처리(에러=ok:false로 실패통지 경로 태움).
 * 승인요청은 M3 judgeApproval로 permissionGate 판정(Tier-D 자동 denied). 팝업(M5) 전엔 ask=fail-closed denied.
 */
import type { Database } from "bun:sqlite";
import { CodexAppServerClient, type ReviewDecision } from "./appServerClient";
import { judgeApproval, resolveWithoutPopup, terminalGuidance } from "./appServerApproval";
import { requestApprovalPopup, PROCESS_INSTANCE } from "./appServerPopup";
import { CodexApprovalCorrelationStore } from "./state";
import type { CodexCaller, CodexTurnResult, CodexTurnOptions } from "./runner";
import type { PermissionAgent, PermissionContext } from "../../lib/permissionGate";

const TURN_TIMEOUT_MS = Number(process.env.B3OS_CODEX_APPSERVER_TIMEOUT_MS ?? 300_000);

/**
 * ★M5.3: db 있으면 팝업(ask→GD 텔레그램 승인), 없으면 fail-closed denied.★
 * makeAppServerCaller(db)로 db 주입 = 팝업 경로. runCodexTurnViaAppServer = db 없는 안전 기본.
 */
export function makeAppServerCaller(db: Database): CodexCaller {
  // ★Phase1 ③: 부팅/모드 활성 시 1회 orphan sweep — 이전 프로세스의 pending/decided 팝업을 orphaned로
  //   (재시작 후 옛 팝업이 새 turn에 재결합되지 않게). best-effort(스윕 실패가 caller 생성을 막지 않음).★
  try { new CodexApprovalCorrelationStore(db).sweepOrphans(PROCESS_INSTANCE); } catch { /* best-effort */ }
  return (opts) => runViaAppServer(opts, db);
}

/** db 없는 기본 caller(ask=fail-closed denied). 팝업 원하면 makeAppServerCaller(db) 사용. */
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
  // ★승인 요청에 실제 팀원 id 를 싣는다★ (팀 리드 2026-08-11: "dex 방에 떠야지").
  //
  //   전에는 id 를 "codex" 로 박아놨다. 그래서 permission_request 의 agent_id 가 전부 "codex" 였고,
  //   ★누구 요청인지 구분이 안 돼 팀원 방으로 보낼 수가 없었다.★ 전부 op 방으로 갔다.
  //   (그리고 "codex" 는 ★실재하는 다른 팀원의 id★ 다 — 명부에 codex(openclaw)와 dex(codex 런타임)가 따로 있다.
  //    허가증도 이 id 로 저장되니, 두 사람이 같은 서랍을 쓰고 있었다.)
  //
  //   앞 주석은 "Tier-D는 id 불필요" 라고 했는데 ★틀렸다★ — permissionGate.checkPermission 은
  //   id 가 없으면 예외를 던지고, Tier-D 판정은 그 뒤에 있다. id 없이는 도달조차 못 한다.
  const permAgent: PermissionAgent = {
    id: opts.agentId ?? "codex",
    workspace_path: opts.cwd ?? opts.writableRoots?.[0] ?? "",
  };
  const permCtx: PermissionContext = { workspaceRoot: opts.cwd ?? opts.writableRoots?.[0] ?? null };
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
    // ★F6 배선(하네스 재검증: terminalGuidance가 dead code였음): 차단된 exec의 '터미널 직접 안내'를 수집해
    // 최종 답변에 붙인다. 막다른 "차단됨" 대신 GD가 직접 실행할 수 있게(우리 규칙 Tier-D=GD 터미널만 정합).★
    const guidances: string[] = [];
    const r = await client.runTurn(opts.prompt, {
      onApproval: async (req) => {
        // ★승인요청 → permissionGate 판정. Tier-D=denied 확정. ask면: db 있으면 GD 팝업(M5.3), 없으면 fail-closed denied.★
        const j = judgeApproval(permAgent, req, permCtx);
        let decision: ReviewDecision;
        if (!j.needsApproval) {
          decision = j.decision ?? "denied"; // Tier-D deny 확정
        } else if (db) {
          decision = await requestApprovalPopup(db, req, permAgent.id, opts.cwd); // ★ask→GD 텔레그램 팝업★
        } else {
          decision = resolveWithoutPopup(j); // db 없음 → 안전 기본 denied
        }
        if (decision === "denied") {
          const g = terminalGuidance(req);
          if (g && !guidances.includes(g)) guidances.push(g);
        }
        return decision;
      },
    }, TURN_TIMEOUT_MS);
    // 차단 안내가 있으면 최종 답변에 덧붙임(작업 종류별 안내, 이미 포함된 안내는 중복 방지).
    const fresh = guidances.filter((g) => !r.finalText.includes(g.split("\n")[0]!));
    if (fresh.length) {
      r.finalText = r.finalText.trim() ? `${r.finalText}\n\n---\n${fresh.join("\n\n")}` : fresh.join("\n\n");
    }
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

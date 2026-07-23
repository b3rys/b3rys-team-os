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
import { requestApprovalPopup } from "./appServerPopup";
import type { CodexCaller, CodexTurnResult, CodexTurnOptions } from "./runner";
import type { PermissionAgent, PermissionContext } from "../../lib/permissionGate";

const TURN_TIMEOUT_MS = Number(process.env.B3OS_CODEX_APPSERVER_TIMEOUT_MS ?? 300_000);

/**
 * ★M5.3: db 있으면 팝업(ask→GD 텔레그램 승인), 없으면 fail-closed denied.★
 * makeAppServerCaller(db)로 db 주입 = 팝업 경로. runCodexTurnViaAppServer = db 없는 안전 기본.
 */
export function makeAppServerCaller(db: Database): CodexCaller {
  return (opts) => runViaAppServer(opts, db);
}

/** db 없는 기본 caller(ask=fail-closed denied). 팝업 원하면 makeAppServerCaller(db) 사용. */
export const runCodexTurnViaAppServer: CodexCaller = (opts) => runViaAppServer(opts);

async function runViaAppServer(opts: CodexTurnOptions, db?: Database): Promise<CodexTurnResult> {
  const startedAt = nowMs();
  const client = new CodexAppServerClient();
  // 승인 판정용 최소 agent/ctx (Tier-D는 id 불필요, 워크스페이스-write는 cwd 기준).
  const permAgent: PermissionAgent = { id: "codex", workspace_path: opts.cwd ?? opts.writableRoots?.[0] ?? "" };
  const permCtx: PermissionContext = { workspaceRoot: opts.cwd ?? opts.writableRoots?.[0] ?? null };
  try {
    await client.start();
    await client.startThread({
      cwd: opts.cwd,
      model: opts.model,
      // ★안전 F2 픽스(하네스 재검증 최우선): sandbox를 read-only로 하드 강제.★
      // 이유: workspace-write면 codex가 writable_roots 안의 파괴(rm·overwrite·git reset·훅 심기)를
      // 승인요청 없이 자체 실행 → 게이트에 안 옴 → Tier-D dead code → 게이트 전체 무력화(F2).
      // read-only면 모든 쓰기/실행이 escalation → 승인요청 → 게이트(F1: Tier-D deny 아니면 ask=거절).
      // ★쓰기 지원은 M5 팝업(GD 승인) 배선 후 별도 설계. 그 전엔 안전 우선으로 read-only 고정.★
      sandbox: "read-only",
      approvalPolicy: "on-request", // 모든 escalation을 승인요청으로(게이트가 보게)
      runtimeWorkspaceRoots: opts.writableRoots && opts.writableRoots.length ? opts.writableRoots : undefined,
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

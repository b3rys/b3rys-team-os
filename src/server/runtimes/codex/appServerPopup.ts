/**
 * M5 — codex app-server 승인요청 → GD 텔레그램 팝업(기존 승인 인프라 재사용).
 *
 * ★재빌드 아님:★ permissionGate.requestPermission(팝업 생성)+getPermissionRequest(상태) + telegramCapture(3버튼 렌더)
 * 를 재사용. onApproval이 ask면 여기서 팝업 띄우고 GD 결정을 폴링해 ReviewDecision으로 매핑한다.
 *
 * 매핑: allowed_once→approved · allowed_always→approved_for_session · denied/expired/timeout→denied.
 * ★안전: Tier-D는 여기 도달 전 judgeApproval에서 이미 denied(팝업 안 뜸). fail-closed: 에러/무응답→denied.★
 */
import type { Database } from "bun:sqlite";
import { requestPermission, getPermissionRequest, type PermissionOperation } from "../../lib/permissionGate";
import type { ApprovalRequest, ReviewDecision } from "./appServerClient";

const POPUP_TTL_MS = Number(process.env.B3OS_CODEX_APPSERVER_POPUP_TTL_MS ?? 60 * 60 * 1000); // 1h (GD: 무응답→hold)
const POLL_INTERVAL_MS = Number(process.env.B3OS_CODEX_APPSERVER_POLL_MS ?? 1500);

/** M5.1 — codex 승인요청 → PermissionOperation(requestPermission 입력). */
export function buildOperationFromApproval(req: ApprovalRequest, agentId: string, cwd?: string): PermissionOperation {
  const p = req.params as Record<string, any>;
  const provenance: Record<string, unknown> = {
    source: "appserver_approval",
    approval_method: req.method,
    call_id: p.callId ?? null,
    cwd: cwd ?? p.cwd ?? null,
    // ★provenance에 origin 표식(팝업 표시 하드닝·audit). taint 전체는 M3b 공용 layer로 확장.★
    input_origin: "codex_turn",
  };
  if (Array.isArray(p.command)) {
    return { runtime: "codex", agent_id: agentId, action: "shell", command: p.command.join(" ").slice(0, 2000), requested_by: agentId, provenance };
  }
  if (p.fileChanges && typeof p.fileChanges === "object") {
    // ★하네스 CRITICAL 1-B 픽스: scope_key(target)를 files[0]만이 아니라 '전체 파일집합(정렬)'으로 →
    // [a.ts,b.ts] 승인이 [a.ts,evil.sh]로 재사용되는 grant 우회 차단(다른 파일집합=다른 scope).★
    const files = Object.keys(p.fileChanges).sort();
    return { runtime: "codex", agent_id: agentId, action: "write", path: files.join("|").slice(0, 500), text: files.join(", ").slice(0, 500), requested_by: agentId, provenance };
  }
  return { runtime: "codex", agent_id: agentId, action: req.method.slice(0, 64), text: typeof p.reason === "string" ? p.reason.slice(0, 500) : undefined, requested_by: agentId, provenance };
}

/** M5.2 — permission_request 상태를 폴링해 GD 결정을 ReviewDecision으로. 무응답 TTL→denied(hold). */
export async function pollDecision(db: Database, requestId: string, ttlMs = POPUP_TTL_MS, intervalMs = POLL_INTERVAL_MS): Promise<ReviewDecision> {
  const deadline = Date.now() + ttlMs;
  for (;;) {
    let status: string | undefined;
    try {
      status = getPermissionRequest(db, requestId)?.status;
    } catch {
      return "denied"; // ★fail-closed: 조회 에러 → 거절★
    }
    switch (status) {
      case "allowed_once": return "approved";
      case "allowed_always": return "approved_for_session";
      case "denied":
      case "expired": return "denied";
      case undefined: return "denied"; // 요청 사라짐 = 거절
      // "pending" → 계속 폴링
    }
    if (Date.now() >= deadline) return "denied"; // ★1h 무응답 → hold(거절)★
    await sleep(intervalMs);
  }
}

/**
 * M5.3 진입점 — ask-tier 승인요청을 팝업으로 처리. onApproval에서 needsApproval일 때 호출.
 * ★반환 전까지 codex 턴이 대기하므로, 상위(runner)는 이 대기 동안 turn timeout을 연기해야 한다(M5.3 배선).★
 */
export async function requestApprovalPopup(db: Database, req: ApprovalRequest, agentId: string, cwd?: string, ttlMs = POPUP_TTL_MS): Promise<ReviewDecision> {
  let requestId: string | undefined;
  try {
    const op = buildOperationFromApproval(req, agentId, cwd);
    const res = requestPermission(db, op); // ★팝업 생성(telegramCapture가 렌더)★
    // requestPermission이 Tier-D면 deny로 즉시 반환(팝업 안 만듦) — 이중 안전.
    if (res.decision === "deny") return "denied";
    if (res.decision === "allow") return "approved"; // 이미 grant 있으면 통과
    requestId = res.request?.id;
  } catch {
    return "denied"; // ★fail-closed: 팝업 생성 실패 → 거절★
  }
  if (!requestId) return "denied";
  return pollDecision(db, requestId, ttlMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * M5 — codex app-server 승인요청 → GD 텔레그램 팝업(기존 승인 인프라 재사용).
 *
 * ★재빌드 아님:★ permissionGate.requestPermission(팝업 생성)+getPermissionRequest(상태) + telegramCapture(3버튼 렌더)
 * 를 재사용. onApproval이 ask면 여기서 팝업 띄우고 GD 결정을 폴링해 ReviewDecision으로 매핑한다.
 *
 * 매핑: allowed_once→approved · allowed_always→approved_for_session · denied/expired/timeout→denied.
 * ★안전: Tier-D는 여기 도달 전 judgeApproval에서 이미 denied(팝업 안 뜸). fail-closed: 에러/무응답→denied.★
 */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { requestPermission, getPermissionRequest, type PermissionOperation } from "../../lib/permissionGate";
import type { ApprovalRequest, ReviewDecision } from "./appServerClient";
import { CodexApprovalCorrelationStore } from "./state";

/** ★Phase1 ③: 이 서버 프로세스 인스턴스 id — 재시작 감지용(옛 팝업을 새 프로세스가 새 turn에 재결합 금지).★ */
export const PROCESS_INSTANCE = randomUUID();

/**
 * ★Phase1 ③: 승인 결정을 상관키 스토어 CAS로 마감해 안전 배달 여부를 정한다(순수 로직·테스트 가능).
 * - 거절류(denied/abort): decided+expire(중복 차단·grant 없음) 후 그대로 반환.
 * - 승인류(approved/approved_for_session): CAS pending→decided(중복 버튼=exactly-once) → delivered(operation_hash+process_instance 일치 시만).
 *   어느 단계든 실패=★fail-closed로 "denied"★(상관키 미기록·중복·불일치·orphan 전부 거부).
 *
 * ★범위 주의★: 여기서 operation_hash 비교가 막는 것은 ★다른 요청의 결정이 이 슬롯에 배달되는 것★이다.
 * 같은 요청의 작업이 승인 후 실행 직전에 바뀌는 것은 막지 못한다 — 비교 대상이 승인 ★전에 캡처한 같은 값★이기 때문.
 * (approvalOperationHash 주석의 '알려진 갭' 참조) */
export function finalizeApprovalDelivery(
  store: CodexApprovalCorrelationStore,
  requestId: string,
  operationHash: string,
  decision: ReviewDecision,
  processInstance: string = PROCESS_INSTANCE,
): ReviewDecision {
  if (decision === "denied" || decision === "abort") {
    store.markDecided(requestId); // 중복 버튼 차단(CAS)
    store.expire(requestId);      // 거절 = grant 없음 명시
    return decision;
  }
  if (!store.markDecided(requestId)) return "denied";                              // 미기록/이미처리 → fail-closed
  if (!store.markDelivered(requestId, operationHash, processInstance)) return "denied"; // 요청 불일치/orphan/재시작 → 거부
  return decision;
}

/** 승인 요청의 작업 지문(sha256 16hex) — 전체 command 배열 + 파일 ★이름★ 집합 + method + reason.
 *  용도는 하나뿐이다: 상관키 테이블/CAS가 ★결정↔요청을 1:1로 맞추는 것★(다른 요청의 결정이 이 슬롯에 배달되는 것을 막는다).
 *
 *  ★이 해시가 하지 ★않는★ 것 — 알려진 갭(2026-07-28 Codex·Bill 리뷰에서 확인, 재현 테스트는 아래 파일 참조):★
 *   1. ★권한 grant 재사용을 막지 못한다.★ grant scope는 permissionGate.scopeKeyForOperation이 따로 만들고
 *      그 안에 이 해시가 들어가지 않는다(permissionGate.ts에 operation_hash 참조 0건). scope의 target은
 *      ★앞 240자만★ 쓰므로(permissionGate.ts:216), 240자 prefix가 같고 뒤가 다른 두 작업은 ★같은 grant★로 취급된다.
 *      게다가 이미 grant가 있으면 requestApprovalPopup이 조기 반환해 상관키·CAS·finalize를 ★전부 건너뛴다★.
 *   2. ★승인 후 실행 직전의 변경을 잡지 못한다.★ 이 해시는 승인 ★전에 한 번★ 계산해 그 캡처값을 그대로
 *      finalize에 넘긴다 — 실행 직전에 다시 계산해 비교하지 않는다.
 *   3. ★같은 파일의 내용 변경을 구분하지 못한다.★ files는 Object.keys()라 ★이름만★ 담는다.
 *      command 경로는 배열 전체가 들어가 구분되지만, fileChanges 경로는 이름 집합이 같으면 해시가 같다.
 *
 *  → 위 3건은 후속 작업에서 다룬다(전체 canonical operation을 grant scope에 결합 + 실행 직전 재해시 +
 *     파일 내용 해시). ★그 전까지 B3OS_CODEX_APPSERVER를 켜지 않는다 — release blocker.★ */
export function approvalOperationHash(req: ApprovalRequest): string {
  const p = req.params as Record<string, any>;
  const basis = {
    method: req.method,
    command: Array.isArray(p.command) ? p.command : null,
    files: p.fileChanges && typeof p.fileChanges === "object" ? Object.keys(p.fileChanges).sort() : null,
    reason: typeof p.reason === "string" ? p.reason : null,
  };
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

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
    // 작업 지문 — ★audit/상관키 대조용으로만 기록된다.★ permissionGate는 이 값을 읽지 않으므로
    // ★grant scope에는 반영되지 않는다★(알려진 갭 — approvalOperationHash 주석 참조).
    operation_hash: approvalOperationHash(req),
  };
  if (Array.isArray(p.command)) {
    return { runtime: "codex", agent_id: agentId, action: "shell", command: p.command.join(" ").slice(0, 2000), requested_by: agentId, provenance };
  }
  if (p.fileChanges && typeof p.fileChanges === "object") {
    // scope_key(target)의 입력을 files[0]에서 '정렬된 전체 파일목록'으로 넓힌다.
    // ★단 target 절단 전까지만 구분력이 늘어날 뿐, '서로 다른 파일집합 → 서로 다른 scope'를 일반 보장하지 않는다.★
    // (여기서 500자, permissionGate.targetForOperation에서 240자로 잘린다.) 전체 결합은 미구현 — 이슈 #106.
    const files = Object.keys(p.fileChanges).sort();
    return { runtime: "codex", agent_id: agentId, action: "write", path: files.join("|").slice(0, 500), text: files.join(", ").slice(0, 500), requested_by: agentId, provenance };
  }
  // ★S0(#106) — 여기까지 왔다는 것은 payload 를 해석하지 못했다는 뜻이다. 그 사실을 명시한다.★
  //
  //  예전에는 action 에 req.method 를, text 에 reason 만 넣었다. reason 이 없으면 targetForOperation 이
  //  action 으로 떨어지므로 ★target = method 이름★ 이 되어 ★그 method 로 오는 모든 요청이 같은 scope★ 였다.
  //  → 한 번 allowed_always 를 받으면 이후 ★내용이 전혀 다른 요청도 팝업 없이 통과★ 한다.
  //  실측(2026-07-28): item/commandExecution/requestApproval 로 온 'rm -rf /tmp/x' 와 'cat ~/.ssh/id_rsa' 가
  //  ★같은 scope_key★ 를 가졌다.
  //
  //  ★팀 리드 원칙(2026-07-28): "애매하면 통과가 아니고 ask 로."★
  //  해석에 실패했으면 넓은 열쇠를 만들지 않는다 — payload 지문을 target 에 넣어 ★payload 가 다르면 열쇠도 다르게★ 한다.
  //  저장된 grant 는 자기와 똑같은 payload 에만 적용되고, 조금이라도 다르면 다시 사람에게 묻는다.
  //
  //  ※ ★실제 효과: 신세대 payload 는 itemId·turnId·startedAtMs 가 요청마다 달라서 사실상 매번 새 열쇠가 된다★
  //    = 해석 못 한 요청은 ★매번 묻는다★. 그게 이 단계가 노린 보수적 동작이다.
  //  ※ reason 을 text 에 남기는 이유: permissionGate.operationText 가 text 도 Tier-D 스캔에 쓴다.
  //    빼면 위험 문자열이 reason 에 있을 때 하드 차단이 약해진다.
  const reason = typeof p.reason === "string" ? p.reason.slice(0, 300) : "";
  return {
    runtime: "codex",
    agent_id: agentId,
    action: "approval_unparsed",
    text: `${req.method} #${unparsedPayloadDigest(req)}${reason ? ` ${reason}` : ""}`.slice(0, 500),
    requested_by: agentId,
    provenance,
  };
}

/** 해석하지 못한 요청을 ★받은 payload 전체★ 로 묶는 지문(sha256 16hex).
 *
 *  approvalOperationHash 를 쓰지 않는 이유: 그 basis 는 {method, command(배열만), files, reason} 라
 *  ★신세대 payload 를 하나도 담지 못한다★ — command 가 문자열이면 Array.isArray 가 false 라 null 이 되고,
 *  fileChanges 는 신세대에 아예 없다. 그래서 서로 다른 두 명령이 ★같은 지문★ 을 갖는다(테스트로 고정해 뒀다).
 *  해석에 실패한 마당에 '무엇이 중요한 필드인지' 를 고를 근거가 없으므로 ★전부★ 를 담는다.
 *
 *  키 순서에 흔들리지 않도록 재귀 정렬해 직렬화한다 — JSON.stringify 는 삽입 순서를 따르므로,
 *  같은 내용이 다른 순서로 오면 지문이 달라져 ★같은 작업에 열쇠가 두 개★ 생긴다. */
function unparsedPayloadDigest(req: ApprovalRequest): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => { acc[k] = stable((v as Record<string, unknown>)[k]); return acc; }, {});
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(stable({ method: req.method, params: req.params ?? null })))
    .digest("hex")
    .slice(0, 16);
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
  const store = new CodexApprovalCorrelationStore(db);
  const opHash = approvalOperationHash(req);
  let requestId: string | undefined;
  try {
    const op = buildOperationFromApproval(req, agentId, cwd);
    const res = requestPermission(db, op); // ★팝업 생성(telegramCapture가 렌더)★
    // requestPermission이 Tier-D면 deny로 즉시 반환(팝업 안 만듦) — 이중 안전.
    if (res.decision === "deny") return "denied";
    if (res.decision === "allow") return "approved"; // 이미 grant 있으면 통과(기존 grant는 permissionGate가 벤팅)
    requestId = res.request?.id;
  } catch {
    return "denied"; // ★fail-closed: 팝업 생성 실패 → 거절★
  }
  if (!requestId) return "denied";
  // ★Phase1 ③: 팝업↔app-server 요청 1:1 상관키 record(pending). best-effort — 미기록이면 finalize가 fail-closed.★
  const p = req.params as Record<string, any>;
  try {
    store.record({
      requestId, agentId,
      serverRequestId: req.serverRequestId ?? null,
      threadId: typeof p.threadId === "string" ? p.threadId : null,
      turnId: typeof p.turnId === "string" ? p.turnId : null,
      itemId: typeof p.itemId === "string" ? p.itemId : null,
      operationHash: opHash,
      processInstance: PROCESS_INSTANCE,
    });
  } catch { /* best-effort */ }
  const decision = await pollDecision(db, requestId, ttlMs);
  // ★결정을 CAS로 마감(중복 버튼·요청 불일치·orphan 거부) 후 반환. 실행 직전 변경 검출은 아님 — 위 갭 주석 참조.★
  return finalizeApprovalDelivery(store, requestId, opHash, decision);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

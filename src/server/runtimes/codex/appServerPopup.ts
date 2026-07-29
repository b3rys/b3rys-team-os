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
import type { ObservedFileChange } from "./appServerItemIndex";
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
 *      command 경로는 (배열이든 문자열이든) 전체가 들어가 구분되지만, fileChanges 경로는 이름 집합이 같으면 해시가 같다.
 *
 *  → 위 3건은 후속 작업에서 다룬다(전체 canonical operation을 grant scope에 결합 + 실행 직전 재해시 +
 *     파일 내용 해시). ★그 전까지 B3OS_CODEX_APPSERVER를 켜지 않는다 — release blocker.★ */
export function approvalOperationHash(req: ApprovalRequest): string {
  const p = req.params as Record<string, any>;
  const basis: Record<string, unknown> = {
    method: req.method,
    // ★신세대 문자열 command 도 담는다★ — 예전엔 Array.isArray 만 봐서 신세대는 null 이 됐고,
    //   그 결과 ★서로 다른 신세대 명령이 같은 지문★ 을 가졌다(Codex 리뷰 2026-07-29에서 재현).
    //   S1 이 그 문자열을 실제 shell operation 으로 승격하므로, 상관키·audit 지문도 구분해야 한다.
    //   ★배열은 배열 그대로 둔다★ — 구세대 지문 값을 바꾸지 않기 위해서다(변경 범위 최소).
    command: Array.isArray(p.command) ? p.command : (typeof p.command === "string" ? p.command.trim() || null : null),
    files: p.fileChanges && typeof p.fileChanges === "object" ? Object.keys(p.fileChanges).sort() : null,
    reason: typeof p.reason === "string" ? p.reason : null,
  };
  // ★S2 — 신세대 파일변경 승인은 위 4개가 ★전부 비어 있다★(method 말고는 command·files·reason 모두 null).
  //   그래서 한 턴에 두 건이 오면 ★서로 다른 요청이 같은 지문★ 을 갖는다 — S1 에서 문자열 command 로 겪은
  //   것과 같은 형태다. 상관키·audit 이 둘을 구분해야 하므로 payload 에 있을 때만 덧붙인다.
  //   ★있을 때만 넣는 이유★: 무조건 키를 추가하면 null 로라도 직렬화에 끼어들어 ★구세대 지문 값이 바뀐다★
  //   (진행 중 승인의 상관키가 어긋난다). 구세대 params 에는 itemId·grantRoot 가 없다(스키마 실측).
  const itemId = typeof p.itemId === "string" && p.itemId ? p.itemId : null;
  if (itemId) basis.item_id = itemId;
  const grantRoot = grantRootOf(p);
  if (grantRoot) basis.grant_root = grantRoot;
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

const POPUP_TTL_MS = Number(process.env.B3OS_CODEX_APPSERVER_POPUP_TTL_MS ?? 60 * 60 * 1000); // 1h (GD: 무응답→hold)
const POLL_INTERVAL_MS = Number(process.env.B3OS_CODEX_APPSERVER_POLL_MS ?? 1500);

/** 명령 승인 요청에서 ★실행될 명령 문자열★ 을 꺼낸다. 명령 승인이 아니면 null.
 *
 *  ★판정을 payload 모양이 아니라 method 로 한다.★ 모양은 세대마다 바뀌지만 method 는 계약이다 —
 *  예전 코드가 `Array.isArray(p.command)` 로 판정한 탓에 신세대(command 가 문자열)가 통째로
 *  해석 실패로 떨어졌다. ★모양으로 판정하면 다음 세대에서 또 조용히 미끄러진다.★
 *
 *  세대별 실제 모양(codex-cli 0.144.6 벤더 스키마 실측):
 *    execCommandApproval                     → command: string[]   (구세대)
 *    item/commandExecution/requestApproval   → command: string|null (신세대)
 *
 *  ★method 는 아는데 command 가 비어 있으면 null 을 돌려준다★ — 그러면 호출부가 해석 실패 분기로
 *  보내 S0 의 보수적 처리(payload 지문 + 매번 묻기)를 받는다. ★모르면 넓게 통과가 아니라 좁게 묻는다.★ */
type CommandParse =
  | { kind: "not_command" }          // 명령 승인 method 가 아니다 — 다음 분기로 넘긴다
  | { kind: "invalid" }              // 명령 승인 method 인데 command 를 못 읽었다 — ★즉시 해석 실패로★
  | { kind: "ok"; command: string };

/** 명령 승인 요청을 파싱한다. ★'명령 method 가 아님' 과 '명령 method 인데 못 읽음' 을 구분한다.★
 *
 *  ★왜 구분해야 하나 (2026-07-29 Codex 리뷰에서 잡힌 실제 구멍):★
 *  둘을 같은 null 로 합치면 호출부가 이어서 fileChanges 를 검사한다. 그래서
 *  `item/commandExecution/requestApproval` + `command: ""` + `fileChanges: {...}` 같은
 *  ★혼합 payload 가 approval_unparsed 가 아니라 write 로 처리됐다★ — 주석과 테스트가 약속한
 *  fail-closed 계약과 반대다. ★명령 승인이라고 밝힌 요청은 명령을 못 읽는 순간 거기서 멈춰야 한다.★
 *  (정상 스키마에서는 안 생기는 조합이지만, ★malformed 입력에서 좁게 묻기 불변식★ 이 깨지면 안 된다.)
 *
 *  세대별 모양(codex-cli 0.144.6 벤더 스키마 실측):
 *    execCommandApproval                     → command: string[]   (구세대)
 *    item/commandExecution/requestApproval   → command: string|null (신세대)
 *  ★판정은 payload 모양이 아니라 method 로 한다★ — 모양은 세대마다 바뀌지만 method 는 계약이다. */
function parseCommandApproval(req: ApprovalRequest): CommandParse {
  if (req.method !== "execCommandApproval" && req.method !== "item/commandExecution/requestApproval") {
    return { kind: "not_command" };
  }
  const raw = (req.params as Record<string, unknown>)?.command;
  if (Array.isArray(raw)) {
    const joined = raw.map((x) => String(x)).join(" ").trim();
    return joined.length > 0 ? { kind: "ok", command: joined } : { kind: "invalid" };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? { kind: "ok", command: trimmed } : { kind: "invalid" };
  }
  return { kind: "invalid" };
}

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
  // ★S1(#106) — 명령 승인을 세대 무관하게 해석한다.★
  //
  //  구세대 execCommandApproval 은 command 가 ★배열★, 신세대 item/commandExecution/requestApproval 은
  //  ★문자열★ 이다(codex-cli 0.144.6 벤더 스키마 실측). 예전에는 Array.isArray 만 봐서 ★신세대가 통째로
  //  해석 실패 분기로 떨어졌다★ — S0 이 그 분기를 안전하게 만들었지만, 안전할 뿐 ★사람이 읽을 수는 없었다★
  //  (열쇠도 팝업도 지문 문자열이라 무슨 명령인지 안 보인다).
  //
  //  여기서는 ★method 로 명령 승인임을 먼저 판정★ 하고, command 가 배열이든 문자열이든 같은 모양으로 만든다.
  //  판정 기준을 payload 모양이 아니라 method 로 둔 이유: 모양은 세대마다 바뀌지만 ★method 는 계약★ 이다.
  //  모양으로 판정하면 다음 세대에서 또 조용히 미끄러진다(그게 이 버그의 원인이었다).
  //
  //  ★교환 관계를 명시한다★: 해석되면 열쇠가 '명령' 단위가 되어 '항상 허용' 이 의미를 갖는다(쓸 만해진다).
  //  대신 그 열쇠는 permissionGate 에서 ★앞 240자만★ 쓰므로, 240자 prefix 가 같고 뒤가 다른 긴 명령은
  //  같은 열쇠가 된다 — ★구세대가 원래 갖고 있던 노출이고, S5(공용 결합)에서 닫힌다.★ #106 참조.
  const parsed = parseCommandApproval(req);
  if (parsed.kind === "ok") {
    return { runtime: "codex", agent_id: agentId, action: "shell", command: parsed.command.slice(0, 2000), requested_by: agentId, provenance };
  }
  // ★명령 승인이라고 밝혔는데 명령을 못 읽었다 → 여기서 멈춘다.★ 아래 fileChanges 분기로 흘려보내면
  //   혼합 payload 가 write 로 처리되어 fail-closed 계약이 깨진다(Codex 리뷰 2026-07-29).
  if (parsed.kind === "invalid") return unparsedOperation(req, agentId, provenance);
  // ★S2(#106) — 신세대 파일변경 승인을 실제 내용으로 해석한다.★
  //
  //  신세대 `item/fileChange/requestApproval` 은 ★무엇을 바꾸는지 payload 에 담지 않는다★(itemId 만 준다).
  //  그리고 ★벤더 프로토콜에 item 을 id 로 조회하는 요청이 없다★ — 처음 계획서에 "itemId 로 조회한다" 고
  //  적었던 것이 ★없는 기능★ 이었다(2026-07-29 스키마 전수 확인에서 발견).
  //  대신 내용이 ★알림으로 먼저 온다★(item/started · item/fileChange/patchUpdated). 그래서 클라이언트가
  //  같은 turn 안에서 itemId 로 색인해 두었다가 여기에 실어 준다(ApprovalRequest.observedItem).
  //
  //  ★짝이 없으면 내용을 지어내지 않는다★ — 알림을 못 봤거나 순서가 뒤집혔으면 해석 실패로 보내
  //  매번 묻게 한다. 여기서 "파일 변경입니다" 라고만 뭉뚱그리면 ★그 method 로 오는 모든 변경이 한 열쇠★ 가
  //  되어 S0 이 닫은 구멍이 다시 열린다.
  if (req.method === "item/fileChange/requestApproval") {
    const observed = req.observedItem;
    if (!observed || observed.changes.length === 0) return unparsedOperation(req, agentId, provenance);
    return fileChangeOperation(agentId, provenance, observed.changes, grantRootOf(p), observed.itemId);
  }
  if (p.fileChanges && typeof p.fileChanges === "object") {
    // scope_key(target)의 입력을 files[0]에서 '정렬된 전체 파일목록'으로 넓힌다.
    // ★단 target 절단 전까지만 구분력이 늘어날 뿐, '서로 다른 파일집합 → 서로 다른 scope'를 일반 보장하지 않는다.★
    // (여기서 500자, permissionGate.targetForOperation에서 240자로 잘린다.) 전체 결합은 미구현 — 이슈 #106.
    const files = Object.keys(p.fileChanges).sort();
    // ★S2: grantRoot 는 구세대 applyPatchApproval 에도 있다★ — 지금까지 통째로 무시하고 있었다.
    //   있으면 '이 파일들' 이 아니라 ★'이 루트 하위 전부' 를 세션 동안 허용해 달라는 요청★ 이다.
    //   열쇠에 반영하지 않으면 파일 몇 개에 준 '항상 허용' 이 루트 전체 승인으로 재사용된다.
    const grantRoot = grantRootOf(p);
    if (grantRoot) {
      return {
        runtime: "codex", agent_id: agentId, action: "write",
        path: `grant_root=${grantRoot} | ${files.join("|")}`.slice(0, 500),
        text: `${GRANT_ROOT_WARNING}${grantRoot} · 파일 ${files.length}개: ${files.join(", ")}`.slice(0, 500),
        requested_by: agentId, provenance: { ...provenance, grant_root: grantRoot },
      };
    }
    return { runtime: "codex", agent_id: agentId, action: "write", path: files.join("|").slice(0, 500), text: files.join(", ").slice(0, 500), requested_by: agentId, provenance };
  }
  return unparsedOperation(req, agentId, provenance);
}

/** ★팝업에서 '이건 파일 몇 개가 아니다' 를 사람이 놓치지 않게 하는 머리말.★ 문구가 두 곳에서 같아야
 *  하므로 상수로 둔다(구세대·신세대 경로 모두 같은 위험을 같은 말로 알린다). */
const GRANT_ROOT_WARNING = "⚠ 세션 동안 아래 폴더 하위 전체에 쓰기 허용 요청 · ";

/** grantRoot 를 꺼낸다. 빈 문자열·공백뿐이면 없는 것으로 본다.
 *  ★벤더 설명: "the agent is asking the user to allow writes under this root for the remainder of the
 *  session"★ — 즉 파일 단위 승인이 아니라 ★루트 단위 세션 승인★ 이다. UNSTABLE 표기지만 payload 에
 *  실려 오는 이상 ★우리 쪽 열쇠와 표시는 이걸 반영해야 한다.★ */
function grantRootOf(p: Record<string, any> | undefined): string | null {
  const raw = p?.grantRoot;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length > 0 ? t.slice(0, 300) : null;
}

/** 변경 규모(추가/삭제 줄수) — 사람이 ★'한 줄인지 삼백 줄인지'★ 를 가늠하게 하는 용도.
 *
 *  ★실측(2026-07-29, codex-cli 0.144.6 라이브)에서 diff 모양이 ★종류마다 다르다★ 는 것을 확인했다:★
 *    update → 진짜 통일diff        `@@ -1,4 +1,3 @@\n alpha\n-bravo\n+BRAVO\n charlie\n-delta\n`
 *    add    → ★파일 원문 그대로★   `HELLO\n`   (`+` 접두어도 `@@` 헤더도 없다)
 *  처음엔 둘 다 통일diff 라고 가정하고 `+`/`-` 만 셌는데, 그러면 ★새 파일 생성이 전부 "(+0/-0)"★ 로 보인다 —
 *  ★사람에게 "아무것도 안 바뀐다" 로 읽히는 것이 제일 나쁜 거짓말이다.★ 그래서 모양을 판별해서 센다.
 *  (delete 는 라이브로 못 봤다 — 통일diff 가 아니면 삭제 규모로 센다.) */
function changeStat(kind: string, diff: string): { added: number; removed: number } {
  const lines = diff.split("\n");
  const isUnified = lines.some((l) => l.startsWith("@@"));
  if (isUnified) {
    let added = 0, removed = 0;
    for (const line of lines) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
    return { added, removed };
  }
  // 통일diff 가 아니면 ★원문★ 이다. 끝 개행 때문에 생기는 빈 줄은 빼고 센다.
  const n = lines.filter((l, i) => l.length > 0 || i < lines.length - 1).length;
  return kind === "delete" ? { added: 0, removed: n } : { added: n, removed: 0 };
}

/**
 * ★S2 — 관측된 파일변경으로 write operation 을 만든다.★
 *
 * ■ 열쇠(scope)는 ★파일 경로 집합★ 이다 — 내용(diff)이 아니다.
 *   내용까지 열쇠에 넣으면 같은 파일을 두 번 고칠 때마다 다른 열쇠가 되어 ★'항상 허용' 이 영원히 안 붙는다★
 *   (S0 의 지문 열쇠가 정확히 그랬다 — 안전하지만 쓸 수 없었다). 사람이 '항상 허용' 으로 뜻하는 단위는
 *   ★"이 파일들에 쓰는 것"★ 이고, 그건 구세대 동작과도 같다. ★단, grantRoot 가 있으면 단위가 통째로
 *   달라지므로 열쇠 맨 앞에 넣는다★ — permissionGate 가 target 을 ★앞 240자만★ 쓰기 때문에
 *   ★제일 위험한 정보가 잘려나가면 안 된다.★
 *
 * ■ 내용(diff)은 ★사람이 보는 요약★ 과 ★audit 지문★ 에만 쓴다.
 *   diff 원문을 text 에 그대로 실으면 permissionGate.operationText 를 통해 ★파일 내용이 Tier-D 스캔에
 *   걸려★ 멀쩡한 코드가 차단될 수 있다. 그래서 ★경로·종류·줄수 요약만★ 싣는다.
 */
function fileChangeOperation(
  agentId: string,
  provenance: Record<string, unknown>,
  changes: ObservedFileChange[],
  grantRoot: string | null,
  itemId: string,
): PermissionOperation {
  const paths = [...new Set(changes.map((c) => c.path))].sort();
  const summary = changes
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((c) => {
      const { added, removed } = changeStat(c.kind, c.diff);
      const dest = c.movePath ? `→${c.movePath}` : "";
      return `${c.kind} ${c.path}${dest}(+${added}/-${removed})`;
    })
    .join(", ");
  const head = grantRoot ? `grant_root=${grantRoot} | ` : "";
  const textHead = grantRoot ? `${GRANT_ROOT_WARNING}${grantRoot} · ` : "";
  return {
    runtime: "codex",
    agent_id: agentId,
    action: "write",
    path: `${head}${paths.join("|")}`.slice(0, 500),
    text: `${textHead}파일 ${paths.length}개: ${summary}`.slice(0, 500),
    requested_by: agentId,
    provenance: {
      ...provenance,
      item_id: itemId,
      grant_root: grantRoot,
      // 관측 경로를 남긴다 — 나중에 "이 내용을 어디서 알았나" 를 답할 수 있어야 한다.
      file_changes_source: "notification_index",
      // ★audit 전용 내용 지문.★ 열쇠에는 안 들어간다(위 설명) — permissionGate 는 provenance 를 읽지 않는다.
      file_changes_digest: createHash("sha256")
        .update(JSON.stringify(changes.map((c) => [c.path, c.kind, c.movePath, c.diff]).sort()))
        .digest("hex")
        .slice(0, 16),
    },
  };
}

/** ★해석하지 못한 승인 요청의 operation.★ 두 곳에서 쓴다 — 아무 분기에도 안 걸린 경우와,
 *  ★명령 승인이라고 밝혔지만 명령을 못 읽은 경우★(그 경우 fileChanges 분기로 흘리면 안 된다).
 *
 *  예전에는 action 에 req.method 를, text 에 reason 만 넣었다. reason 이 없으면 targetForOperation 이
 *  action 으로 떨어지므로 ★target = method 이름★ 이 되어 ★그 method 로 오는 모든 요청이 같은 scope★ 였다.
 *  → 한 번 allowed_always 를 받으면 이후 ★내용이 전혀 다른 요청도 팝업 없이 통과★ 한다.
 *
 *  ★팀 리드 원칙(2026-07-28): "애매하면 통과가 아니고 ask 로."★
 *  해석에 실패했으면 넓은 열쇠를 만들지 않는다 — payload 지문을 target 에 넣어 payload 가 다르면 열쇠도 다르게.
 *
 *  ※ reason 을 text 에 남기는 이유: permissionGate.operationText 가 text 도 Tier-D 스캔에 쓴다. */
function unparsedOperation(req: ApprovalRequest, agentId: string, provenance: Record<string, unknown>): PermissionOperation {
  const p = req.params as Record<string, any>;
  const reason = typeof p?.reason === "string" ? p.reason.slice(0, 500) : "";
  return {
    runtime: "codex",
    agent_id: agentId,
    action: "approval_unparsed",
    text: `${req.method.slice(0, 64)} #${unparsedPayloadDigest(req)}${reason ? ` ${reason}` : ""}`,
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
      // ★Object.fromEntries 를 쓴다 — 일반 객체에 acc["__proto__"]=... 로 대입하면 ★프로토타입이 바뀔 뿐
      //  own property 가 되지 않아 JSON.stringify 에서 통째로 사라진다.★ 그러면 "__proto__" 값만 다른 두
      //  payload 가 ★같은 지문·같은 열쇠★ 가 된다(Codex 리뷰에서 지적, 재현 확인: 둘 다 #5353b5b6…).
      //  JSON-RPC payload 에 그 키가 오는 것은 유효하므로, ★해석 실패 경로에서 이건 우회 통로★ 가 된다.
      //  fromEntries 는 CreateDataProperty 라 "__proto__" 도 평범한 키로 보존한다.
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])] as const),
      );
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

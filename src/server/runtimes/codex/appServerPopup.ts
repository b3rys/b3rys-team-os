/** 승인 요청은 기존 permissionGate와 채널 팝업을 통해 결정으로 매핑한다. 오류·무응답은 거절하며 Tier-D는 팝업 생성 전에 requestPermission에서 거절한다.
 * 한 번·세션·지속 허용의 구분을 보존하고 삭제된 별도 판정기를 현재 방어선으로 간주하지 않는다. */
import { sendApprovalCard, type ApprovalCardInput } from "../../lib/cogsPermissions/card";
import { uiText } from "./uiStrings";
import { cogsActivityArgs, filename } from "./cogsActivity";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { requestPermission, getPermissionRequest, decidePermissionRequest, tierDReasons, type PermissionOperation } from "../../lib/permissionGate";
import type { ApprovalRequest, ReviewDecision } from "./appServerClient";
import { CodexApprovalCorrelationStore } from "./state";
import { appendAudit } from "../../db/queries";
import { readFileSync } from "node:fs";
import { codexBridgePaths, resolveOwnerDmId } from "./launcher";
import { readMemberChannel, type MemberChannel } from "../../lib/memberChannel";
import { redactApprovalText } from "../../lib/redactSecrets";
import { folderOperationDigest, type FolderSessionApprovals } from "./folderSessionApprovals";
export { redactApprovalText } from "../../lib/redactSecrets";

/** Phase1 ③: 이 서버 프로세스 인스턴스 id — 재시작 감지용(옛 팝업을 새 프로세스가 새 turn에 재결합 금지). */
export const PROCESS_INSTANCE = randomUUID();

/** 승인 결정은 pending→decided→delivered CAS와 operation_hash·process_instance 대조가 모두 성공해야 전달한다. 거절은 만료 처리하고 단계 실패는 거절한다.
 * Folder 호출자는 전달 직전 전체 operation을 다시 계산한다. 공용 경로는 승인 전 캡처값만 비교한다. */
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

/** operation hash는 전체 명령·파일 종류/경로/이동·내용을 결합해 결정과 요청을 맞춘다. scope는 내용 변경마다 지속 허용이 풀리지 않도록 내용 해시를 제외한다.
 * 공용 경로는 실행 직전 재계산을 하지 않는다. Folder 경로는 별도의 전체 digest를 다시 비교한다. CLI 0.144.6(rust-v0.144.6/5d1fbf26)은 승인 중 같은 call_id의 갱신 경로가 없고 patchUpdated는 기본 OFF인 승인 전 스트리밍이며 steer도 다음 모델 요청 전에 적용된다.
 * 벤더가 승인 중 갱신을 허용하면 재검토해야 한다. 수신 색인은 갱신 가능하며 patchUpdated는 실제 프로토콜 알림이다. 재확인은 내용 동의가 있는 finalize 직전이 후보이나, 결정 반환 후 벤더 내부 실행 구간은 관측할 수 없다. */
export function approvalOperationHash(req: ApprovalRequest): string {
  const p = req.params as Record<string, any>;
  const basis: Record<string, unknown> = {
    method: req.method,
    // 문자열 command도 요청 해시에 담아 신세대 명령끼리 구분한다. 배열은 기존 직렬화 형태를 유지해 진행 중 승인 상관키를 보존한다.
    command: Array.isArray(p.command) ? p.command : (typeof p.command === "string" ? p.command.trim() || null : null),
    // 이동 목적지도 해시에 담아 출발지만 같은 요청을 구분한다. 이동이 없으면 기존 경로 정렬과 동일한 결과를 유지한다.
    files: p.fileChanges && typeof p.fileChanges === "object" ? fileChangeEntries(p.fileChanges) : null,
    reason: typeof p.reason === "string" ? p.reason : null,
  };
  // S2 — 신세대 파일변경 승인은 위 4개가 전부 비어 있다(method 말고는 command·files·reason 모두 null).
  //   그래서 한 턴에 두 건이 오면 서로 다른 요청이 같은 operation hash 을 갖는다 — S1 에서 문자열 command 로 겪은
  //   것과 같은 형태다. 상관키·audit 이 둘을 구분해야 하므로 payload 에 있을 때만 덧붙인다.
  //   있을 때만 넣는 이유: 무조건 키를 추가하면 null 로라도 직렬화에 끼어들어 구세대 operation hash 값이 바뀐다
  //   (진행 중 승인의 상관키가 어긋난다). 구세대 params 에는 itemId·grantRoot 가 없다(스키마 실측).
  const itemId = typeof p.itemId === "string" && p.itemId ? p.itemId : null;
  if (itemId) basis.item_id = itemId;
  if (p.permissions !== undefined) basis.permissions = p.permissions;
  const grantRoot = grantRootOf(p);
  if (grantRoot) basis.grant_root = grantRoot;
  // 같은 파일의 다른 변경을 구분하도록 내용 해시를 결합한다. 내용이 있을 때만 키를 추가해야 내용 없는 기존 요청의 상관키가 바뀌지 않는다.
  const contentDigest = approvalContentDigest(req);
  if (contentDigest) basis.content = contentDigest;
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

/** 구세대 내용은 fileChanges, 신세대는 먼저 받은 observedItem에서 얻는다. add·delete는 content, update는 unified_diff·move_path를 사용한다.
 * 종류·이동 목적지도 포함하고 전문 대신 해시만 담아 큰 diff의 직렬화 비용을 제한한다. */
function approvalContentDigest(req: ApprovalRequest): string | null {
  const p = req.params as Record<string, any>;
  // body 는 string | null 이다 — ""(빈 내용을 안다) 와 null(내용을 모른다) 은 다른 상태다.
  //   앞선 판은 둘을 "" 하나로 합쳐서 빈 파일 생성과 빈 파일 삭제가 같은 operation hash 이었다(P1 · 재현 확인).
  //   basis.files 에는 kind 가 없으므로 그 둘을 갈라줄 다른 재료도 없었다.
  const rows: Array<[string, string, string | null, string | null]> = [];

  // 신세대 — 관측해 둔 변경(내용 포함). 관측이 있으면 그 내용은 아는 것 이다(빈 문자열도 포함).
  for (const c of req.observedItem?.changes ?? []) {
    rows.push([c.path, c.kind, c.movePath, typeof c.diff === "string" ? c.diff : null]);
  }
  // 구세대 — payload 안에 내용이 있다
  const fc = p?.fileChanges;
  if (fc && typeof fc === "object" && !Array.isArray(fc)) {
    for (const [path, raw] of Object.entries(fc)) {
      const ch = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const kind = typeof ch.type === "string" && ch.type ? ch.type : "change";
      const mv = typeof ch.move_path === "string" && ch.move_path.trim() ? ch.move_path : null;
      // 종류에 맞는 필드만 본다 — 짝이 어긋난 payload 에서 엉뚱한 값을 operation hash 에 넣지 않기 위해서다
      //   (S3 에서 표시 쪽에 같은 정정을 했다: 재료를 고르는 기준과 쓰는 기준이 달라 규모를 지어냈다).
      //   필드가 없으면 null — "내용이 비어 있다" 가 아니라 "내용을 모른다" 다.
      const body =
        kind === "update"
          ? typeof ch.unified_diff === "string" ? ch.unified_diff : null
          : kind === "add" || kind === "delete"
            ? typeof ch.content === "string" ? ch.content : null
            // 모르는 종류만 휴리스틱 — 있는 쪽을 쓴다. 빈 문자열도 '있는 것' 으로 센다
            //   (unified_diff:"" 가 content:"X" 를 가리는 것은 의도된 우선순위다: 종류를 모를 때
            //    먼저 선언된 필드를 믿는다. 시험으로 고정한다.)
            : typeof ch.unified_diff === "string" ? ch.unified_diff : typeof ch.content === "string" ? ch.content : null;
      rows.push([path, kind, mv, body]);
    }
  }
  // 하나라도 '아는' 내용이 있으면 operation hash화한다 — 길이가 아니라 null 여부 로 판정한다.
  //   길이로 재면 빈 파일 작업이 "모름" 과 합쳐진다(P1). 아무것도 모르면 키를 안 붙여 구세대 골든을 지킨다.
  if (!rows.some((r) => r[3] !== null)) return null;
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

// 반응이 5분 넘게 없으면 무효.
//   1시간이면 그동안 codex 턴이 통째로 매달려 그 팀원이 아무 일도 못 한다.
const POPUP_TTL_MS = Number(process.env.B3OS_CODEX_APPSERVER_POPUP_TTL_MS ?? 5 * 60 * 1000);
const POLL_INTERVAL_MS = Number(process.env.B3OS_CODEX_APPSERVER_POLL_MS ?? 1500);

/** 명령 승인은 payload 모양 대신 method로 분류한다. 구세대 command는 배열이고 신세대는 문자열이라 모양만 보면 누락된다.
 * 명령이 비었으면 null로 두어 내용을 추정해 허용하지 않고 해석 실패 경로에서 매번 묻게 한다. */
type CommandParse =
  | { kind: "not_command" }          // 명령 승인 method 가 아니다 — 다음 분기로 넘긴다
  | { kind: "invalid" }              // 명령 승인 method 인데 command 를 못 읽었다 — 즉시 해석 실패로
  | { kind: "ok"; command: string; material: string };

/** 명령 method가 아닌 경우와 명령을 읽지 못한 경우를 구분한다. 후자를 파일변경 분기로 넘기면 혼합 payload가 잘못된 쓰기 승인으로 통과한다. */
function parseCommandApproval(req: ApprovalRequest): CommandParse {
  if (req.method !== "execCommandApproval" && req.method !== "item/commandExecution/requestApproval") {
    return { kind: "not_command" };
  }
  const raw = (req.params as Record<string, unknown>)?.command;
  //  command 는 사람이 보는 줄, material 은 열쇠를 가르는 재료 — 둘을 분리한다.
  //  분리하는 이유: 사람 눈 문자열로 합치면 실제로 다른 작업이 같은 문자열이 된다. (실측)
  //  · 구세대 ['a b','c'] 와 ['a','b c'] → join(" ") 후 둘 다 "a b c" → 같은 열쇠 → 두 번째가 팝업 없이 통과.
  //  → material 은 원본 구조(배열은 배열대로) + method(세대 표식) 를 JSON 으로 굳혀 쓴다.
  //  구세대와 신세대를 method 로 가르는 것도 의도다 — 같아 보여도 경로가 다르면 따로 묻는다(애매하면 ask).
  if (Array.isArray(raw)) {
    //  문자열이 아닌 원소는 해석 성공으로 받지 않는다.
    //  String(x) 로 강제변환하면 서로 다른 payload 가 같은 재료가 된다 (DB 경로에서 재현 확인):
    //    [1] 승인 뒤 ["1"] → allow · [null] 과 ["null"] → allow · [{}] 는 "[object Object]" 가 된다.
    //  이건 규격에 없는 payload 를 넓게 통과 시키는 자리다. 모르면 좁게 묻는다 —
    //  invalid 로 보내면 해석 실패 경로(S0: payload digest + 매번 묻기)를 받는다.
    const argv = raw.every((x) => typeof x === "string") ? (raw as string[]) : null;
    if (argv === null) return { kind: "invalid" };
    const joined = argv.join(" ").trim();
    return joined.length > 0
      ? { kind: "ok", command: joined, material: JSON.stringify([req.method, argv]) }
      : { kind: "invalid" };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0
      ? { kind: "ok", command: trimmed, material: JSON.stringify([req.method, trimmed]) }
      : { kind: "invalid" };
  }
  return { kind: "invalid" };
}

/** 명령은 자르지 않고 전부 검사하되 2000자를 넘으면 팝업 없이 거절하고 감사 기록으로 별도 검토한다.
 * 긴 heredoc 정상 범위 약 724자의 여유를 두면서 사람이 읽고 판단할 수 없는 과도한 명령은 제외한다. */
const COMMAND_REVIEW_LIMIT = 2_000;

/** scope는 앞 240자만 쓰므로 전체 명령 해시를 그 안에 포함하고, 위험 스캔에는 text로 전문을 따로 전달한다. 표시용 command만 자르면 뒷부분의 위험 명령을 놓친다.
 * 명령을 먼저 보여주고 해시는 남은 예산에 보존하며 코드포인트 경계에서 잘라 문자가 깨지지 않게 한다. */
function commandOperationFields(material: string, command: string): { command: string; text: string } {
  //  operation hash 는 material(원본 구조 전문) 로 만든다 — 화면용으로 자른 값으로 만들지 않는다.
  //  자른 값으로 만들면 잘린 뒤가 달라도 operation hash 가 같아진다(실측: 앞 2000자 동일 → 두 번째 'allow').
  //
  //  자르지 않은 64 hex 전문을 쓴다. 표시용 체크섬이 아니라 팝업 우회를 막는 유일한 구분자 다.
  //  12 hex(48비트)면 SAFE/EVIL 후보를 각 2^24개씩 만들어 충돌시키는 게 GPU 로 현실적이다.
  const digest = createHash("sha256").update(material).digest("hex");
  // 공백 정규화 후 잘리므로(normalizeText → slice) operation hash 안에는 공백이 없어야 한다.
  const suffix = ` #${digest}`;
  const budget = Math.max(0, VISIBLE_BUDGET - suffix.length);
  //  잘랐으면 잘랐다고 말한다. 표시가 없으면 사람은 이게 명령 전부인 줄 안다 —
  //  "kubectl delete ns prod " 뒤에 500자가 더 있어도 화면은 그냥 174자에서 끊긴다(실측).
  //  전문이 text 로 빠진 지금은 사람 눈에 닿는 경로가 이 한 줄뿐 이라 더 중요해졌다.
  //  S3 가 쓰기 경로에서 세운 규칙과도 같다 — 넘치면 몇 개가 잘렸는지 말한다.
  const display = redactApprovalText(command);
  const truncated = display.length > budget;
  const visible = truncated ? `${cutCodePoints(display, Math.max(0, budget - 1))}…` : display;
  return { command: `${visible}${suffix}`, text: command };
}

/** M5.1 — codex 승인요청 → PermissionOperation(requestPermission 입력). */
export function buildOperationFromApproval(req: ApprovalRequest, agentId: string, cwd?: string): PermissionOperation {
  const p = req.params as Record<string, any>;
  const provenance: Record<string, unknown> = {
    source: "appserver_approval",
    approval_method: req.method,
    call_id: p.callId ?? null,
    cwd: cwd ?? p.cwd ?? null,
    // provenance에 origin 표식(팝업 표시 하드닝·audit). taint 전체는 M3b 공용 layer로 확장.
    input_origin: "codex_turn",
    // 작업 operation hash — audit/상관키 대조용으로만 기록된다. permissionGate는 이 값을 읽지 않으므로
    // grant scope에는 반영되지 않는다(알려진 갭 — approvalOperationHash 주석 참조).
    operation_hash: approvalOperationHash(req),
  };
  // 명령 세대별 payload는 배열·문자열로 다르므로 method로 먼저 분류한다. 해석된 전체 명령 해시를 표시 상한 안에 남겨 서로 다른 명령의 지속 허용이 합쳐지지 않게 한다.
  const parsed = parseCommandApproval(req);
  if (parsed.kind === "ok") {
    return { runtime: "codex", agent_id: agentId, action: "shell", ...commandOperationFields(parsed.material, parsed.command), requested_by: agentId, provenance };
  }
  // 명령 method를 읽지 못하면 여기서 멈춘다. fileChanges가 섞여도 write로 바꾸지 않아야 해석 실패의 보수적 처리가 유지된다.
  if (parsed.kind === "invalid") return unparsedOperation(req, agentId, provenance);
  // 신세대 파일변경 승인은 내용·ID 조회 요청이 없으므로 같은 턴의 선행 알림을 색인한 observedItem을 사용한다.
  // 짝이 없으면 추정하지 않고 매번 묻게 해야 모든 파일변경이 같은 허용 범위로 합쳐지지 않는다.
  if (req.method === "item/fileChange/requestApproval") {
    const observed = req.observedItem;
    if (!observed || observed.changes.length === 0) return unparsedOperation(req, agentId, provenance);
    // grantRoot 로 보이는 낯선 키가 있으면 여기서 멈춘다 — 폴더 전체 요청이 평범한 파일 쓰기로
    //   보이는 것보다 매번 묻는 게 낫다(벤더 개명 대비).
    if (hasUnreadGrantRootKey(p)) return unparsedOperation(req, agentId, provenance);
    return writeOperation(agentId, provenance, observed.changes, grantRootOf(p), observed.itemId);
  }
  // 구세대 fileChanges도 종류별 실제 내용 필드를 사용한다. 배열은 파일 경로 맵이 아니므로 인덱스를 경로로 표시하지 않고 해석 실패로 처리한다.
  if (p.fileChanges && typeof p.fileChanges === "object" && !Array.isArray(p.fileChanges)) {
    // S2: grantRoot 는 구세대 applyPatchApproval 에도 있다 — 지금까지 통째로 무시하고 있었다.
    //   있으면 '이 파일들' 이 아니라 '이 루트 하위 전부' 를 세션 동안 허용해 달라는 요청 이다.
    //   열쇠에 반영하지 않으면 파일 몇 개에 준 '항상 허용' 이 루트 전체 승인으로 재사용된다.
    if (hasUnreadGrantRootKey(p)) return unparsedOperation(req, agentId, provenance); // 위와 같은 이유
    const oldChanges = oldGenChanges(p.fileChanges);
    // 빈 목록은 '파일 0개 쓰기' 가 아니라 해석 실패다 — 신세대(관측된 변경 0건)와 정책을 맞춘다.
    //   앞선 판은 `fileChanges: {}` 를 write 로 만들어 내용 없는 넓은 열쇠 를 하나 만들었다.
    if (oldChanges.length === 0) return unparsedOperation(req, agentId, provenance);
    return writeOperation(agentId, provenance, oldChanges, grantRootOf(p), null);
  }
  return unparsedOperation(req, agentId, provenance);
}

/** 팝업에서 '이건 파일 몇 개가 아니다' 를 사람이 놓치지 않게 하는 머리말. 문구가 두 곳에서 같아야
 *  하므로 상수로 둔다(구세대·신세대 경로 모두 같은 위험을 같은 말로 알린다). */
const GRANT_ROOT_WARNING = uiText("operation_grant_root",{},"ko");

/** 해석 실패 팝업의 첫 말. 팝업 앞줄(`… · approval_unparsed`)은 공용 코드가 만들어 여기서 못 바꾼다 —
 *  그래서 뒷줄이 사람에게 상황을 말한다. 상수라서 열쇠 구분력에 영향이 없다. */
const UNPARSED_NOTICE = uiText("operation_unparsed",{},"ko");

/** grantRoot 를 꺼낸다. 빈 문자열·공백뿐이면 없는 것으로 본다.
 *  벤더 설명: "the agent is asking the user to allow writes under this root for the remainder of the
 *  session" — 즉 파일 단위 승인이 아니라 루트 단위 세션 승인 이다. UNSTABLE 표기지만 payload 에
 *  실려 오는 이상 우리 쪽 열쇠와 표시는 이걸 반영해야 한다. */
/** grantRoot 유사 미지원 키는 해석 실패로 처리한다. 조용히 무시하면 폴더 전체 쓰기 경고가 사라지고 서로 다른 권한이 합쳐질 수 있다. CLI 0.144.6은 grantRoot를 사용한다. */
function hasUnreadGrantRootKey(p: Record<string, any> | undefined): boolean {
  if (!p || typeof p !== "object") return false;
  return Object.keys(p).some((k) => k !== "grantRoot" && /grant.?root/i.test(k));
}

function grantRootOf(p: Record<string, any> | undefined): string | null {
  const raw = p?.grantRoot;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  // grantRoot는 해시·scope 계산 전에 자르지 않는다. 긴 공통 접두사의 서로 다른 루트가 합쳐지지 않도록 표시만 줄인다.
  return t.length > 0 ? t : null;
}

/** 이동 목적지도 scope에 넣어야 안전한 목적지에 준 지속 허용이 다른 목적지 이동에 재사용되지 않는다. 표시만 다르게 해서는 두 번째 팝업이 없어 구분할 수 없다. */
function writeTargetEntry(path: string, movePath: string | null): string {
  return movePath ? `${path}>${movePath}` : path;
}

/** 구세대 update의 move_path도 대상 목록에 포함한다. 이동이 없으면 기존 경로 정렬 결과를 보존해 저장된 scope·상관키 호환성을 유지한다. */
function fileChangeEntries(fileChanges: Record<string, unknown>): string[] {
  return Object.entries(fileChanges)
    .map(([path, ch]) => {
      const mv = ch && typeof ch === "object" && typeof (ch as any).move_path === "string" ? (ch as any).move_path : null;
      return writeTargetEntry(path, mv && mv.trim() ? mv : null);
    })
    .sort();
}

/** update는 unified diff, add는 파일 원문이므로 종류에 맞게 규모를 센다. 원문을 diff로 세면 새 파일이 변경 0줄로 보인다.
 * delete는 실사용 관측 없이 비-diff 입력을 삭제 줄수로 처리하는 경로다. */
function changeStat(kind: string, diff: string): { added: number; removed: number } {
  const lines = diff.split("\n");
  // 원문에 @@ 제목이 있어도 diff로 오판하지 않도록 종류로 분류한다. update만 diff로 세고 add·delete는 원문 줄수, 모르는 종류만 형태를 추정한다.
  const isUnified = kind === "update" ? true : kind === "add" || kind === "delete" ? false : lines.some((l) => l.startsWith("@@"));
  if (isUnified) {
    let added = 0, removed = 0;
    for (const line of lines) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
    return { added, removed };
  }
  // 통일diff 가 아니면 원문 이다. 끝 개행 때문에 생기는 빈 줄은 빼고 센다.
  const n = lines.filter((l, i) => l.length > 0 || i < lines.length - 1).length;
  return kind === "delete" ? { added: 0, removed: n } : { added: n, removed: 0 };
}

/** 쓰기 승인 한 건의 공통 내부 표현. 세대마다 payload 모양은 다르지만(신세대=알림 색인, 구세대=fileChanges)
 *  사람이 봐야 하는 것은 같다 — 무슨 파일을, 어떤 종류로, 얼마나 바꾸는가. 한 곳에서 만든다. */
export interface WriteChange {
  path: string;
  kind: string;
  movePath: string | null;
  diff: string;
}

/** 구세대 add·delete는 content, update는 unified_diff·move_path를 사용한다.
 * 내용이 없으면 빈 diff로 규모 표시를 생략해야 알 수 없는 변경을 0줄로 단정하지 않는다. */
function oldGenChanges(fileChanges: Record<string, unknown>): WriteChange[] {
  return Object.entries(fileChanges).map(([path, raw]) => {
    const ch = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const mv = typeof ch.move_path === "string" && ch.move_path.trim() ? ch.move_path : null;
    const kind = typeof ch.type === "string" && ch.type ? ch.type : "change";
    // update는 unified_diff, add·delete는 content를 골라 kind와 집계 재료를 맞춘다. 필드가 없으면 규모를 추정하지 않고 표시를 생략한다.
    const diff =
      kind === "update"
        ? typeof ch.unified_diff === "string" ? ch.unified_diff : ""
        : kind === "add" || kind === "delete"
          ? typeof ch.content === "string" ? ch.content : ""
          : typeof ch.unified_diff === "string" ? ch.unified_diff : typeof ch.content === "string" ? ch.content : "";
    return { path, kind, movePath: mv, diff };
  });
}

/** 팝업에서 사람이 실제로 읽는 한 줄의 예산. permissionGate.targetForOperation 이 target 을
 *  앞 240자만 쓰고, 텔레그램 팝업은 그 target 을 그대로 한 줄로 보여준다(telegramCapture 의
 *  `${pr.runtime}/${pr.agent_id} · ${pr.action}\n${pr.target}`). 즉 240자가 화면이다. */
const VISIBLE_BUDGET = 240;

/** UTF-16 code unit에서 자르면 이모지의 서로게이트 쌍이 갈라져 승인 대상 표기가 깨지므로 코드포인트 경계를 지킨다. */
function cutCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const cp of s) {
    if (out.length + cp.length > max) break;
    out += cp;
  }
  return out;
}

/** 첫 파일부터 표시 예산을 지키고 생략 개수를 알린다. 긴 첫 경로가 예산을 넘으면 뒤의 해시가 240자 절단에서 사라져 다른 요청이 합쳐진다. */
function fitEntries(display: string[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < display.length; i++) {
    const piece = display[i]!;
    const cost = piece.length + (out.length ? 2 : 0);
    const rest = display.length - i;
    const tail = rest > 1 ? uiText("operation_more_files",{count:rest},"ko").length : 0;
    if (used + cost + tail > budget) {
      if (out.length > 0) return `${out.join(", ")}${uiText("operation_more_files",{count:rest},"ko")}`;
      // 첫 항목 하나도 안 들어간다 → 그 항목 자체를 예산에 맞춰 자르고 잘렸음을 표시한다.
      const room = Math.max(0, budget - (rest > 1 ? tail : 1));
      const cut = `${cutCodePoints(piece, Math.max(0, room - 1))}…`;
      return rest > 1 ? `${cut}${uiText("operation_more_files",{count:rest},"ko")}` : cut;
    }
    out.push(piece);
    used += cost;
  }
  return out.join(", ");
}

/** 쓰기 scope는 경로 집합과 grantRoot를 사용하며 내용·줄수는 수정마다 지속 허용이 풀리지 않도록 제외한다. diff 전문은 코드 문자열이 위험 스캔에 잘못 걸리지 않도록 싣지 않는다.
 * 화면과 scope를 겸하는 path에는 경고→해시→파일 개수·종류·경로 순으로 넣어 240자 절단에도 권한 차이를 보존한다. 규모는 text에만 남기며 화면 표시는 별도 렌더러 변경 결정이 필요하다. */
function writeOperation(
  agentId: string,
  provenance: Record<string, unknown>,
  changes: WriteChange[],
  grantRoot: string | null,
  itemId: string | null,
): PermissionOperation {
  // 이동 대상은 [path, movePath] 구조로 해시한다. >로 이어붙이면 a>b 파일과 a→b 이동처럼 서로 다른 작업이 충돌한다.
  const keyOf = (c: WriteChange) => JSON.stringify([c.path, c.movePath]);
  const byKey = new Map<string, WriteChange>();
  for (const c of changes) if (!byKey.has(keyOf(c))) byKey.set(keyOf(c), c);
  const uniq = [...byKey.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const entries = uniq.map((c) => [c.path, c.movePath] as const);
  const sorted = changes.slice().sort((a, b) => a.path.localeCompare(b.path));
  // scope 해시는 표시에서 잘린 파일도 포함한 전체 경로 집합·grantRoot로 만든다.
  // grantRoot 표시는 뒤 71자뿐이므로 전문 해시가 없으면 앞부분이 다른 권한 범위가 합쳐진다. 내용은 제외해 같은 파일의 지속 허용을 유지한다.
  const setDigest = createHash("sha256")
    .update(JSON.stringify({ grant_root: grantRoot, entries }))
    .digest("hex")
    .slice(0, 12);
  // 표시도 원본 필드에서 조립한다 — 이어붙인 문자열에서 `>` 를 `→` 로 바꾸면
  //   이름에 `>` 가 든 평범한 파일이 "옮긴다" 로 거짓 표시된다(실측: `a>b.ts` → `add a→b.ts`).
  const display = uniq.map((c) => `${c.kind} ${c.path}${c.movePath ? ` → ${c.movePath}` : ""}`);
  // 사람이 읽는 경고·개수·파일을 먼저 보여주되 해시 길이를 미리 예약해 240자 절단 안에 요청 구분값을 보존한다.
  const head = grantRoot ? `${GRANT_ROOT_WARNING}${grantRootDisplay(grantRoot)} · ` : "";
  const prefix = `${head}${uiText("operation_file_count",{count:entries.length},"ko")} · `;
  const suffix = ` #${setDigest}`;
  const scale = sorted
    .map((c) => {
      const stat = c.diff ? changeStat(c.kind, c.diff) : null;
      const dest = c.movePath ? ` → ${c.movePath}` : "";
      return `${c.kind} ${c.path}${dest}${stat ? `(+${stat.added}/-${stat.removed})` : ""}`;
    })
    .join(", ");
  return {
    runtime: "codex",
    agent_id: agentId,
    action: "write",
    // 화면 = 앞 240자 이므로 예산을 그 기준으로 잡고, 열쇠용 전체는 500자까지 남긴다.
    path: `${prefix}${fitEntries(display, Math.max(0, VISIBLE_BUDGET - prefix.length - suffix.length))}${suffix}`.slice(0, 500),
    text: `${grantRoot ? `${GRANT_ROOT_WARNING}${grantRoot.slice(0, 200)} · ` : ""}${uiText("operation_file_count",{count:entries.length},"ko")}: ${scale}`.slice(0, 500),
    requested_by: agentId,
    provenance: {
      ...provenance,
      item_id: itemId,
      grant_root: grantRoot,
      // 관측 경로를 남긴다 — 나중에 "이 내용을 어디서 알았나" 를 답할 수 있어야 한다.
      file_changes_source: itemId ? "notification_index" : "approval_payload",
      // audit 전용 content digest. 열쇠에는 안 들어간다(위 설명) — permissionGate 는 provenance 를 읽지 않는다.
      file_changes_digest: createHash("sha256")
        .update(JSON.stringify(changes.map((c) => [c.path, c.kind, c.movePath, c.diff]).sort()))
        .digest("hex")
        .slice(0, 16),
    },
  };
}

/** grantRoot 를 사람이 구별할 수 있게 줄인다. 열쇠 구분은 operation hash(setDigest)이 하므로
 *  여기서는 읽히는 것만 신경 쓴다 — 뿌리는 앞이 아니라 뒤가 다르다
 *  (`/Users/gdmini/Development/a` vs `…/b` 는 앞 60자가 똑같다). 그래서 길면 뒤를 남긴다. */
function grantRootDisplay(root: string): string {
  if (root.length <= 72) return root;
  return `…${root.slice(-71)}`;
}

/** 해석 실패는 method만으로 넓은 scope를 만들지 않고 전체 payload 해시로 좁혀 매번 확인한다.
 * reason도 위험 검사에 필요하므로 text에 보존한다. 명령 해석 실패는 파일변경 경로로 넘기지 않는다. */
function unparsedOperation(req: ApprovalRequest, agentId: string, provenance: Record<string, unknown>): PermissionOperation {
  const p = req.params as Record<string, any>;
  const reason = typeof p?.reason === "string" ? p.reason.slice(0, 500) : "";
  return {
    runtime: "codex",
    agent_id: agentId,
    action: "approval_unparsed",
    // text가 화면과 scope를 겸하므로 사람이 읽는 안내→해시→스캔 payload 순으로 구성한다. 필드를 추가하면 화면과 scope가 함께 바뀐다.
    // 해석 실패도 위험 검사는 생략하지 않는다. payload의 우연한 위험 문자열도 거절할 수 있으나 알 수 없는 입력은 보수적으로 처리한다.
    text:
      `${UNPARSED_NOTICE}${req.method.slice(0, 64)} #${unparsedPayloadDigest(req)}${reason ? ` ${reason}` : ""}` +
      ` ${payloadScanText(req)}`,
    requested_by: agentId,
    provenance,
  };
}

/** 해석 실패 시 중요한 필드를 고를 근거가 없으므로 payload 전체를 해시한다. 키 순서 차이로 같은 작업이 달라지지 않게 재귀 정렬해 직렬화한다. */
/** 위험 스캔은 payload의 문자열 값들을 공백으로 이어 사용한다. JSON의 개행 이스케이프는 nsudo처럼 단어 경계를 없애 검사를 우회할 수 있다.
 * 요청 동일성 해시는 키 순서 안정성이 목적이므로 정렬한 JSON 표현을 별도로 사용한다. */
function payloadScanText(req: ApprovalRequest): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number" || typeof v === "boolean") out.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    //  키를 정렬해서 돈다 — 안 하면 같은 내용이 다른 순서로 왔을 때 스캔 문자열이 달라지고,
    //  이 경로에서는 text 가 곧 target 이라 같은 작업에 열쇠가 두 개 생긴다(S0 정본 시험이 잡았다).
    else if (v && typeof v === "object") for (const k of Object.keys(v as Record<string, unknown>).sort()) walk((v as Record<string, unknown>)[k]);
  };
  walk(req.params ?? null);
  return out.join(" ");
}

/** 받은 payload 를 키 순서에 흔들리지 않게 문자열로 굳힌다. operation hash 전용 — 스캔은 payloadScanText 를 쓴다. */
function stablePayloadJson(req: ApprovalRequest): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      // __proto__도 일반 own property로 보존하도록 Object.fromEntries를 쓴다. 일반 객체 대입은 프로토타입으로 처리되어 JSON 해시에서 빠지고 다른 요청과 충돌한다.
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])] as const),
      );
    }
    return v;
  };
  return JSON.stringify(stable({ method: req.method, params: req.params ?? null }));
}

function unparsedPayloadDigest(req: ApprovalRequest): string {
  return createHash("sha256").update(stablePayloadJson(req)).digest("hex").slice(0, 16);
}

/** M5.2 — permission_request 상태를 폴링해 GD 결정을 ReviewDecision으로. 무응답 TTL→denied(hold). */
export async function pollDecision(db: Database, requestId: string, ttlMs = POPUP_TTL_MS, intervalMs = POLL_INTERVAL_MS): Promise<ReviewDecision> {
  const deadline = Date.now() + ttlMs;
  for (;;) {
    let status: string | undefined;
    let scope: string | null | undefined;
    try {
      const row = getPermissionRequest(db, requestId);
      status = row?.status;
      // status 와 decision_scope 를 같이 읽는다. '이 세션' 은 지속되는 허가를 남기지 않아
      //   status 가 allowed_once 와 같다(permissionGate.ts) — 둘을 가르는 것은 이 칸뿐이다.
      //   status 만 읽으면 사람이 세션을 골라도 런타임에는 '한번' 이 간다.
      scope = row?.decision_scope ?? null;
    } catch {
      return "denied"; // fail-closed: 조회 에러 → 거절
    }
    // 행이 스스로 만료를 말한다 — 이 프로세스의 deadline 과 무관하게(재시작 후에도 유효).
    if (status === "pending" && isExpiredRow(db, requestId)) {
      try { expirePermissionRequest(db, requestId); } catch { /* best-effort */ }
      return "denied";
    }
    switch (status) {
      // decision_scope가 session일 때만 세션 허용한다. NULL·미지원 값은 한 번 허용으로 두어 이전 결정을 소급 확대하지 않는다.
      case "allowed_once": return scope === "session" ? "approved_for_session" : "approved";
      case "allowed_always": return "approved_for_session";
      case "denied":
      case "expired": return "denied";
      case undefined: return "denied"; // 요청 사라짐 = 거절
      // "pending" → 계속 폴링
    }
    if (Date.now() >= deadline) {
      // 무응답 만료 — 행도 expired 로 닫는다.
      //   안 닫으면 행이 pending 으로 남아, 한참 뒤에 누른 탭이 이미 끝난 턴을 승인 한다.
      //   버튼도 그때 지워져서 사람이 "만료됐다" 를 화면에서 본다(헤르메스와 같은 모양).
      try { expirePermissionRequest(db, requestId); } catch { /* best-effort — 만료 판정은 유지 */ }
      return "denied";
    }
    await sleep(intervalMs);
  }
}

/** 행에 박힌 만료시각이 지났나. 컬럼이 없거나 값이 없으면 만료 아님(폴링 deadline 이 받친다). */
export function isExpiredRow(db: Database, requestId: string): boolean {
  try {
    const r = db.prepare("SELECT (expires_at IS NOT NULL AND datetime('now') > expires_at) AS gone FROM permission_request WHERE id = ?").get(requestId) as { gone?: number } | undefined;
    return Boolean(r?.gone);
  } catch { return false; }
}

/** 아직 pending 인 요청만 expired 로 닫는다(이미 결정된 것은 건드리지 않는다). */
export function expirePermissionRequest(db: Database, requestId: string): void {
  db.prepare("UPDATE permission_request SET status='expired', decided_at=datetime('now') WHERE id=? AND status='pending'").run(requestId);
}

/** 길이 제한은 명령 승인에만 적용한다. 파일 변경 내용은 길어도 정상이라 같은 제한으로 거절하면 안 된다.
 * 해석된 명령 또는 해석 실패 payload의 값만 세며 표시 안내·해시처럼 추가한 문구는 길이 판정에서 제외한다. */
export function oversizedForReview(req: ApprovalRequest): number | null {
  const parsed = parseCommandApproval(req);
  if (parsed.kind === "not_command") return null;   // 파일 변경·그 밖의 승인은 이 규칙 대상이 아니다
  const len = parsed.kind === "ok" ? parsed.command.length : payloadScanText(req).length;
  return len > COMMAND_REVIEW_LIMIT ? len : null;
}

/** 지금이 시험 실행인가. 시험이면 실제 전송을 막는다(fetchFn 을 넣어 준 시험은 그 가짜로 검증한다). */
export function isTestRun(): boolean {
  return process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1" || Boolean(process.env.B3OS_TEST);
}

/** 승인 팝업은 해당 팀원 봇으로 보내고 콜백은 그 봇을 폴링하는 브리지가 처리한다. getUpdates는 봇당 한 프로세스만 허용된다. */
export async function sendApprovalToMemberRoom(
  agentId: string,
  requestId: string,
  req: ApprovalRequest,
  deps: {
    token?: string; chatId?: string; fetchFn?: typeof fetch; resolveDestination?: () => string | null;
    /** 위험 표시 — tierDReasons 결과. 카드에 적고, 있으면 '항상 허용' 버튼을 빼는 근거가 된다. */
    risks?: string[];
    /** 이 팀원의 채널(시험 주입). 없으면 agents.json 의 channel. */
    channel?: MemberChannel;
    allowAlways?: boolean;
    ownerId?: string;
    requireDelivery?: boolean;
    onDelivered?: (delivery: {owner_id:string;chat_id:string;message_id:number}) => boolean;
  } = {},
): Promise<boolean> {
  const risks = deps.risks ?? [];
  // 시험에서는 실제 토큰·방으로 팝업을 보내지 않도록 발신 함수 자체에서 외부 전송을 차단한다.
  if (isTestRun() && !deps.fetchFn) return false;

  const paths = codexBridgePaths(agentId);
  let token = deps.token;
  if (!token) {
    try { token = readFileSync(paths.tokenFile, "utf-8").trim(); } catch { return false; }
  }
  // 목적지는 해당 팀원 봇과 오너의 DM이며 b3chat은 owner_chat을 쓴다. allowFrom은 인가 목록이라 그룹이 앞에 올 수 있으므로 목적지로 사용하지 않는다.
  // 목적지를 모르면 발송하지 않으며 해석기를 주입해 인가 목록과 DM이 다른 조건도 검증한다.
  const channel = deps.channel ?? readMemberChannel(agentId);
  const b3chat = channel.kind === "b3chat";
  const ownerId = deps.ownerId ?? channel.ownerChat ?? (deps.resolveDestination ?? resolveOwnerDmId)();
  const chatId = deps.chatId ?? (b3chat ? channel.ownerChat : ownerId);
  if (deps.requireDelivery && (b3chat || !ownerId || !/^[1-9]\d*$/.test(ownerId))) return false;
  if (!token || !chatId) {
    if (b3chat && token) console.warn(`[codex-approval] ★b3chat owner_chat 이 없어 승인 요청을 못 띄운다★ agent=${agentId} request=${requestId}`);
    return false;
  }
  if (channel.error) {
    console.warn(`[codex-approval] ★채널 설정 오류(${channel.error}) — 승인 요청을 보내지 않는다★ agent=${agentId} request=${requestId}`);
    return false;
  }
  if (b3chat) return sendApprovalPlain(channel.apiBase, token, chatId, agentId, requestId, req, risks, deps.fetchFn ?? fetch);

  // 간결하게 — 사람이 폰에서 한눈에 보고 누른다. 무엇을 하려는지 한 줄, 그 아래 대상.
  const { title, detail } = approvalSummary(req);
  // 위험 사유를 카드에 적는다. 우리가 대신 막지 않기로 했으면 판단 근거는 줘야 한다.
  //   이 줄이 없으면 `sudo rm -rf /` 와 `ls` 가 폰에서 생김새가 같다.
  const riskLine = risks.length ? `\n\n${escapeHtml(uiText("approval_risk",{risks:risks.join(" · ")}))}` : "";
  const text = (detail ? `${uiText("approval_card",{title})}\n\n<code>${escapeHtml(detail)}</code>` : uiText("approval_card",{title})) + riskLine;
  const doFetch = deps.fetchFn ?? fetch;
  try {
    const res = await doFetch(`${channel.apiBase}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        // 버튼은 폰 공간을 줄이도록 한 줄에 배치한다. 위험 표시는 무인 반복을 허용하는 24시간 지속 grant를 막는다.
        // 한 번·세션 허용은 제공하되 세션 허용은 지속 grant를 남기지 않고 Codex 세션과 함께 끝난다.
        reply_markup: { inline_keyboard: [risks.length || deps.allowAlways === false
          ? [
              { text: uiText("approval_allow_once"), callback_data: `pg1:${requestId}` },
              { text: uiText("approval_allow_session"), callback_data: `pgs:${requestId}` },
              { text: uiText("approval_deny"), callback_data: `pgd:${requestId}` },
            ]
          : [
              { text: uiText("approval_allow_once"), callback_data: `pg1:${requestId}` },
              { text: uiText("approval_allow_session"), callback_data: `pgs:${requestId}` },
              { text: uiText("approval_allow_always"), callback_data: `pga:${requestId}` },
              { text: uiText("approval_deny"), callback_data: `pgd:${requestId}` },
            ]] },
      }),
    });
    if (!res.ok) return false;
    if (deps.onDelivered) {
      const body = await res.json() as {ok?:boolean;result?:{message_id?:number;chat?:{id?:number}}};
      const messageId = body.result?.message_id;
      const responseChat = body.result?.chat?.id;
      if ((deps.requireDelivery || responseChat !== undefined) && String(responseChat) !== String(chatId)) return false;
      if (body.ok !== true || !Number.isSafeInteger(messageId) || messageId! <= 0 || !ownerId) return false;
      return deps.onDelivered({owner_id:ownerId,chat_id:String(chatId),message_id:messageId!});
    }
    return true;
  } catch { return false; }
}

/** b3chat은 parse_mode·버튼 저장을 지원하지 않을 수 있어 승인 대상을 평문으로 남기고 버튼도 함께 보낸다.
 * 버튼 전송이 거절되면 버튼 없이 한 번 재시도하고 실패를 기록한다. 팀원 방 승인은 op /approve에 없으므로 버튼 미지원이면 만료 후 미실행된다. */
async function sendApprovalPlain(
  apiBase: string, token: string, chatId: string, agentId: string, requestId: string,
  req: ApprovalRequest, risks: string[], doFetch: typeof fetch,
): Promise<boolean> {
  // 카드 모양·512바이트 한도·버튼 재시도는 공통 카드 전송이 맡는다(cogs 클로드 승인과 같은 길).
  const r = await sendApprovalCard(apiBase, token, chatId, cogsCardInputFor(req, requestId, risks, !risks.length), doFetch, { agentId });
  return r.ok;
}

/** 코덱스 승인 요청 → cogs 카드 입력(무엇을·대상·폴더 전체 요청 표시). 팝업 경로와 cogs 정책 경로가 같이 쓴다. */
export function cogsCardInputFor(req: ApprovalRequest, requestId: string, risks: string[], allowAlways: boolean): ApprovalCardInput {
  const params=(req.params??{}) as Record<string,unknown>;
  const operationCode=params.command ? "run_command" : params.fileChanges || params.changes || req.observedItem?.changes.length ? "edit_files" : params.reason ? "request_permission" : "approval_required";
  const observed=req.observedItem?.changes;
  const target=cogsActivityArgs(observed?.length ? {changes:observed} : params);
  let detail: string | undefined;
  if (target.target) detail=target.target;
  if (target.count!==undefined) detail=String(target.count);
  const root=grantRootOf(params);
  return { requestId, operationCode, detail, grantRoot: root ? grantRootDisplay(root) : undefined, risks, allowAlways };
}

/**
 * 팝업 문구 — 무엇을 하려는지 한 줄(title) + 그 대상(detail).
 * 폰에서 한눈에 읽혀야 한다. 긴 것은 자른다(안 자르면 버튼이 화면 밖으로 밀린다).
 */
export function approvalSummary(req: ApprovalRequest): { title: string; detail?: string } {
 const summary=approvalSummaryBase(req);
 const root=grantRootOf(req.params as Record<string,any>);
 const result = root ? {title:uiText("approval_root_title"),detail:[uiText("approval_grant_root",{root}),summary.detail].filter(Boolean).join("\n")} : summary;
 return { ...result, ...(result.detail ? { detail: redactApprovalText(result.detail) } : {}) };
}
function approvalSummaryBase(req: ApprovalRequest): {title:string;detail?:string} {
  const p = (req.params ?? {}) as Record<string, unknown>;
  const cmd = p.command;
  const cmdText = typeof cmd === "string" ? cmd : Array.isArray(cmd) ? cmd.join(" ") : null;
  if (cmdText) return { title: uiText("approval_command"), detail: clip(redactApprovalText(cmdText), 2000) };

  if (req.method === "item/permissions/requestApproval") {
    const permissions = p.permissions as { fileSystem?: { read?: string[]; write?: string[]; entries?: unknown[] }; network?: { enabled?: boolean } } | undefined;
    const fs = permissions?.fileSystem;
    const paths = [...(fs?.read ?? []).map((path) => `${uiText("approval_read_path")}: ${path}`), ...(fs?.write ?? []).map((path) => `${uiText("approval_write_path")}: ${path}`)];
    for (const raw of fs?.entries ?? []) {
      const entry = raw as {access?: string; path?: {path?: string; pattern?: string; value?: unknown}};
      const path = entry.path?.path ?? entry.path?.pattern;
      const label = entry.access === "read" ? uiText("approval_read_path") : entry.access === "write" ? uiText("approval_write_path") : entry.access;
      paths.push(path && label ? `${label}: ${path}` : JSON.stringify(raw));
    }
    if (permissions?.network?.enabled) paths.push(uiText("approval_network"));
    return { title: uiText("approval_permission"), detail: clip([typeof p.reason === "string" ? p.reason : "", ...paths].filter(Boolean).join("\n"), 2000) };
  }

  if (req.observedItem?.changes.length) {
    return { title: uiText("approval_files", { count: req.observedItem.changes.length }), detail: clip(req.observedItem.changes.map((c) => c.movePath ? `${c.path} → ${c.movePath}` : c.path).join("\n"), 2000) };
  }

  const changes = p.fileChanges;
  if (changes && typeof changes === "object") {
    const files = Object.keys(changes as Record<string, unknown>);
    const head = files.slice(0, 3).join("\n");
    return { title: uiText("approval_files",{count:files.length}), detail: clip(files.length > 3 ? `${head}\n${uiText("approval_more_files",{count:files.length-3})}` : head) };
  }
  if (typeof p.reason === "string") return { title: uiText("approval_permission"), detail: clip(p.reason) };
  return { title: uiText("approval_required"), detail: req.method };
}

function clip(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * M5.3 진입점 — ask-tier 승인요청을 팝업으로 처리. onApproval에서 needsApproval일 때 호출.
 * 반환 전까지 codex 턴이 대기하므로, 상위(runner)는 이 대기 동안 turn timeout을 연기해야 한다(M5.3 배선).
 */
export async function requestApprovalPopup(db: Database, req: ApprovalRequest, agentId: string, cwd?: string, ttlMs = POPUP_TTL_MS, options: { allowAlways?: boolean; failOnSendError?: boolean; folderSessions?: FolderSessionApprovals; deliveryDeps?: Parameters<typeof sendApprovalToMemberRoom>[3] } = {}): Promise<ReviewDecision> {
  const store = new CodexApprovalCorrelationStore(db);
  const folder = options.allowAlways === false;
  const opHash = folder ? folderOperationDigest(req) : approvalOperationHash(req);
  if (!opHash) {
    appendAudit(db, agentId, "codex_folder_content_unknown", req.method, {});
    return "denied";
  }
  const requestIdentity = () => JSON.stringify([req.serverRequestId ?? null, req.params.threadId ?? null, req.params.turnId ?? null, req.params.itemId ?? null, req.params.callId ?? null]);
  const initialIdentity = requestIdentity();
  const deliveryMatches = () => folderOperationDigest(req) === opHash && requestIdentity() === initialIdentity;
  const reuse = folder ? options.folderSessions?.get(agentId, req) : undefined;

  //  너무 긴 요청은 팝업을 만들지 않고 거절한다 — 사람이 읽고 판단할 수 있는 대상이 아니다.
  //  조용히 통과시키지도, 못 읽을 것을 사람에게 들이밀지도 않는다. 기록을 남겨 따로 검토 하게 한다.
  const oversized = oversizedForReview(req);
  if (oversized !== null) {
    try {
      appendAudit(db, agentId, "codex_approval_oversized", req.method, {
        length: oversized,
        limit: COMMAND_REVIEW_LIMIT,
        operation_hash: opHash,
        note: "명령이 너무 길어 승인 팝업을 만들지 않고 거절했습니다. 원문을 따로 검토하세요.",
      });
    } catch { /* 기록 실패가 거절을 막지 않는다 */ }
    return "denied";
  }

  let requestId: string | undefined;
  let risks: string[] = [];
  try {
    const op = buildOperationFromApproval(req, agentId, cwd);
    // 위험 사유를 카드에 싣는다.
    //   우리가 대신 막지 않기로 했으면 사람이 판단할 근거를 줘야 그 전제가 성립한다.
    //   그 전까지 `sudo rm -rf /` 와 `ls` 가 폰에서 생김새가 같았다.
    risks = tierDReasons(op);
    op.provenance = {...op.provenance,...(folder ? {operation_hash:opHash} : {}),codex_approval:{
      allowed_decisions: options.allowAlways === false || risks.length ? ["allow_once","allow_session","deny"] : ["allow_once","allow_session","allow_always","deny"],
      telegram_delivery: null,
    }};
    const res = requestPermission(db, op); // 팝업 생성(telegramCapture가 렌더)
    // ※ Tier-D 로 여기서 deny 하던 "이중 안전" 은 없어졌다(우리가 판정하지 않는다).
    //   이 분기는 grant 조회 결과가 deny 일 때만 남아 있다. 위험 명령은 이제 카드로 올라간다.
    if (res.decision === "deny") return "denied";
    if (res.decision === "allow") return "approved"; // 이미 grant 있으면 통과(기존 grant는 permissionGate가 벤팅)
    requestId = res.request?.id;
  } catch {
    return "denied"; // fail-closed: 팝업 생성 실패 → 거절
  }
  if (!requestId) return "denied";
  // Phase1 ③: 팝업↔app-server 요청 1:1 상관키 record(pending). best-effort — 미기록이면 finalize가 fail-closed.
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
  // 만료 시각을 행에 박는다 — 기다리는 프로세스가 죽어도 행이 스스로 만료를 말한다.
  try {
    db.prepare("UPDATE permission_request SET expires_at = datetime('now', ?) WHERE id = ?")
      .run(`+${Math.round(ttlMs / 1000)} seconds`, requestId);
  } catch { /* best-effort — 컬럼이 없어도 폴링 deadline 이 받쳐준다 */ }

  // A remembered decision still gets its own row, correlation, CAS and delivery audit.
  if (reuse) {
    try {
      const source = getPermissionRequest(db, reuse.requestId);
      const sourcePolicy = JSON.parse(source?.provenance_json ?? "{}").codex_approval;
      const sourceCorrelation = store.get(reuse.requestId);
      if (sourceCorrelation?.state !== "delivered" || sourceCorrelation.operation_hash !== opHash || sourceCorrelation.process_instance !== PROCESS_INSTANCE ||
          source?.status !== "allowed_once" || source.decision_scope !== "session" ||
          JSON.stringify(sourcePolicy?.telegram_delivery) !== JSON.stringify(reuse.delivery)) throw new Error("invalid session source");
      const row = getPermissionRequest(db, requestId)!;
      const provenance = JSON.parse(row.provenance_json ?? "{}");
      provenance.codex_approval = {...provenance.codex_approval, telegram_delivery: reuse.delivery, session_source_request: reuse.requestId};
      db.prepare("UPDATE permission_request SET provenance_json=? WHERE id=? AND status='pending'").run(JSON.stringify(provenance), requestId);
      if (!decidePermissionRequest(db, requestId, "allow_session", {approver:reuse.delivery.owner_id}).ok) throw new Error("session decision failed");
      if (!deliveryMatches()) throw new Error("operation changed");
      appendAudit(db, agentId, "codex_session_approval_reused", req.method, {request_id:requestId,source_request:reuse.requestId,operation_hash:opHash,telegram_delivery:reuse.delivery});
      return finalizeApprovalDelivery(store, requestId, opHash, "approved");
    } catch {
      expirePermissionRequest(db, requestId);
      return finalizeApprovalDelivery(store, requestId, opHash, "denied");
    }
  }
  // 그 팀원 방에 띄운다. 실패해도 요청 행은 남으므로 op 목록에서 여전히 보인다(조용히 사라지지 않는다).
  const sent = await sendApprovalToMemberRoom(agentId, requestId, req, {
    ...options.deliveryDeps, risks, allowAlways: options.allowAlways, requireDelivery: options.allowAlways === false,
    onDelivered: delivery => {
      const row = getPermissionRequest(db,requestId!);
      if (!row || row.status !== "pending") return false;
      const provenance = JSON.parse(row.provenance_json ?? "{}");
      provenance.codex_approval = {...provenance.codex_approval,telegram_delivery:delivery};
      return db.prepare("UPDATE permission_request SET provenance_json=? WHERE id=? AND status='pending'")
        .run(JSON.stringify(provenance),requestId!).changes === 1;
    },
  });
  if (!sent) {
    try { appendAudit(db, agentId, "codex_approval_room_send_failed", req.method, { request_id: requestId }); } catch { /* best-effort */ }
    if (options.failOnSendError) {
      expirePermissionRequest(db, requestId);
      return finalizeApprovalDelivery(store, requestId, opHash, "denied");
    }
  }
  const decision = await pollDecision(db, requestId, ttlMs);
  // Re-read the complete folder operation immediately before committing its delivery.
  if (folder) {
    if (!deliveryMatches()) {
      appendAudit(db, agentId, "codex_folder_operation_changed", req.method, {request_id:requestId,operation_hash:opHash});
      return finalizeApprovalDelivery(store, requestId, opHash, "denied");
    }
    const delivered = finalizeApprovalDelivery(store, requestId, opHash, decision === "approved_for_session" ? "approved" : decision);
    if (delivered === "approved" && decision === "approved_for_session") {
      const row = getPermissionRequest(db, requestId);
      const delivery = JSON.parse(row?.provenance_json ?? "{}").codex_approval?.telegram_delivery;
      if (delivery) options.folderSessions?.remember(agentId, req, {requestId, delivery});
    }
    return delivered;
  }
  return finalizeApprovalDelivery(store, requestId, opHash, decision);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

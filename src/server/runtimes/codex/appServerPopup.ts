/**
 * M5 — codex app-server 승인요청 → GD 텔레그램 팝업(기존 승인 인프라 재사용).
 *
 * ★재빌드 아님:★ permissionGate.requestPermission(팝업 생성)+getPermissionRequest(상태) + telegramCapture(3버튼 렌더)
 * 를 재사용. onApproval이 ask면 여기서 팝업 띄우고 GD 결정을 폴링해 ReviewDecision으로 매핑한다.
 *
 * 매핑: allowed_once→approved(★decision_scope 가 session 이면 approved_for_session★) ·
 * allowed_always→approved_for_session · denied/expired/timeout→denied.
 * ★안전: Tier-D는 requestPermission(permissionGate)이 ★팝업을 만들기 전에★ deny 로 반환한다("이중 안전" 지점).
 *   이 자리의 판정은 judgeApproval 이 아니다 — #316 에서 경계가 codex 설정으로 넘어가며 경로에서 빠졌고,
 *   아무도 부르지 않던 그 함수는 삭제됐다. ★주석만 남으면 없는 방어선을 있다고 읽는다.★
 *   fail-closed(에러/무응답→denied)는 그대로다.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { requestPermission, getPermissionRequest, tierDReasons, type PermissionOperation } from "../../lib/permissionGate";
import type { ApprovalRequest, ReviewDecision } from "./appServerClient";
import { CodexApprovalCorrelationStore } from "./state";
import { appendAudit } from "../../db/queries";
import { readFileSync } from "node:fs";
import { codexBridgePaths, resolveOwnerDmId } from "./launcher";

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
 *  ★이 해시가 하지 ★않는★ 것 — 알려진 갭 3건과 현재 상태:★
 *   1. ★권한 grant 재사용을 막지 못한다★ → ★S5 에서 닫혔다.★
 *      grant scope 의 target 이 앞 240자만 쓰던 문제를, ★이 함수가 만드는 값 안에 명령 전체의 지문을 넣어★
 *      절단선 안에 남기는 방식으로 해결했다(공용 permissionGate 는 무수정). 실제 DB 경로 회귀 테스트로 고정.
 *   2. ★같은 파일의 내용 변경을 구분하지 못한다★ → ★S4 에서 닫혔다.★ approvalContentDigest 가 내용을 basis 에 넣는다.
 *      (단 ★권한 열쇠(scope)에는 내용이 여전히 안 들어간다 — 이건 버그가 아니라 S2/S3 설계 의도다.★
 *       넣으면 같은 파일을 고칠 때마다 열쇠가 달라져 '항상 허용' 이 영원히 안 붙는다.)
 *   3. ★승인 후 실행 직전의 변경을 잡지 못한다★ → ★고치지 않는다.★
 *      이 해시는 승인 ★전에 한 번★ 계산해 그 캡처값을 finalize 에 넘긴다 — 실행 직전에 다시 계산하지 않는다.
 *      ★그런데 이 버전(codex-cli 0.144.6 · rust-v0.144.6 / 5d1fbf26)에서는 그 창이 열리지 않는다.★ 근거:
 *        · patchUpdated 는 apply_patch ★입력 스트리밍 progress★ 이고 Feature::ApplyPatchStreamingEvents 가
 *          ★default_enabled: false★ 다(features/src/lib.rs:957, Stage::UnderDevelopment).
 *          켜도 최종 tool call·승인 요청 ★이전★ 에 끝난다.
 *        · ★승인 대기 중 같은 call_id 의 patch 를 갈아끼우는 경로가 없다★ — request_patch_approval 이 changes 를
 *          ★값으로 받아★ call_id 로 oneshot 채널을 걸고 기다린다(session/mod.rs:2249~).
 *        · ★steer 는 즉시 반영되지 않는다★ — pending_input 으로 큐잉되어 ★다음 모델 요청 전에★ drain 된다
 *          (session/mod.rs:3931~). 그래서 기존 승인이 해소되기 전에는 실행되지 않고, 거절하면 ★새 itemId 의
 *          별도 승인★ 으로 다시 올라온다.
 *        · 반대로 ★받는 쪽은 열려 있다★ — 갱신본이 오기만 하면 이쪽 색인은 승인 대기 중에도 갱신되어 스냅샷과
 *          갈린다. 즉 ★막힌 곳은 보내는 쪽이다.★
 *        · patchUpdated 자체는 규격에 ★실재하는 서버 알림★ 이다(ServerNotification 68종 중 하나).
 *          ★"프로토콜에 없다" 로 쓰면 틀린다.★
 *      ★이 판정은 버전에 묶인다.★ codex 가 저 기능을 기본 활성으로 바꾸거나 승인 중 갱신 경로를 만들면 ★다시 열린다.★
 *      재확인 지점을 넣는다면 ★finalize 직전 하나★ 다 — 사람의 ★내용-특정 동의가 존재하는 곳이 거기뿐★ 이기 때문이다
 *      (grant 경로는 애초에 내용을 안 보고 준 동의라 재확인할 대상이 없다).
 *      ★남는 한계★: 결정을 돌려준 ★이후★ codex 가 실행하기까지의 구간은 ★관측 불가★ 다(벤더 안쪽).
 *      어디에 재확인을 두든 그 구간은 남는다 — ★"완전히 닫았다" 고 쓰면 안 된다.★ */
export function approvalOperationHash(req: ApprovalRequest): string {
  const p = req.params as Record<string, any>;
  const basis: Record<string, unknown> = {
    method: req.method,
    // ★신세대 문자열 command 도 담는다★ — 예전엔 Array.isArray 만 봐서 신세대는 null 이 됐고,
    //   그 결과 ★서로 다른 신세대 명령이 같은 지문★ 을 가졌다(2026-07-29 재현 확인).
    //   S1 이 그 문자열을 실제 shell operation 으로 승격하므로, 상관키·audit 지문도 구분해야 한다.
    //   ★배열은 배열 그대로 둔다★ — 구세대 지문 값을 바꾸지 않기 위해서다(변경 범위 최소).
    command: Array.isArray(p.command) ? p.command : (typeof p.command === "string" ? p.command.trim() || null : null),
    // ★이동 목적지도 담는다(P1)★ — 예전엔 출발지만 담아 목적지만 다른 두 요청이 같은 지문이었다.
    //   move_path 가 없으면 결과가 Object.keys().sort() 와 완전히 같다(golden 고정).
    files: p.fileChanges && typeof p.fileChanges === "object" ? fileChangeEntries(p.fileChanges) : null,
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
  // ★S4 — 내용까지 담는다.★ 여기까지의 basis 는 파일 ★이름★ 만 담아서, 같은 파일을 고치는 두 요청이
  //   ★내용이 전혀 달라도 같은 지문★ 이었다(알려진 갭 #2 — 테스트로 못박아 뒀던 것).
  //   상관키가 ★결정↔요청을 1:1로 맞추는 것★ 이 이 지문의 일인데, 이름만 보면
  //   ★다른 작업의 승인이 이 슬롯에 배달되는 것★ 을 못 막는다.
  //   ★있을 때만 넣는다★ — 무조건 키를 추가하면 null 로라도 직렬화에 끼어들어 ★구세대 지문 값이 바뀐다★
  //   (진행 중 승인의 상관키가 어긋난다). S2 에서 item_id·grant_root 에 쓴 것과 같은 규칙이다.
  const contentDigest = approvalContentDigest(req);
  if (contentDigest) basis.content = contentDigest;
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

/** 승인 요청이 실제로 바꾸려는 ★내용★ 의 지문. 내용을 모르면 null(그러면 basis 에 키가 안 붙는다).
 *
 *  ■ 어디서 내용을 얻나 — 세대마다 다르다(둘 다 실측)
 *    구세대 `fileChanges` : `{type:"update", unified_diff}` · `{type:"add"|"delete", content}` (+`move_path`)
 *    신세대               : payload 에 내용이 ★없다.★ 알림으로 먼저 온 것을 색인한 `observedItem` 에 있다.
 *
 *  ■ ★전문이 아니라 해시만 담는다★ — 지문은 "같은가 다른가" 만 답하면 되고,
 *    전문을 basis 에 넣으면 큰 diff 마다 직렬화가 커진다.
 *
 *  ■ ★종류·이동 목적지도 함께 담는다★ — 같은 내용을 add 하는 것과 update 하는 것은 다른 작업이고,
 *    옮기는 목적지가 다른 것도 다른 작업이다(S2·S3 에서 열쇠에 대해 배운 것과 같은 이유).
 */
function approvalContentDigest(req: ApprovalRequest): string | null {
  const p = req.params as Record<string, any>;
  // ★body 는 string | null 이다 — ""(빈 내용을 안다) 와 null(내용을 모른다) 은 다른 상태다.★
  //   앞선 판은 둘을 "" 하나로 합쳐서 ★빈 파일 생성과 빈 파일 삭제가 같은 지문★ 이었다(P1 · 재현 확인).
  //   basis.files 에는 kind 가 없으므로 그 둘을 갈라줄 다른 재료도 없었다.
  const rows: Array<[string, string, string | null, string | null]> = [];

  // 신세대 — 관측해 둔 변경(내용 포함). 관측이 있으면 그 내용은 ★아는 것★ 이다(빈 문자열도 포함).
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
      // ★종류에 맞는 필드만 본다★ — 짝이 어긋난 payload 에서 엉뚱한 값을 지문에 넣지 않기 위해서다
      //   (S3 에서 표시 쪽에 같은 정정을 했다: 재료를 고르는 기준과 쓰는 기준이 달라 규모를 지어냈다).
      //   ★필드가 없으면 null★ — "내용이 비어 있다" 가 아니라 "내용을 모른다" 다.
      const body =
        kind === "update"
          ? typeof ch.unified_diff === "string" ? ch.unified_diff : null
          : kind === "add" || kind === "delete"
            ? typeof ch.content === "string" ? ch.content : null
            // 모르는 종류만 휴리스틱 — 있는 쪽을 쓴다. ★빈 문자열도 '있는 것' 으로 센다★
            //   (unified_diff:"" 가 content:"X" 를 가리는 것은 의도된 우선순위다: 종류를 모를 때
            //    먼저 선언된 필드를 믿는다. 시험으로 고정한다.)
            : typeof ch.unified_diff === "string" ? ch.unified_diff : typeof ch.content === "string" ? ch.content : null;
      rows.push([path, kind, mv, body]);
    }
  }
  // ★하나라도 '아는' 내용이 있으면 지문화한다★ — 길이가 아니라 ★null 여부★ 로 판정한다.
  //   길이로 재면 ★빈 파일 작업이 "모름" 과 합쳐진다★(P1). 아무것도 모르면 키를 안 붙여 구세대 골든을 지킨다.
  if (!rows.some((r) => r[3] !== null)) return null;
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

// ★반응이 5분 넘게 없으면 무효.★
//   1시간이면 그동안 codex 턴이 통째로 매달려 그 팀원이 아무 일도 못 한다.
const POPUP_TTL_MS = Number(process.env.B3OS_CODEX_APPSERVER_POPUP_TTL_MS ?? 5 * 60 * 1000);
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
  | { kind: "ok"; command: string; material: string };

/** 명령 승인 요청을 파싱한다. ★'명령 method 가 아님' 과 '명령 method 인데 못 읽음' 을 구분한다.★
 *
 *  ★왜 구분해야 하나 (2026-07-29 리뷰에서 잡힌 실제 구멍):★
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
  //  ★command 는 사람이 보는 줄, material 은 열쇠를 가르는 재료 — 둘을 분리한다.★
  //  분리하는 이유: 사람 눈 문자열로 합치면 ★실제로 다른 작업이 같은 문자열이 된다.★ (실측)
  //  · 구세대 ['a b','c'] 와 ['a','b c'] → join(" ") 후 둘 다 "a b c" → 같은 열쇠 → 두 번째가 팝업 없이 통과.
  //  → material 은 ★원본 구조(배열은 배열대로) + method(세대 표식)★ 를 JSON 으로 굳혀 쓴다.
  //  구세대와 신세대를 method 로 가르는 것도 의도다 — 같아 보여도 경로가 다르면 ★따로 묻는다★(애매하면 ask).
  if (Array.isArray(raw)) {
    //  ★문자열이 아닌 원소는 해석 성공으로 받지 않는다.★
    //  String(x) 로 강제변환하면 ★서로 다른 payload 가 같은 재료가 된다★ (DB 경로에서 재현 확인):
    //    [1] 승인 뒤 ["1"] → allow · [null] 과 ["null"] → allow · [{}] 는 "[object Object]" 가 된다.
    //  이건 규격에 없는 payload 를 ★넓게 통과★ 시키는 자리다. 모르면 좁게 묻는다 —
    //  invalid 로 보내면 해석 실패 경로(S0: payload 지문 + 매번 묻기)를 받는다.
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

/**
 * ★이보다 긴 명령은 승인 흐름에 태우지 않는다 — 거절하고 따로 검토한다.★
 *
 * ★이 자리에 스캔 상한을 두지 않는다.★ 자르면 잘린 뒤가 검사에서 빠지고,
 * "얼마나 잘라야 안전한가" 에는 답이 없다.
 * ★자르지 않으면 그 문제가 통째로 사라진다★ — 받은 명령은 이미 우리 손에 있으니 전부 검사하면 된다.
 *
 * 대신 ★비정상적으로 긴 명령은 사람이 팝업으로 판단할 수 있는 대상이 아니다.★
 * 실측: 실제로 온 승인요청 5건의 명령 길이는 전부 45자.
 * 다만 ★설정 파일을 명령 안에 통째로 써 넣는 모양(heredoc)이 700자대★ 라, 1,000자는 여유가 1.4배뿐이었다.
 * 그래서 한도는 ★2,000자★ 다 — 정상 범위(~724자)의 약 3배.
 *
 * → 넘으면 ★팝업을 만들지 않고 거절★ 하고, `audit_event` 에 남겨 별도 검토로 보낸다.
 *   (조용히 통과시키지도, 사람에게 못 읽을 것을 들이밀지도 않는다.)
 */
const COMMAND_REVIEW_LIMIT = 2_000;

/**
 * ★S5 — 긴 명령 두 개가 한 열쇠로 묶이던 것을 닫는다.★
 *
 * ■ 무엇이 문제였나 (정본 테스트에 갭으로 박혀 있던 것)
 * 권한 열쇠(scopeKeyForOperation)는 target 을 쓰고, target 은 ★앞 240자만★ 본다.
 * 그래서 `y×240 + SAFE` 와 `y×240 + EVIL` 이 ★같은 열쇠★ 였다 —
 * ★안전한 명령에 '항상 허용' 을 한 번 주면 위험한 명령이 팝업 없이 통과★ 한다.
 *
 * ■ 어떻게 닫나 — ★공용 코드를 건드리지 않는다★
 * 우리가 만드는 값 안에 전체 명령의 지문을 넣어 240자 절단선 안에 살린다. permissionGate 는 그대로.
 *
 * ■ ★두 자리로 나눠 싣는 이유 — 한 필드가 두 가지 일을 하려다 둘 다 놓쳤다★
 *  · op.command → ★사람이 보는 줄이자 열쇠의 재료★ (target 우선순위 1위, 240자에서 잘림)
 *  · op.text    → ★위험 스캔용 전문★ (operationText 가 command·path·egress·text 를 이어 Tier-D 에 넣는다)
 *
 * command 하나에 다 싣고 2000자에서 자르면 ★2000자를 패딩으로 채우고 그 뒤에 sudo 를 붙였을 때
 * 게이트도 못 보고(스캔 밖) 사람도 못 봤다(화면 밖).★ 실측: 2100자 뒤 `; sudo id` → 탐지 0, 400자면 탐지됨.
 * 전문을 text 로 따로 보내면 탐지가 살아나고, ★열쇠는 안 바뀐다★(target 은 command 가 우선).
 *
 * ■ 지문을 뒤에 두는 이유
 * 스캔이 text 로 옮겨갔으므로 command 는 ★사람이 읽는 일만★ 하면 된다. 그래서 명령을 먼저 보여주고
 * 지문을 뒤에 붙인다(S3 쓰기 경로와 같은 모양). 예산 안에서 자르므로 지문은 240자 안에 반드시 남는다.
 * 자를 때는 ★코드포인트 경계★ 로 자른다 — UTF-16 으로 자르면 이모지·한글이 반토막 난다.
 */
function commandOperationFields(material: string, command: string): { command: string; text: string } {
  //  ★지문은 material(원본 구조 전문) 로 만든다 — 화면용으로 자른 값으로 만들지 않는다.★
  //  자른 값으로 만들면 잘린 뒤가 달라도 지문이 같아진다(실측: 앞 2000자 동일 → 두 번째 'allow').
  //
  //  ★자르지 않은 64 hex 전문을 쓴다.★ 표시용 체크섬이 아니라 ★팝업 우회를 막는 유일한 구분자★ 다.
  //  12 hex(48비트)면 SAFE/EVIL 후보를 각 2^24개씩 만들어 충돌시키는 게 GPU 로 현실적이다.
  const digest = createHash("sha256").update(material).digest("hex");
  // 공백 정규화 후 잘리므로(normalizeText → slice) ★지문 안에는 공백이 없어야 한다.★
  const suffix = ` #${digest}`;
  const budget = Math.max(0, VISIBLE_BUDGET - suffix.length);
  //  ★잘랐으면 잘랐다고 말한다.★ 표시가 없으면 사람은 ★이게 명령 전부인 줄★ 안다 —
  //  "kubectl delete ns prod " 뒤에 500자가 더 있어도 화면은 그냥 174자에서 끊긴다(실측).
  //  전문이 text 로 빠진 지금은 ★사람 눈에 닿는 경로가 이 한 줄뿐★ 이라 더 중요해졌다.
  //  S3 가 쓰기 경로에서 세운 규칙과도 같다 — 넘치면 몇 개가 잘렸는지 말한다.
  const truncated = command.length > budget;
  const visible = truncated ? `${cutCodePoints(command, Math.max(0, budget - 1))}…` : command;
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
  //  ★S5 에서 240자 절단 노출을 닫았다★ — 위 commandOperationFields 참조.
  const parsed = parseCommandApproval(req);
  if (parsed.kind === "ok") {
    return { runtime: "codex", agent_id: agentId, action: "shell", ...commandOperationFields(parsed.material, parsed.command), requested_by: agentId, provenance };
  }
  // ★명령 승인이라고 밝혔는데 명령을 못 읽었다 → 여기서 멈춘다.★ 아래 fileChanges 분기로 흘려보내면
  //   혼합 payload 가 write 로 처리되어 fail-closed 계약이 깨진다(2026-07-29).
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
    // ★grantRoot 로 보이는 낯선 키가 있으면 여기서 멈춘다★ — 폴더 전체 요청이 평범한 파일 쓰기로
    //   보이는 것보다 매번 묻는 게 낫다(벤더 개명 대비).
    if (hasUnreadGrantRootKey(p)) return unparsedOperation(req, agentId, provenance);
    return writeOperation(agentId, provenance, observed.changes, grantRootOf(p), observed.itemId);
  }
  // ★S3(#106) — 구세대도 신세대와 ★같은 것을 보여준다.★
  //
  //  지금까지 구세대 팝업은 ★파일 이름만★ 보여줬다("무엇이 어떻게 바뀌는지" 없이). 재료가 없어서가 아니었다 —
  //  ★벤더 스키마(0.144.6)를 실제로 읽어보니 구세대 payload 에도 내용이 실려 있다:★
  //    AddFileChange    { type: "add",    content }        DeleteFileChange { type: "delete", content }
  //    UpdateFileChange { type: "update", unified_diff, move_path? }
  //  ★모양을 짐작하지 않고 벤더 스키마에서 읽었다★ — 앞서 patchUpdated 를 짐작해 한 번 틀렸던 자리다.
  // ★배열은 파일 목록이 아니다(2026-07-30).★ `typeof [] === "object"` 라 그냥 통과했고,
  //   그 결과 ★인덱스 0 을 파일 경로로 표시★ 했다(실측: `change 0`). 모양이 아니면 해석 실패로 보낸다.
  if (p.fileChanges && typeof p.fileChanges === "object" && !Array.isArray(p.fileChanges)) {
    // ★S2: grantRoot 는 구세대 applyPatchApproval 에도 있다★ — 지금까지 통째로 무시하고 있었다.
    //   있으면 '이 파일들' 이 아니라 ★'이 루트 하위 전부' 를 세션 동안 허용해 달라는 요청★ 이다.
    //   열쇠에 반영하지 않으면 파일 몇 개에 준 '항상 허용' 이 루트 전체 승인으로 재사용된다.
    if (hasUnreadGrantRootKey(p)) return unparsedOperation(req, agentId, provenance); // 위와 같은 이유
    const oldChanges = oldGenChanges(p.fileChanges);
    // ★빈 목록은 '파일 0개 쓰기' 가 아니라 해석 실패다★ — 신세대(관측된 변경 0건)와 정책을 맞춘다.
    //   앞선 판은 `fileChanges: {}` 를 write 로 만들어 ★내용 없는 넓은 열쇠★ 를 하나 만들었다.
    if (oldChanges.length === 0) return unparsedOperation(req, agentId, provenance);
    return writeOperation(agentId, provenance, oldChanges, grantRootOf(p), null);
  }
  return unparsedOperation(req, agentId, provenance);
}

/** ★팝업에서 '이건 파일 몇 개가 아니다' 를 사람이 놓치지 않게 하는 머리말.★ 문구가 두 곳에서 같아야
 *  하므로 상수로 둔다(구세대·신세대 경로 모두 같은 위험을 같은 말로 알린다). */
const GRANT_ROOT_WARNING = "⚠ 세션 동안 아래 폴더 하위 전체에 쓰기 허용 요청 · ";

/** ★해석 실패 팝업의 첫 말.★ 팝업 앞줄(`… · approval_unparsed`)은 공용 코드가 만들어 여기서 못 바꾼다 —
 *  그래서 뒷줄이 사람에게 상황을 말한다. ★상수라서 열쇠 구분력에 영향이 없다.★ */
const UNPARSED_NOTICE = "내용 해석 실패 — 원문 확인 필요 · ";

/** grantRoot 를 꺼낸다. 빈 문자열·공백뿐이면 없는 것으로 본다.
 *  ★벤더 설명: "the agent is asking the user to allow writes under this root for the remainder of the
 *  session"★ — 즉 파일 단위 승인이 아니라 ★루트 단위 세션 승인★ 이다. UNSTABLE 표기지만 payload 에
 *  실려 오는 이상 ★우리 쪽 열쇠와 표시는 이걸 반영해야 한다.★ */
/** ★grantRoot 로 보이는데 우리가 안 읽는 키가 있으면 해석 실패로 보낸다(2026-07-30).★
 *
 *  ★왜 필요한가 — 실패가 조용하기 때문이다.★ 리뷰 중 payload 를 `grant_root` 로 잘못 만들어
 *  돌려보니, ★"⚠ 세션 동안 폴더 하위 전체 쓰기 허용" 경고가 화면에서 사라지고★ 서로 다른 폴더 요청
 *  두 건이 ★같은 열쇠★ 가 됐다. 0.144.6 에서는 도달 불가다(바이너리 문자열로 직접 확인:
 *  `grantRoot` 3건 / `grant_root` 0건). 그러나 ★벤더가 다음 버전에서 이름을 바꾸면 에러 하나 없이★
 *  폴더 전체 권한이 평범한 파일 쓰기로 보인다.
 *
 *  같은 형태의 실패가 이 저장소에 둘 있다 — `patchUpdated` 를 짐작한 것(안 오는 알림이었다),
 *  `Array.isArray(command)` 로 세대를 판정한 것(신세대가 통째로 미끄러졌다). ★모양이 바뀌면
 *  조용히 미끄러지는 자리에는 가드를 둔다.★ 배열·빈 목록에 이미 같은 정책(모르면 ask)을 쓰고 있다. */
function hasUnreadGrantRootKey(p: Record<string, any> | undefined): boolean {
  if (!p || typeof p !== "object") return false;
  return Object.keys(p).some((k) => k !== "grantRoot" && /grant.?root/i.test(k));
}

function grantRootOf(p: Record<string, any> | undefined): string | null {
  const raw = p?.grantRoot;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  // ★여기서 자르지 않는다(2026-07-29 · P2).★ 앞선 판은 300자로 잘랐는데, 그러면
  //   ★공통 prefix 가 긴 서로 다른 루트가 같은 값이 되어 열쇠·지문이 합쳐졌다★
  //   (310자 공통 + `/one` vs `/two` 로 재현 확인). 자르는 것은 ★표시할 때만★ 한다.
  return t.length > 0 ? t : null;
}

/**
 * ★쓰기 대상 한 건의 표기 — 이동이면 목적지까지 포함한다(2026-07-29 · P1).★
 *
 * 앞선 판은 출발지만 열쇠에 넣고 목적지는 ★팝업 글자에만★ 넣었다. 그래서 `a.ts→safe.ts` 와
 * `a.ts→outside/target.ts` 가 ★팝업 문구는 다른데 열쇠가 완전히 같았다.★
 * ★그게 특히 나쁜 이유★: 안전한 이동에 '항상 허용' 을 한 번 주면 위험한 목적지로의 이동은
 * ★팝업 자체가 안 뜬다★ — 사람이 그 차이를 볼 기회가 없다. ★팝업이 보여주는 것과 열쇠가 뜻하는 것이
 * 어긋나면, 보여준 쪽은 아무 힘이 없다.★
 */
function writeTargetEntry(path: string, movePath: string | null): string {
  return movePath ? `${path}>${movePath}` : path;
}

/** 구세대 fileChanges(경로 → FileChange) → 정렬된 쓰기 대상 표기 목록.
 *  ★move_path 는 UpdateFileChange 에만 있다★(0.144.6 스키마 실측) — 구세대에도 P1 과 ★같은 구멍★ 이
 *  있었다(지금까지 Object.keys 만 봤다). move_path 가 없으면 결과가 예전 Object.keys().sort() 와
 *  ★완전히 동일★ 하다 — 구세대 열쇠·지문 값 불변 조건이고 golden 으로 고정해 뒀다. */
function fileChangeEntries(fileChanges: Record<string, unknown>): string[] {
  return Object.entries(fileChanges)
    .map(([path, ch]) => {
      const mv = ch && typeof ch === "object" && typeof (ch as any).move_path === "string" ? (ch as any).move_path : null;
      return writeTargetEntry(path, mv && mv.trim() ? mv : null);
    })
    .sort();
}

/** 변경 규모(추가/삭제 줄수) — 사람이 ★'한 줄인지 삼백 줄인지'★ 를 가늠하게 하는 용도.
 *
 *  ★실측(2026-07-29, codex-cli 0.144.6 라이브)에서 diff 모양이 ★종류마다 다르다★ 는 것을 확인했다:★
 *    update → 진짜 통일diff        `@@ -1,4 +1,3 @@\n alpha\n-bravo\n+BRAVO\n charlie\n-delta\n`
 *    add    → ★파일 원문 그대로★   `HELLO\n`   (`+` 접두어도 `@@` 헤더도 없다)
 *  둘 다 통일diff 라고 가정해 `+`/`-` 만 세면 ★새 파일 생성이 전부 "(+0/-0)"★ 로 보인다 —
 *  ★사람에게 "아무것도 안 바뀐다" 로 읽히는 것이 제일 나쁜 거짓말이다.★ 그래서 모양을 판별해서 센다.
 *  (delete 는 라이브로 못 봤다 — 통일diff 가 아니면 삭제 규모로 센다.) */
function changeStat(kind: string, diff: string): { added: number; removed: number } {
  const lines = diff.split("\n");
  // ★모양이 아니라 종류로 판정한다(2026-07-30 · P2).★ 앞선 판은 `@@` 로 시작하는 줄이
  //   있으면 통일diff 로 봤는데, add/delete 의 `content` 는 ★파일 원문★ 이라 마크다운 제목 `@@ heading`
  //   같은 줄이 들어오면 통일diff 로 오판해 ★(+0/-0)★ 을 만든다(실측 재현: add·delete·신세대 add 전부).
  //   ★그게 이 함수가 애초에 막으려 했던 거짓말 그 자체다.★ 벤더 스키마상 통일diff 는 update 뿐이므로
  //   update 면 diff 로 세고, add/delete 면 원문 줄수로 센다. ★모르는 종류만 모양으로 추정한다.★
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
  // 통일diff 가 아니면 ★원문★ 이다. 끝 개행 때문에 생기는 빈 줄은 빼고 센다.
  const n = lines.filter((l, i) => l.length > 0 || i < lines.length - 1).length;
  return kind === "delete" ? { added: 0, removed: n } : { added: n, removed: 0 };
}

/** 쓰기 승인 한 건의 공통 내부 표현. 세대마다 payload 모양은 다르지만(신세대=알림 색인, 구세대=fileChanges)
 *  ★사람이 봐야 하는 것은 같다★ — 무슨 파일을, 어떤 종류로, 얼마나 바꾸는가. 한 곳에서 만든다. */
export interface WriteChange {
  path: string;
  kind: string;
  movePath: string | null;
  diff: string;
}

/** 구세대 `fileChanges`(경로 → FileChange) → WriteChange[].
 *
 *  ★벤더 스키마 0.144.6 실측(짐작 아님):★
 *    AddFileChange    `{ type: "add",    content: string }`
 *    DeleteFileChange `{ type: "delete", content: string }`
 *    UpdateFileChange `{ type: "update", unified_diff: string, move_path?: string|null }`
 *
 *  ★내용이 없으면 규모를 지어내지 않는다★ — `diff: ""` 로 두면 표시에서 `(+n/-n)` 자체가 빠진다.
 *  `(+0/-0)` 으로 채우면 사람에게 ★"아무것도 안 바뀐다"★ 로 읽힌다(S2 에서 새 파일 생성이 그렇게 보였던 것과 같은 거짓말). */
function oldGenChanges(fileChanges: Record<string, unknown>): WriteChange[] {
  return Object.entries(fileChanges).map(([path, raw]) => {
    const ch = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const mv = typeof ch.move_path === "string" && ch.move_path.trim() ? ch.move_path : null;
    const kind = typeof ch.type === "string" && ch.type ? ch.type : "change";
    // ★필드를 종류에 맞춰 고른다(2026-07-30 · 2회전).★ 앞선 판은 type 과 무관하게
    //   unified_diff 를 먼저 집었다. changeStat 은 kind 로 세는데 재료는 kind 를 안 보고 골랐으니
    //   ★짝이 어긋난 payload 에서 규모를 지어냈다★ (전부 실측):
    //     {type:"update", content:"hello\n"}            → update x(+0/-0)  ← "아무것도 안 바뀐다" 거짓말
    //     {type:"add", unified_diff:"@@ …"}             → add x(+3/-0)     ← 없는 내용에서 규모를 만듦
    //     {type:"add", content:"one\n", unified_diff:…} → add x(+3/-0)     ← 맞는 필드를 두고 틀린 걸 씀
    //   ★모르면 비워 둔다★ — diff="" 면 표시에서 (+n/-n) 자체가 빠진다. 모르는 종류만 휴리스틱을 쓴다.
    const diff =
      kind === "update"
        ? typeof ch.unified_diff === "string" ? ch.unified_diff : ""
        : kind === "add" || kind === "delete"
          ? typeof ch.content === "string" ? ch.content : ""
          : typeof ch.unified_diff === "string" ? ch.unified_diff : typeof ch.content === "string" ? ch.content : "";
    return { path, kind, movePath: mv, diff };
  });
}

/** ★팝업에서 사람이 실제로 읽는 한 줄의 예산.★ permissionGate.targetForOperation 이 target 을
 *  ★앞 240자만★ 쓰고, 텔레그램 팝업은 그 target 을 그대로 한 줄로 보여준다(telegramCapture 의
 *  `${pr.runtime}/${pr.agent_id} · ${pr.action}\n${pr.target}`). ★즉 240자가 화면이다.★ */
const VISIBLE_BUDGET = 240;

/** 코드포인트 경계에서 자른다. ★UTF-16 code unit 으로 자르면 이모지 한 자를 반 토막 낸다★ —
 *  `a×224 + 😀` 경로에서 target 끝이 고아 서로게이트(U+D83D)로 끝나는 것을 재현했다(2026-07-30).
 *  화면에 깨진 글자가 뜨는 것 자체도 문제지만, ★"내가 지금 무엇을 승인하는가" 를 흐리는 것★ 이 더 나쁘다. */
function cutCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const cp of s) {
    if (out.length + cp.length > max) break;
    out += cp;
  }
  return out;
}

/** 파일 목록을 예산 안에 담고, 넘치면 ★몇 개가 잘렸는지 말한다.★
 *  예전에는 500자로 이어붙인 뒤 permissionGate 가 240자에서 ★단어 중간을 잘랐다★ —
 *  화면에는 `…component/fil` 처럼 끝나고 ★"12개 중 5개만 보고 있다" 는 사실이 사라졌다.★
 *
 *  ★첫 항목도 예산을 지킨다(2026-07-30 · P1).★ 앞선 판은 `out.length > 0` 일 때만 줄여서
 *  ★첫 경로가 길면 통째로 밀어넣었다★ — 그러면 뒤에 붙는 지문이 permissionGate 의 240자 절단에서
 *  ★사라지고, 앞 240자가 같은 서로 다른 긴 경로가 한 열쇠로 합쳐진다★(400자 단일 경로로 재현).
 *  ★지문을 뒤에 두기로 한 결정이 성립하려면 "예산은 무조건 지킨다" 가 예외 없이 참이어야 한다.★ */
function fitEntries(display: string[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < display.length; i++) {
    const piece = display[i]!;
    const cost = piece.length + (out.length ? 2 : 0);
    const rest = display.length - i;
    const tail = rest > 1 ? ` …외 ${rest}개`.length : 0;
    if (used + cost + tail > budget) {
      if (out.length > 0) return `${out.join(", ")} …외 ${rest}개`;
      // ★첫 항목 하나도 안 들어간다 → 그 항목 자체를 예산에 맞춰 자르고 잘렸음을 표시한다.★
      const room = Math.max(0, budget - (rest > 1 ? tail : 1));
      const cut = `${cutCodePoints(piece, Math.max(0, room - 1))}…`;
      return rest > 1 ? `${cut} …외 ${rest}개` : cut;
    }
    out.push(piece);
    used += cost;
  }
  return out.join(", ");
}

/**
 * ★S2 — 관측된 파일변경으로 write operation 을 만든다. S3 에서 ★그 한 줄이 읽히게★ 다시 짰다.★
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
 *
 * ■ ★S3 — path 는 열쇠이면서 ★동시에 사람이 읽는 유일한 한 줄★ 이다.★
 *   targetForOperation 의 우선순위가 command > path > egress_url > text 이므로, write 승인에서는
 *   ★path 가 target 이 되고 text 는 화면에 안 나온다★(실측 확인). 그래서 path 를 열쇠로만 짜면
 *   사람은 `grant_root#…=/Users/… | a.ts|b.ts` 를 보게 된다 — ★열쇠를 사람에게 읽히는 셈★ 이다.
 *   → 한 문자열이 두 일을 해야 하므로 순서를 이렇게 고정한다:
 *     ①경고(사람) ②지문(열쇠 — 잘려도 구분됨) ③파일 개수·종류·경로(사람+열쇠)
 *   ★규모(+n/-n)는 여기 못 넣는다★ — 내용이 바뀔 때마다 열쇠가 달라져 '항상 허용' 이 영원히 안 붙는다.
 * 규모는 text 에 남고, 그것을 화면에 띄우려면 렌더러(codex 폴더 밖)를 고쳐야 한다 — ★렌더러 변경 결정 대기.★
 */
function writeOperation(
  agentId: string,
  provenance: Record<string, unknown>,
  changes: WriteChange[],
  grantRoot: string | null,
  itemId: string | null,
): PermissionOperation {
  // ★이동은 목적지까지가 쓰기 대상이다★ — 출발지만 넣으면 목적지가 달라도 같은 열쇠가 된다(P1).
  //
  // ★지문의 재료는 구조화 tuple 이다 — 이어붙인 문자열이 아니다(2026-07-30 · P1).★
  //   앞선 판은 `path + ">" + movePath` 문자열 집합을 해시했다. 그래서
  //     경로 이름이 그대로 `a>b` 인 파일  vs  `a` 를 `b` 로 옮기는 이동
  //     `a>b` → `c`                      vs  `a` → `b>c`
  //   가 ★완전히 같은 재료★ 가 됐다 — 뒤 쌍은 ★실제로 같은 열쇠★ 임을 재현했다.
  //   ★"지문이 갈라준다" 는 지문의 재료가 모호하지 않을 때만 참이다.★ 그 전제가 깨지면 문장도 깨진다.
  //   [path, movePath] 로 담아 구분이 구조에서 나오게 한다.
  const keyOf = (c: WriteChange) => JSON.stringify([c.path, c.movePath]);
  const byKey = new Map<string, WriteChange>();
  for (const c of changes) if (!byKey.has(keyOf(c))) byKey.set(keyOf(c), c);
  const uniq = [...byKey.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const entries = uniq.map((c) => [c.path, c.movePath] as const);
  const sorted = changes.slice().sort((a, b) => a.path.localeCompare(b.path));
  // ★열쇠 지문 — 잘림이 서로 다른 요청을 합치지 못하게 한다.★ 예산 안에 못 들어간 파일이 있어도
  //   집합이 다르면 지문이 다르다. 내용이 아니라 ★경로 집합 + grantRoot 전문★ 만 담으므로, 같은 파일을
  //   다시 고칠 때는 같은 지문이다('항상 허용' 이 계속 유효). ★이 지문이 있어야 뒤쪽을 사람 말로 줄일 수 있다.★
  //
  //   ★grantRoot 를 반드시 지문에 넣는다(P2 재발 방지).★ 표시용 grantRootDisplay 는
  //   뒤 71자만 남기므로, 지문이 없으면 ★앞부분만 다른 두 루트가 같은 열쇠★ 가 된다 —
  //   그게 P2 에서 실제로 재현했던 사고다(공통 prefix 가 긴 서로 다른 루트).
  const setDigest = createHash("sha256")
    .update(JSON.stringify({ grant_root: grantRoot, entries }))
    .digest("hex")
    .slice(0, 12);
  // ★표시도 원본 필드에서 조립한다★ — 이어붙인 문자열에서 `>` 를 `→` 로 바꾸면
  //   이름에 `>` 가 든 평범한 파일이 ★"옮긴다" 로 거짓 표시된다★(실측: `a>b.ts` → `add a→b.ts`).
  const display = uniq.map((c) => `${c.kind} ${c.path}${c.movePath ? ` → ${c.movePath}` : ""}`);
  // ★사람이 읽는 순서로 놓는다 — 경고 → 개수 → 파일. 지문은 ★맨 뒤★ 다.★
  //   지문을 앞에 두면 화면 첫 글자가 `#77b435181b45` 로 시작해 ★사람은 못 읽고 열쇠만 보인다.★
  //   뒤로 보내도 안전한 이유: 아래에서 지문 길이만큼 예산을 ★먼저 떼어놓고★ 파일 목록을 채우므로
  //   240자 절단선 안에 지문이 반드시 남는다(그게 P2 재발 방지의 조건이다).
  const head = grantRoot ? `${GRANT_ROOT_WARNING}${grantRootDisplay(grantRoot)} · ` : "";
  const prefix = `${head}파일 ${entries.length}개 · `;
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
    // ★화면 = 앞 240자★ 이므로 예산을 그 기준으로 잡고, 열쇠용 전체는 500자까지 남긴다.
    path: `${prefix}${fitEntries(display, Math.max(0, VISIBLE_BUDGET - prefix.length - suffix.length))}${suffix}`.slice(0, 500),
    text: `${grantRoot ? `${GRANT_ROOT_WARNING}${grantRoot.slice(0, 200)} · ` : ""}파일 ${entries.length}개: ${scale}`.slice(0, 500),
    requested_by: agentId,
    provenance: {
      ...provenance,
      item_id: itemId,
      grant_root: grantRoot,
      // 관측 경로를 남긴다 — 나중에 "이 내용을 어디서 알았나" 를 답할 수 있어야 한다.
      file_changes_source: itemId ? "notification_index" : "approval_payload",
      // ★audit 전용 내용 지문.★ 열쇠에는 안 들어간다(위 설명) — permissionGate 는 provenance 를 읽지 않는다.
      file_changes_digest: createHash("sha256")
        .update(JSON.stringify(changes.map((c) => [c.path, c.kind, c.movePath, c.diff]).sort()))
        .digest("hex")
        .slice(0, 16),
    },
  };
}

/** grantRoot 를 ★사람이 구별할 수 있게★ 줄인다. 열쇠 구분은 지문(setDigest)이 하므로
 *  여기서는 읽히는 것만 신경 쓴다 — ★뿌리는 앞이 아니라 뒤가 다르다★
 *  (`/Users/gdmini/Development/a` vs `…/b` 는 앞 60자가 똑같다). 그래서 길면 ★뒤를 남긴다.★ */
function grantRootDisplay(root: string): string {
  if (root.length <= 72) return root;
  return `…${root.slice(-71)}`;
}

/** ★해석하지 못한 승인 요청의 operation.★ 두 곳에서 쓴다 — 아무 분기에도 안 걸린 경우와,
 *  ★명령 승인이라고 밝혔지만 명령을 못 읽은 경우★(그 경우 fileChanges 분기로 흘리면 안 된다).
 *
 *  예전에는 action 에 req.method 를, text 에 reason 만 넣었다. reason 이 없으면 targetForOperation 이
 *  action 으로 떨어지므로 ★target = method 이름★ 이 되어 ★그 method 로 오는 모든 요청이 같은 scope★ 였다.
 *  → 한 번 allowed_always 를 받으면 이후 ★내용이 전혀 다른 요청도 팝업 없이 통과★ 한다.
 *
 * ★원칙(2026-07-28): 애매하면 통과가 아니라 ask 다.★
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
    // ★S3 — 화면 첫 글자를 사람 말로 시작한다.★ 팝업이 보여주는 두 줄은
    //   `codex/dex · approval_unparsed` / `<target>` 인데, 앞줄의 action 은 codex 계층에서 바꿀 수 없다
    //   (permissionGate 가 만든다 = 공용). ★그러면 최소한 뒷줄이 사람에게 상황을 말해야 한다.★
    //   내부 식별자만 두 줄 연달아 보여주면 사람은 무엇을 승인/거절하는지 모른 채 버튼을 누른다.
    //   지문은 그 뒤에 온다 — 앞머리는 ★모든 해석 실패에서 같은 상수★ 라 열쇠 구분력을 줄이지 않는다.
    //  ★해석에 실패했다고 위험 검사까지 건너뛰지 않는다.★
    //   해석 실패로 보내는 것은 ★열쇠를 좁히려는 것★ 이지 ★검사를 면제하려는 것★ 이 아니다.
    //   payload 를 안 실으면 이 요청의 Tier-D 스캔 입력이 ★0★ 이 되고, 그러면
    //   `[1, "; sudo rm -rf /tmp/x"]` 같은 규격 밖 요청이 ★사람이 누를 수 있는 평범한 팝업★ 으로 내려온다
    //   (Tier-D 는 사람도 승인 못 하는 등급인데, 스캔이 비면 그 등급이 붙을 근거가 없어진다).
    //   ★알아볼 수 없는 것을 넓게 통과시키지 않는다★ 는 이 경로의 원래 취지와도 맞다.
    //
    //   ★부작용은 명시한다★: 거대 payload 안에 'sudo' 같은 문자열이 ★우연히★ 들어 있으면 hard-deny 가 된다.
    //   해석조차 못 한 payload 에 대해서는 fail-closed 가 맞는 방향이라고 봤다.
    //
    //   붙이는 자리는 ★맨 뒤★ 다 — 앞은 사람이 읽는 안내문이어야 한다(팝업 첫 줄).
    //   ★주의: 이 op 은 command·path·egress 가 없어서 text 가 곧 target(=열쇠) 이다.★
    //   (앞선 주석에 "우선순위상 열쇠를 안 바꾼다" 고 적었는데 틀렸다. 지금은 안내문·지문이
    //    앞에 있어 해롭지 않지만, ★이 필드에 뭘 더 실으면 화면과 열쇠가 같이 바뀐다.★)
    text:
      `${UNPARSED_NOTICE}${req.method.slice(0, 64)} #${unparsedPayloadDigest(req)}${reason ? ` ${reason}` : ""}` +
      ` ${payloadScanText(req)}`,
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
/**
 * 받은 payload 에서 ★문자열 값만 모아 공백으로 잇는다★ — 위험 스캔에 넣을 용도.
 *
 * ★JSON 을 그대로 스캔에 쓰면 안 된다.★ JSON.stringify 는 줄바꿈을 ★역슬래시+n 두 글자★ 로 바꾼다.
 * 그러면 `"...\n" + "sudo"` 가 스캔 문자열에서 `nsudo` 가 되고, Tier-D 규칙 대부분이 쓰는
 * 단어 경계(\b)가 안 맞아 ★줄바꿈 하나로 검사를 통과한다.★ 실측:
 *   'echo hi<개행>sudo id' → 해석 실패 경로 [] · 정상 경로 ["sudo"]
 * codex 명령은 heredoc·`bash -c` 라 ★여러 줄이 기본★ 이므로, 공격이 아니어도 그냥 샌다.
 *
 * ★지문은 여전히 JSON 을 쓴다★(stablePayloadJson) — 거기서는 키 순서 안정성이 목적이라 JSON 이 맞다.
 * 같은 payload 를 ★목적에 따라 다른 표현★ 으로 본다.
 */
function payloadScanText(req: ApprovalRequest): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number" || typeof v === "boolean") out.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    //  ★키를 정렬해서 돈다★ — 안 하면 같은 내용이 다른 순서로 왔을 때 스캔 문자열이 달라지고,
    //  이 경로에서는 text 가 곧 target 이라 ★같은 작업에 열쇠가 두 개★ 생긴다(S0 정본 시험이 잡았다).
    else if (v && typeof v === "object") for (const k of Object.keys(v as Record<string, unknown>).sort()) walk((v as Record<string, unknown>)[k]);
  };
  walk(req.params ?? null);
  return out.join(" ");
}

/** 받은 payload 를 ★키 순서에 흔들리지 않게★ 문자열로 굳힌다. ★지문 전용★ — 스캔은 payloadScanText 를 쓴다. */
function stablePayloadJson(req: ApprovalRequest): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      // ★Object.fromEntries 를 쓴다 — 일반 객체에 acc["__proto__"]=... 로 대입하면 ★프로토타입이 바뀔 뿐
      //  own property 가 되지 않아 JSON.stringify 에서 통째로 사라진다.★ 그러면 "__proto__" 값만 다른 두
      //  payload 가 ★같은 지문·같은 열쇠★ 가 된다(재현 확인: 둘 다 #5353b5b6…).
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
      // ★status 와 decision_scope 를 같이 읽는다.★ '이 세션' 은 지속되는 허가를 남기지 않아
      //   status 가 allowed_once 와 같다(permissionGate.ts) — 둘을 가르는 것은 이 칸뿐이다.
      //   status 만 읽으면 사람이 세션을 골라도 런타임에는 '한번' 이 간다.
      scope = row?.decision_scope ?? null;
    } catch {
      return "denied"; // ★fail-closed: 조회 에러 → 거절★
    }
    // ★행이 스스로 만료를 말한다★ — 이 프로세스의 deadline 과 무관하게(재시작 후에도 유효).
    if (status === "pending" && isExpiredRow(db, requestId)) {
      try { expirePermissionRequest(db, requestId); } catch { /* best-effort */ }
      return "denied";
    }
    switch (status) {
      // ★decision_scope 가 'session' 일 때만 세션으로 올린다.★ #325 이전에 결정된 행은 이 칸이
      //   NULL 이다 — NULL 을 session 으로 읽으면 옛 '한번' 결정이 소급해서 세션 허용이 된다.
      //   모르는 값도 같다: 좁은 쪽(approved)으로 떨어뜨린다.
      case "allowed_once": return scope === "session" ? "approved_for_session" : "approved";
      case "allowed_always": return "approved_for_session";
      case "denied":
      case "expired": return "denied";
      case undefined: return "denied"; // 요청 사라짐 = 거절
      // "pending" → 계속 폴링
    }
    if (Date.now() >= deadline) {
      // ★무응답 만료 — 행도 expired 로 닫는다.★
      //   안 닫으면 행이 pending 으로 남아, 한참 뒤에 누른 탭이 ★이미 끝난 턴을 승인★ 한다.
      //   버튼도 그때 지워져서 사람이 "만료됐다" 를 화면에서 본다(헤르메스와 같은 모양).
      try { expirePermissionRequest(db, requestId); } catch { /* best-effort — 만료 판정은 유지 */ }
      return "denied";
    }
    await sleep(intervalMs);
  }
}

/** 행에 박힌 만료시각이 지났나. 컬럼이 없거나 값이 없으면 ★만료 아님★(폴링 deadline 이 받친다). */
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

/**
 * 승인 흐름에 태우기엔 ★너무 긴 '명령'★ 인지 본다. 넘으면 그 길이를, 아니면 null.
 *
 * ★명령 승인에만 적용한다.★ 기준은 ★명령★ 의 길이이고,
 * ★파일 변경 승인의 '내용' 은 길어도 이상하지 않다★ — 1,200자짜리 파일은 평범하다.
 * (모든 승인에 걸면 ★평범한 파일 변경이 거절된다★. 실측:
 *  applyPatchApproval 에 1,200자 파일을 넣으면 denied · permission_request 0행 ·
 *  기록은 '명령이 너무 길다' — 잘 되던 기능이 죽고 기록까지 틀린 이유를 댔다.)
 *
 * 재는 대상은 ★사람이 판단해야 할 내용★ 이다 — 해석되면 명령, 명령 method 인데 해석이 안 되면 payload 값들.
 * (지문·안내문 같은 우리가 붙인 것은 빼고 잰다. 그걸 세면 기준이 우리 포맷에 흔들린다.)
 */
export function oversizedForReview(req: ApprovalRequest): number | null {
  const parsed = parseCommandApproval(req);
  if (parsed.kind === "not_command") return null;   // ★파일 변경·그 밖의 승인은 이 규칙 대상이 아니다★
  const len = parsed.kind === "ok" ? parsed.command.length : payloadScanText(req).length;
  return len > COMMAND_REVIEW_LIMIT ? len : null;
}

/** 지금이 시험 실행인가. 시험이면 실제 전송을 막는다(fetchFn 을 넣어 준 시험은 그 가짜로 검증한다). */
export function isTestRun(): boolean {
  return process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1" || Boolean(process.env.B3OS_TEST);
}

/**
 * ★승인 요청을 그 팀원 방에 띄운다.★
 *
 * 전에는 op 방으로 갔다 — 실측상 permission_request 를 만든 팀원은 codex 런타임뿐이었고(다른 팀원 0건),
 * 그건 사용성이 아니라 우리 구현이 얹은 것이다.
 *
 * 그 팀원 봇으로 보낸다(브리지와 같은 봇). 보내는 것은 폴링과 충돌하지 않는다 —
 * getUpdates 만 한 프로세스여야 하므로 버튼 처리는 브리지가 한다.
 */
export async function sendApprovalToMemberRoom(
  agentId: string,
  requestId: string,
  req: ApprovalRequest,
  deps: {
    token?: string; chatId?: string; fetchFn?: typeof fetch; resolveDestination?: () => string | null;
    /** ★위험 표시★ — tierDReasons 결과. 카드에 적고, 있으면 '항상 허용' 버튼을 빼는 근거가 된다. */
    risks?: string[];
  } = {},
): Promise<boolean> {
  const risks = deps.risks ?? [];
  // ★시험 중에는 진짜 텔레그램으로 보내지 않는다.★ (2026-08-12 사고)
  //   requestApprovalPopup 을 지나는 시험이 deps 없이 이 함수를 부르면 ★실제 토큰·실제 방★ 으로
  //   메시지가 나간다. 실제로 나갔다 — 팀 리드 방에 'echo hi' 'src/x.ts' 같은 ★시험 픽스처가 승인창으로★
  //   떴다. 시험을 돌릴 때마다 반복됐다. 보내는 함수는 스스로 이걸 막아야 한다.
  if (isTestRun() && !deps.fetchFn) return false;

  const paths = codexBridgePaths(agentId);
  let token = deps.token;
  if (!token) {
    try { token = readFileSync(paths.tokenFile, "utf-8").trim(); } catch { return false; }
  }
  // ★목적지는 '그 팀원 방' = 팀 리드와 그 팀원 봇의 1:1 DM.★
  //   어느 방인지는 ★봇 토큰★ 이 정하고, 상대는 ★팀 리드 DM★ 이다.
  //
  //   전에는 allowFrom 의 첫 항목을 썼는데 ★그건 "누가 말 걸 수 있나" 인가 목록★ 이다.
  //   목록은 [팀리드 DM, 팀 그룹] 이라 ★팀 리드 DM 이 비면 첫 항목이 팀 그룹이 된다★ —
  //   그러면 ★보안 질문이 단체방에 뜬다.★ 인가 목록을 목적지로 쓰면 안 된다.
  //
  //   모르면 ★보내지 않는다.★ 아무 방에나 띄우는 것보다 안 뜨는 게 낫다(fail-closed).
  //   ★목적지 해석기를 주입 가능하게 둔다★ — 그래야 시험이 "인가 목록" 과 "팀 리드 DM" 을
  //   ★서로 다른 값으로★ 놓고 어느 쪽을 쓰는지 실제로 가를 수 있다. 이 기계에서는 두 값이 우연히
  //   같아서, 주입 없이는 옛 버그 코드로 되돌려도 시험이 초록으로 통과한다.
  const chatId = deps.chatId ?? (deps.resolveDestination ?? resolveOwnerDmId)();
  if (!token || !chatId) return false;

  // ★간결하게★ — 사람이 폰에서 한눈에 보고 누른다. 무엇을 하려는지 한 줄, 그 아래 대상.
  const { title, detail } = approvalSummary(req);
  // ★위험 사유를 카드에 적는다.★ 우리가 대신 막지 않기로 했으면 ★판단 근거는 줘야 한다.★
  //   이 줄이 없으면 `sudo rm -rf /` 와 `ls` 가 폰에서 생김새가 같다.
  const riskLine = risks.length ? `\n\n⚠️ 위험 표시: ${escapeHtml(risks.join(" · "))}` : "";
  const text = (detail ? `🔐 ${title}\n\n<code>${escapeHtml(detail)}</code>` : `🔐 ${title}`) + riskLine;
  const doFetch = deps.fetchFn ?? fetch;
  try {
    const res = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        // ★한 줄에 셋★ — 폰에서 두 줄이면 자리만 먹는다.
        // ★위험 표시가 붙은 건에는 '항상 허용' 을 주지 않는다.★
        //   우리가 막는 게 아니다 — 사람은 여전히 '한번 허용' 으로 실행할 수 있다.
        //   막는 것은 ★무인 반복★ 이다: '항상 허용' 은 24시간 grant 를 만들어 그동안 카드가 다시 안 뜬다.
        //   codex 자신도 위험한 것은 세션 단위로만 기억한다(acceptForSession).
        //   ★'이 세션' 은 위험 표시가 있어도 준다.★ 지속되는 허가를 남기지 않고 codex 세션이
        //   끝나면 함께 사라진다 — codex 자신이 위험한 것을 기억하는 단위가 이것이다(acceptForSession).
        reply_markup: { inline_keyboard: [risks.length
          ? [
              { text: "한번 허용", callback_data: `pg1:${requestId}` },
              { text: "이 세션", callback_data: `pgs:${requestId}` },
              { text: "거절", callback_data: `pgd:${requestId}` },
            ]
          : [
              { text: "한번 허용", callback_data: `pg1:${requestId}` },
              { text: "이 세션", callback_data: `pgs:${requestId}` },
              { text: "항상 허용", callback_data: `pga:${requestId}` },
              { text: "거절", callback_data: `pgd:${requestId}` },
            ]] },
      }),
    });
    return res.ok;
  } catch { return false; }
}

/**
 * 팝업 문구 — ★무엇을 하려는지 한 줄(title) + 그 대상(detail).★
 * 폰에서 한눈에 읽혀야 한다. 긴 것은 자른다(안 자르면 버튼이 화면 밖으로 밀린다).
 */
export function approvalSummary(req: ApprovalRequest): { title: string; detail?: string } {
  const p = (req.params ?? {}) as Record<string, unknown>;
  const cmd = p.command;
  const cmdText = typeof cmd === "string" ? cmd : Array.isArray(cmd) ? cmd.join(" ") : null;
  if (cmdText) return { title: "명령을 실행할까요?", detail: clip(cmdText) };

  const changes = p.fileChanges;
  if (changes && typeof changes === "object") {
    const files = Object.keys(changes as Record<string, unknown>);
    const head = files.slice(0, 3).join("\n");
    return { title: `파일 ${files.length}개를 고칠까요?`, detail: clip(files.length > 3 ? `${head}\n…외 ${files.length - 3}개` : head) };
  }
  if (typeof p.reason === "string") return { title: "권한을 요청합니다", detail: clip(p.reason) };
  return { title: "승인이 필요합니다", detail: req.method };
}

function clip(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * M5.3 진입점 — ask-tier 승인요청을 팝업으로 처리. onApproval에서 needsApproval일 때 호출.
 * ★반환 전까지 codex 턴이 대기하므로, 상위(runner)는 이 대기 동안 turn timeout을 연기해야 한다(M5.3 배선).★
 */
export async function requestApprovalPopup(db: Database, req: ApprovalRequest, agentId: string, cwd?: string, ttlMs = POPUP_TTL_MS): Promise<ReviewDecision> {
  const store = new CodexApprovalCorrelationStore(db);
  const opHash = approvalOperationHash(req);

  //  ★너무 긴 요청은 팝업을 만들지 않고 거절한다★ — 사람이 읽고 판단할 수 있는 대상이 아니다.
  //  조용히 통과시키지도, 못 읽을 것을 사람에게 들이밀지도 않는다. 기록을 남겨 ★따로 검토★ 하게 한다.
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
    // ★위험 사유를 카드에 싣는다.★
    //   우리가 대신 막지 않기로 했으면 ★사람이 판단할 근거를 줘야★ 그 전제가 성립한다.
    //   그 전까지 `sudo rm -rf /` 와 `ls` 가 폰에서 ★생김새가 같았다.★
    risks = tierDReasons(op);
    const res = requestPermission(db, op); // ★팝업 생성(telegramCapture가 렌더)★
    // ※ Tier-D 로 여기서 deny 하던 "이중 안전" 은 없어졌다(우리가 판정하지 않는다).
    //   이 분기는 grant 조회 결과가 deny 일 때만 남아 있다. 위험 명령은 이제 ★카드로 올라간다.★
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
  // ★만료 시각을 행에 박는다★ — 기다리는 프로세스가 죽어도 행이 스스로 만료를 말한다.
  try {
    db.prepare("UPDATE permission_request SET expires_at = datetime('now', ?) WHERE id = ?")
      .run(`+${Math.round(ttlMs / 1000)} seconds`, requestId);
  } catch { /* best-effort — 컬럼이 없어도 폴링 deadline 이 받쳐준다 */ }

  // ★그 팀원 방에 띄운다.★ 실패해도 요청 행은 남으므로 op 목록에서 여전히 보인다(조용히 사라지지 않는다).
  const sent = await sendApprovalToMemberRoom(agentId, requestId, req, { risks });
  if (!sent) {
    try { appendAudit(db, agentId, "codex_approval_room_send_failed", req.method, { request_id: requestId }); } catch { /* best-effort */ }
  }
  const decision = await pollDecision(db, requestId, ttlMs);
  // ★결정을 CAS로 마감(중복 버튼·요청 불일치·orphan 거부) 후 반환. 실행 직전 변경 검출은 아님 — 위 갭 주석 참조.★
  return finalizeApprovalDelivery(store, requestId, opHash, decision);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

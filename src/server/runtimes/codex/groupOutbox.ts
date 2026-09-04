/**
 * ★그룹 답을 셸 없이 내보내는 자리.★ 팀원은 답을 파일로 쓰고, 운반은 브리지가 한다.
 *
 * ★셸을 태우면 답이 안 나갔다★ — 실측된 인과(당시 실행 모드가 `approvalPolicy: "on-request"` 였다):
 *   셸 실행마다 승인 팝업이 뜬다.
 *   팝업의 목적지는 ★오너 DM★ 이고 그룹방이 아니다. 아무도 누르지 않으면 ★300초 뒤 만료★ 되며
 *   턴이 `interrupted · 0자` 로 끝난다. 승인 요청·만료 시각이 턴 종료 시각과 초 단위로 일치한다.
 *   `appserver_interrupted` 는 원인이 아니라 결과다.
 *
 * ★"명령을 고정해 항상 허용을 한 번 받는다" 는 성립하지 않는다★ — 세 값이 각각 막는다:
 *   · 승인 scope key 에 ★명령 전문★ 이 들어가고 명령에는 답 본문이 있다 → 열쇠가 매 턴 다르다
 *   · `permissionGate.ts` 의 `GRANT_TTL_HOURS = 24` → 기억은 ★하루★ 만 산다
 *   · `permission_grant` 를 조회하는 유일한 함수 `evaluatePermission` 은 ★호출부가 없다★
 *     → 기록은 남지만 다음 턴 판정에 쓰이지 않는다
 *
 * ★당시 요구사항★: 대화에는 승인창이 뜨지 않는다(0회이지 1회가 아니다).
 *
 * ★그 뒤 실행 정책이 "never" 로 바뀌어 셸을 태워도 팝업이 안 생긴다★(appServerRunner.ts).
 *   그래서 아래 승인 관련 서술은 ★과거 "on-request" 시절의 실측★ 이다. 지금 이 설계를 유지하는
 *   이유는 승인이 아니라 ★인용★ 이다 — 답이 명령 문자열에 안 들어가므로 따옴표·백틱·heredoc
 *   종료자가 해석될 자리가 없다. 그 결함군은 승인 정책과 무관하게 남아 있었다.

 *
 * ★자동 게시와 다르다★: 자동 게시는 턴 출력을 팀원 의사와 무관하게 방에 실었다.
 * 여기서는 ★답 파일을 쓰는 행위가 곧 발신 결정★ 이고 브리지는 운반만 한다 — 안 쓰면 안 나간다.
 *
 * ★불변식★: 답 본문은 명령 문자열에 들어가지 않는다. 따옴표·백틱·heredoc 종료자가 해석될 자리가 없다.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** 답 파일 상한 — 텔레그램 한 건보다 넉넉하되, 실수로 로그를 통째로 쓴 것은 거른다. */
export const MAX_REPLY_BYTES = 64 * 1024;

/**
 * ★이 턴 전용 경로를 만든다.★
 *
 * ★고정 경로를 쓰면 안 된다★: 같은 파일을 재사용하면 이번 턴이 안 썼을 때
 * ★직전 턴의 답이 다시 나간다.★ 빈 파일은 거절되지만 ★옛 내용은 거절되지 않는다★ —
 * 조용한 실패가 아니라 ★그럴듯하게 틀린★ 결과다.
 *
 * `agentId` 를 경로에 넣는 이유: 한 팀원 안의 겹침은 `serialTurnQueue` 가 막지만
 * ★팀원 사이는 안 막는다.★ 경로가 갈리면 서로를 못 덮는다.
 */
export function groupReplyPath(repoRoot: string, agentId: string): string {
  const nonce = randomBytes(8).toString("hex");
  return join(outboxDir(repoRoot, agentId), `${nonce}.txt`);
}

/**
 * ★그 팀원의 자리 — 경로에서 되뽑지 않고 `repoRoot`·`agentId` 에서 ★독립적으로★ 계산한다.★
 *
 * 읽을 때 이것과 대조한다. ★`dirname(path)` 를 기대값으로 쓰면 자기 자신과 비교하는 것이라
 * 언제나 통과한다★ — 검사가 아니라 모양만 남는다.
 */
export function outboxDir(repoRoot: string, agentId: string): string {
  const safeAgent = agentId.replace(/[^A-Za-z0-9_-]/g, "_");
  // ★신뢰하는 쪽만 풀고 나머지는 문자열로 붙인다.★ `repoRoot` 는 에이전트가 못 바꾸지만
  //   그 아래 `outbox/<agent>` 는 바꿀 수 있다. ★양쪽에 realpath 를 걸면 링크가 같이 풀려
  //   비교가 언제나 통과한다★ — 검사가 아니라 모양만 남는다.
  let root = repoRoot;
  try { root = realpathSync(repoRoot); } catch { /* 없으면 준 값을 그대로 쓴다 */ }
  return join(root, "var", "codex-bridge", "outbox", safeAgent);
}

/** 결과. ★"안 썼다" 와 "못 읽었다" 를 가른다★ — 둘을 뭉치면 "답 안 함" 이 고장으로 읽힌다. */
export type ConsumeResult =
  | { kind: "reply"; text: string }
  | { kind: "none" }
  | { kind: "rejected"; reason: "not_regular_file" | "too_large" | "empty" | "unreadable" | "dir_moved" };

/**
 * ★답 파일을 한 번 읽고 지운다.★ 읽든 못 읽든 ★반드시 지운다★ —
 * 남기면 다음 턴이 그것을 이번 답으로 읽고, 팀 대화가 디스크에 그대로 남는다.
 *
 * ★심링크를 따라가지 않는다★: 에이전트가 쓰는 자리라 링크가 걸려 있으면 그 대상을 읽어
 * 방에 게시하게 된다 — ★읽기 권한이 곧 유출 경로★ 가 된다.
 */
export function consumeGroupReply(path: string, expectedDir: string): ConsumeResult {
  // ★부모 경로도 본다★: `O_NOFOLLOW` 는 ★마지막 조각만★ 안 따라간다.
  //   에이전트가 `outbox/<agent>` 를 ★디렉터리 대신 심링크★ 로 바꾸면 그 너머의 파일은
  //   ★보통 파일이라 통과★ 하고, 남의 파일이 방에 올라간다. `mkdirSync(recursive)` 는
  //   그 자리가 이미 심링크-디렉터리면 ★그냥 통과★ 해서 못 막는다.
  //   → 실제로 열리는 디렉터리가 ★우리가 만든 그 디렉터리★ 인지 대조한다.
  //   ★남는 창은 여기까지다★: `realpath` 와 `open` 사이가 벌어져 있어 그 사이에 부모를 바꾸면
  //   여전히 통과한다. 완전히 닫으려면 디렉터리 fd 기준 상대 열기(`openat`)가 필요한데 Node 가 안 내준다.
  //   ★이 가드의 값어치는 "적대적 팀원을 이기는 것" 이 아니다★ — 팀원은 브리지와 ★같은 사용자★ 로 돌아서
  //   원하면 이 경로를 안 통하고 그냥 읽으면 된다. 막는 것은 ★실수·오작동이 방으로 새는 것★ 이다.
  //   (팀원을 다른 사용자·다른 샌드박스로 돌리면 그때 이 경계가 진짜가 되고 `openat` 부재가 제약이 된다)
  //
  //   ★필수 인자다★ — 선택으로 두면 안 넘긴 호출부에서 이 검사가 통째로 꺼지고,
  //   그래도 컴파일과 시험이 통과한다. 시험은 어긋남을 탐지하고 ★구조는 어긋남을 예방한다.★
  try {
    // ★기대값에는 realpath 를 안 건다★ — 이미 신뢰하는 뿌리에서 계산된 값이다.
    // ★여기서는 지우지 않는다★: 부모가 링크면 `path` 는 신뢰 경계 ★밖★ 을 가리키고,
    //   `rmSync(path)` 는 그 링크를 따라가 ★남의 파일을 실제로 지운다.★
    //   읽기를 막으려는 가드가 삭제를 수행하면 원래 막으려던 것보다 나쁜 일을 한다.
    //   자리를 안 비우는 대가는 없다 — 다음 턴의 경로는 어차피 다르다.
    if (realpathSync(dirname(path)) !== expectedDir) return { kind: "rejected", reason: "dir_moved" };
  } catch {
    return { kind: "rejected", reason: "dir_moved" };
  }
  // ★경로로 두 번 열지 않는다★ (TOCTOU):
  //   경로로 재고 ★경로로 다시 열면★ 그 사이에 경로를 심링크로 바꿔치기했을 때 읽기가 링크를
  //   따라간다 — ★검사한 것과 읽은 것이 다른 객체★ 가 된다. 크기 검사도 같은 이유로 샌다(잰 뒤 커질 수 있다).
  //   ★이건 이론이 아니다★ — 그 경로를 아는 것이 팀원 자신이다. 브리지가 알려준다.
  //   성공하면 ★비밀 파일 내용이 그룹방에 올라간다.★
  //
  //   → ★fd 하나로 끝낸다.★ `O_NOFOLLOW` 는 마지막 경로 요소가 심링크면 ★열기 자체가 실패★ 하고,
  //     `fstat` 은 경로가 아니라 ★열린 그 파일★ 을 잰다. 검사한 것과 읽은 것이 같음이 보장된다.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    // ★"안 썼다" 와 "심링크였다" 를 가른다★ — 뭉치면 공격 시도가 "답 안 함" 으로 조용히 묻힌다.
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") return { kind: "none" }; // 턴이 안 썼다 = 답 안 함. 고장이 아니다
    if (code === "ELOOP" || code === "EMLINK") return discard(path, { kind: "rejected", reason: "not_regular_file" });
    return discard(path, { kind: "rejected", reason: "unreadable" });
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return discard(path, { kind: "rejected", reason: "not_regular_file" });
    if (st.size > MAX_REPLY_BYTES) return discard(path, { kind: "rejected", reason: "too_large" });
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString("utf8").trim();
    if (!text) return discard(path, { kind: "rejected", reason: "empty" });
    return discard(path, { kind: "reply", text });
  } catch {
    return discard(path, { kind: "rejected", reason: "unreadable" });
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
  }
}

/** 읽었든 거절했든 ★자리를 비우고★ 결과를 그대로 돌려준다.
 *  남기면 다음 턴이 그걸 이번 답으로 읽고, 팀 대화가 디스크에 그대로 남는다. */
function discard<T extends ConsumeResult>(path: string, r: T): T {
  try { rmSync(path, { force: true }); } catch { /* best-effort — 다음 턴 경로가 달라 치명적이지 않다 */ }
  return r;
}

/**
 * 팀원이 쓸 자리를 미리 만든다. ★실패를 삼키지 않는다★ —
 * 삼키면 자리가 없어서 못 쓴 것이 ★"답 안 함"(정상)★ 으로 기록되고 경고도 안 붙는다.
 * 그 상태에서는 모든 턴이 조용히 통과하고, 사람은 팀원이 답을 안 한다고 읽는다.
 */
export function ensureOutboxDir(path: string): { ok: true } | { ok: false; detail: string } {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: (e as { code?: string }).code ?? String(e).slice(0, 60) };
  }
}

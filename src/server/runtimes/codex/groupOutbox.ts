/** 답 파일 작성이 팀원의 명시적 발신 결정이며 브리지는 운반만 한다. 파일이 없으면 자동으로 턴 본문을 게시하지 않는다.
 * 본문을 셸 명령에 넣지 않아 따옴표·백틱·heredoc 종료자가 해석되지 않게 한다. 현재 never 정책에는 셸 승인창도 없으므로 이 경로의 이유는 승인 회피가 아니라 인용 보존이다. */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** 답 파일 상한 — 텔레그램 한 건보다 넉넉하되, 실수로 로그를 통째로 쓴 것은 거른다. */
export const MAX_REPLY_BYTES = 64 * 1024;

/** 고정 경로는 이번 턴에 쓰지 않아도 이전 답을 다시 보낼 수 있어 턴마다 새 경로를 만든다. 팀원 간에는 큐가 공유되지 않으므로 agentId로 경로도 분리한다. */
export function groupReplyPath(repoRoot: string, agentId: string): string {
  const nonce = randomBytes(8).toString("hex");
  return join(outboxDir(repoRoot, agentId), `${nonce}.txt`);
}

/** 예상 디렉터리는 repoRoot·agentId에서 독립 계산한다. 답 경로의 dirname을 기대값으로 쓰면 자기 자신과 비교해 항상 통과한다. */
export function outboxDir(repoRoot: string, agentId: string): string {
  const safeAgent = agentId.replace(/[^A-Za-z0-9_-]/g, "_");
  // 신뢰하는 쪽만 풀고 나머지는 문자열로 붙인다. `repoRoot` 는 에이전트가 못 바꾸지만
  //   그 아래 `outbox/<agent>` 는 바꿀 수 있다. 양쪽에 realpath 를 걸면 링크가 같이 풀려
  //   비교가 언제나 통과한다 — 검사가 아니라 모양만 남는다.
  let root = repoRoot;
  try { root = realpathSync(repoRoot); } catch { /* 없으면 준 값을 그대로 쓴다 */ }
  return join(root, "var", "codex-bridge", "outbox", safeAgent);
}

/** 결과. "안 썼다" 와 "못 읽었다" 를 가른다 — 둘을 뭉치면 "답 안 함" 이 고장으로 읽힌다. */
export type ConsumeResult =
  | { kind: "reply"; text: string }
  | { kind: "none" }
  | { kind: "rejected"; reason: "not_regular_file" | "too_large" | "empty" | "unreadable" | "dir_moved" };

/** 답 파일은 성공·실패 모두 한 번 읽고 지워 잔여 본문이 재발신되거나 디스크에 계속 남지 않게 한다.
 * 에이전트가 쓴 심링크를 따라가면 다른 파일을 방에 게시할 수 있으므로 링크를 거절한다. */
export function consumeGroupReply(path: string, expectedDir: string): ConsumeResult {
  // O_NOFOLLOW는 마지막 조각만 막으므로 부모도 독립 계산한 디렉터리와 대조한다. 필수 인자로 두어 호출부 누락 시 검사가 꺼지지 않게 한다.
  // realpath와 open 사이 부모 교체 창은 남으며 Node는 openat을 제공하지 않는다. 같은 사용자 팀원 간 강한 보안 경계가 아니라 실수·오작동 유출 방지다. 사용자·샌드박스를 나누면 이 제약을 재검토해야 한다.
  try {
    // 기대값에는 realpath 를 안 건다 — 이미 신뢰하는 뿌리에서 계산된 값이다.
    // 여기서는 지우지 않는다: 부모가 링크면 `path` 는 신뢰 경계 밖 을 가리키고,
    //   `rmSync(path)` 는 그 링크를 따라가 남의 파일을 실제로 지운다.
    //   읽기를 막으려는 가드가 삭제를 수행하면 원래 막으려던 것보다 나쁜 일을 한다.
    //   자리를 안 비우는 대가는 없다 — 다음 턴의 경로는 어차피 다르다.
    if (realpathSync(dirname(path)) !== expectedDir) return { kind: "rejected", reason: "dir_moved" };
  } catch {
    return { kind: "rejected", reason: "dir_moved" };
  }
  // 검사 뒤 경로를 다시 열면 바꿔치기된 링크·크기를 읽을 수 있으므로 O_NOFOLLOW로 한 번 열고 같은 fd의 fstat·읽기로 대상 동일성을 유지한다.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    // "안 썼다" 와 "심링크였다" 를 가른다 — 뭉치면 공격 시도가 "답 안 함" 으로 조용히 묻힌다.
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

/** 읽었든 거절했든 자리를 비우고 결과를 그대로 돌려준다.
 *  남기면 다음 턴이 그걸 이번 답으로 읽고, 팀 대화가 디스크에 그대로 남는다. */
function discard<T extends ConsumeResult>(path: string, r: T): T {
  try { rmSync(path, { force: true }); } catch { /* best-effort — 다음 턴 경로가 달라 치명적이지 않다 */ }
  return r;
}

/**
 * 팀원이 쓸 자리를 미리 만든다. 실패를 삼키지 않는다 —
 * 삼키면 자리가 없어서 못 쓴 것이 "답 안 함"(정상) 으로 기록되고 경고도 안 붙는다.
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

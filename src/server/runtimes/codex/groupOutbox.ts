/**
 * ★그룹 답을 셸 없이 내보내는 자리.★
 *
 * ★왜 셸을 안 태우나 — 실측으로 배웠다(2026-08-24).★
 * 전에는 프롬프트가 `send.sh` 를 ★실행★ 하라고 시켰다. 그러자 그 실행마다 codex 가
 * ★승인 팝업★ 을 띄웠고(그 팀원 설정이 `approval_policy = "on-request"`), 팝업은 그룹방이 아니라
 * ★오너 DM★ 으로 갔다. 아무도 안 누르니 ★300초 뒤 만료 → 턴이 통째로 죽었다.★
 * `appserver_interrupted · 0자` 는 원인이 아니라 ★결과★ 였다.
 *
 * "명령을 고정해서 '항상 허용' 을 한 번 받자" 도 검토했고 ★접었다★:
 *   `permissionGate.ts` 의 `GRANT_TTL_HOURS = 24` — ★그 기억은 24시간짜리다.★
 *   즉 "한 번만 누르면 끝" 이 아니라 ★하루에 한 번★ 이고, 다음날 조용해지면
 *   ★아무도 아무것도 안 했으므로 원인이 안 보인다.★ 팀장 기준은 "대화에 승인창은 아니다" —
 *   목표는 ★한 번만 뜨는 것이 아니라 안 뜨는 것★ 이다.
 *
 * → ★팀원은 답을 파일로 쓰고, 운반은 브리지가 한다.★ 셸을 안 타므로 승인 경로를 아예 안 지난다.
 *   덤으로 heredoc·따옴표·백틱·종료자 사고가 ★통째로 사라진다★ — 답이 명령 문자열에 안 들어간다.
 *
 * ★자동 게시로 돌아간 것이 아니다.★ 자동 게시는 턴의 stdout 을 팀원 의사와 무관하게 방에 부었다.
 * 여기서는 ★답 파일을 쓰는 행위 자체가 "보낸다" 는 결정★ 이고 브리지는 운반만 한다.
 * ★안 쓰면 안 나간다★ — "보낸 것만 말한 것이다" 가 그대로 유지된다.
 */
import { lstatSync, mkdirSync, readFileSync, rmSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** 답 파일 상한 — 텔레그램 한 건보다 넉넉하되, 실수로 로그를 통째로 쓴 것은 거른다. */
export const MAX_REPLY_BYTES = 64 * 1024;

/**
 * ★이 턴 전용 경로를 만든다.★
 *
 * ★고정 경로를 쓰지 않는다★ (리뷰에서 같은 지적을 두 번 받았다): 같은 파일을 재사용하면
 * 이번 턴이 안 썼을 때 ★직전 턴의 답이 그대로 다시 나간다.★ 빈 파일은 거절되지만
 * ★옛 내용은 거절되지 않는다★ — 조용한 실패가 아니라 ★그럴듯하게 틀린★ 쪽이라 더 나쁘다.
 *
 * `agentId` 를 경로에 넣는 이유: 한 팀원 안의 겹침은 `serialTurnQueue` 가 막지만
 * ★팀원 사이는 안 막는다.★ 경로가 갈리면 서로를 못 덮는다.
 */
export function groupReplyPath(repoRoot: string, agentId: string): string {
  const safeAgent = agentId.replace(/[^A-Za-z0-9_-]/g, "_");
  const nonce = randomBytes(8).toString("hex");
  return join(repoRoot, "var", "codex-bridge", "outbox", safeAgent, `${nonce}.txt`);
}

/** 결과. ★"안 썼다" 와 "못 읽었다" 를 가른다★ — 둘을 뭉치면 "답 안 함" 이 고장으로 읽힌다. */
export type ConsumeResult =
  | { kind: "reply"; text: string }
  | { kind: "none" }
  | { kind: "rejected"; reason: "not_regular_file" | "too_large" | "empty" | "unreadable" };

/**
 * ★답 파일을 한 번 읽고 지운다.★ 읽든 못 읽든 ★반드시 지운다★ —
 * 남기면 다음 턴이 그것을 이번 답으로 읽고, 팀 대화가 디스크에 그대로 남는다.
 *
 * ★심링크를 따라가지 않는다★: `lstat` 으로 ★보통 파일★ 인지 먼저 본다. 에이전트가 쓰는 자리라
 * 링크가 걸려 있으면 그 대상을 읽어 방에 게시하게 된다 — ★읽기 권한이 곧 유출 경로★ 가 된다.
 */
export function consumeGroupReply(path: string): ConsumeResult {
  let st: Stats;
  try {
    // ★lstat 이다 — stat 이 아니다.★ `stat` 은 링크를 따라가므로 링크도 "보통 파일" 로 통과한다.
    //   그러면 에이전트가 남의 파일로 링크를 걸어 그 내용을 방에 게시하게 만들 수 있다.
    st = lstatSync(path);
  } catch {
    return { kind: "none" }; // ★턴이 안 썼다 = 답 안 함.★ 고장이 아니다
  }
  if (!st.isFile()) return discard(path, { kind: "rejected", reason: "not_regular_file" });
  if (st.size > MAX_REPLY_BYTES) return discard(path, { kind: "rejected", reason: "too_large" });
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return discard(path, { kind: "rejected", reason: "unreadable" });
  }
  if (!text) return discard(path, { kind: "rejected", reason: "empty" });
  return discard(path, { kind: "reply", text });
}

/** 읽었든 거절했든 ★자리를 비우고★ 결과를 그대로 돌려준다.
 *  남기면 다음 턴이 그걸 이번 답으로 읽고, 팀 대화가 디스크에 그대로 남는다. */
function discard<T extends ConsumeResult>(path: string, r: T): T {
  try { rmSync(path, { force: true }); } catch { /* best-effort — 다음 턴 경로가 달라 치명적이지 않다 */ }
  return r;
}

/** 팀원이 쓸 자리를 미리 만들어 둔다 — 디렉터리가 없어서 못 쓰는 일이 없게. */
export function ensureOutboxDir(path: string): void {
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
}

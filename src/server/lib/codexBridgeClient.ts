/**
 * ★서버가 codex 브리지의 bridge window 를 부르는 쪽.★ (telegramCapture 의 codex 분기가 쓴다)
 *
 * 다른 런타임과 같은 모양이다 — 서버는 턴을 돌지 않고 ★런타임을 소유한 프로세스★ 를 부른다.
 *
 * ★재시도하지 않는다.★ 타임아웃이 나도 턴은 브리지에서 계속 돌고 있을 수 있다 —
 * 다시 부르면 그게 곧 이중응답이다(리뷰 지적). 실패는 실패로 두고 audit 만 남긴다.
 *
 * ★매 호출 전에 bridge window 파일을 다시 읽는다.★ 브리지가 재시작하면 포트가 바뀌는데
 * 캐시하고 있으면 ★조용히 안 간다.★
 */
import { readWindowFile, windowFilePathFor, type BridgeWindowRequest } from "../runtimes/codex/bridgeWindow";

/** bridge window 호출 결과. ★queued 는 "접수" 지 "답했다" 가 아니다.★ */
export type CodexBridgeCallResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: "unreachable" | "timeout" | "rejected" | "no_window"; status?: number };

export interface CodexBridgeCallDeps {
  /** 그 팀원 브리지의 pid 파일 경로(bridge window 파일은 그 옆에 있다). */
  pidFile: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 그 pid 가 살아 있나. 시험에서 갈아 끼운다. */
  isAlive?: (pid: number) => boolean;
}

/**
 * `signal 0` 은 신호를 안 보내고 ★존재만★ 묻는다.
 *
 * ★던진 이유를 갈라야 한다★ (리뷰 지적):
 * · `ESRCH` = 그런 프로세스가 없다 → ★죽었다★
 * · `EPERM` = 있는데 신호를 보낼 권한이 없다 → ★살아 있다★
 * 둘을 뭉쳐서 "던졌으니 죽었다" 로 읽으면 ★살아 있는 브리지를 죽은 것으로 판정★ 해 그룹이 조용해진다.
 * 모르는 오류도 ★살아 있는 쪽★ 으로 둔다 — 여기서 틀리면 배달이 멈추고, 유출은 ESRCH 로만 생긴다.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== "ESRCH";
  }
}

/** 기본 타임아웃 — bridge window 는 큐에 넣고 바로 답한다(턴을 기다리지 않는다). 짧게 잡는다. */
export const BRIDGE_CALL_TIMEOUT_MS = 5_000;

export async function callCodexBridge(
  req: BridgeWindowRequest,
  deps: CodexBridgeCallDeps,
): Promise<CodexBridgeCallResult> {
  const path = windowFilePathFor(deps.pidFile, req.agentId);
  if (!path) return { ok: false, reason: "no_window" };
  const file = readWindowFile(path);
  if (!file) return { ok: false, reason: "no_window" };
  // ★파일에 적힌 주인이 이 팀원인지 본다★ — 다만 이 검사만으로는 부족하다.
  //   파일 경로가 이미 `${agentId}.window.json` 이라 남의 파일이 올 일이 거의 없고,
  //   ★죽은 내 파일★ 은 agentId 가 그대로라 이걸로 못 거른다.
  if (file.agentId !== req.agentId) return { ok: false, reason: "no_window" };

  // ★"파일이 있다" 와 "그 프로세스가 살아 있다" 는 다른 값이다.★ (리뷰 지적 — 유출 경로)
  //   close() 는 SIGTERM·SIGINT 에만 걸린다. ★크래시·SIGKILL 이면 파일이 그대로 남는다.★
  //   포트는 `listen(0)` 이라 ephemeral 대역이고, 브리지가 죽은 뒤 커널이 그 포트를
  //   ★다른 로컬 프로세스★ 에 다시 줄 수 있다. 그러면 이 요청이 그쪽으로 간다 —
  //   ★본문(그룹 원문 + 팀 맥락)과 토큰이 무관한 리스너에게 그대로 날아간다.★
  //   게다가 그쪽이 200 을 주면 부르는 쪽은 `duplicate` 로 읽어 ★성공으로 기록★ 한다.
  //   보내기 전에 존재를 확인하고, 죽었으면 그 파일을 치워 다음 호출을 깨끗하게 한다.
  //
  //   ★남은 파일을 지우지는 않는다★ (리뷰 지적 — 경쟁 조건).
  //   읽고 나서 생존을 확인하는 사이에 브리지가 재기동하면 그 파일은 ★새 pid·포트·토큰으로
  //   원자 교체★ 된다. 그때 옛 pid 로 ESRCH 를 보고 지우면 ★방금 뜬 새 bridge window 파일을 지운다★ —
  //   정상 재기동 직후에 ★계속 no_window★ 가 되어 조용해진다. 치우는 일은 새 브리지가 이미 한다.
  //
  //   ★남는 구멍 — 완전 차단이 아니다★: pid 는 재사용된다. 브리지가 죽고 그 번호를 다른
  //   프로세스가 물려받으면 `pidAlive` 는 참을 준다. 이 검사가 막는 것은 ★그 번호가 아예 없는
  //   경우(ESRCH)★ 이고, 그게 크래시 직후의 대부분이다. 완전한 증명은 파일에 기동 시각·nonce 를
  //   같이 싣고 bridge window 가 자기 것을 확인해야 한다 — 별건이다.
  const alive = (deps.isAlive ?? pidAlive)(file.pid);
  if (!alive) return { ok: false, reason: "no_window" };

  const doFetch = deps.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? BRIDGE_CALL_TIMEOUT_MS);
  try {
    const res = await doFetch(`http://127.0.0.1:${file.port}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-b3os-token": file.token },
      body: JSON.stringify(req),
      signal: ac.signal,
    });
    if (res.status === 202) return { ok: true, duplicate: false };
    if (res.status === 200) return { ok: true, duplicate: true };
    return { ok: false, reason: "rejected", status: res.status };
  } catch (e) {
    // ★끊긴 것과 늦은 것을 가른다★ — audit 에서 원인이 갈려야 다음 사람이 안 헤맨다.
    const aborted = (e as { name?: string }).name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

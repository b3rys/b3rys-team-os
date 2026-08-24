/**
 * ★서버가 codex 브리지의 창구를 부르는 쪽.★ (telegramCapture 의 codex 분기가 쓴다)
 *
 * 다른 런타임과 같은 모양이다 — 서버는 턴을 돌지 않고 ★런타임을 소유한 프로세스★ 를 부른다.
 *
 * ★재시도하지 않는다.★ 타임아웃이 나도 턴은 브리지에서 계속 돌고 있을 수 있다 —
 * 다시 부르면 그게 곧 이중응답이다(리뷰 지적). 실패는 실패로 두고 audit 만 남긴다.
 *
 * ★매 호출 전에 창구 파일을 다시 읽는다.★ 브리지가 재시작하면 포트가 바뀌는데
 * 캐시하고 있으면 ★조용히 안 간다.★
 */
import { readWindowFile, windowFilePathFor, type BridgeWindowRequest } from "../runtimes/codex/bridgeWindow";

/** 창구 호출 결과. ★queued 는 "접수" 지 "답했다" 가 아니다.★ */
export type CodexBridgeCallResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: "unreachable" | "timeout" | "rejected" | "no_window"; status?: number };

export interface CodexBridgeCallDeps {
  /** 그 팀원 브리지의 pid 파일 경로(창구 파일은 그 옆에 있다). */
  pidFile: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 기본 타임아웃 — 창구는 큐에 넣고 바로 답한다(턴을 기다리지 않는다). 짧게 잡는다. */
export const BRIDGE_CALL_TIMEOUT_MS = 5_000;

export async function callCodexBridge(
  req: BridgeWindowRequest,
  deps: CodexBridgeCallDeps,
): Promise<CodexBridgeCallResult> {
  const path = windowFilePathFor(deps.pidFile, req.agentId);
  if (!path) return { ok: false, reason: "no_window" };
  const file = readWindowFile(path);
  if (!file) return { ok: false, reason: "no_window" };
  // ★파일에 적힌 주인이 이 팀원인지 본다★ — 남은 파일(stale)을 잘못 부르지 않게.
  if (file.agentId !== req.agentId) return { ok: false, reason: "no_window" };

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

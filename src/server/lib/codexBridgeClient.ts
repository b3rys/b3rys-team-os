// 타임아웃 뒤에도 브리지 턴이 실행 중일 수 있어 재시도하지 않는다. 재시작 시 포트가 바뀌므로 window 파일은 호출마다 읽는다.
import { readWindowFile, windowFilePathFor, type BridgeWindowFile, type BridgeWindowRequest } from "../runtimes/codex/bridgeWindow";

/** bridge window 호출 결과. queued 는 "접수" 지 "답했다" 가 아니다. */
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

// signal 0의 ESRCH만 종료로 판정한다. EPERM은 프로세스가 존재하지만 신호 권한이 없는 상태다.
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

/** 그 팀원의 살아 있는 window 를 찾는다 — 호출마다 파일을 다시 읽는다(재시작 뒤 옛 포트·토큰으로 보내지 않는다). */
function resolveWindow(agentId: string, deps: CodexBridgeCallDeps): BridgeWindowFile | null {
  const path = windowFilePathFor(deps.pidFile, agentId);
  if (!path) return null;
  const file = readWindowFile(path);
  if (!file) return null;
  // 파일에 적힌 주인이 이 팀원인지 본다 — 다만 이 검사만으로는 부족하다.
  //   파일 경로가 이미 `${agentId}.window.json` 이라 남의 파일이 올 일이 거의 없고,
  //   죽은 내 파일 은 agentId 가 그대로라 이걸로 못 거른다.
  if (file.agentId !== agentId) return null;
  // 종료된 PID의 재사용 포트로 본문·토큰이 전송되지 않도록 생존을 확인한다. PID 재사용까지 식별하지는 못한다.
  // 재기동 중 새 window 파일을 지울 수 있으므로 잔존 파일은 삭제하지 않는다.
  if (!(deps.isAlive ?? pidAlive)(file.pid)) return null;
  return file;
}

async function postWindow(file: BridgeWindowFile, path: "/turn", body: unknown, deps: CodexBridgeCallDeps): Promise<{ status: number } | { error: "timeout" | "unreachable" }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? BRIDGE_CALL_TIMEOUT_MS);
  try {
    const res = await doFetch(`http://127.0.0.1:${file.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-b3os-token": file.token },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    return { status: res.status };
  } catch (e) {
    // 끊긴 것과 늦은 것을 가른다 — audit 에서 원인이 갈려야 다음 사람이 안 헤맨다.
    return { error: (e as { name?: string }).name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function callCodexBridge(
  req: BridgeWindowRequest,
  deps: CodexBridgeCallDeps,
): Promise<CodexBridgeCallResult> {
  const file = resolveWindow(req.agentId, deps);
  if (!file) return { ok: false, reason: "no_window" };
  const r = await postWindow(file, "/turn", req, deps);
  if ("error" in r) return { ok: false, reason: r.error };
  if (r.status === 202) return { ok: true, duplicate: false };
  if (r.status === 200) return { ok: true, duplicate: true };
  return { ok: false, reason: "rejected", status: r.status };
}

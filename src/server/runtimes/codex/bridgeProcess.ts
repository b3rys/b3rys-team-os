/**
 * 브리지 프로세스가 정말 끝났는지 — 퇴사 정리가 "끄고 바로 지우기" 로 경합하지 않게.
 *
 * 실측(앱 [팀원 추가] 실연): bootout 직후 파일을 지우면 아직 꺼지던 브리지(또는 그 자식 codex app-server)가
 * CODEX_HOME 아래 잠금 폴더를 다시 만들었다. 그래서 끄기 전에 브리지와 그 자식들의 pid 를 잡아 두고,
 * 끈 뒤 그들이 다 사라질 때까지(상한 있게) 기다린 다음에 지운다.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pidAlive } from "../../lib/codexBridgeClient";

/** 브리지 ready 표시 파일({pid, agentId, readyAt})에서 pid. 다른 팀원 것이면 쓰지 않는다. */
export function readBridgePid(pidFile: string, agentId: string): number | null {
  try {
    const j = JSON.parse(readFileSync(pidFile, "utf-8")) as { pid?: unknown; agentId?: unknown };
    if (typeof j.pid !== "number" || !Number.isInteger(j.pid) || j.pid <= 1) return null;
    if (typeof j.agentId === "string" && j.agentId && j.agentId !== agentId) return null;
    return j.pid;
  } catch {
    return null;
  }
}

/** 자식·손자 pid(pgrep -P). 못 읽으면 빈 목록. */
export function descendantPids(pid: number, list: (p: number) => number[] = pgrepChildren): number[] {
  const out: number[] = [];
  const queue = [pid];
  while (queue.length && out.length < 200) {
    for (const c of list(queue.shift()!)) {
      if (!out.includes(c) && c !== pid) { out.push(c); queue.push(c); }
    }
  }
  return out;
}

function pgrepChildren(pid: number): number[] {
  const r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf-8", timeout: 2000 });
  return (r.stdout ?? "").split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 1);
}

/** pid 들이 모두 사라질 때까지 기다린다. 상한을 넘으면 false(아직 남은 것이 있다). */
export async function waitForExit(
  pids: number[],
  opts: { timeoutMs: number; pollMs?: number; isAlive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void> },
): Promise<boolean> {
  const alive = opts.isAlive ?? pidAlive;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.timeoutMs;
  let left = pids.filter(alive);
  while (left.length) {
    if (Date.now() >= deadline) return false;
    await sleep(opts.pollMs ?? 200);
    left = left.filter(alive);
  }
  return true;
}

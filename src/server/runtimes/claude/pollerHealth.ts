// 영입과 재시작이 같은 poller 복구를 쓰되 런처·제어 모듈 간 순환 의존을 만들지 않도록 별도 모듈에 둔다.
// 프로세스가 살아 있어도 poller가 없으면 메시지를 못 받으므로 연결을 별도로 확인한다.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SAFE_ID = /^[a-z0-9_-]+$/i;

/** 플러그인은 토큰 확인 후 bot.pid를 쓰므로 이를 poller 기동 신호로 확인한다.
 * 시험은 homeDir·intervalMs를 주입해 실제 홈·봇을 건드리지 않으며 운영 기본 확인 간격은 1500ms다. */
export async function waitForClaudePoller(
  id: string,
  timeoutMs: number,
  opts?: { homeDir?: string; intervalMs?: number; pidAlive?: (pid: number) => boolean },
): Promise<boolean> {
  if (!SAFE_ID.test(id)) return false;
  const home = opts?.homeDir ?? process.env.HOME ?? "";
  const intervalMs = opts?.intervalMs ?? 1500;
  const pidFile = `${home}/.claude/channels/telegram-${id}/bot.pid`;
  const pidAlive = opts?.pidAlive ?? ((pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  const markerAlive = (): boolean => {
    try {
      if (!existsSync(pidFile)) return false;
      const raw = readFileSync(pidFile, "utf-8").trim();
      let pid = Number(raw);
      let agentId: string | undefined;
      if (!Number.isInteger(pid)) {
        const parsed = JSON.parse(raw) as { pid?: unknown; agentId?: unknown };
        pid = Number(parsed.pid);
        agentId = typeof parsed.agentId === "string" ? parsed.agentId : undefined;
      }
      if (agentId && agentId !== id) return false;
      return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
    } catch { return false; }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (markerAlive()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return markerAlive();
}

/** MCP 열거에서 Telegram이 빠졌을 때 /mcp reconnect plugin:telegram:telegram을 주입해 연결한다.
 * 메뉴 위치와 무관한 명령을 사용하며 세션이 없으면 false를 반환한다. */
export function reconnectClaudeTelegram(id: string): boolean {
  if (!SAFE_ID.test(id)) throw new Error(`unsafe agent id: ${id}`);
  try {
    if (spawnSync("tmux", ["has-session", "-t", `claude-${id}`], { stdio: "ignore" }).status !== 0) return false;
    spawnSync("tmux", ["send-keys", "-t", `claude-${id}`, "/mcp reconnect plugin:telegram:telegram", "Enter"], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

export interface PollerUpResult {
  /** poller 가 최종적으로 붙었는가 */
  ok: boolean;
  /** auto-reconnect 로 살려낸 것인가(첫 확인에 이미 붙어 있었으면 false) */
  recovered: boolean;
  /** 주입한 reconnect 횟수 */
  attempts: number;
  /** 사람이 읽는 한 줄(재시작 응답·활성화 step 에 그대로 쓴다) */
  detail: string;
}

/** poller를 기다린 뒤 미연결이면 MCP reconnect로 복구한다. 영입과 재시작 모두 이 경로를 공유해 프로세스만 살아 있는 상태를 방치하지 않는다. */
export async function ensureClaudePollerUp(
  id: string,
  opts?: {
    waitMs?: number;
    reconnectAttempts?: number;
    recheckMs?: number;
    /** 테스트 주입 — 실제 tmux/HOME 을 건드리지 않는다 */
    wait?: (id: string, ms: number) => Promise<boolean>;
    reconnect?: (id: string) => boolean;
  },
): Promise<PollerUpResult> {
  const waitMs = opts?.waitMs ?? 30000;
  const maxAttempts = opts?.reconnectAttempts ?? 2;
  const recheckMs = opts?.recheckMs ?? 12000;
  const wait = opts?.wait ?? ((i, ms) => waitForClaudePoller(i, ms));
  const reconnect = opts?.reconnect ?? reconnectClaudeTelegram;

  let ok = await wait(id, waitMs);
  if (ok) return { ok: true, recovered: false, attempts: 0, detail: "텔레그램 poller 기동 확인" };

  let attempts = 0;
  for (; !ok && attempts < maxAttempts; ) {
    // 세션 자체가 없으면(스폰 실패) reconnect 로 살릴 수 없다 — 헛도는 대신 즉시 중단한다.
    if (!reconnect(id)) break;
    attempts++;
    ok = await wait(id, recheckMs);
  }
  return {
    ok,
    recovered: ok && attempts > 0,
    attempts,
    detail: ok
      ? `텔레그램 poller 복구(auto-reconnect ${attempts}회)`
      : `★텔레그램 poller 미기동★ — auto-reconnect ${attempts}회 시도했으나 미복구. 세션에서 /mcp reconnect 재시도 가능`,
  };
}

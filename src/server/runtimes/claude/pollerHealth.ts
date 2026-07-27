// claude_channel 텔레그램 poller 헬스 + 자동복구.
//
// ★왜 별도 모듈인가★ — 이 로직이 필요한 곳이 둘인데(영입=activation, 재시작=agentControl),
//   기존 위치(activation.ts / launcher.ts)는 서로·agentControl 과 이미 얽혀 있어 어느 방향으로 import 해도
//   순환이 생긴다. 의존이 없는 자리로 내려 양쪽이 함께 쓴다(fs/process/tmux 만 씀).
//
// ★이게 왜 중요한가★ — poller 가 안 붙으면 팀원은 ★조용히 귀머거리★ 가 된다. 프로세스는 살아 있고
//   대시보드도 정상으로 보이는데 메시지만 안 들어온다. 오류도 안 난다. 사람이 눈치챌 때까지 방치된다.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SAFE_ID = /^[a-z0-9_-]+$/i;

/** claude 텔레그램 채널 poller 기동 대기 — 플러그인 MCP(server.ts)가 토큰 확인 통과 후에만 bot.pid를 쓴다.
 *  bot.pid 출현 = poller 실제 폴링 시작 = '진짜 대화됨'. 미출현 = 죽은 봇(귀머거리). timeoutMs 안에 확인. 슬러그 가드.
 *  opts = 테스트 격리용(실 HOME/~/.claude·라이브 봇 미접촉): homeDir로 base 경로를 tmp로 돌리고 intervalMs로 짧은 폴 간격.
 *  production은 opts 없이 호출 → HOME + 1500ms 그대로(동작 불변). */
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

/** ★auto-reconnect★: CC fresh 세션 부팅서 telegram MCP 가 부팅 MCP "열거"에서 빠지는 경우
 *  (실패 세션 로그 `Starting connection` 0건 = 타임아웃 아니라 스폰 자체 없음)를 런타임에 복구한다.
 *  슬래시 명령 `/mcp reconnect plugin:telegram:telegram` 을 세션에 주입하면 재열거돼 즉시 붙는다(실측).
 *  메뉴 네비가 아니라 슬래시 명령이라 커서 위치/항목 순서에 무관 = 로버스트.
 *  b3os 가 tmux 세션을 소유하므로 사용자가 tmux 에 들어갈 필요 없다. 세션이 없으면(스폰 실패) false. */
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

/**
 * poller 가 붙을 때까지 기다리고, 안 붙으면 `/mcp reconnect` 를 주입해 되살린다.
 *
 * ★영입에는 있었지만 재시작에는 없던 것★(2026-07-27 GD 지적) — 재시작 경로는 기동 스크립트만 돌리고
 *   붙었는지 확인조차 안 했다. 그래서 ★재시작 후 안 붙으면 아무도 복구하지 않았다.★ 팀원은 조용히
 *   귀머거리가 되고, 팀장이 눈치챌 때까지 방치된다. 같은 복구를 양쪽에서 쓰게 여기로 모은다.
 */
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

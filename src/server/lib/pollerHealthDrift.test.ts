// ★드리프트 가드★ — scripts/team-os 의 셸 poller 판정이 정본(runtimeEssentials.ts)과 같은 답을 내나.
//
// 왜 두 곳에 같은 판정이 있나:
//   team-os 는 ★서버가 죽었을 때★ 쓰는 복구 도구다. 서버 API 를 부를 수 없으니 셸로 다시 짤 수밖에
//   없다. 그래서 드리프트가 ★구조적으로★ 남는다 — 한쪽만 고치면 헬스 도구가 조용히 갈라진다.
//   조용히 갈라진 헬스 도구는 없는 것보다 나쁘다(정상이라고 거짓말하므로).
//   이 테스트가 두 판정을 같은 케이스 표에 태워 답이 같은지 못박는다. (리사 요구 #3, 2026-07-30)
//
// 실제 사고: 2026-07-30 리사 세션은 살아있는데 poller 가 죽어 28분 무응답. 정본은 그 상태를
//   unhealthy 로 판정했지만(runtime_essentials_missing 기록됨) team-os 는 tmux 세션만 보고
//   healthy 라고 했다. 도구가 정본보다 느슨했다.
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEssentialSettings, createRuntimeEssentialsRegistry } from "./runtimeEssentials";
import type { AgentRecord } from "../types";

const TEAM_OS = join(import.meta.dir, "../../../scripts/team-os");
const NAME = "drifttest";

/** 살아있는 pid — 이 테스트 프로세스 자신. 죽은 pid — 쓰이지 않을 큰 값. */
const ALIVE_PID = process.pid;
const DEAD_PID = 999_999;

interface Case {
  label: string;
  /** bot.pid 파일 내용. null 이면 파일을 만들지 않는다. */
  content: string | null;
  expectHealthy: boolean;
}

const CASES: Case[] = [
  { label: "bot.pid 없음 (2026-07-30 리사 상태)", content: null, expectHealthy: false },
  { label: "빈 파일", content: "", expectHealthy: false },
  { label: "공백만", content: "   \n", expectHealthy: false },
  { label: "평문 pid, 살아있음", content: String(ALIVE_PID), expectHealthy: true },
  { label: "평문 pid, 죽음", content: String(DEAD_PID), expectHealthy: false },
  { label: "평문 pid + 개행, 살아있음", content: `${ALIVE_PID}\n`, expectHealthy: true },
  { label: "JSON pid, 살아있음", content: JSON.stringify({ pid: ALIVE_PID, agentId: NAME }), expectHealthy: true },
  { label: "JSON pid, 죽음", content: JSON.stringify({ pid: DEAD_PID, agentId: NAME }), expectHealthy: false },
  { label: "쓰레기 값", content: "not-a-pid", expectHealthy: false },
  { label: "pid 0", content: "0", expectHealthy: false },
  { label: "음수 pid", content: "-1", expectHealthy: false },
];

/** 격리된 가짜 HOME 에 bot.pid 상태를 만든다. 실제 ~/.claude 는 건드리지 않는다. */
function makeHome(content: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "pollerdrift-"));
  const stateDir = join(home, ".claude", "channels", `telegram-${NAME}`);
  mkdirSync(stateDir, { recursive: true });
  if (content !== null) writeFileSync(join(stateDir, "bot.pid"), content);
  return home;
}

const REPO_ROOT = join(import.meta.dir, "../../..");

/** 셸 판정 — team-os 의 poller_healthy 를 함수만 로드해서 부른다(서브커맨드 실행 없음).
 *  ★TEAM_OS_REPO 를 반드시 준다★: source 하면 $0 이 스크립트 경로가 아니라 셸의 $0 이라서
 *  team-os 의 저장소 자동탐색이 실패하고 ★함수를 정의하기 전에 exit 1★ 한다. 그러면 이 함수가
 *  항상 false 를 리턴해서 "unhealthy" 로 보인다 — 즉 ★판정을 안 부르고도 unhealthy 케이스가
 *  전부 통과한다.★ 실제로 그렇게 짰다가 9건이 거짓 통과했고, healthy 케이스 3건만 빨개져서
 *  겨우 알았다. 그래서 아래 loadsOk() 로 로딩 자체를 따로 단정한다. */
function shellVerdict(home: string): boolean {
  const r = spawnSync(
    "bash",
    ["-c", `TEAMOS_LIB_ONLY=1 . "$1" >/dev/null 2>&1; poller_healthy "$2"`, "_", TEAM_OS, NAME],
    { env: { ...process.env, HOME: home, TEAM_OS_REPO: REPO_ROOT }, encoding: "utf8" },
  );
  return r.status === 0;
}

/** 셸 함수가 실제로 로드됐나 — 크래시가 'unhealthy' 로 위장하는 것을 막는 가드. */
function loadsOk(home: string): boolean {
  const r = spawnSync(
    "bash",
    ["-c", `TEAMOS_LIB_ONLY=1 . "$1" >/dev/null 2>&1; type poller_healthy >/dev/null 2>&1`, "_", TEAM_OS],
    { env: { ...process.env, HOME: home, TEAM_OS_REPO: REPO_ROOT }, encoding: "utf8" },
  );
  return r.status === 0;
}

/** 정본 판정 — claude_channel 분기의 poller 항목만 본다.
 *  ★deps 는 registry 로 주입한다★ — checkEssentialSettings 의 2번째 인자는 deps 가 아니라 registry 다.
 *  거기에 {home} 을 넘기면 registry["claude_channel"] 이 undefined 라서 ★조용히 okResult()★ 가 나온다
 *  (= 전부 healthy). 실제로 그렇게 짰다가 12건 전부 통과해버렸다 — 판정을 안 부르고 초록이 된 것이다. */
async function canonicalVerdict(home: string): Promise<boolean> {
  const agent = { id: NAME, runtime: "claude_channel" } as unknown as AgentRecord;
  const registry = createRuntimeEssentialsRegistry({ home });
  const res = await checkEssentialSettings(agent, registry);
  return !res.missing.some((m) => m.startsWith("poller:claude bot.pid"));
}

describe("poller 판정 — 셸(team-os)과 정본(runtimeEssentials)이 갈라지지 않는다", () => {
  // ★이 단정을 먼저 둔다★ — 셸 로딩이 깨지면 아래 unhealthy 케이스들이 전부 거짓 통과한다.
  test("셸 판정 함수가 실제로 로드된다 (크래시가 unhealthy 로 위장하지 못하게)", () => {
    const home = makeHome(null);
    try {
      expect(loadsOk(home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const c of CASES) {
    test(`${c.label} → ${c.expectHealthy ? "healthy" : "unhealthy"} (양쪽 동일)`, async () => {
      const home = makeHome(c.content);
      try {
        const shell = shellVerdict(home);
        const canon = await canonicalVerdict(home);
        // ① 기대값과 맞나
        expect(shell).toBe(c.expectHealthy);
        expect(canon).toBe(c.expectHealthy);
        // ② ★서로 같나★ — 이게 드리프트 가드의 본체다
        expect(shell).toBe(canon);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("★핵심 케이스: bot.pid 만 없으면 양쪽 다 unhealthy★ (세션 존재와 무관하게)", async () => {
    const home = makeHome(null);
    try {
      expect(shellVerdict(home)).toBe(false);
      expect(await canonicalVerdict(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

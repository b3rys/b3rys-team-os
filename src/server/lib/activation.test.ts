/**
 * activation — claude_channel poller 헬스게이트(waitForClaudePoller) 단위 테스트.
 *
 * 대상: 봇이 tmux로 떠도 텔레그램 플러그인 MCP(poller)가 실제 기동해 bot.pid를 써야 '진짜 대화됨'.
 *   bot.pid 미출현 = 죽은 봇('귀머거리')이 '합류 완료'로 거짓표시되던 근본. 이 게이트로 activateMember가
 *   poller 확인 실패 시 ok:false(step "poller")로 실패시킨다(d383175).
 *
 * ⚠️ 격리(2026-07-01 Steve 인시던트 방지): 실 HOME/~/.claude·라이브 봇을 절대 건드리지 않는다.
 *   waitForClaudePoller에 opts.homeDir=temp dir + 짧은 intervalMs를 주입해 tmp 경로만 검사한다.
 *   process.env.HOME은 읽지도 쓰지도 않는다(opts.homeDir override가 우선).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../db/migrate";
import { syncRegistry } from "./registry";
import { buildPersona, buildAgentsMd } from "./personaTemplates";
import {
  waitForClaudePoller, waitForCodexPoller, waitForHermesGateway,
  activateMember, teardownRuntime, swapRuntime, RUNTIMES, STATUS_BY_RUNTIME,
  type ActivateResult, type SwapDeps,
} from "./activation";

/** tmp HOME을 만들고, present=true면 ~/.claude/channels/telegram-<id>/bot.pid 를 미리 쓴다(실 HOME 미접촉). */
function tmpHome(id: string, present: boolean): string {
  const home = mkdtempSync(join(tmpdir(), "poller-gate-"));
  if (present) {
    const chanDir = join(home, ".claude", "channels", `telegram-${id}`);
    mkdirSync(chanDir, { recursive: true });
    writeFileSync(join(chanDir, "bot.pid"), `${process.pid}\n`, "utf-8");
  }
  return home;
}

describe("activation: claude poller 헬스게이트 (waitForClaudePoller)", () => {
  test("bot.pid 존재 → true, 빠르게 반환(첫 검사에서 확인)", async () => {
    const id = "nova";
    const home = tmpHome(id, true);
    const t0 = Date.now();
    const ok = await waitForClaudePoller(id, 5000, { homeDir: home, intervalMs: 20 });
    const elapsed = Date.now() - t0;
    expect(ok).toBe(true);
    expect(elapsed).toBeLessThan(500); // timeout(5s) 다 안 기다리고 즉시 true
  });

  test("bot.pid 미출현 → false, 짧은 timeout 후 반환(죽은 봇=합류 거짓표시 차단)", async () => {
    const id = "deadbot";
    const home = tmpHome(id, false); // channels 디렉토리 자체가 없음
    const t0 = Date.now();
    const ok = await waitForClaudePoller(id, 100, { homeDir: home, intervalMs: 20 });
    const elapsed = Date.now() - t0;
    expect(ok).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(90); // timeout(100ms)까지 기다림
    expect(elapsed).toBeLessThan(1500); // 그러나 오래 안 걸림(짧은 interval)
  });

  test("폴링 중 bot.pid가 나타나면 → true (레이스: 봇이 뒤늦게 기동)", async () => {
    const id = "late";
    const home = tmpHome(id, false);
    // 40ms 뒤 bot.pid 생성 → poller가 뒤늦게 뜨는 상황
    const chanDir = join(home, ".claude", "channels", `telegram-${id}`);
    setTimeout(() => {
      mkdirSync(chanDir, { recursive: true });
      writeFileSync(join(chanDir, "bot.pid"), `${process.pid}\n`, "utf-8");
    }, 40);
    const ok = await waitForClaudePoller(id, 2000, { homeDir: home, intervalMs: 20 });
    expect(ok).toBe(true);
  });

  test("잘못된 슬러그 id → 즉시 false(경로 주입 가드, FS 미접촉)", async () => {
    const home = tmpHome("x", false);
    const t0 = Date.now();
    const ok = await waitForClaudePoller("bad/../id", 5000, { homeDir: home, intervalMs: 20 });
    expect(ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(100); // 슬러그 가드로 대기 없이 즉시 반환
  });

  test("stale bot.pid(죽은 pid) → false", async () => {
    const id = "stale";
    const home = tmpHome(id, false);
    const chanDir = join(home, ".claude", "channels", `telegram-${id}`);
    mkdirSync(chanDir, { recursive: true });
    writeFileSync(join(chanDir, "bot.pid"), "99999999\n", "utf-8");
    const ok = await waitForClaudePoller(id, 100, { homeDir: home, intervalMs: 20 });
    expect(ok).toBe(false);
  });
});

describe("activation: codex bridge poller 헬스게이트 (waitForCodexPoller)", () => {
  test("ready marker 존재 → true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-poller-gate-"));
    const pidFile = join(dir, "cody.pid");
    writeFileSync(pidFile, `${process.pid}\n`, "utf-8");
    const ok = await waitForCodexPoller("cody", 5000, { pidFile, intervalMs: 20 });
    expect(ok).toBe(true);
  });

  test("ready marker 미출현 → false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-poller-gate-"));
    const ok = await waitForCodexPoller("cody", 100, { pidFile: join(dir, "missing.pid"), intervalMs: 20 });
    expect(ok).toBe(false);
  });

  test("잘못된 슬러그 id → 즉시 false", async () => {
    const ok = await waitForCodexPoller("../cody", 5000, { pidFile: "/tmp/unused", intervalMs: 20 });
    expect(ok).toBe(false);
  });

  test("stale ready marker pid → false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-poller-gate-"));
    const pidFile = join(dir, "cody.pid");
    writeFileSync(pidFile, "99999999\n", "utf-8");
    const ok = await waitForCodexPoller("cody", 100, { pidFile, intervalMs: 20 });
    expect(ok).toBe(false);
  });

  test("JSON ready marker의 agentId가 다르면 → false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-poller-gate-"));
    const pidFile = join(dir, "cody.pid");
    writeFileSync(pidFile, JSON.stringify({ pid: process.pid, agentId: "other" }) + "\n", "utf-8");
    const ok = await waitForCodexPoller("cody", 100, { pidFile, intervalMs: 20 });
    expect(ok).toBe(false);
  });
});

describe("activation: hermes gateway 헬스게이트 (waitForHermesGateway)", () => {
  test("현재 profile status가 대상 profile plist와 PID를 보이면 → true", async () => {
    const calls: string[] = [];
    const ok = await waitForHermesGateway("forin", 5000, {
      intervalMs: 20,
      statusRunner: async (profile) => {
        calls.push(profile);
        return { code: 0, out: "Launchd plist: /tmp/ai.hermes.gateway-forin.plist\n✓ Service definition matches the current Hermes install\n✓ Gateway service is loaded — PID 12345" };
      },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual(["forin"]);
  });

  test("뒤늦게 running 되면 → true", async () => {
    let n = 0;
    const ok = await waitForHermesGateway("forin", 2000, {
      intervalMs: 20,
      statusRunner: async () => (++n < 3
        ? { code: 0, out: "✗ Gateway service is not loaded" }
        : { code: 0, out: "Launchd plist: /tmp/ai.hermes.gateway-forin.plist\n✓ Gateway service is loaded — PID 12345" }),
    });
    expect(ok).toBe(true);
  });

  test("generic current PID만 있고 대상 profile PID가 없으면 → false", async () => {
    const ok = await waitForHermesGateway("forin", 100, {
      intervalMs: 20,
      statusRunner: async () => ({
        code: 0,
        out: [
          "Launchd plist: /Users/you/Library/LaunchAgents/ai.hermes.gateway.plist",
          "✓ Service definition matches the current Hermes install",
          "✗ Gateway service is not loaded",
          "  Service definition exists locally but launchd has not loaded it.",
          "Other profiles:",
          "  ✓ b3ryshermes      — PID 12325",
        ].join("\n"),
      }),
    });
    expect(ok).toBe(false);
  });

  test("generic current PID가 있어도 Other profiles의 대상 profile PID를 인정 → true", async () => {
    const ok = await waitForHermesGateway("mes", 5000, {
      intervalMs: 20,
      statusRunner: async () => ({
        code: 0,
        out: [
          "Launchd plist: /Users/you/Library/LaunchAgents/ai.hermes.gateway.plist",
          "✓ Service definition matches the current Hermes install",
          "✓ Gateway is supervised by launchd (PID 43335)",
          "Other profiles:",
          "  ✓ b3ryshermes      — PID 12325",
          "  ✓ mes              — PID 44736",
        ].join("\n"),
      }),
    });
    expect(ok).toBe(true);
  });

  test("대상 profile 라인이 PID를 보이면 → true", async () => {
    const ok = await waitForHermesGateway("forin", 5000, {
      intervalMs: 20,
      statusRunner: async () => ({ code: 0, out: "Profiles:\n  ✓ forin — PID 23456\n  ✓ other — PID 34567" }),
    });
    expect(ok).toBe(true);
  });

  test("구체적인 PID positive token 미출현 → false", async () => {
    const ok = await waitForHermesGateway("forin", 100, {
      intervalMs: 20,
      statusRunner: async () => ({ code: 0, out: "gateway: running" }),
    });
    expect(ok).toBe(false);
  });

  test("잘못된 profile/id → false", async () => {
    const ok = await waitForHermesGateway("bad/../id", 5000, {
      intervalMs: 20,
      statusRunner: async () => ({ code: 0, out: "✓ Gateway service is loaded — PID 12345" }),
    });
    expect(ok).toBe(false);
  });
});

/**
 * teardownRuntime — offboard(DELETE /members/:id)의 4-branch cleanup 블록 추출(Phase1).
 * ⚠️ 격리: opts.skip=true 또는 DI 오버라이드(setAgentEnabled/removeCodexBridgeFiles/removeClaudeBridgeFiles/
 * existsSync/rmSync/removePathWithRetries) 없이는 절대 호출하지 않는다 — 기본값은 실 HOME(~/.claude 등)을
 * 건드리는 진짜 구현이다(offboard 회귀 테스트는 settings.test.ts가 skipRuntimeCleanup:true로 이미 커버).
 */
describe("activation: teardownRuntime (Phase1 offboard 4-branch 추출)", () => {
  test("skip=true → DI 호출 없이 즉시 반환(skipped:true, FS 미접촉)", async () => {
    const calls: string[] = [];
    const r = await teardownRuntime("ghost", "codex", undefined, {
      skip: true,
      setAgentEnabled: async () => { calls.push("setAgentEnabled"); return { ok: true, detail: "" }; },
      removeCodexBridgeFiles: () => { calls.push("removeCodexBridgeFiles"); },
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(calls).toEqual([]);
  });

  test("codex → setAgentEnabled(false) + removeCodexBridgeFiles(removeToken+removeHome) 호출", async () => {
    const calls: string[] = [];
    const r = await teardownRuntime("cody", "codex", undefined, {
      setAgentEnabled: async (id, rt, en) => { calls.push(`setAgentEnabled:${id}:${rt}:${en}`); return { ok: true, detail: "" }; },
      removeCodexBridgeFiles: (id, opts) => { calls.push(`removeCodexBridgeFiles:${id}:${JSON.stringify(opts)}`); },
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["setAgentEnabled:cody:codex:false", 'removeCodexBridgeFiles:cody:{"removeToken":true,"removeHome":true}']);
  });

  test("claude_channel → setAgentEnabled(false) + removeClaudeBridgeFiles(removeToken) 호출", async () => {
    const calls: string[] = [];
    const r = await teardownRuntime("steve", "claude_channel", undefined, {
      setAgentEnabled: async (id, rt, en) => { calls.push(`setAgentEnabled:${id}:${rt}:${en}`); return { ok: true, detail: "" }; },
      removeClaudeBridgeFiles: (id, opts) => { calls.push(`removeClaudeBridgeFiles:${id}:${JSON.stringify(opts)}`); },
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["setAgentEnabled:steve:claude_channel:false", 'removeClaudeBridgeFiles:steve:{"removeToken":true}']);
  });

  test("hermes_agent(일반 프로필) → setAgentEnabled + rmSync/removePathWithRetries 호출(sleepMs=0으로 대기 스킵)", async () => {
    const calls: string[] = [];
    const t0 = Date.now();
    const r = await teardownRuntime("mes", "hermes_agent", { hermes_profile: "mes" }, {
      sleepMs: 0,
      setAgentEnabled: async (id, rt) => { calls.push(`setAgentEnabled:${id}:${rt}`); return { ok: true, detail: "" }; },
      existsSync: () => true,
      rmSync: ((p: any) => { calls.push(`rmSync:${p}`); }) as any,
      removePathWithRetries: (async (p: any) => { calls.push(`removePathWithRetries:${p}`); return true; }) as any,
    });
    expect(Date.now() - t0).toBeLessThan(300); // sleepMs 오버라이드로 1500ms 실제 대기 없음
    expect(r.ok).toBe(true);
    expect(calls).toContain("setAgentEnabled:mes:hermes_agent");
    expect(calls.some((c) => c.startsWith("rmSync:") && c.includes("mes-token.txt"))).toBe(true);
    expect(calls.some((c) => c.startsWith("removePathWithRetries:") && c.includes("/profiles/mes"))).toBe(true);
  });

  test("hermes_agent(base b3ryshermes) → setAgentEnabled 호출 안 함(공유 auth 소스 보존)", async () => {
    const calls: string[] = [];
    const r = await teardownRuntime("mes", "hermes_agent", { hermes_profile: "b3ryshermes" }, {
      sleepMs: 0,
      setAgentEnabled: async () => { calls.push("setAgentEnabled"); return { ok: true, detail: "" }; },
      existsSync: () => true,
      rmSync: (() => {}) as any,
      removePathWithRetries: (async () => true) as any,
    });
    expect(r.ok).toBe(true);
    expect(calls).not.toContain("setAgentEnabled"); // base profile은 절대 정지 안 함
    expect(r.detail).toContain("건너뜀");
  });

  test("openclaw → setAgentEnabled + 토큰/allowFrom/agent dir 정리 호출", async () => {
    const calls: string[] = [];
    const r = await teardownRuntime("lui", "openclaw", undefined, {
      setAgentEnabled: async (id, rt) => { calls.push(`setAgentEnabled:${id}:${rt}`); return { ok: true, detail: "" }; },
      existsSync: () => true,
      rmSync: ((p: any, opts?: any) => { calls.push(`rmSync:${p}:${JSON.stringify(opts ?? null)}`); }) as any,
    });
    expect(r.ok).toBe(true);
    expect(calls).toContain("setAgentEnabled:lui:openclaw");
    expect(calls.some((c) => c.includes("telegram-lui-token.txt"))).toBe(true);
    expect(calls.some((c) => c.includes("telegram-lui-allowFrom.json"))).toBe(true);
    expect(calls.some((c) => c.includes("/agents/lui") && c.includes('"recursive":true'))).toBe(true);
  });
});

/**
 * swapRuntime — 팀원 런타임 교체(claude_channel ↔ codex ↔ openclaw ↔ hermes_agent) 핵심 로직.
 * ⚠️ 격리: agents.json/워크스페이스는 전부 mkdtempSync 임시 dir. checkRuntimeAuth/activateMember/teardownRuntime는
 * 항상 DI mock(실 FS·바이너리·네트워크 미접촉). APPROVAL_EXECUTION_ENABLED=1은 이 describe 안에서만 세팅.
 */
describe("activation: swapRuntime", () => {
  const prevExec = process.env.APPROVAL_EXECUTION_ENABLED;
  beforeEach(() => { process.env.APPROVAL_EXECUTION_ENABLED = "1"; });
  afterEach(() => {
    if (prevExec === undefined) delete process.env.APPROVAL_EXECUTION_ENABLED;
    else process.env.APPROVAL_EXECUTION_ENABLED = prevExec;
  });

  function setupSwapFixture(
    agentOverrides: Record<string, unknown> | ((wsDir: string) => Record<string, unknown>) = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "swap-test-"));
    const wsDir = join(dir, "ws");
    mkdirSync(wsDir, { recursive: true });
    const registryPath = join(dir, "agents.json");
    const base: Record<string, unknown> = {
      id: "nova", display_name: "Nova", role: "design", nicknames: ["nova"],
      runtime: "claude_channel", status_provider: "claude_tmux",
      workspace_path: wsDir, persona_file: join(wsDir, "SOUL.md"),
      tmux_session: "claude-nova", telegram_bot_username: "nova_bot",
      avatar_emoji: "🤖", moderator_eligible: false,
    };
    const resolvedOverrides = typeof agentOverrides === "function" ? agentOverrides(wsDir) : agentOverrides;
    const agent = { ...base, ...resolvedOverrides };
    writeFileSync(registryPath, JSON.stringify([agent], null, 2), "utf-8");
    const db = new Database(":memory:");
    migrate(db);
    return { dir, wsDir, registryPath, db, agent };
  }

  const authOk = async (runtime: string) => ({ runtime, loggedIn: true, detail: "auth ok", fixHint: "" });
  const activateOk = async (): Promise<ActivateResult> => ({ ok: true, steps: [{ step: "runtime", ok: true, detail: "mock" }] });
  const teardownNoop: NonNullable<SwapDeps["teardownRuntime"]> = async () => ({ ok: true, detail: "noop(test)" });
  const FAKE_TOKEN = "123456:" + "A".repeat(35);

  test("off 공식멤버 16번째 재활성은 activateMember 중앙 가드에서 side effect 전에 거부", async () => {
    const { registryPath, db, agent } = setupSwapFixture();
    const active = Array.from({ length: 15 }, (_, i) => ({
      ...agent, id: `active${i}`, display_name: `Active ${i}`,
      workspace_path: `${agent.workspace_path}-${i}`, persona_file: `${agent.persona_file}-${i}`,
    }));
    writeFileSync(registryPath, JSON.stringify([agent, ...active], null, 2), "utf-8");
    const offFile = join(mkdtempSync(join(tmpdir(), "activation-limit-off-")), "agent-off.txt");
    const previousOffFile = process.env.TEAMOS_AGENT_OFF_FILE;
    process.env.TEAMOS_AGENT_OFF_FILE = offFile;
    writeFileSync(offFile, "nova\n", "utf-8");
    try {
      const result = await activateMember(db, {
        id: "nova", display_name: "Nova", role: "design", runtime: "claude_channel",
        bot_token: FAKE_TOKEN, registryPath,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("member_limit");
      expect(result.error).toBe("team_member_limit_reached");
      expect(result.steps[0]?.step).toBe("member-limit");
    } finally {
      if (previousOffFile === undefined) delete process.env.TEAMOS_AGENT_OFF_FILE;
      else process.env.TEAMOS_AGENT_OFF_FILE = previousOffFile;
    }
  });

  test("off 공식멤버 runtime swap은 teardown 전에 member_limit으로 거부", async () => {
    const { registryPath, db, agent } = setupSwapFixture();
    const active = Array.from({ length: 15 }, (_, i) => ({
      ...agent, id: `active${i}`, display_name: `Active ${i}`,
      workspace_path: `${agent.workspace_path}-${i}`, persona_file: `${agent.persona_file}-${i}`,
    }));
    writeFileSync(registryPath, JSON.stringify([agent, ...active], null, 2), "utf-8");
    const offFile = join(mkdtempSync(join(tmpdir(), "swap-limit-off-")), "agent-off.txt");
    const previousOffFile = process.env.TEAMOS_AGENT_OFF_FILE;
    process.env.TEAMOS_AGENT_OFF_FILE = offFile;
    writeFileSync(offFile, "nova\n", "utf-8");
    let teardownCalls = 0;
    try {
      const result = await swapRuntime(db, { id: "nova", targetRuntime: "codex", registryPath, bot_token: FAKE_TOKEN }, {
        checkRuntimeAuth: authOk,
        activateMember: activateOk,
        teardownRuntime: async () => { teardownCalls++; return { ok: true, detail: "unexpected" }; },
      });
      expect(result.code).toBe("member_limit");
      expect(teardownCalls).toBe(0);
    } finally {
      if (previousOffFile === undefined) delete process.env.TEAMOS_AGENT_OFF_FILE;
      else process.env.TEAMOS_AGENT_OFF_FILE = previousOffFile;
    }
  });

  test("swapRuntime 소스에 archiveWorkspace 호출이 없다(정적 가드 — 메모리 보존 불변식)", () => {
    const src = readFileSync(new URL("./activation.ts", import.meta.url), "utf-8");
    const start = src.indexOf("export async function swapRuntime");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\nexport async function approveOpenclawPairing", start);
    const body = src.slice(start, end > -1 ? end : undefined);
    expect(body).not.toContain("archiveWorkspace(");
  });

  test("메모리 보존 — MEMORY.md·memory/*.md·TODO.md 바이트 동일 유지, .archived 미생성", async () => {
    const { registryPath, wsDir, db } = setupSwapFixture();
    mkdirSync(join(wsDir, "memory"), { recursive: true });
    writeFileSync(join(wsDir, "MEMORY.md"), "# 기억\n\n중요한 내용.\n", "utf-8");
    writeFileSync(join(wsDir, "memory", "2026-01-01.md"), "일지 내용\n", "utf-8");
    writeFileSync(join(wsDir, "TODO.md"), "- [ ] 할 일\n", "utf-8");
    const memoryBefore = readFileSync(join(wsDir, "MEMORY.md"), "utf-8");
    const dailyBefore = readFileSync(join(wsDir, "memory", "2026-01-01.md"), "utf-8");
    const todoBefore = readFileSync(join(wsDir, "TODO.md"), "utf-8");

    const result = await swapRuntime(db, { id: "nova", targetRuntime: "codex", registryPath, bot_token: FAKE_TOKEN }, {
      checkRuntimeAuth: authOk, activateMember: activateOk, teardownRuntime: teardownNoop,
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(wsDir, "MEMORY.md"), "utf-8")).toBe(memoryBefore);
    expect(readFileSync(join(wsDir, "memory", "2026-01-01.md"), "utf-8")).toBe(dailyBefore);
    expect(readFileSync(join(wsDir, "TODO.md"), "utf-8")).toBe(todoBefore);
    expect(existsSync(join(wsDir, ".archived"))).toBe(false);
  });

  test("persona 파일명 전환 — claude→codex: CLAUDE.md 제거 + TEAM-OS.md 심링크 제거 + registry persona_file→SOUL.md", async () => {
    const { registryPath, wsDir, db } = setupSwapFixture();
    writeFileSync(join(wsDir, "CLAUDE.md"), "# Nova\n\n정체성.\n", "utf-8");
    require("node:fs").symlinkSync("/tmp/fake-team-os-src.md", join(wsDir, "TEAM-OS.md"));

    const result = await swapRuntime(db, { id: "nova", targetRuntime: "codex", registryPath, bot_token: FAKE_TOKEN }, {
      checkRuntimeAuth: authOk, activateMember: activateOk, teardownRuntime: teardownNoop,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(wsDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(wsDir, "TEAM-OS.md"))).toBe(false);
    const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(reg[0].persona_file).toBe(join(wsDir, "SOUL.md"));
    expect(reg[0].runtime).toBe("codex");
    expect(reg[0].status_provider).toBe("codex_cli");
    expect(reg[0].tmux_session).toBeUndefined();
  });

  test("persona 파일명 전환 — codex→claude: AGENTS.md orphan 제거 + TEAM-OS.md 심링크 생성 + registry persona_file은 SOUL.md 유지", async () => {
    const { registryPath, wsDir, db } = setupSwapFixture((ws) => ({
      runtime: "codex", status_provider: "codex_cli", persona_file: join(ws, "SOUL.md"), tmux_session: undefined,
    }));
    writeFileSync(join(wsDir, "SOUL.md"), "# SOUL.md — Nova\n\n정체성.\n", "utf-8");
    writeFileSync(join(wsDir, "AGENTS.md"), "# AGENTS.md — Nova\n\n로딩 파일.\n", "utf-8");

    const result = await swapRuntime(db, { id: "nova", targetRuntime: "claude_channel", registryPath, bot_token: FAKE_TOKEN }, {
      checkRuntimeAuth: authOk, activateMember: activateOk, teardownRuntime: teardownNoop,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(wsDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(wsDir, "TEAM-OS.md"))).toBe(true);
    expect(lstatSync(join(wsDir, "TEAM-OS.md")).isSymbolicLink()).toBe(true);
    const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(reg[0].persona_file).toBe(join(wsDir, "SOUL.md"));
    expect(reg[0].tmux_session).toBe("claude-nova");
    expect(reg[0].hermes_profile).toBeUndefined();
  });

  test("preflight 미로그인 → teardown/activate 호출 안 함 + agents.json 완전 불변 + code=preflight_blocked", async () => {
    const { registryPath, db } = setupSwapFixture();
    const before = readFileSync(registryPath, "utf-8");
    let teardownCalls = 0, activateCalls = 0;
    const result = await swapRuntime(db, { id: "nova", targetRuntime: "codex", registryPath }, {
      checkRuntimeAuth: async (rt) => ({ runtime: rt, loggedIn: false, detail: "미로그인", fixHint: "codex login 하세요" }),
      teardownRuntime: async () => { teardownCalls++; return { ok: true, detail: "" }; },
      activateMember: async () => { activateCalls++; return { ok: true, steps: [] }; },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("preflight_blocked");
    expect(result.error).toBe("codex login 하세요");
    expect(teardownCalls).toBe(0);
    expect(activateCalls).toBe(0);
    expect(readFileSync(registryPath, "utf-8")).toBe(before);
  });

  test("허용 안 되는 target_runtime(오타) → invalid_runtime, checkRuntimeAuth 호출 안 됨", async () => {
    const { registryPath, db } = setupSwapFixture();
    let authCalls = 0;
    const result = await swapRuntime(db, { id: "nova", targetRuntime: "codexx", registryPath }, {
      checkRuntimeAuth: async (rt) => { authCalls++; return { runtime: rt, loggedIn: true, detail: "", fixHint: "" }; },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_runtime");
    expect(authCalls).toBe(0);
  });

  test("실행 OFF(APPROVAL_EXECUTION_ENABLED 미설정) → 레지스트리 변경 전에 execution_off로 거부", async () => {
    delete process.env.APPROVAL_EXECUTION_ENABLED;
    const { registryPath, db } = setupSwapFixture();
    const before = readFileSync(registryPath, "utf-8");
    const result = await swapRuntime(db, { id: "nova", targetRuntime: "codex", registryPath }, { checkRuntimeAuth: authOk });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("execution_off");
    expect(readFileSync(registryPath, "utf-8")).toBe(before);
  });

  test("스왑 성공 후 runtime·status_provider 정합 + syncRegistry(reload) 통과", async () => {
    const { registryPath, db } = setupSwapFixture();
    const result = await swapRuntime(db, { id: "nova", targetRuntime: "openclaw", registryPath, bot_token: FAKE_TOKEN }, {
      checkRuntimeAuth: authOk, activateMember: activateOk, teardownRuntime: teardownNoop,
    });
    expect(result.ok).toBe(true);
    const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(reg[0].runtime).toBe("openclaw");
    expect(reg[0].status_provider).toBe(STATUS_BY_RUNTIME.openclaw);
    expect(() => syncRegistry(db, registryPath)).not.toThrow();
  });

  test("teardown 호출 — old runtime별로 teardownRuntime이 정확한 (id, runtime) 인자로 호출됨", async () => {
    for (const oldRuntime of ["codex", "claude_channel", "hermes_agent", "openclaw"] as const) {
      const target = [...RUNTIMES].find((r) => r !== oldRuntime)!;
      const { registryPath, db } = setupSwapFixture({
        runtime: oldRuntime,
        status_provider: STATUS_BY_RUNTIME[oldRuntime],
        hermes_profile: oldRuntime === "hermes_agent" ? "nova" : undefined,
      });
      const calls: Array<{ id: string; runtime: string }> = [];
      const result = await swapRuntime(db, { id: "nova", targetRuntime: target, registryPath, bot_token: FAKE_TOKEN }, {
        checkRuntimeAuth: authOk, activateMember: activateOk,
        teardownRuntime: async (id, runtime) => { calls.push({ id, runtime }); return { ok: true, detail: "spy" }; },
      });
      expect(result.ok).toBe(true);
      expect(calls).toEqual([{ id: "nova", runtime: oldRuntime }]);
    }
  });

  test("base hermes(b3ryshermes) 스왑 시도 → teardown 호출 전 거부(code=base_hermes_guard)", async () => {
    const { registryPath, db } = setupSwapFixture({ id: "b3ryshermes", runtime: "hermes_agent", status_provider: "hermes_gateway", hermes_profile: "b3ryshermes" });
    let teardownCalls = 0;
    const result = await swapRuntime(db, { id: "b3ryshermes", targetRuntime: "codex", registryPath }, {
      checkRuntimeAuth: authOk, activateMember: activateOk,
      teardownRuntime: async () => { teardownCalls++; return { ok: true, detail: "" }; },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("base_hermes_guard");
    expect(teardownCalls).toBe(0);
  });

  test("STEP5(activateMember) 실패 → 레지스트리·persona 원복 + old runtime self-heal 시도", async () => {
    const { registryPath, wsDir, db } = setupSwapFixture();
    const ORIGINAL_PERSONA = "# Nova\n\n원본 SOUL.md 커스텀 내용.\n";
    const ORIGINAL_LOADING = "# Nova\n\n원본 CLAUDE.md 로딩 내용.\n";
    writeFileSync(join(wsDir, "SOUL.md"), ORIGINAL_PERSONA, "utf-8");
    writeFileSync(join(wsDir, "CLAUDE.md"), ORIGINAL_LOADING, "utf-8");

    let activateCallCount = 0;
    const teardownCalls: Array<{ id: string; runtime: string }> = [];
    const result = await swapRuntime(db, { id: "nova", targetRuntime: "codex", registryPath, bot_token: FAKE_TOKEN }, {
      checkRuntimeAuth: authOk,
      teardownRuntime: async (id, runtime) => { teardownCalls.push({ id, runtime }); return { ok: true, detail: "teardown ok" }; },
      activateMember: async (_db, input) => {
        activateCallCount++;
        if (input.runtime === "codex") return { ok: false, steps: [{ step: "runtime", ok: false, detail: "boom" }], error: "boom" };
        return { ok: true, steps: [{ step: "runtime", ok: true, detail: "self-heal ok" }] }; // old(claude_channel) 재활성화는 성공
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("activate_failed");
    expect(activateCallCount).toBe(2); // 신 런타임 시도 1회 + old self-heal 1회
    expect(teardownCalls).toEqual([
      { id: "nova", runtime: "claude_channel" },
      { id: "nova", runtime: "codex" },
    ]);
    const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(reg[0].runtime).toBe("claude_channel"); // 복원됨
    expect(reg[0].status_provider).toBe("claude_tmux");
    expect(reg[0].persona_file).toBe(join(wsDir, "SOUL.md"));
    expect(readFileSync(join(wsDir, "SOUL.md"), "utf-8")).toBe(ORIGINAL_PERSONA); // persona 복원
    expect(readFileSync(join(wsDir, "CLAUDE.md"), "utf-8")).toBe(ORIGINAL_LOADING); // loading 복원
    const selfHealStep = result.steps.find((s) => s.step === "rollback-self-heal");
    expect(selfHealStep?.ok).toBe(true);
  });

  test("봇 토큰 전무(미제공+var/secrets+구 런타임 저장소 모두 없음) → ★teardown 전★ 즉시 실패(구 런타임 무손상)", async () => {
    const { registryPath, db } = setupSwapFixture();
    let teardownCalled = false;
    const result = await swapRuntime(db, { id: "nova", targetRuntime: "codex", registryPath }, {
      checkRuntimeAuth: authOk,
      teardownRuntime: async () => { teardownCalled = true; return { ok: true, detail: "noop(test)" }; },
      activateMember: async () => { throw new Error("활성화가 호출되면 안 됨(토큰 없어 그 전에 실패해야 함)"); },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("activate_failed");
    // ★핵심: 토큰 없으면 teardown 전에 중단 → 구 런타임 무손상(self-lock 아웃티지 방지, GD 2026-07-05 하네스 fix)★
    expect(teardownCalled).toBe(false);
    const precheck = result.steps.find((s) => s.step === "token-precheck");
    expect(precheck?.ok).toBe(false);
    expect(precheck?.detail).toContain("토큰");
  });

  test("자동 소싱 — bot_token 미제공+구 런타임 토큰 있음 → ★teardown이 그 토큰을 지워도★ 활성화가 수신(teardown 전 캡처 증명)", async () => {
    const { dir, registryPath, db } = setupSwapFixture();
    // ② 구 런타임 토큰 시뮬레이션: var/secrets/nova.bot-token 생성
    const secretsDir = join(dir, "var", "secrets");
    mkdirSync(secretsDir, { recursive: true });
    const tokenFile = join(secretsDir, "nova.bot-token");
    writeFileSync(tokenFile, FAKE_TOKEN + "\n", "utf-8");
    let capturedToken: string | undefined;
    let teardownCalled = false;
    const result = await swapRuntime(db, { id: "nova", targetRuntime: "codex", registryPath }, {
      checkRuntimeAuth: authOk,
      // ★실 teardown 의미 재현 — 구 런타임 토큰파일 삭제★. 캡처가 teardown보다 먼저여야 활성화가 토큰을 받는다.
      teardownRuntime: async () => { teardownCalled = true; require("node:fs").rmSync(tokenFile, { force: true }); return { ok: true, detail: "deleted-token(test)" }; },
      activateMember: async (_db: any, args: any): Promise<ActivateResult> => { capturedToken = args?.bot_token; return { ok: true, steps: [{ step: "runtime", ok: true, detail: "mock" }] }; },
    });
    expect(result.ok).toBe(true);
    expect(teardownCalled).toBe(true);        // teardown이 실제로 토큰파일을 지웠음
    expect(capturedToken).toBe(FAKE_TOKEN);   // ★그럼에도 활성화가 토큰 수신 = teardown 전에 캡처됐다는 증명(dead-code 아님)★
  });
});

/**
 * swapRuntime의 STEP4(c)는 핵심룰/comms 재주입을 의도적으로 생략한다 — activateMember가 항상
 * buildPersona(persona_file, existsSync 게이트)/buildAgentsMd(AGENTS.md, 무조건 덮어씀)로 새로 쓰므로
 * 스왑 후 정합성은 이 두 함수의 정확성으로 환원된다. 여기서 그 전제를 직접 증명한다(설계 노트 참조).
 */
describe("activation: swap 후 persona 정합성의 근거 — buildPersona/buildAgentsMd 직접 검증", () => {
  const base = { id: "nova", display_name: "Nova", role: "design" };

  test("claude_channel → CLAUDE.md에 핵심룰 + Claude 소통섹션 둘 다 포함", () => {
    const out = buildPersona({ ...base, runtime: "claude_channel" });
    expect(out).toContain("## ⭐ Core Rules");
    expect(out).toContain("## Communication note (Claude runtime)");
  });

  test("단순모델: buildPersona = claude CLAUDE.md 전용(@SOUL.md 참조 + 룰, 자동 정체성 없음)", () => {
    // 단순 모델(GD 2026-07-05): buildPersona는 claude 로딩파일만. openclaw/hermes IDENTITY.md는 사용자 입력 verbatim(buildPersona 아님).
    const out = buildPersona({ ...base, runtime: "claude_channel" });
    expect(out).toContain("@SOUL.md");        // IDENTITY.md 참조(inline)
    expect(out).not.toContain("You are");          // 자동 정체성 wrapper 없음
    expect(out).toMatch(/Core Rules|핵심 룰/);      // 룰은 있음
  });

  test("openclaw/hermes/codex → AGENTS.md(buildAgentsMd, 로딩파일)엔 핵심룰 있고 comms는 없음", () => {
    for (const runtime of ["openclaw", "hermes_agent", "codex"]) {
      const out = buildAgentsMd({ ...base, runtime });
      expect(out).toContain("## ⭐ Core Rules");
      expect(out).not.toContain("## Communication note (Claude runtime)");
    }
  });
});

// statusProbe characterization tests — P1b 안전망 (리팩토링 전 현재 동작 고정).
// 순수 헬퍼(extractCtxPercent·computeStateFromActivity)부터 핀. 외부호출(tmux/openclaw/hermes) 분기는
// 후속 단계에서 status-builder 추출 후 추가.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { AgentRecord } from "../types";
import type { Database } from "bun:sqlite";
import {
  extractCtxPercent,
  computeStateFromActivity,
  offlineStatus,
  buildClaudeStatus,
  buildOpenclawStatus,
  buildCodexStatus,
  codexBridgeLiveness,
  buildHermesStatus,
  hasStatusChanged,
  LIVENESS_PROBES,
  __setOpenclawHealthForTest,
} from "./statusProbe";
import { clearRuntimeBlock } from "../lib/runtimeBlocks";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("extractCtxPercent — Claude Code 'ctx N%' footer 파싱", () => {
  test("단일 매치 → 그 값", () => {
    expect(extractCtxPercent(["ctx 62%"])).toBe(62);
  });
  test("매치 없음 → null", () => {
    expect(extractCtxPercent(["no footer here", "just logs"])).toBe(null);
  });
  test("빈 배열 → null", () => {
    expect(extractCtxPercent([])).toBe(null);
  });
  test("여러 매치 → 가장 최근(배열 끝쪽) 값 우선", () => {
    // 구현은 끝에서부터 스캔하여 첫 매치 반환 = 가장 최근 라인의 값
    expect(extractCtxPercent(["ctx 30%", "ctx 80%"])).toBe(80);
  });
  test("0% 경계 허용", () => {
    expect(extractCtxPercent(["ctx 0%"])).toBe(0);
  });
  test("100% 경계 허용", () => {
    expect(extractCtxPercent(["ctx 100%"])).toBe(100);
  });
  test("100 초과 → 거부(null)", () => {
    expect(extractCtxPercent(["ctx 150%"])).toBe(null);
  });
  test("공백 변형 'ctx  62%' 매치", () => {
    expect(extractCtxPercent(["ctx  62%"])).toBe(62);
  });
});

describe("computeStateFromActivity — 마지막 활동 시각 → 상태", () => {
  test("null(활동기록 없음) → offline", () => {
    expect(computeStateFromActivity(null)).toBe("offline");
  });
  test("방금(<60s) → running", () => {
    const justNow = new Date(Date.now() - 5_000).toISOString();
    expect(computeStateFromActivity(justNow)).toBe("running");
  });
  test("60s~5min 사이 → idle", () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(computeStateFromActivity(twoMinAgo)).toBe("idle");
  });
  test("5min 초과 → blocked", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(computeStateFromActivity(tenMinAgo)).toBe("blocked");
  });
  test("경계 직후(60s 막 지남) → idle", () => {
    const justOverIdle = new Date(Date.now() - 61_000).toISOString();
    expect(computeStateFromActivity(justOverIdle)).toBe("idle");
  });

  // ★위 테스트들은 전부 toISOString()(Z 포함)을 넣는다 — ★프로덕션이 넘기는 형식이 아니다.★
  //   실제로 오는 값은 log_line.captured_at 그대로다: "2026-07-13 04:48:15" (UTC, ★Z 없음★).
  //   JS 는 Z 없는 문자열을 ★로컬 타임존★ 으로 읽는다 → KST 서버에서 9시간 어긋난다 →
  //   elapsed 가 9시간 부풀어 ★방금 답한 에이전트가 blocked 로 보인다.★ 지표가 통째로 거짓말한다.
  //
  // ■ ★왜 이게 여태 안 잡혔나 — 여기가 진짜 교훈이다★
  //   ★`bun test` 는 TZ=UTC 로 돈다. 서버는 KST 로 돈다.★ (실측: 테스트 안 오프셋 0, 서버 +9)
  //   TZ=UTC 에서는 Z 를 안 붙여도 결과가 같다 → ★이 계열 버그는 유닛 테스트로 원리적으로 못 잡는다.★
  //   그래서 아래 테스트는 ★TZ 를 직접 고정한다.★ 고정하지 않으면 이 테스트도 똑같이 눈을 감는다.
  describe("★비-UTC 타임존에서★ DB 형식(Z 없는 UTC)을 UTC 로 읽는가", () => {
    const savedTz = process.env.TZ;
    beforeEach(() => { process.env.TZ = "Asia/Seoul"; }); // ★+9 — 여기서만 고정★
    afterEach(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

    // UTC 벽시계 문자열 (SQLite datetime('now') 이 내놓는 바로 그 형식)
    const dbFormat = (msAgo: number) =>
      new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");

    test("★방금(5s) → running★ (UTC 로 안 읽으면 9시간 밀려 blocked 가 된다)", () => {
      expect(computeStateFromActivity(dbFormat(5_000))).toBe("running");
    });
    test("2분 전 → idle", () => {
      expect(computeStateFromActivity(dbFormat(2 * 60_000))).toBe("idle");
    });
    test("★형식이 달라도 같은 순간이면 같은 상태★ (ISO-Z ≡ DB 형식)", () => {
      const ms = 5_000;
      expect(computeStateFromActivity(dbFormat(ms))).toBe(
        computeStateFromActivity(new Date(Date.now() - ms).toISOString()),
      );
    });
  });
});

describe("offlineStatus — 오프라인 AgentStatus 생성", () => {
  test("기본 → offline·last_log null·pid null·ctx null", () => {
    const s = offlineStatus("ag1");
    expect(s.agent_id).toBe("ag1");
    expect(s.state).toBe("offline");
    expect(s.last_log_line).toBe(null);
    expect(s.tmux_pid).toBe(null);
    expect(s.ctx_percent).toBe(null);
    expect(s.last_activity_at).toBe(null);
  });
  test("lastLogLine 지정 → 그 값", () => {
    expect(offlineStatus("ag1", "down 사유").last_log_line).toBe("down 사유");
  });
});

describe("buildClaudeStatus — claude_tmux 상태 생성", () => {
  test("세션 없음(exists=false) → offline (pid·recent 무시)", () => {
    const s = buildClaudeStatus("bill", false, 1234, [{ line: "x", captured_at: new Date().toISOString() }]);
    expect(s.state).toBe("offline");
    expect(s.tmux_pid).toBe(null);
    expect(s.last_log_line).toBe(null);
  });
  test("세션 있음 + 최근 활동 → running + pid + 마지막 로그 + ctx", () => {
    const latestTs = new Date(Date.now() - 3_000).toISOString();
    const recent = [
      { line: "older", captured_at: new Date(Date.now() - 30_000).toISOString() },
      { line: "ctx 42% latest", captured_at: latestTs },
    ];
    const s = buildClaudeStatus("bill", true, 5678, recent);
    expect(s.state).toBe("running");
    expect(s.tmux_pid).toBe(5678);
    expect(s.last_log_line).toBe("ctx 42% latest");
    // footer "ctx 42%" = 잔여 42% → 저장은 사용률로 뒤집음(100-42=58). Claude Code 문맥표시 역전 fix(2026-07-03).
    expect(s.ctx_percent).toBe(58);
    expect(s.last_activity_at).toBe(latestTs);
  });
  test("usage-limit 프롬프트가 최근 로그에 있으면 footer보다 우선 보존", () => {
    const latestTs = new Date(Date.now() - 3_000).toISOString();
    const recent = [
      { line: "You've hit your monthly spend limit.", captured_at: new Date(Date.now() - 10_000).toISOString() },
      { line: "  -- INSERT -- ⏵⏵ auto mode on · ← for agents", captured_at: latestTs },
    ];
    const s = buildClaudeStatus("bill", true, 5678, recent);
    expect(s.last_log_line).toContain("monthly spend limit");
    expect(s.last_activity_at).toBe(latestTs);
  });
  test("weekly-limit 프롬프트는 현재 화면 footer만 갱신돼도 보존", () => {
    const latestTs = new Date(Date.now() - 3_000).toISOString();
    const recent = [
      { line: "You've hit your weekly limit.", captured_at: new Date(Date.now() - 10_000).toISOString() },
      { line: "  -- INSERT -- ⏵⏵ auto mode on · ← for agents", captured_at: latestTs },
    ];
    const currentPane = [
      "❯ ",
      "/Users/you/Development/your-workspace   Opus 4.8",
      "ctx 91% [===============-] · reset 48m (14:45)",
      "-- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ];
    const s = buildClaudeStatus("bill", true, 5678, recent, currentPane);
    expect(s.last_log_line).toContain("weekly limit");
  });
  test("현재 화면의 weekly-limit은 아래쪽 prompt/footer보다 우선한다", () => {
    const latestTs = new Date(Date.now() - 3_000).toISOString();
    const recent = [
      { line: "review request received", captured_at: new Date(Date.now() - 10_000).toISOString() },
      { line: "  -- INSERT -- ⏵⏵ auto mode on · ← for agents", captured_at: latestTs },
    ];
    const currentPane = [
      "⎿  You've hit your weekly limit · resets 8am (Asia/Seoul)",
      "   /upgrade or /usage-credits to finish what you’re working on.",
      "",
      "✻ Sautéed for 1s",
      "❯ ",
      "/Users/you/Development/your-workspace   Opus 4.8",
      "ctx 13% [==--------------] · reset 22m (20:45)",
      "-- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ];
    const s = buildClaudeStatus("bill", true, 5678, recent, currentPane);
    expect(s.last_log_line).toContain("weekly limit");
  });
  test("usage credits 상태는 세션이 살아 있어도 last_log_line에 보존", () => {
    const latestTs = new Date(Date.now() - 3_000).toISOString();
    const recent = [
      { line: "Now using usage credits.", captured_at: new Date(Date.now() - 10_000).toISOString() },
      { line: "  -- INSERT -- ⏵⏵ auto mode on · ← for agents", captured_at: latestTs },
    ];
    const s = buildClaudeStatus("steve", true, 5678, recent);
    expect(s.last_log_line).toContain("usage credits");
    expect(s.state).toBe("running");
  });
  test("usage-limit 프롬프트가 오래됐고 이후 정상 출력이 있으면 정상 출력으로 복구", () => {
    const latestTs = new Date(Date.now()).toISOString();
    const recent = [
      { line: "You've hit your monthly spend limit.", captured_at: new Date(Date.now() - 10 * 60_000).toISOString() },
      { line: "Ready for input · ctx 12%", captured_at: latestTs },
    ];
    const s = buildClaudeStatus("bill", true, 5678, recent);
    expect(s.last_log_line).toBe("Ready for input · ctx 12%");
  });
  test("현재 tmux 화면이 있으면 오래된 DB usage-limit 잔여 상태보다 현재 화면을 우선한다", () => {
    const staleTs = new Date(Date.now() - 5 * 60_000).toISOString();
    const recent = [
      { line: "You've hit your monthly spend limit.", captured_at: staleTs },
      { line: "  -- INSERT -- ⏵⏵ auto mode on · ← for agents", captured_at: staleTs },
    ];
    const currentPane = [
      "⏺ GD에게 응답 전송 완료.",
      "────────────────────────────────────────────────────────────────────────────────",
      "❯ ",
      "/Users/you/Development/your-workspace   Opus 4.8",
      "ctx 94% [===============-] · reset 48m (14:45)",
      "-- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ];
    const s = buildClaudeStatus("dbak", true, 5678, recent, currentPane);
    expect(s.last_log_line).not.toContain("monthly spend limit");
    expect(s.last_log_line).toContain("auto mode on");
    // "ctx 94%" = 잔여 94%(거의 빈) → 저장 사용률 6%(100-94). 문맥표시 역전 fix(2026-07-03).
    expect(s.ctx_percent).toBe(6);
    // Activity still comes from captured log movement, not from a static pane snapshot.
    expect(s.last_activity_at).toBe(staleTs);
  });
  test("세션 있음 + 빈 로그 → offline state(활동기록 없음), pid는 유지", () => {
    const s = buildClaudeStatus("bill", true, 99, []);
    expect(s.state).toBe("offline"); // computeStateFromActivity(null)
    expect(s.tmux_pid).toBe(99);
    expect(s.last_activity_at).toBe(null);
    expect(s.ctx_percent).toBe(null);
  });
});

describe("hasStatusChanged — broadcast 변경 판단", () => {
  test("last_log_line만 바뀌어도 capacity alert 진입/복구를 위해 changed", () => {
    const base = buildClaudeStatus("bill", true, 1234, [
      { line: "Ready for input · ctx 12%", captured_at: new Date().toISOString() },
    ]);
    const next = { ...base, last_log_line: "You've hit your weekly limit." };

    expect(hasStatusChanged(base, next)).toBe(true);
  });
});

describe("buildOpenclawStatus — openclaw_gateway 상태 생성", () => {
  test("게이트웨이 down → offline + 'openclaw gateway down'", () => {
    const s = buildOpenclawStatus("codex", false);
    expect(s.state).toBe("offline");
    expect(s.last_log_line).toBe("openclaw gateway down");
  });
  test("게이트웨이 healthy → idle + 'gateway healthy (per-agent probe TBD)'", () => {
    const s = buildOpenclawStatus("codex", true);
    expect(s.state).toBe("idle");
    expect(s.last_log_line).toBe("gateway healthy (per-agent probe TBD)");
  });
  test("게이트웨이 healthy여도 최근 runtime block이 있으면 blocked + block line", () => {
    const s = buildOpenclawStatus("codex", true, "openclaw runtime openclaw response timeout");
    expect(s.state).toBe("blocked");
    expect(s.last_log_line).toContain("openclaw response timeout");
  });
});

describe("buildCodexStatus — codex_cli 상태 생성", () => {
  test("idle + block 없음 → bus idle + bridge not probed", () => {
    const s = buildCodexStatus("cody", 0);
    expect(s.state).toBe("idle");
    expect(s.last_log_line).toBe("codex bus idle; codex telegram bridge not probed");
  });
  test("최근 runtime block이 있으면 blocked + block line", () => {
    const s = buildCodexStatus("cody", 0, "codex runtime failed: 429 rate limit");
    expect(s.state).toBe("blocked");
    expect(s.last_log_line).toContain("429 rate limit");
  });
  test("exit_0 empty-reply block은 liveness 실패로 보지 않음", () => {
    const s = buildCodexStatus("cody", 0, "codex runtime failed: exit_0", { ok: true, line: "codex telegram bridge ready (pid 123)" });
    expect(s.state).toBe("idle");
    expect(s.last_log_line).toBe("codex bus idle; codex telegram bridge ready (pid 123)");
  });
  test("turn in flight는 block보다 running 상태를 우선 표시", () => {
    const s = buildCodexStatus("cody", 1, "codex runtime failed: 429 rate limit");
    expect(s.state).toBe("running");
    expect(s.last_log_line).toContain("turn(s) in flight");
  });
  test("telegram bridge marker missing은 bus idle과 분리해 보조 liveness로만 관측", () => {
    const s = buildCodexStatus("cody", 0, null, { ok: false, line: "codex telegram bridge marker missing" });
    expect(s.state).toBe("idle");
    expect(s.last_log_line).toBe("codex bus idle; codex telegram bridge marker missing");
  });
  test("telegram bridge ready는 bus idle line에 함께 표시", () => {
    const s = buildCodexStatus("cody", 0, null, { ok: true, line: "codex telegram bridge ready (pid 123)" });
    expect(s.state).toBe("idle");
    expect(s.last_log_line).toContain("codex bus idle");
    expect(s.last_log_line).toContain("telegram bridge ready");
  });
});

describe("codexBridgeLiveness", () => {
  test("현재 pid marker는 ready", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-liveness-"));
    const pidFile = join(dir, "cody.pid");
    writeFileSync(pidFile, `${process.pid}\n`, "utf-8");
    const r = codexBridgeLiveness("cody", { pidFile });
    expect(r.ok).toBe(true);
    expect(r.line).toContain("ready");
  });
  test("JSON pid marker도 ready", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-liveness-"));
    const pidFile = join(dir, "cody.pid");
    writeFileSync(pidFile, JSON.stringify({ pid: process.pid, ready_at: new Date().toISOString() }), "utf-8");
    const r = codexBridgeLiveness("cody", { pidFile });
    expect(r.ok).toBe(true);
    expect(r.line).toContain(`pid ${process.pid}`);
  });
  test("잘못된 JSON pid marker는 invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-liveness-"));
    const pidFile = join(dir, "cody.pid");
    writeFileSync(pidFile, "{broken", "utf-8");
    const r = codexBridgeLiveness("cody", { pidFile });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("pid invalid");
  });
  test("없는 marker는 down", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-liveness-"));
    const r = codexBridgeLiveness("cody", { pidFile: join(dir, "missing.pid") });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("marker missing");
  });
  test("죽은 pid marker는 down", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-liveness-"));
    const pidFile = join(dir, "dead.pid");
    writeFileSync(pidFile, "99999999\n", "utf-8");
    const r = codexBridgeLiveness("cody", { pidFile });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("pid not running");
  });
});

describe("buildHermesStatus — hermes_gateway 상태 생성", () => {
  test("ok=true → idle + line 보존", () => {
    const s = buildHermesStatus("hermes", { ok: true, line: "Gateway service is loaded" });
    expect(s.state).toBe("idle");
    expect(s.last_log_line).toBe("Gateway service is loaded");
  });
  test("ok=false → offline + line 보존", () => {
    const s = buildHermesStatus("hermes", { ok: false, line: "timeout" });
    expect(s.state).toBe("offline");
    expect(s.last_log_line).toBe("timeout");
  });
});

describe("LIVENESS_PROBES 레지스트리 (Steve Q2: openclaw 캐시 live-binding)", () => {
  const agent = { id: "codex", status_provider: "openclaw_gateway" } as AgentRecord;
  const fakeDb = {} as Database;

  test("openclaw probe는 openclawHealth 갱신을 '호출시점'에 반영 (스냅샷 주입 아님)", async () => {
    // 격리: openclaw probe는 module-level runtimeBlocks(getRuntimeBlock) 를 읽는다.
    // 앞 테스트 파일이 "codex" 블록을 남겼으면 idle 대신 blocked 로 오염 → 자기 상태를 선정리.
    clearRuntimeBlock(agent.id);
    const probe = LIVENESS_PROBES.get("openclaw_gateway");
    expect(probe).toBeDefined();
    // 게이트웨이 down 상태 → offline
    __setOpenclawHealthForTest(false);
    expect((await probe!(agent, fakeDb)).state).toBe("offline");
    // 사전체크가 healthy로 갱신(객체 reassign) → probe가 최신 binding 반영해야 idle
    // (factory로 스냅샷 주입했다면 여기서 여전히 offline → 전 openclaw 강제 offline 버그)
    __setOpenclawHealthForTest(true);
    expect((await probe!(agent, fakeDb)).state).toBe("idle");
    // 정리: 라이브 사전체크 흐름에 영향 없게 false로 복원
    __setOpenclawHealthForTest(false);
  });

  test("미지원 status_provider → undefined → offlineStatus (기존 else 등가)", async () => {
    const probe = LIVENESS_PROBES.get("nonexistent_provider");
    expect(probe).toBeUndefined();
    // 루프는 undefined → offlineStatus(agent.id) 폴백 (payload = 기존 else와 동일: 전부 null)
    const fallback = offlineStatus("x");
    expect(fallback.state).toBe("offline");
    expect(fallback.last_log_line).toBe(null);
    expect(fallback.tmux_pid).toBe(null);
    expect(fallback.ctx_percent).toBe(null);
  });
});

import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AgentRecord, AgentState, AgentStatus } from "../types";
import { upsertStatus, getStatus, recentLogLines } from "../db/queries";
import type { Broadcaster } from "./types";
import { inFlightCount } from "../runtimes/b3osNative/adapter";
import { inFlightCount as codexInFlightCount } from "../runtimes/codex/adapter";
import { codexBridgePaths } from "../runtimes/codex/launcher";
import { getRuntimeBlock } from "../lib/runtimeBlocks";
import { hermesBinary } from "../lib/paths";

const POLL_INTERVAL_MS = 5000;
const IDLE_AFTER_MS = 60_000;
const BLOCKED_AFTER_MS = 5 * 60_000;

async function tmuxSessionExists(session: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", ["has-session", "-t", session]);
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

async function tmuxPid(session: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", ["list-panes", "-t", session, "-F", "#{pane_pid}"]);
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const pid = parseInt(out.trim().split("\n")[0] ?? "", 10);
      resolve(Number.isFinite(pid) ? pid : null);
    });
  });
}

async function captureTmuxPane(session: string): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", ["capture-pane", "-p", "-t", session, "-S", "-80"]);
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.on("error", () => resolve([]));
    proc.on("close", (code) => {
      if (code !== 0) return resolve([]);
      const lines = out.split("\n");
      while (lines.length && lines[lines.length - 1]?.trim() === "") lines.pop();
      resolve(lines);
    });
  });
}

let openclawHealth: { ok: boolean; checked_at: number } = { ok: false, checked_at: 0 };
const hermesHealth = new Map<string, { ok: boolean; checked_at: number; line: string }>();

// 테스트 전용: openclaw probe가 module-level openclawHealth를 '호출시점 live 참조'로 읽는지 핀하기 위함
// (Steve P1b 리뷰 Q2: factory로 스냅샷 주입하면 사전체크 갱신 안 보여 전 openclaw 강제 offline 버그).
// 프로덕션 경로는 이 함수를 호출하지 않는다.
export function __setOpenclawHealthForTest(ok: boolean): void {
  openclawHealth = { ok, checked_at: Date.now() };
}

async function checkOpenclawHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; status?: string };
    return body.ok === true || body.status === "live";
  } catch {
    return false;
  }
}

async function checkHermesGateway(agent: AgentRecord): Promise<{ ok: boolean; line: string }> {
  const cmd = agent.hermes_alias ?? hermesBinary(agent);
  return new Promise((resolve) => {
    const proc = spawn(cmd, ["gateway", "status"]);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, line: "hermes gateway status timeout" });
    }, 3000);
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, line: e.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // "Other profiles:" 섹션은 다른 프로필들의 ✓/PID 를 나열하므로 자기 프로필 판정에서 제외한다.
      // (전체 out 에 /PID/ 를 걸면 죽은 프로필도 다른 프로필 PID 에 매칭돼 healthy 오탐 — 2026-07-08 대시보드 버그.)
      const selfOut = out.split(/^[ \t]*Other profiles:/im)[0] ?? out;
      const text = (selfOut || err).split("\n").find((l) => l.trim())?.trim() ?? "";
      const healthy = /Gateway service is loaded|\bPID\b|running/i.test(selfOut) && !/not loaded|not running/i.test(selfOut);
      resolve({ ok: code === 0 && healthy, line: text || "hermes gateway status checked" });
    });
  });
}

/** Extract "ctx 62%" from recent Claude Code tmux footer lines. Returns null if not found. */
export function extractCtxPercent(lines: string[]): number | null {
  // Scan from most-recent first.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]?.match(/ctx\s+(\d+)%/);
    if (m && m[1]) {
      const v = parseInt(m[1], 10);
      if (Number.isFinite(v) && v >= 0 && v <= 100) return v;
    }
  }
  return null;
}

const RUNTIME_BLOCK_FRESH_MS = Number(process.env.HEALTH_RUNTIME_BLOCK_FRESH_MS ?? 2 * 60_000);
const WEEKLY_LIMIT_FRESH_MS = Number(process.env.HEALTH_WEEKLY_LIMIT_FRESH_MS ?? 24 * 60 * 60_000);
const WEEKLY_LIMIT_RE = /you.ve hit your weekly limit|weekly limit/i;
const CAPACITY_RE =
  /weekly limit|monthly spend limit|usage credits?|usage credit balance|now using usage credits|wait for limit to reset|used 100% of your session limit/i;
const PASSIVE_STATUS_RE = /^\s*(ctx\s+\d+%|\S*\s*-- INSERT --|-- INSERT --)/i;

function parseCapturedAt(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  const withZ = /[Z+]/.test(iso) ? iso : iso + "Z";
  const n = Date.parse(withZ);
  return Number.isNaN(n) ? null : n;
}

function runtimeBlockedLine(recent: { line: string; captured_at: string }[]): string | null {
  const latestAt = parseCapturedAt(recent[recent.length - 1]?.captured_at);
  let sawNewerSubstantiveLine = false;
  for (let i = recent.length - 1; i >= 0; i--) {
    const item = recent[i];
    if (!item) continue;
    const line = item.line;
    if (WEEKLY_LIMIT_RE.test(line)) {
      if (sawNewerSubstantiveLine) return null;
      if (latestAt == null) return line;
      const capturedAt = parseCapturedAt(item.captured_at);
      if (capturedAt != null && latestAt - capturedAt <= WEEKLY_LIMIT_FRESH_MS) return line;
    }
    if (line.trim() && !PASSIVE_STATUS_RE.test(line)) sawNewerSubstantiveLine = true;
    if (latestAt != null) {
      const capturedAt = parseCapturedAt(item.captured_at);
      if (capturedAt != null && latestAt - capturedAt > RUNTIME_BLOCK_FRESH_MS) continue;
    }
    if (CAPACITY_RE.test(line) || /enter to confirm · esc to cancel/i.test(line)) {
      return line;
    }
  }
  return null;
}

function weeklyLimitBlockedLine(recent: { line: string; captured_at: string }[]): string | null {
  const latestAt = parseCapturedAt(recent[recent.length - 1]?.captured_at);
  let sawNewerSubstantiveLine = false;
  for (let i = recent.length - 1; i >= 0; i--) {
    const item = recent[i];
    if (!item) continue;
    const line = item.line;
    if (WEEKLY_LIMIT_RE.test(line)) {
      if (sawNewerSubstantiveLine) return null;
      if (latestAt == null) return line;
      const capturedAt = parseCapturedAt(item.captured_at);
      if (capturedAt != null && latestAt - capturedAt <= WEEKLY_LIMIT_FRESH_MS) return line;
    }
    if (line.trim() && !PASSIVE_STATUS_RE.test(line)) sawNewerSubstantiveLine = true;
  }
  return null;
}

function currentPaneCapacityLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && CAPACITY_RE.test(line)) return line;
  }
  return null;
}

// ★DB 시각은 UTC 인데 Z 가 없다 ("2026-07-13 04:48:15").★ 맨 `new Date()` 로 읽으면 ★로컬★ 로 해석돼
//   KST 서버에서 9시간 어긋나고, elapsed 가 9시간 부풀어 ★방금 답한 에이전트가 blocked 로 뒤집힌다.★
//   parseCapturedAt 이 Z 를 붙여 UTC 로 고정한다 — 다른 호출부는 이미 이걸 쓰고 있었고 ★여기만 안 썼다.★
export function computeStateFromActivity(lastActivityAt: string | null): AgentState {
  if (!lastActivityAt) return "offline";
  const at = parseCapturedAt(lastActivityAt);
  if (at === null) return "offline"; // 파싱 불가 = 활동을 모른다 (0 으로 읽어 blocked 로 단정하지 않는다)
  const elapsed = Date.now() - at;
  if (elapsed < IDLE_AFTER_MS) return "running";
  if (elapsed < BLOCKED_AFTER_MS) return "idle";
  return "blocked";
}

// ── status-builder 순수 함수 (P1b: 루프 인라인 AgentStatus 생성을 추출 → 테스트 가능 + LivenessAdapter 씨앗) ──
// 외부호출(tmux/openclaw/hermes) '결과'를 입력으로 받아 AgentStatus만 생성한다(순수). 외부호출 자체는 루프에 남김.
// 동작 동일: 각 분기의 객체 생성 로직을 그대로 옮긴 것(probed_at = 호출 시각).
export function offlineStatus(agentId: string, lastLogLine: string | null = null): AgentStatus {
  return {
    agent_id: agentId,
    state: "offline",
    last_activity_at: null,
    last_log_line: lastLogLine,
    tmux_pid: null,
    ctx_percent: null,
    probed_at: new Date().toISOString(),
  };
}

export function buildClaudeStatus(
  agentId: string,
  exists: boolean,
  pid: number | null,
  recent: { line: string; captured_at: string }[],
  currentPaneLines: string[] = [],
): AgentStatus {
  if (!exists) return offlineStatus(agentId);
  const lastLog = recent[recent.length - 1];
  const observedLines = currentPaneLines.length ? currentPaneLines : recent.map((r) => r.line);
  const now = new Date().toISOString();
  const observedRecent = currentPaneLines.length
    ? currentPaneLines.map((line) => ({ line, captured_at: now }))
    : recent;
  const blockedLine =
    (currentPaneLines.length ? currentPaneCapacityLine(currentPaneLines) : null) ??
    runtimeBlockedLine(observedRecent) ??
    (currentPaneLines.length ? weeklyLimitBlockedLine(recent) : null);
  const lastActivityAt = lastLog?.captured_at ?? null;
  const visibleLastLine = currentPaneLines.findLast((line) => line.trim()) ?? null;
  // Claude Code footer "ctx N%" = auto-compact 까지 *남은* 문맥%(잔여). b3os 지표는 '사용률'(높을수록 위험 —
  //   AgentCard 바 ≥85%=빨강, health ≥90%=compact권장)이라 저장 시 뒤집는다: usage = 100 - remaining.
  //   안 뒤집으면 갓 뜬 빈 세션(잔여 95%)이 빨강, 실제 꽉 참(잔여 10%)이 초록으로 숨는 역전 오탐 —
  //   모니터가 거꾸로 동작(GD 맥북 클린테스트서 Claude Code v2.1.200 확인 2026-07-03).
  const ctxRemaining = extractCtxPercent(observedLines) ?? (currentPaneLines.length ? extractCtxPercent(recent.map((r) => r.line)) : null);
  return {
    agent_id: agentId,
    state: computeStateFromActivity(lastActivityAt),
    last_activity_at: lastActivityAt,
    last_log_line: blockedLine ?? visibleLastLine ?? lastLog?.line ?? null,
    tmux_pid: pid,
    ctx_percent: ctxRemaining == null ? null : 100 - ctxRemaining,
    probed_at: new Date().toISOString(),
  };
}

export function buildOpenclawStatus(agentId: string, gatewayOk: boolean, runtimeBlockLine: string | null = null): AgentStatus {
  if (!gatewayOk) return offlineStatus(agentId, "openclaw gateway down");
  // Phase 1: per-agent state unknown (no public per-agent API yet). gateway healthy → "idle".
  return {
    agent_id: agentId,
    state: runtimeBlockLine ? "blocked" : "idle",
    last_activity_at: null,
    last_log_line: runtimeBlockLine ?? "gateway healthy (per-agent probe TBD)",
    tmux_pid: null,
    ctx_percent: null,
    probed_at: new Date().toISOString(),
  };
}

export interface CodexBridgeLiveness {
  ok: boolean;
  line: string;
}

export function codexBridgeLiveness(agentId: string, opts?: { pidFile?: string }): CodexBridgeLiveness {
  if (!/^[a-z0-9_-]+$/i.test(agentId)) return { ok: false, line: "codex telegram bridge invalid agent id" };
  const pidFile = opts?.pidFile ?? codexBridgePaths(agentId).pidFile;
  if (!existsSync(pidFile)) return { ok: false, line: "codex telegram bridge marker missing" };
  const raw = readFileSync(pidFile, "utf-8").trim();
  let marker: unknown = raw;
  if (raw.startsWith("{")) {
    try {
      marker = (JSON.parse(raw) as { pid?: unknown }).pid;
    } catch {
      return { ok: false, line: "codex telegram bridge pid invalid" };
    }
  }
  const pid = typeof marker === "number" ? marker : Number.parseInt(String(marker), 10);
  if (!Number.isFinite(pid) || pid <= 0) return { ok: false, line: "codex telegram bridge pid invalid" };
  try {
    process.kill(pid, 0);
    return { ok: true, line: `codex telegram bridge ready (pid ${pid})` };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "EPERM") return { ok: true, line: `codex telegram bridge ready (pid ${pid}, permission limited)` };
    return { ok: false, line: `codex telegram bridge pid not running (${pid})` };
  }
}

export function buildCodexStatus(
  agentId: string,
  activeTurns: number,
  runtimeBlockLine: string | null = null,
  bridge: CodexBridgeLiveness | null = null,
): AgentStatus {
  const blockingLine = /codex runtime failed:\s*exit_0\b/i.test(runtimeBlockLine ?? "") ? null : runtimeBlockLine;
  const bridgeLine = bridge?.line ?? "codex telegram bridge not probed";
  return {
    agent_id: agentId,
    state: activeTurns > 0 ? "running" : blockingLine ? "blocked" : "idle",
    last_activity_at: null,
    last_log_line: activeTurns > 0
      ? `codex: ${activeTurns} turn(s) in flight`
      : blockingLine ?? `codex bus idle; ${bridgeLine}`,
    tmux_pid: null,
    ctx_percent: null,
    probed_at: new Date().toISOString(),
  };
}

export function buildHermesStatus(agentId: string, health: { ok: boolean; line: string }): AgentStatus {
  return {
    agent_id: agentId,
    state: health.ok ? "idle" : "offline",
    last_activity_at: null,
    last_log_line: health.line,
    tmux_pid: null,
    ctx_percent: null,
    probed_at: new Date().toISOString(),
  };
}

// b3os_native: 런타임이 in-process(서버 자체)라 서버가 떠 있으면 항상 도달 가능 = idle, 진행 중 턴이 있으면 running.
// M1: activeTurns는 전역 카운트(어댑터 inFlight)라 팀원별 정밀하지 않음 — 팀원별 추적은 M2. (외부 폴링 없음 = 토큰 0.)
export function buildNativeStatus(agentId: string, activeTurns: number): AgentStatus {
  return {
    agent_id: agentId,
    state: activeTurns > 0 ? "running" : "idle",
    last_activity_at: null,
    last_log_line: activeTurns > 0 ? `b3os_native: ${activeTurns} turn(s) in flight` : "b3os_native runner idle",
    tmux_pid: null,
    ctx_percent: null,
    probed_at: new Date().toISOString(),
  };
}

// ── LivenessAdapter 레지스트리 (P1b: status_provider별 probe를 if/else → Map, P1a 런타임 레지스트리와 같은 패턴) ──
// 각 probe = 외부호출(tmux/openclaw/hermes) + 순수 builder. 새 런타임 라이브니스 추가 = 이 Map에 한 줄.
// 미지원 status_provider → undefined → offlineStatus (기존 else 분기와 동일). 캐시(openclawHealth/hermesHealth)는
// 모듈레벨 변수라 클로저가 최신값 참조(openclaw 배치 사전체크가 갱신한 값 그대로). 동작 동일.
type LivenessProbe = (agent: AgentRecord, db: Database) => Promise<AgentStatus>;
export const LIVENESS_PROBES = new Map<string, LivenessProbe>([
  [
    "claude_tmux",
    async (agent, db) => {
      if (!agent.tmux_session) return offlineStatus(agent.id);
      const exists = await tmuxSessionExists(agent.tmux_session);
      const pid = exists ? await tmuxPid(agent.tmux_session) : null;
      const recent = exists ? recentLogLines(db, agent.id, 20) : [];
      const currentPaneLines = exists ? await captureTmuxPane(agent.tmux_session) : [];
      return buildClaudeStatus(agent.id, exists, pid, recent, currentPaneLines);
    },
  ],
  ["openclaw_gateway", async (agent) => buildOpenclawStatus(agent.id, openclawHealth.ok, getRuntimeBlock(agent.id)?.line ?? null)],
  ["b3os_native_runner", async (agent) => buildNativeStatus(agent.id, inFlightCount())],
  // codex: 버스 어댑터는 in-process(서버 떠있으면 도달=idle, 턴 중이면 running). 외부 폴링 0(토큰 0).
  // 한계(M3): per-member 텔레그램 브리지 프로세스 liveness는 별도(pid 체크는 후속) — 여기선 어댑터 기준.
  [
    "codex_cli",
    async (agent) => {
      const turns = codexInFlightCount();
      return buildCodexStatus(agent.id, turns, getRuntimeBlock(agent.id)?.line ?? null, codexBridgeLiveness(agent.id));
    },
  ],
  [
    "hermes_gateway",
    async (agent) => {
      const now = Date.now();
      let health = hermesHealth.get(agent.id);
      if (!health || now - health.checked_at > 15_000) {
        const checked = await checkHermesGateway(agent);
        health = { ok: checked.ok, checked_at: now, line: checked.line };
        hermesHealth.set(agent.id, health);
      }
      return buildHermesStatus(agent.id, health);
    },
  ],
]);

export function hasStatusChanged(prev: AgentStatus | null | undefined, next: AgentStatus): boolean {
  return (
    !prev ||
    prev.state !== next.state ||
    prev.last_activity_at !== next.last_activity_at ||
    prev.last_log_line !== next.last_log_line ||
    prev.tmux_pid !== next.tmux_pid ||
    prev.ctx_percent !== next.ctx_percent
  );
}

export function startStatusProbe(
  db: Database,
  agents: AgentRecord[],
  broadcast: Broadcaster,
  openclawUrl: string,
): () => void {
  let stopped = false;

  const probe = async () => {
    if (stopped) return;
    if (agents.some((a) => a.status_provider === "openclaw_gateway")) {
      const now = Date.now();
      if (now - openclawHealth.checked_at > 15_000) {
        openclawHealth = { ok: await checkOpenclawHealth(openclawUrl), checked_at: now };
      }
    }

    for (const agent of agents) {
      // status_provider별 probe(외부호출+builder)를 레지스트리에서 골라 실행. 미지원 → offline (기존 else와 동일).
      const probe = LIVENESS_PROBES.get(agent.status_provider);
      const next: AgentStatus = probe ? await probe(agent, db) : offlineStatus(agent.id);

      const prev = getStatus(db, agent.id);
      const changed = hasStatusChanged(prev, next);
      upsertStatus(db, next);
      if (changed) broadcast({ type: "agent_status", agent_id: agent.id, status: next });
    }
  };

  void probe();
  const interval = setInterval(() => void probe(), POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

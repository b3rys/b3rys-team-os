// 대시보드-실행-활성화 (OWNER 2026-06-11): 영입 마지막 단계 = 서버가 런타임을 활성화한다.
//   = 수동(member·member 손으로 AGENTS.md·런타임)이던 걸 자동화. OWNER 클릭 → 서버 실행 → 터미널 0.
//
// 단계(런타임별):
//   1) workspace + persona(SOUL/CLAUDE.md) 작성 (recruit가 했으면 skip)
//   2) AGENTS.md(openclaw/hermes 로딩파일) = buildAgentsMd 로 작성  ← 그동안 빠졌던 OT 지식 주입
//   3) 런타임 활성화 스크립트 spawn (openclaw agents add / hermes profile create) — 봇 토큰 사용
//   4) bus wake allowlist(var/bus-wake-extra.txt)에 추가  ← 재시작 없이 깨워짐
//
// 보안: 런타임 활성화 = self-mod. 서버가 실행 = OWNER가 /approve executor(APPROVAL_EXECUTION_ENABLED=1)로
// 인가한 권한. 이 함수는 그 권한 위에서 동작한다(인증된 대시보드/approve 트리거에서만 호출).

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, renameSync, rmSync, copyFileSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";
import { memberPaths, MEMBERS_ROOT, personaTargetsForRuntime, assertNotLiveMemberFsUnderTest } from "./personaTemplates";
import { writeMemberPersona, savePersonaFile } from "./writeMemberPersona";
import { MANUALS_DIR } from "./paths";
import { appendAuditFile } from "./auditFile";
import { codexBridgePaths, placeCodexToken, writeCodexBridgeFiles, removeCodexBridgeFiles } from "../runtimes/codex/launcher";
import { placeClaudeToken, writeClaudeBridgeFiles, seedClaudeTrust, seedClaudeAccess, killClaudeTmux, claudeBridgePaths, installReplyGuardHook, installOutboundHook, uninstallOutboundHook, uninstallReplyGuardHook, uninstallRecoveryHook, removeClaudeBridgeFiles } from "../runtimes/claude/launcher";
import { isTier2Outbound, isTier2Shadow } from "../runtimes/claude/tier2Flag";
import { setAgentEnabled, clearAgentOff } from "./agentControl";
import { checkRuntimeAuth } from "./runtimeAuth";
import { LIVE_TEAM_OS_PATH } from "./teamOsRender";
import { linkHermesTeamSkill } from "./hermesSkills";
import { resolveTokenStore } from "./rotateToken";
import { checkEssentialSettings } from "./runtimeEssentials";

const HOME = process.env.HOME ?? "";

// runtime 화이트리스트 + status_provider 매핑 — settings.ts(영입/PATCH)와 swapRuntime 양쪽이
// 이 단일 정본을 쓴다(전엔 settings.ts에만 있어 activation.ts가 별도 복제할 위험 — OWNER 2026-07-04 swap 설계).
export const RUNTIMES = new Set(["claude_channel", "openclaw", "hermes_agent", "codex"]);
// runtime → status_provider (agent 테이블 CHECK 제약과 일치해야 함; 안 그러면 reload 시 크래시)
export const STATUS_BY_RUNTIME: Record<string, string> = {
  claude_channel: "claude_tmux",
  openclaw: "openclaw_gateway",
  hermes_agent: "hermes_gateway",
  codex: "codex_cli",
};

/**
 * 경로 삭제(rm) 재시도 헬퍼 — hermes 프로필 dir 등 게이트웨이 bootout 직후 잠깐 파일잠금(EBUSY류)이 걸릴 수
 * 있는 경로에 사용. (Phase1 리팩터: 원래 routes/settings.ts에 있었으나 teardownRuntime이 여기서 쓰므로 이관.
 * settings.ts는 기존 import 경로(`./settings`)가 깨지지 않게 재export한다.)
 */
export async function removePathWithRetries(
  path: string,
  options: Parameters<typeof rmSync>[1],
  deps: {
    attempts?: number;
    delayMs?: number;
    exists?: typeof existsSync;
    rm?: typeof rmSync;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const attempts = Math.max(1, deps.attempts ?? 3);
  const delayMs = Math.max(0, deps.delayMs ?? 500);
  const exists = deps.exists ?? existsSync;
  const rm = deps.rm ?? rmSync;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let i = 0; i < attempts; i++) {
    if (!exists(path)) return true;
    try {
      rm(path, options);
      if (!exists(path)) return true;
    } catch {
      // best-effort cleanup: gateway bootout can release files shortly after the first rm attempt.
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return !exists(path);
}

/**
 * 구 런타임 teardown — offboard(DELETE /members/:id)의 4-branch cleanup 블록을 추출(Phase1).
 * swap-runtime(신규)과 offboard가 이 함수 하나를 공유한다. writeAgents(레지스트리 커밋)·archiveWorkspace·
 * removeBusWake·OT delete·slack revoke는 여기 포함 안 됨(호출측 책임 — 문서 backend_plan 참조).
 *
 * best-effort: 각 단계 실패는 삼켜지고(고아 방지 목적이지 치명적이지 않음) teardown 자체는 항상 ok:true를
 * 반환한다(원래 offboard 동작과 동일 — 실패해도 퇴사/스왑 자체를 막지 않았음).
 *
 * opts.skip=true면 아무 것도 안 건드리고 즉시 반환 — 테스트 격리(offboard의 skipRuntimeCleanup과 동일 규약).
 * opts의 나머지 필드는 테스트가 setAgentEnabled/removeCodexBridgeFiles 등을 스파이/모킹할 수 있게 하는
 * 선택적 DI 시드(실 운영은 전부 기본값 그대로 — 동작 불변).
 */
export interface TeardownResult { ok: boolean; detail: string; skipped?: boolean }
export interface TeardownDeps {
  skip?: boolean;
  setAgentEnabled?: typeof setAgentEnabled;
  removeCodexBridgeFiles?: typeof removeCodexBridgeFiles;
  removeClaudeBridgeFiles?: typeof removeClaudeBridgeFiles;
  removePathWithRetries?: typeof removePathWithRetries;
  existsSync?: typeof existsSync;
  rmSync?: typeof rmSync;
  sleepMs?: number; // hermes teardown 전 대기(기본 1500ms, 프로필 dir 파일잠금 레이스 방지) — 테스트에서 0으로 단축
}

export async function teardownRuntime(
  id: string,
  runtime: string,
  agent: { hermes_profile?: string | null } | undefined,
  opts: TeardownDeps = {},
): Promise<TeardownResult> {
  if (opts.skip) return { ok: true, detail: "teardown 건너뜀(skip — 테스트 격리 또는 skipRuntimeCleanup)", skipped: true };
  const doSetAgentEnabled = opts.setAgentEnabled ?? setAgentEnabled;
  const doRemoveCodexBridgeFiles = opts.removeCodexBridgeFiles ?? removeCodexBridgeFiles;
  const doRemoveClaudeBridgeFiles = opts.removeClaudeBridgeFiles ?? removeClaudeBridgeFiles;
  const doRemovePathWithRetries = opts.removePathWithRetries ?? removePathWithRetries;
  const doExistsSync = opts.existsSync ?? existsSync;
  const doRmSync = opts.rmSync ?? rmSync;
  const HH = process.env.HOME ?? "";

  // codex teardown: 브리지 정지(bootout) + plist/wrapper/토큰/CODEX_HOME 정리 — 고아 프로세스·잔존 시크릿 방지(best-effort).
  if (runtime === "codex") {
    try { await doSetAgentEnabled(id, "codex", false); } catch { /* best-effort */ }
    try { doRemoveCodexBridgeFiles(id, { removeToken: true, removeHome: true }); } catch { /* best-effort */ }
    return { ok: true, detail: "codex teardown 완료(best-effort)" };
  }
  // claude_channel teardown: 봇 LaunchAgent 정지(bootout) + plist/.env(토큰) 정리 — 고아 tmux·잔존 시크릿 방지(best-effort).
  if (runtime === "claude_channel") {
    try { await doSetAgentEnabled(id, "claude_channel", false); } catch { /* best-effort */ }
    try { doRemoveClaudeBridgeFiles(id, { removeToken: true }); } catch { /* best-effort */ }
    return { ok: true, detail: "claude_channel teardown 완료(best-effort)" };
  }
  // hermes_agent teardown: 게이트웨이 stop + 프로필별 LaunchAgent plist + credential 토큰 + 프로필 dir 정리.
  //   ★CRITICAL 가드: base 프로필(b3ryshermes)은 모든 hermes 멤버의 auth.json 심링크 소스+clone 원본이라
  //   절대 정지/삭제하지 않는다(공유 인프라 보존, 멤버 레지스트리/per-id 토큰만 정리) — offboard 원본 로직 그대로.
  if (runtime === "hermes_agent") {
    const prof = agent?.hermes_profile ?? id;
    const isBaseHermesProfile = prof === "b3ryshermes";
    try { if (!isBaseHermesProfile) await doSetAgentEnabled(id, "hermes_agent", false); } catch { /* best-effort */ }
    await new Promise((r) => setTimeout(r, opts.sleepMs ?? 1500)); // 게이트웨이 bootout 후 프로필 dir 해제 대기(레이스 방지)
    if (/^[a-z0-9_-]+$/i.test(prof) && !isBaseHermesProfile) {
      try { const hp = `${HH}/Library/LaunchAgents/ai.hermes.gateway-${prof}.plist`; if (doExistsSync(hp)) doRmSync(hp); } catch { /* best-effort */ }
    }
    if (/^[a-z0-9_-]+$/i.test(id)) {
      try { const ct = `${HH}/.hermes/credentials/${id}-token.txt`; if (doExistsSync(ct)) doRmSync(ct); } catch { /* best-effort */ }
    }
    if (/^[a-z0-9_-]+$/i.test(prof) && !isBaseHermesProfile) {
      try { const pd = `${HH}/.hermes/profiles/${prof}`; await doRemovePathWithRetries(pd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    return { ok: true, detail: isBaseHermesProfile ? "hermes teardown 건너뜀(base profile 보존)" : "hermes teardown 완료(best-effort)" };
  }
  // openclaw teardown: 계정 disable(게이트웨이 restart) + 토큰/allowFrom/agent dir 정리.
  if (runtime === "openclaw") {
    try { await doSetAgentEnabled(id, "openclaw", false); } catch { /* best-effort */ }
    try { const ot = `${HH}/.openclaw/credentials/telegram-${id}-token.txt`; if (doExistsSync(ot)) doRmSync(ot); } catch { /* best-effort */ }
    if (/^[a-z0-9_-]+$/i.test(id)) {
      try { const af = `${HH}/.openclaw/credentials/telegram-${id}-allowFrom.json`; if (doExistsSync(af)) doRmSync(af); } catch { /* best-effort */ }
    }
    if (/^[a-z0-9_-]+$/i.test(id)) {
      try { const ad = `${HH}/.openclaw/agents/${id}`; if (doExistsSync(ad)) doRmSync(ad, { recursive: true }); } catch { /* best-effort */ }
    }
    return { ok: true, detail: "openclaw teardown 완료(best-effort)" };
  }
  return { ok: true, detail: `${runtime}: teardown 대상 아님(알려진 4 런타임 밖)` };
}

export interface ActivateInput {
  id: string;
  display_name: string;
  role: string;
  runtime: string;
  bot_username?: string;
  persona?: string; // 능력/강점(영입 입력)
  bot_token: string; // provisioning 에서 받은 BotFather 토큰
}

export interface ActivateResult {
  ok: boolean;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
  error?: string;
}

const COORDINATOR_CAPABILITY = "coordinator";

async function pushEssentialStep(
  steps: ActivateResult["steps"],
  agent: { id: string; runtime: string; openclaw_agent_id?: string | null; hermes_profile?: string | null },
): Promise<boolean> {
  const essentials = await checkEssentialSettings(agent as any);
  steps.push({
    step: "essentials",
    ok: essentials.ok,
    detail: essentials.ok
      ? "필수설정 확인(토큰·allowFrom·채널·poller)"
      : `필수설정 누락: ${essentials.missing.join(", ")}${essentials.canAutoFix ? " (자동복구 가능)" : ""}`,
  });
  return essentials.ok;
}

/**
 * ★팀 리드가 갖는 능력 묶음★ — '팀 리드'라는 역할이 곧 이 둘이다.
 *   - coordinator  : 기본 owner(라우팅 fallback). 팀에 0명이면 미배정 메시지가 유실된다.
 *   - full_context : 팀방 대화 맥락 수신. 팀 리드는 팀원들의 메시지 맥락을 본다.
 *
 * 따로 관리하면 한쪽만 붙는 갭이 생긴다(실제로 그랬다 — 첫 영입 멤버는 coordinator 만 받아서
 * 팀 리드인데도 팀 맥락을 못 봤다. full_context 는 부여하는 코드가 아예 없어 손으로 agents.json 을
 * 고치지 않는 한 아무도 못 받았다. OWNER 2026-07-12). 그래서 한 묶음·단일 출처로 둔다.
 */
export const LEAD_CAPABILITIES = [COORDINATOR_CAPABILITY, "full_context"] as const;

/** 기존 능력에 팀 리드 능력을 더한다(중복 없이). 첫 영입·승계가 같은 규칙을 쓰게 하는 단일 출처. */
export function withLeadCapabilities(existing: unknown): string[] {
  const capabilities = new Set(Array.isArray(existing) ? existing.map(String) : []);
  for (const c of LEAD_CAPABILITIES) capabilities.add(c);
  return [...capabilities];
}

/**
 * 초기 레지스트리 안전망: 첫 영입 멤버를 팀 리드로 둔다.
 * (public/default owner 가 비지 않게 + 팀 리드로서 팀원 메시지 맥락을 보게)
 */
export function withInitialLeadCapabilities<T extends Record<string, unknown>>(
  existingAgents: unknown[],
  entry: T,
): T & { capabilities?: string[] } {
  if (existingAgents.length > 0) return entry;
  return { ...entry, capabilities: withLeadCapabilities(entry.capabilities) };
}

/** 런타임 활성화 스크립트 경로 + 토큰 파일 경로(스크립트가 기대하는 위치). */
function runtimeScript(id: string, runtime: string): { script: string; tokenFile: string; env: Record<string, string> } | null {
  // ★WS=MEMBERS_ROOT/id 명시 주입 — 스크립트 default(WS=~/Development/id)는 퍼블릭 모드(MEMBERS_ROOT=$B3RYS_HOME/members)서 persona/AGENTS.md 위치와 어긋남(claude WORKDIR과 같은 계열, 하네스 HIGH). 스크립트가 WS env 이미 존중. OWNER 2026-07-02.
  const ws = `${MEMBERS_ROOT}/${id}`;
  if (runtime === "openclaw") {
    return {
      script: `${MANUALS_DIR}/openclaw/activate-openclaw-agent.sh`,
      tokenFile: `${HOME}/.openclaw/credentials/telegram-${id}-token.txt`,
      env: { AGENT_ID: id, DISPLAY: id.toUpperCase(), WS: ws },
    };
  }
  if (runtime === "hermes_agent") {
    return {
      script: `${MANUALS_DIR}/hermes/activate-hermes-agent.sh`,
      tokenFile: `${HOME}/.hermes/credentials/${id}-token.txt`,
      env: { AGENT_ID: id, WS: ws },
    };
  }
  return null; // claude_channel 은 별도 런타임 활성화 없음(CLAUDE.md + tmux/LaunchAgent)
}

/** 토큰을 스크립트가 기대하는 파일에 0600 저장(stdout 노출 없음). */
function placeToken(tokenFile: string, token: string): void {
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, token.trim() + "\n", "utf-8");
  chmodSync(tokenFile, 0o600);
}

/** claude 텔레그램 채널 poller 기동 대기 — 플러그인 MCP(server.ts)가 토큰 확인 통과 후에만 bot.pid를 쓴다(server.ts:69).
 *  bot.pid 출현 = poller 실제 폴링 시작 = '진짜 대화됨'. 미출현 = 죽은 봇(귀머거리). timeoutMs 안에 file 확인. 슬러그 가드.
 *  opts = 테스트 격리용(실 HOME/~/.claude·라이브 봇 미접촉): homeDir로 base 경로를 tmp로 돌리고 intervalMs로 짧은 폴 간격.
 *  production은 opts 없이 호출 → HOME + 1500ms 그대로(동작 불변). */
export async function waitForClaudePoller(
  id: string,
  timeoutMs: number,
  opts?: { homeDir?: string; intervalMs?: number; pidAlive?: (pid: number) => boolean },
): Promise<boolean> {
  if (!/^[a-z0-9_-]+$/i.test(id)) return false;
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

/** codex per-member bridge 헬스게이트 — 첫 getUpdates 성공 후 bridge.ts가 쓰는 pid marker를 기다린다. */
export async function waitForCodexPoller(
  id: string,
  timeoutMs: number,
  opts?: { pidFile?: string; intervalMs?: number; pidAlive?: (pid: number) => boolean },
): Promise<boolean> {
  if (!/^[a-z0-9_-]+$/i.test(id)) return false;
  const intervalMs = opts?.intervalMs ?? 1500;
  const pidFile = opts?.pidFile ?? codexBridgePaths(id).pidFile;
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

type HermesStatusRunner = (profile: string) => Promise<{ code: number; out: string }>;

async function defaultHermesStatusRunner(profile: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["hermes", "gateway", "status"], {
    env: { ...process.env, HERMES_PROFILE: profile, PATH: `${HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: (out + (err ? "\n" + err : "")).trim() };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hermesStatusLineHealthy(line: string): boolean {
  return /\bPID\s+\d+\b/i.test(line) && (/[✓✔]/.test(line) || /\bloaded\b/i.test(line) || /\bhealthy\b/i.test(line));
}

function hermesCurrentStatusMatchesProfile(profile: string, lines: string[]): boolean {
  const p = escapeRegExp(profile);
  const patterns = [
    new RegExp(`ai\\.hermes\\.gateway-${p}\\.plist`, "i"),
    new RegExp(`--profile\\s+${p}\\b`, "i"),
    new RegExp(`\\bprofile\\b\\s*[:=]\\s*${p}\\b`, "i"),
    new RegExp(`\\.hermes/profiles/${p}(/|\\b)`, "i"),
  ];
  return lines.some((line) => patterns.some((re) => re.test(line)));
}

function hermesStatusRunning(profile: string, status: { code: number; out: string }): boolean {
  if (status.code !== 0) return false;
  const lines = status.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const otherProfilesAt = lines.findIndex((line) => /^Other profiles:/i.test(line));
  const currentProfileLines = otherProfilesAt >= 0 ? lines.slice(0, otherProfilesAt) : lines;
  const profileLine = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(profile)}([^A-Za-z0-9_-]|$)`, "i");
  if (currentProfileLines.some(hermesStatusLineHealthy) && hermesCurrentStatusMatchesProfile(profile, currentProfileLines)) return true;
  return lines.some((line) => profileLine.test(line) && hermesStatusLineHealthy(line));
}

/** hermes 프로필 게이트웨이가 실제 running 상태가 될 때까지 기다린다. */
export async function waitForHermesGateway(
  id: string,
  timeoutMs: number,
  opts?: { profile?: string; intervalMs?: number; statusRunner?: HermesStatusRunner },
): Promise<boolean> {
  if (!/^[a-z0-9_-]+$/i.test(id)) return false;
  const profile = opts?.profile ?? id;
  if (!/^[a-z0-9_-]+$/i.test(profile)) return false;
  const intervalMs = opts?.intervalMs ?? 1500;
  const statusRunner = opts?.statusRunner ?? defaultHermesStatusRunner;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (hermesStatusRunning(profile, await statusRunner(profile))) return true; } catch { /* best-effort */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  try { return hermesStatusRunning(profile, await statusRunner(profile)); } catch { return false; }
}

/** bus wake allowlist 파일에 에이전트 추가(재시작 없이 반영). */
function addBusWake(id: string): boolean {
  const f = process.env.TEAMOS_BUS_WAKE_EXTRA_FILE ?? `${process.cwd()}/var/bus-wake-extra.txt`; // 테스트 격리(실 운영파일 미변경)
  try {
    let cur = "";
    try { cur = readFileSync(f, "utf-8"); } catch { /* 없으면 새로 */ }
    const ids = new Set(cur.split(/[\s,]+/).map((s: string) => s.trim()).filter(Boolean));
    if (ids.has(id)) return true;
    ids.add(id);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, [...ids].join("\n") + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** 퇴사 시 bus-wake allowlist에서 제거(addBusWake 역) — 안 지우면 offboard된 id가 wake 대상에 잔존(ghost wake). OWNER 2026-07-01 하네스 #2. */
export function removeBusWake(id: string): void {
  const f = process.env.TEAMOS_BUS_WAKE_EXTRA_FILE ?? `${process.cwd()}/var/bus-wake-extra.txt`; // 테스트 격리(실 운영파일 미변경)
  try {
    const cur = readFileSync(f, "utf-8");
    const ids = new Set(cur.split(/[\s,]+/).map((s: string) => s.trim()).filter(Boolean));
    if (!ids.has(id)) return;
    ids.delete(id);
    writeFileSync(f, [...ids].join("\n") + (ids.size ? "\n" : ""), "utf-8");
  } catch { /* best-effort */ }
}

/**
 * 퇴사 시 workspace 보관(archive) — 삭제가 아니라 mv. 재영입 시 잔재 충돌 방지 + 데이터 보존.
 * MEMBERS_ROOT/.archived/<id>-<timestamp> 로 이동. workspace 없으면 null(이미 없음).
 */
export function archiveWorkspace(id: string, runtime: string): string | null {
  const { workspace_path } = memberPaths(id, runtime);
  if (!existsSync(workspace_path)) return null;
  assertNotLiveMemberFsUnderTest(workspace_path, `archiveWorkspace(${id})`); // FIX2(OWNER 2026-07-08): 테스트가 라이브 워크스페이스 mv 못 하게 차단
  const archiveRoot = `${MEMBERS_ROOT}/.archived`;
  mkdirSync(archiveRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let dest = `${archiveRoot}/${id}-${stamp}`;
  let n = 1;
  while (existsSync(dest)) dest = `${archiveRoot}/${id}-${stamp}-${n++}`; // 같은 초 중복 방지
  renameSync(workspace_path, dest);
  return dest;
}

/**
 * Tier2 훅만 재적용(전체 activateMember 없이 · tmux/세션 유지 · 다음 턴 반영). Phase0 shadow 설치·Phase1 승격용.
 * flag에 따라 activateMember(505~511)와 동일한 훅 정책:
 *   shadow(isTier2Shadow만) → installOutboundHook(dryRun)만. persona 무변경 = 진짜 무영향(shadow).
 *   live(isTier2Outbound)   → installOutboundHook(live) + reply-guard/recovery 제거(단일 전송경로=이중전송 차단).
 * 멱등: installOutboundHook의 includes 가드로 재호출 no-op. persona는 안 건드림(reapply는 훅 배선만).
 * 서버 내부에서만 실행(엔드포인트 경유) → 팀원 settings.json 직접 편집 아님(classifier 무관).
 */
export function reapplyTier2Hook(id: string): "shadow" | "live" | "none" {
  if (isTier2Outbound(id)) {
    // ★MED 승격(shadow→live): 기존 훅(shadow의 dryRun 포함) 먼저 제거 후 재설치.★ installOutboundHook 멱등
    // 가드가 파일명만 봐서 dryRun 프리픽스를 안 벗기므로, uninstall→reinstall 해야 dryRun→live로 실제 전환.
    uninstallOutboundHook(id);
    installOutboundHook(id, { dryRun: false }); // ★HIGH: 명시적 live 전송({dryRun:false} 필수 — 기본 dryRun이라 누락 시 침묵)★
    uninstallReplyGuardHook(id);
    uninstallRecoveryHook(id);
    return "live";
  }
  if (isTier2Shadow(id)) {
    installOutboundHook(id, { dryRun: true });
    return "shadow";
  }
  return "none";
}

/**
 * 멤버 활성화. 단계별 결과를 모아 반환(에러여도 진행상황 보임 — 스무스·에러처리).
 * ⚠ 런타임 스크립트 spawn = self-mod. APPROVAL_EXECUTION_ENABLED=1(OWNER 인가) 일 때만 런타임 단계 실행.
 */
export async function activateMember(db: Database, input: ActivateInput): Promise<ActivateResult> {
  const { id, display_name, role, runtime, bot_username, persona, bot_token } = input;
  const steps: ActivateResult["steps"] = [];
  // ★재영입 belt-and-suspenders: off-list에서 제거 — openclaw/hermes는 setAgentEnabled(true) 경로를 안 타서, 이거 없으면 재영입해도 stale off로 버스 suppress(하네스 #1). OWNER 2026-07-01.
  try { clearAgentOff(id); } catch { /* best-effort */ }
  const paths = memberPaths(id, runtime);
  // 라이브 생성 경로 → 핵심룰의 {{OWNER}}/{{TEAM}} 을 setting owner_name(="OWNER")/team_name(="b3rys")으로 치환. 미설정이면 undefined → 플레이스홀더 유지.
  const ownerRow = db.query("SELECT value FROM setting WHERE key = 'owner_name'").get() as { value: string } | null;
  const owner_name = ownerRow?.value || undefined;
  const teamRow = db.query("SELECT value FROM setting WHERE key = 'team_name'").get() as { value: string } | null;
  const team_name = teamRow?.value || undefined;

  // 1) workspace + persona
  try {
    mkdirSync(paths.workspace_path, { recursive: true });
    // ★룰(로딩파일) 렌더와 persona 저장은 분리된 트랜잭션이다★ (OWNER 2026-07-17).
    //   writeMemberPersona = 룰 렌더러(CLAUDE.md/AGENTS.md). SOUL.md 는 건드리지 않는다.
    //   persona 값은 savePersonaFile 로 SOUL.md 에만 저장한다 — 저장 지점은 거기 하나뿐이다.
    const wr = writeMemberPersona({ id, display_name, role, runtime, bot_username, owner_name, team_name, workspace_path: paths.workspace_path, persona_file: paths.persona_file, team_collect_enabled: false /* 수집 오케스트레이션 제거 (2026-07-13) — collector 가 직접 모아 직접 보고한다 */ });
    const written = [...wr.written];
    if (persona && persona.trim()) { savePersonaFile(paths.persona_file, persona); written.push(paths.persona_file); }
    // ★persona 가 없으면 SOUL 을 만들지 않는다★ — 빈 껍데기(`# Role\n\ndev\n\n# Persona`)를 찍으면
    //   그게 굳어 페르소나가 없는 채로 남는다(2026-07-17 lui·forin 실측). 없으면 나중에 채우면 된다.
    steps.push({ step: "workspace+persona", ok: true, detail: written.join(", ") });
  } catch (e) {
    steps.push({ step: "workspace+persona", ok: false, detail: (e as Error).message });
    return { ok: false, steps, error: "workspace/persona 작성 실패" };
  }

  // 2) [삭제됨 — 하네스 CRITICAL fix 2026-07-05] 옛날엔 여기서 AGENTS.md를 buildAgentsMd로 재작성했으나,
  //   step1의 writeMemberPersona가 이미 비-claude 로딩파일(=AGENTS.md)을 ★custom-aware(custom 있으면 verbatim, 없으면 buildAgentsMd)★로
  //   backup-first 하며 쓴다. 여기서 다시 쓰면 custom purpose가 default로 클로버돼 유실(=Lui 스왑 버그 재현) → 제거.
  //   단일통로: persona/AGENTS.md 쓰기는 writeMemberPersona 한 곳만.

  // 2.5) 런타임 인증 preflight(안전망) — claude/codex oauth 로그인 안 돼 있으면 spawn 전에 중단.
  //   claude는 미로그인 시 tmux headless 프롬프트에 갇히고, codex는 exit 1로 실패하므로 사전 차단.
  //   credential 값은 보지 않고 존재·status만 본다. claude_channel(spawn 없음)도 결과를 steps에 기록.
  const auth = await checkRuntimeAuth(runtime);
  if (!auth.loggedIn) {
    steps.push({ step: "preflight", ok: false, detail: auth.fixHint || auth.detail });
    appendAuditFile("activation", "preflight_blocked", id, { runtime });
    return { ok: false, steps, error: auth.fixHint || `${runtime} 런타임 인증 미완료` };
  }
  steps.push({ step: "preflight", ok: true, detail: auth.detail });

  // 3) 런타임 활성화(self-mod — 인가된 executor에서만)
  // codex: 텔레그램 브리지 = 토큰 배치 → wrapper/plist 생성 → LaunchAgent bootstrap.
  if (runtime === "codex") {
    if (process.env.APPROVAL_EXECUTION_ENABLED !== "1") {
      steps.push({ step: "runtime", ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — codex 브리지 기동 건너뜀" });
      return { ok: false, steps, error: "런타임 활성화 권한 OFF(팀장 인가 필요)" };
    }
    try {
      placeCodexToken(id, bot_token);
      const bridgePaths = writeCodexBridgeFiles(id);
      try { rmSync(bridgePaths.pidFile, { force: true }); } catch { /* stale marker cleanup best-effort */ }
      appendAuditFile("activation", "runtime_start", id, { runtime });
      const res = await setAgentEnabled(id, "codex", true); // 브리지 LaunchAgent bootstrap + off명단 해제
      appendAuditFile("activation", res.ok ? "runtime_done" : "runtime_failed", id, { runtime });
      steps.push({ step: "runtime", ok: res.ok, detail: res.detail });
      if (!res.ok) return { ok: false, steps, error: "codex 브리지 기동 실패" };
      const rawWait = process.env.TEAMOS_POLLER_WAIT_MS;
      const pollerWaitMs = rawWait !== undefined && Number.isFinite(Number(rawWait)) ? Number(rawWait) : 28000;
      const pollerOk = await waitForCodexPoller(id, pollerWaitMs);
      steps.push({ step: "poller", ok: pollerOk, detail: pollerOk ? "codex 브리지 poller 기동 확인(getUpdates ready marker)" : "codex 브리지 poller 미기동(ready marker 없음 — 봇이 메시지를 못 받음, 재활성화 필요)" });
      if (!pollerOk) return { ok: false, steps, error: "codex 브리지 poller 미기동 — 봇이 메시지를 받지 못합니다(재활성화하세요)" };
      if (!await pushEssentialStep(steps, { id, runtime })) return { ok: false, steps, error: "codex 필수설정 누락 — 재활성화/설정 복구 필요" };
    } catch (e) {
      steps.push({ step: "runtime", ok: false, detail: (e as Error).message });
      return { ok: false, steps, error: "codex 브리지 셋업 오류" };
    }
    const wakeOk0 = addBusWake(id);
    steps.push({ step: "bus-wake", ok: wakeOk0, detail: wakeOk0 ? "allowlist 추가" : "추가 실패" });
    return { ok: steps.every((s) => s.ok), steps };
  }
  // claude_channel: 토큰을 채널 .env 배치 + LaunchAgent plist 생성 → setClaude bootstrap(tmux 봇 기동).
  //   (OWNER 2026-07-01 — 영입이 codex만 배선돼 claude 봇이 안 뜨던 갭 보완: setClaude가 plist를 요구하는데 생성기가 없었음.)
  if (runtime === "claude_channel") {
    if (process.env.APPROVAL_EXECUTION_ENABLED !== "1") {
      steps.push({ step: "runtime", ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — claude 봇 기동 건너뜀" });
      return { ok: false, steps, error: "런타임 활성화 권한 OFF(팀장 인가 필요)" };
    }
    try {
      placeClaudeToken(id, bot_token);   // ~/.claude/channels/telegram-<id>/.env (봇이 여기서 토큰 읽음)
      writeClaudeBridgeFiles(id);        // LaunchAgent plist 생성(setClaude bootstrap 대상)
      // reply-guard(reply 도구 미사용 감지 block)는 tier2 live(마커모드=reply 도구 안 씀)엔 미설치 — 안 그러면 매턴 block(Bill 하네스).
      //   shadow는 persona normal(reply 도구 유지)이라 reply-guard 유효 → 설치. live만 skip.
      if (!isTier2Outbound(id)) installReplyGuardHook(id);   // 워크스페이스 .claude/settings.json 에 reply-guard Stop 훅(send-drift 안전망)
      // ★recovery 훅은 삭제됨(OWNER 2026-07-14) — 훅이 팀원 '대신' 보내는 [A] 패턴이라 제거.★
      //   이미 설치된 멤버에서도 걷어낸다(재활성화 때 self-heal). 안 보냈으면 안 보낸 것이고,
      //   그 사실을 팀원에게 되돌려 주는 것(reply-guard)까지가 시스템의 몫이다.
      uninstallRecoveryHook(id);
      // ★Tier2(2026-07-06, Bill 하네스 HIGH#2 수정): flag 켜진 멤버는 tg-outbound 훅도 실제 설치★
      //   (전엔 미호출 → 마커모드인데 훅 없어 답 유실). live=실전송 / shadow=dryRun(persona normal·로그만).
      // ★live는 반드시 {dryRun:false} 명시 (Bill 하네스 Phase1 HIGH): DRYRUN 기본true라 생략하면
      //   live인데 dryRun→reply-guard/recovery만 걷히고 실전송0=멤버 침묵=답 유실. '말 유실 방지'가 유실 낼 뻔.
      if (isTier2Outbound(id)) installOutboundHook(id, { dryRun: false }); // Phase1 live 실전송
      else if (isTier2Shadow(id)) installOutboundHook(id, { dryRun: true }); // Phase0 shadow: 훅 로그만(무영향)
      seedClaudeTrust(id);               // ~/.claude.json projects 시드 → 신규 workspace trust 프롬프트 hang 방지(하네스 #2)
      seedClaudeAccess(id);              // access.json 시드(오너 DM 페어링) — 도출 불가 시 skip(버스/그룹 도달, DM 수동)(하네스 #1)
      // ★재활성화 stale false-pass 차단(하네스 HIGH, OWNER 2026-07-02): 죽은 봇의 옛 tmux 세션·bot.pid가 남으면 poller-gate가 첫 iteration에서 즉시 거짓통과(귀머거리 봇이 합류로).
      //   재활성화 전에 세션 kill + stale bot.pid 제거 → idempotent 가드 우회하고 항상 fresh 기동 → 새로 쓰인 bot.pid만 게이트 통과(codex activation.ts:263 stale삭제와 동형).
      killClaudeTmux(id);
      try { rmSync(claudeBridgePaths(id).botPid, { force: true }); } catch { /* best-effort stale marker cleanup */ }
      appendAuditFile("activation", "runtime_start", id, { runtime });
      const res = await setAgentEnabled(id, "claude_channel", true); // plist bootstrap → RunAtLoad로 start-telegram-channel.sh <id> 기동(tmux claude-<id>)
      appendAuditFile("activation", res.ok ? "runtime_done" : "runtime_failed", id, { runtime });
      steps.push({ step: "runtime", ok: res.ok, detail: res.ok ? "claude 봇 tmux 기동(LaunchAgent)" : res.detail });
      if (!res.ok) return { ok: false, steps, error: "claude 봇 기동 실패" };
      // ★poller 헬스게이트(OWNER 2026-07-02, 하네스 근본): 봇이 tmux로 떠도 텔레그램 플러그인 MCP(poller)가 실제 기동해 bot.pid를 써야 '진짜 대화됨'.
      //   bot.pid 미출현 = 죽은 봇이 '합류 완료'로 거짓표시되던 근본(lod: 첫 기동 STATE_DIR 갭으로 MCP exit). 여기서 확인 안 하면 귀머거리 봇이 합류로 보임.
      // 기본 28s. TEAMOS_POLLER_WAIT_MS 로 오버라이드(테스트 격리 belt-and-suspenders — 실 activateMember가 우발적으로 실행돼도 28s hang 방지). 미설정·비숫자 → 28000.
      const rawWait = process.env.TEAMOS_POLLER_WAIT_MS;
      const pollerWaitMs = rawWait !== undefined && Number.isFinite(Number(rawWait)) ? Number(rawWait) : 28000;
      const pollerOk = await waitForClaudePoller(id, pollerWaitMs);
      steps.push({ step: "poller", ok: pollerOk, detail: pollerOk ? "텔레그램 채널 poller 기동 확인(bot.pid)" : "poller 미기동(bot.pid 없음 — 봇이 메시지를 못 받음, 재활성화 필요)" });
      if (!pollerOk) return { ok: false, steps, error: "텔레그램 채널 poller 미기동 — 봇이 메시지를 받지 못합니다(재활성화하세요)" };
      if (!await pushEssentialStep(steps, { id, runtime })) return { ok: false, steps, error: "claude 필수설정 누락 — 재활성화/설정 복구 필요" };
      // recall 주입(OWNER 2026-07-05): 활성화=새 claude 세션(맥락 빔)이니 --fresh 재시작과 동일하게 직전 대화 digest 주입.
      //   런타임 스왑/영입이 곧 '첫 로딩'이라 여기가 OWNER가 원한 '첫 로딩 시 주입' 지점. fire-forget best-effort(세션 준비는 스크립트 sleep이 대기, 실패해도 활성화 정상).
      try { Bun.spawn(["bash", `${process.cwd()}/scripts/inject-recall.sh`, id], { stdout: "ignore", stderr: "ignore" }); } catch { /* best-effort */ }
      steps.push({ step: "recall", ok: true, detail: "recall 복구블록 주입 스케줄(활성화 첫 로딩)" });
    } catch (e) {
      steps.push({ step: "runtime", ok: false, detail: (e as Error).message });
      return { ok: false, steps, error: "claude 봇 셋업 오류" };
    }
    const wakeOkCl = addBusWake(id);
    steps.push({ step: "bus-wake", ok: wakeOkCl, detail: wakeOkCl ? "allowlist 추가" : "추가 실패" });
    return { ok: steps.every((s) => s.ok), steps };
  }
  const rs = runtimeScript(id, runtime);
  if (rs) {
    if (process.env.APPROVAL_EXECUTION_ENABLED !== "1") {
      steps.push({ step: "runtime", ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 런타임 활성화 건너뜀" });
      return { ok: false, steps, error: "런타임 활성화 권한 OFF(팀장 인가 필요)" };
    }
    try {
      placeToken(rs.tokenFile, bot_token);
      appendAuditFile("activation", "runtime_start", id, { runtime });
      const proc = Bun.spawn(["bash", rs.script], { env: { ...process.env, ...rs.env }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      const tail = (out + (err ? "\n[stderr]\n" + err : "")).trim().slice(-800);
      appendAuditFile("activation", code === 0 ? "runtime_done" : "runtime_failed", id, { runtime, code });
      steps.push({ step: "runtime", ok: code === 0, detail: code === 0 ? "런타임 활성화 완료" : `실패(exit ${code}): ${tail.slice(-300)}` });
      if (code !== 0) return { ok: false, steps, error: `런타임 활성화 실패(${runtime})` };
      if (runtime === "hermes_agent") {
        const rawWait = process.env.TEAMOS_POLLER_WAIT_MS;
        const gatewayWaitMs = rawWait !== undefined && Number.isFinite(Number(rawWait)) ? Number(rawWait) : 28000;
        const gatewayOk = await waitForHermesGateway(id, gatewayWaitMs);
        steps.push({ step: "gateway", ok: gatewayOk, detail: gatewayOk ? "hermes gateway running 확인" : "hermes gateway 기동 실패(status에서 대상 profile PID 확인 안 됨 — generic/per-profile supervisor 충돌 가능, 재활성화 필요)" });
        if (!gatewayOk) return { ok: false, steps, error: "hermes gateway 기동 실패 — 대상 profile PID를 확인하지 못했습니다(재활성화하세요)" };
        // ★팀 스킬 = 정본 심링크★ (OWNER 2026-07-14). 활성화 스크립트는 기존 프로필을 ★통째로 복제★ 하므로
        //   스킬도 사본으로 따라간다 → 정본을 고쳐도 사본은 안 따라온다(실측: --from 차단이 정본에만 들어가
        //   3개 프로필이 뚫려 있었고, 사본엔 bus-recall.sh 가 아예 없어 룰이 시키는 명령을 실행할 수 없었다).
        //   심링크면 정본 한 번 고칠 때 전원이 즉시 따라온다. 사본은 만들지 않는다.
        const skill = linkHermesTeamSkill(id);
        steps.push({ step: "skills", ok: skill.linked, detail: skill.detail });
        if (!skill.linked) return { ok: false, steps, error: `팀 버스 스킬 링크 실패 — ${skill.detail} (스킬 없이는 팀원이 메시지를 보낼 수 없습니다)` };
      }
      if (!await pushEssentialStep(steps, { id, runtime })) return { ok: false, steps, error: `${runtime} 필수설정 누락 — 재활성화/설정 복구 필요` };
    } catch (e) {
      steps.push({ step: "runtime", ok: false, detail: (e as Error).message });
      return { ok: false, steps, error: "런타임 스크립트 실행 오류" };
    }
  } else {
    steps.push({ step: "runtime", ok: true, detail: `${runtime}: 별도 런타임 활성화 없음` });
  }

  // 4) bus wake
  const wakeOk = addBusWake(id);
  steps.push({ step: "bus-wake", ok: wakeOk, detail: wakeOk ? "allowlist 추가(재시작 불필요)" : "추가 실패" });

  return { ok: steps.every((s) => s.ok), steps };
}

// ── 런타임 스왑(claude_channel ↔ codex ↔ openclaw ↔ hermes_agent) ─────────────
// agents.json 은 settings.ts(createSettingsApp)의 readAgents/writeAgents 클로저가 정본으로 다루지만,
// activation.ts는 settings.ts를 import할 수 없다(circular). swapRuntime은 registryPath를 직접 받아
// 여기 전용 read/write 헬퍼(backup+0600, writeAgents와 동등)로 원자 갱신하고, 호출측(settings.ts 라우트)이
// 성공/실패 무관하게 deps.onRegistryChanged?.()를 다시 불러 in-memory/DB 캐시를 재동기화한다.
function readAgentsFile(registryPath: string): any[] {
  // agents.json 미존재(untracked 런타임 상태) = 빈 로스터. writeAgentsFile 이 곧 생성.
  let raw: string;
  try {
    raw = readFileSync(registryPath, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  return JSON.parse(raw);
}
function writeAgentsFile(registryPath: string, list: any[]): void {
  if (existsSync(registryPath)) copyFileSync(registryPath, registryPath + ".bak");
  writeFileSync(registryPath, JSON.stringify(list, null, 2) + "\n", "utf-8");
  try { chmodSync(registryPath, 0o600); } catch { /* best-effort */ }
}

export interface SwapInput {
  id: string;
  targetRuntime: string;
  registryPath: string; // agents.json 경로(SettingsDeps.registryPath 그대로 전달)
  bot_token?: string;
}

export interface SwapStep { step: string; ok: boolean; detail: string }

export interface SwapResult {
  ok: boolean;
  steps: SwapStep[];
  error?: string;
  // 라우트 핸들러가 HTTP status로 매핑하는 기계판독 사유(없으면 ok:true 200 또는 일반 400).
  code?: "unknown_member" | "no_op" | "invalid_runtime" | "base_hermes_guard" | "execution_off" | "preflight_blocked" | "read_failed" | "registry_write_failed" | "activate_failed";
}

export interface SwapDeps {
  checkRuntimeAuth?: typeof checkRuntimeAuth;
  activateMember?: typeof activateMember;
  teardownRuntime?: typeof teardownRuntime;
}

interface RollbackCtx {
  id: string;
  registryPath: string;
  list: any[]; // STEP3 이전 원본 전체 목록(불변 상태로 전달됨)
  idx: number;
  target: any; // STEP3 이전 원본 엔트리
  oldRuntime: string;
  oldPaths: { workspace_path: string; persona_file: string };
  oldLoadingFile: string;
  bakDir: string;
  personaBackedUp: boolean;
  loadingBackedUp: boolean;
  agentsMdBackedUp: boolean;
  doActivateMember: typeof activateMember;
  token: string; // STEP5에서 이미 해석된 봇 토큰(재사용 — self-heal도 같은 BotFather 토큰이면 충분, 파일 재탐색 불필요)
}

/** STEP3(레지스트리 커밋) 이후 실패 시 best-effort 롤백 — old runtime 으로 되돌리고 self-heal 재활성화 시도. */
async function rollbackSwap(db: Database, ctx: RollbackCtx): Promise<{ steps: SwapStep[] }> {
  const steps: SwapStep[] = [];
  try {
    const restored = [...ctx.list];
    restored[ctx.idx] = ctx.target;
    writeAgentsFile(ctx.registryPath, restored);
    steps.push({ step: "rollback-registry", ok: true, detail: `runtime 복원: ${ctx.oldRuntime}` });
  } catch (e) {
    steps.push({ step: "rollback-registry", ok: false, detail: (e as Error).message });
  }
  try {
    if (ctx.personaBackedUp) {
      const bakPersonaFile = `${ctx.bakDir}/${ctx.oldPaths.persona_file.split("/").pop()}`;
      if (existsSync(bakPersonaFile)) {
        mkdirSync(dirname(ctx.oldPaths.persona_file), { recursive: true });
        copyFileSync(bakPersonaFile, ctx.oldPaths.persona_file);
      }
    }
    if (ctx.loadingBackedUp) {
      const bakLoadingFile = `${ctx.bakDir}/${ctx.oldLoadingFile.split("/").pop()}`;
      if (existsSync(bakLoadingFile)) {
        mkdirSync(dirname(ctx.oldLoadingFile), { recursive: true });
        copyFileSync(bakLoadingFile, ctx.oldLoadingFile);
      }
    }
    const bakAgentsMdFile = `${ctx.bakDir}/AGENTS.md`;
    if (ctx.agentsMdBackedUp && existsSync(bakAgentsMdFile)) {
      copyFileSync(bakAgentsMdFile, `${ctx.oldPaths.workspace_path}/AGENTS.md`);
    }
    steps.push({ step: "rollback-persona", ok: true, detail: "옛 persona 복원(.swap-bak/)" });
  } catch (e) {
    steps.push({ step: "rollback-persona", ok: false, detail: (e as Error).message });
  }
  try {
    const token = ctx.token;
    if (token) {
      const heal = await ctx.doActivateMember(db, {
        id: ctx.id, display_name: ctx.target.display_name, role: ctx.target.role,
        runtime: ctx.oldRuntime, bot_username: ctx.target.telegram_bot_username,
        bot_token: token, // ★persona 미전달: SOUL.md 는 STEP1 백업에서 복원된다(아래 copyFileSync). purpose 는 제거됨(cfe8bf7)
      });
      steps.push({ step: "rollback-self-heal", ok: heal.ok, detail: heal.ok ? "옛 런타임 재활성화 성공" : (heal.error || "옛 런타임 재활성화 실패 — 수동 복구 필요") });
    } else {
      steps.push({ step: "rollback-self-heal", ok: false, detail: "봇 토큰 없어 self-heal 불가 — 수동 복구 필요" });
    }
  } catch (e) {
    steps.push({ step: "rollback-self-heal", ok: false, detail: (e as Error).message });
  }
  appendAuditFile("swap", "swap_rollback", ctx.id, { to_old_runtime: ctx.oldRuntime });
  return { steps };
}

/**
 * 런타임 스왑(claude_channel ↔ codex ↔ openclaw ↔ hermes_agent) — 메모리(MEMORY.md·memory/*.md·TODO.md·
 * 워크스페이스 dir)를 보존한 채 런타임만 교체한다. delete+recruit 경로는 절대 쓰지 않는다(archiveWorkspace가
 * 워크스페이스를 .archived 로 mv → 메모리 소실) — 이 함수는 archiveWorkspace를 어디서도 호출하지 않는다.
 *
 * STEP0 검증(순수 read, 실패해도 아무 것도 안 바꿈) → STEP1 페르소나 스냅샷(.swap-bak/) → STEP2 구 런타임
 * teardown → STEP3 레지스트리 원자 갱신(runtime+status_provider 동시 커밋) → STEP4 persona 파일명 전환
 * (orphan 정리 + claude↔비claude TEAM-OS.md 심링크) → STEP5 신 런타임 activateMember → STEP6 audit.
 *
 * 롤백 시맨틱: STEP3(레지스트리 커밋) 이전 실패=변경 없음(그냥 실패 반환, 가장 안전). STEP3 이후 STEP5(신
 * 런타임 activateMember) 실패=위험 구간(구 런타임은 teardown으로 이미 죽었을 수 있음) — 레지스트리를 old로
 * 되돌리고 .swap-bak/의 옛 persona를 복원한 뒤 old runtime activateMember로 best-effort self-heal 재시도.
 * self-heal 성패와 무관하게 ok:false + steps에 각 단계 결과를 남겨 사람이 어디서 실패했는지 알 수 있게 한다.
 */
export async function swapRuntime(db: Database, input: SwapInput, deps: SwapDeps = {}): Promise<SwapResult> {
  const { id, targetRuntime, registryPath, bot_token } = input;
  const doCheckRuntimeAuth = deps.checkRuntimeAuth ?? checkRuntimeAuth;
  const doActivateMember = deps.activateMember ?? activateMember;
  const doTeardownRuntime = deps.teardownRuntime ?? teardownRuntime;
  const steps: SwapStep[] = [];

  // STEP0(a) — 레지스트리에서 대상 조회.
  let list: any[];
  try {
    list = readAgentsFile(registryPath);
  } catch (e) {
    return { ok: false, steps, error: "레지스트리 읽기 실패: " + (e as Error).message, code: "read_failed" };
  }
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return { ok: false, steps, error: "알 수 없는 팀원", code: "unknown_member" };
  const target = { ...list[idx] };
  const oldRuntime: string = target.runtime;

  // STEP0(b) — no-op.
  if (targetRuntime === oldRuntime) {
    return { ok: false, steps, error: "이미 해당 런타임입니다(no-op)", code: "no_op" };
  }

  // STEP0(c) — 화이트리스트 검증. ★checkRuntimeAuth 호출보다 반드시 먼저 — checkRuntimeAuth는 미정의
  //   런타임 문자열을 loggedIn:true 로 fail-open 통과시킨다(runtimeAuth.ts KNOWN_RUNTIMES 밖). 여기서
  //   막지 않으면 오타·미지원 런타임이 무점검으로 teardown까지 진행해버릴 수 있다.
  if (!RUNTIMES.has(targetRuntime)) {
    return { ok: false, steps, error: `허용되지 않는 런타임: ${targetRuntime}`, code: "invalid_runtime" };
  }

  // STEP0(e) — base hermes 프로필(b3ryshermes) 가드. 모든 hermes 멤버의 공유 auth 소스라 교체 대상이
  //   아니다(offboard 가드와 동일 조건 재사용: target.runtime==="hermes_agent" && (hermes_profile??id)
  //   === "b3ryshermes"). swap 특유 추가: id 자체가 b3ryshermes면 방향 무관 거부(STEP3에서 hermes_profile
  //   이 id로 세팅되므로 "b3ryshermes로 교체해 들어가는" 경우도 이 한 줄로 커버됨).
  const isBaseHermesTarget = target.runtime === "hermes_agent" && ((target.hermes_profile ?? id) === "b3ryshermes");
  if (isBaseHermesTarget || id === "b3ryshermes") {
    return {
      ok: false, steps,
      error: "b3ryshermes는 모든 hermes 멤버가 공유하는 base 프로필(auth 소스)입니다. 런타임 교체 대상이 아닙니다.",
      code: "base_hermes_guard",
    };
  }

  // exec 게이트 — OFF면 레지스트리 변경 전에 거부(teardown 후 신런타임을 못 띄우는 반쯤-된 상태 예방).
  if (process.env.APPROVAL_EXECUTION_ENABLED !== "1") {
    return {
      ok: false, steps,
      error: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 런타임 교체는 팀장 인가(실행 ON) 후에만 가능합니다",
      code: "execution_off",
    };
  }

  // STEP0(d) — preflight. 미설치/미로그인이면 여기서 중단 — 아직 아무것도 안 바꿨다(가장 안전한 상태,
  //   구 런타임은 그대로 살아있어 다운타임 0).
  const auth = await doCheckRuntimeAuth(targetRuntime);
  if (!auth.loggedIn) {
    steps.push({ step: "preflight", ok: false, detail: auth.fixHint || auth.detail });
    appendAuditFile("swap", "preflight_blocked", id, { from: oldRuntime, to: targetRuntime });
    return { ok: false, steps, error: auth.fixHint || auth.detail, code: "preflight_blocked" };
  }
  steps.push({ step: "preflight", ok: true, detail: auth.detail });

  // 경로 해석 — agents.json 의 실제 workspace_path/persona_file 우선(id≠워크스페이스 폴더명 대응,
  // /regenerate-persona 와 동일 패턴), 없으면 memberPaths() 폴백. 워크스페이스 dir 자체는 런타임 무관.
  // 새 런타임의 persona 파일명은 personaTargetsForRuntime() 단일 정본을 쓴다(CLAUDE/SOUL 하드코딩 분산 방지).
  const fbOld = memberPaths(id, oldRuntime);
  const wsPath: string = (target.workspace_path as string) || fbOld.workspace_path;
  // FIX2(OWNER 2026-07-08): STEP1 스냅샷/STEP4 rmSync 전에 라이브 트리 차단. 테스트가 workspace_path 없는
  //   fixture id(steve/bill)로 스왑하면 wsPath 가 ~/Development/<id> 로 폴백 → 실 CLAUDE.md 삭제하던 근본버그.
  //   prod 무동작; test에서 라이브 경로면 여기서 throw(아무 것도 mutate 하기 전).
  assertNotLiveMemberFsUnderTest(wsPath, `swapRuntime(${id})`);
  const oldPersonaFile: string = (target.persona_file as string) || fbOld.persona_file;
  const oldTargets = personaTargetsForRuntime(oldRuntime, wsPath, oldPersonaFile);
  const newTargets = personaTargetsForRuntime(targetRuntime, wsPath);
  const newPersonaFile = newTargets.personaFile;
  const oldPaths = { workspace_path: wsPath, persona_file: oldPersonaFile };

  // STEP1 — 스냅샷(rollback 자산). persona 파일(SOUL.md) + loading file(CLAUDE/AGENTS.md) + AGENTS.md(있으면)를 .swap-bak/<ts>/ 로 백업.
  //   ★MEMORY.md·memory/*.md·TODO.md·README.md·reports/·.git 은 여기서 절대 손대지 않는다 — 워크스페이스
  //   dir 자체가 런타임 무관이고 이 함수가 archiveWorkspace를 안 부르는 한 자동 보존된다.
  const bakDir = `${wsPath}/.swap-bak/${Date.now()}`;
  const oldAgentsMdPath = `${wsPath}/AGENTS.md`;
  let personaBackedUp = false;
  let loadingBackedUp = false;
  let agentsMdBackedUp = false;
  try {
    if (existsSync(oldPersonaFile)) {
      mkdirSync(bakDir, { recursive: true });
      copyFileSync(oldPersonaFile, `${bakDir}/${oldPersonaFile.split("/").pop()}`);
      personaBackedUp = true;
    }
    if (oldTargets.loadingFile !== oldPersonaFile && existsSync(oldTargets.loadingFile)) {
      mkdirSync(bakDir, { recursive: true });
      copyFileSync(oldTargets.loadingFile, `${bakDir}/${oldTargets.loadingFile.split("/").pop()}`);
      loadingBackedUp = true;
    }
    if (existsSync(oldAgentsMdPath)) {
      mkdirSync(bakDir, { recursive: true });
      copyFileSync(oldAgentsMdPath, `${bakDir}/AGENTS.md`);
      agentsMdBackedUp = true;
    }
    steps.push({ step: "snapshot", ok: true, detail: personaBackedUp ? `백업: ${bakDir}` : "백업 대상 없음(신규 워크스페이스)" });
  } catch (e) {
    steps.push({ step: "snapshot", ok: false, detail: (e as Error).message }); // best-effort — 백업 실패해도 스왑은 계속(치명 아님)
  }

  // STEP1.5 — ★활성화 토큰 사전 확보(OWNER 2026-07-05, 하네스 critical fix)★.
  //   STEP2 teardown 이 구 런타임 토큰 저장소(파일)를 삭제하므로, 반드시 ★teardown 전에★ 메모리로 확보한다.
  //   우선순위 ①명시 bot_token ②var/secrets/<id>.bot-token ③구 런타임 토큰 저장소(자동 소싱).
  //   ③ = 대시보드 '봇 토큰 변경'→'런타임 교체'가 팀원 수동개입 없이 그 자체로 완결되게(공개판엔 대신할 팀원 없음).
  //   셋 다 없으면 ★아무것도 바꾸기 전에 즉시 실패★ — teardown 스킵 → 구 런타임 무손상(self-lock 아웃티지 방지).
  let tokenForActivate: string | undefined = bot_token;
  if (!tokenForActivate) {
    const tp = `${dirname(registryPath)}/var/secrets/${id}.bot-token`;
    try { if (existsSync(tp)) tokenForActivate = readFileSync(tp, "utf-8").trim() || undefined; } catch { /* best-effort */ }
  }
  if (!tokenForActivate) {
    try {
      const store = resolveTokenStore(oldRuntime, id, target);
      if (!("unsupported" in store)) { const t = store.read(); if (t) tokenForActivate = t; }
    } catch { /* best-effort — 아래 명확한 실패로 안내 */ }
  }
  if (!tokenForActivate) {
    steps.push({ step: "token-precheck", ok: false, detail: "봇 토큰을 찾을 수 없습니다(명시·var/secrets·구 런타임 저장소 모두 없음). 대시보드 '봇 토큰 변경'으로 먼저 토큰을 넣어 주세요." });
    appendAuditFile("swap", "swap_token_missing", id, { from: oldRuntime, to: targetRuntime });
    return { ok: false, steps, error: "봇 토큰 없음 — 교체 중단(구 런타임 그대로 유지)", code: "activate_failed" };
  }
  // 형식 검증(cheap·무네트워크) — 명백히 malformed면 teardown 전에 차단(구 런타임 유지). getMe 생존검증은
  //   activate 하류의 poller 헬스게이트에 위임(자동소싱 토큰은 방금까지 살아있던 구 런타임 것이라 dead일 확률 낮음).
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(tokenForActivate)) {
    steps.push({ step: "token-precheck", ok: false, detail: "봇 토큰 형식이 올바르지 않아요 — 교체 중단(구 런타임 유지). 대시보드 '봇 토큰 변경'으로 새 토큰을 넣어 주세요." });
    appendAuditFile("swap", "swap_token_invalid", id, { from: oldRuntime, to: targetRuntime });
    return { ok: false, steps, error: "봇 토큰 형식 오류 — 교체 중단", code: "activate_failed" };
  }

  // STEP2 — 구 런타임 teardown. 레지스트리는 아직 안 건드림(setHermes가 ambientAgents()로 프로필을
  //   조회하는데 먼저 지우면 profile≠id 케이스에서 엉뚱한 프로필을 건드리는 offboard와 동일 순서 교훈).
  const teardown = await doTeardownRuntime(id, oldRuntime, target, {});
  steps.push({ step: "teardown", ok: teardown.ok, detail: teardown.detail });

  // STEP3 — 레지스트리 원자 갱신(단일 write — runtime+status_provider가 절대 따로 안 쓰인다. 따로 쓰면
  //   DB CHECK 위반으로 syncRegistry reload 크래시). 런타임별 부가필드(tmux_session/hermes_profile) 동시 처리.
  const updatedEntry: any = { ...target, runtime: targetRuntime, status_provider: STATUS_BY_RUNTIME[targetRuntime], workspace_path: wsPath, persona_file: newPersonaFile };
  delete updatedEntry.tmux_session;
  delete updatedEntry.hermes_profile;
  if (targetRuntime === "claude_channel") updatedEntry.tmux_session = `claude-${id}`;
  if (targetRuntime === "hermes_agent") updatedEntry.hermes_profile = id;
  const newList = [...list];
  newList[idx] = updatedEntry;
  try {
    writeAgentsFile(registryPath, newList);
    steps.push({ step: "registry", ok: true, detail: `runtime ${oldRuntime} → ${targetRuntime}` });
  } catch (e) {
    steps.push({ step: "registry", ok: false, detail: (e as Error).message });
    return { ok: false, steps, error: "레지스트리 갱신 실패 — teardown은 이미 진행됐을 수 있습니다(수동 확인 필요)", code: "registry_write_failed" };
  }

  // STEP4 — loading 파일 전환(orphan 정리) + claude↔비claude TEAM-OS.md 심링크/AGENTS.md 처리.
  //   persona_file 은 런타임 무관 SOUL.md 이고, 런타임별 로딩파일(CLAUDE.md/AGENTS.md)만 전환된다.
  //   ※ 핵심룰/comms 재주입(coreRuleTargets/injectCoreRule 등, regenerate-persona 로직) 재실행은 의도적으로
  //   생략했다 — buildPersona/buildAgentsMd(personaTemplates.ts)가 런타임별로 이미 정확하게 만든다(claude=
  //   core+comms 포함 CLAUDE.md / openclaw·hermes·codex=core만 있고 comms 없는 AGENTS.md, SOUL.md는
  //   정체성 전용으로 core·comms 둘 다 없음 — buildPersona 소스 직접 확인). STEP5의 fresh activateMember
  //   호출은 ★loading file 만★ 재생성한다 — ★SOUL.md 는 재생성하지 않는다★(OWNER 2026-07-17: 사용자 소유).
  try {
    // ★SOUL.md 는 절대 지우지 않는다 — 경로가 바뀌면 ★옮긴다★.★ (OWNER 2026-07-17)
    //
    //   옛 코드: rmSync(oldPersonaFile, { force: true })  ← ★삭제★
    //   그때는 STEP5 의 writeMemberPersona 가 purpose 로 SOUL 을 ★재생성★ 했으므로 삭제가 성립했다.
    //   ★지금은 성립하지 않는다★: purpose 필드는 제거됐고(cfe8bf7) 렌더러는 SOUL 을 만들지 않는다.
    //   → 지우면 ★재생성해 줄 사람이 없다 = 페르소나 영구 소멸.★ force:true 라 .bak 조차 안 남는다.
    //   (steve 리뷰 2026-07-17: "삭제 후 재생성 = 이름만 바꾼 덮어쓰기" — 그 재생성마저 이제 없다)
    //
    //   ※ 현재 이 가지는 발화하지 않는다(persona_file 은 런타임 무관 SOUL.md 라 old === new).
    //     죽은 가지지만 방치하지 않는다 — 경로 규칙이 한 번 바뀌면 그날 조용히 지운다.
    //     이 rmSync 는 전과가 있다: 스왑 테스트가 실 id 로 라이브 파일을 지운 적이 있다(가드 a2becec).
    if (existsSync(oldPersonaFile) && oldPersonaFile !== newPersonaFile) {
      mkdirSync(dirname(newPersonaFile), { recursive: true });
      if (existsSync(newPersonaFile)) copyFileSync(newPersonaFile, `${newPersonaFile}.bak`); // 목적지가 있으면 백업 먼저
      renameSync(oldPersonaFile, newPersonaFile);   // ★내용을 새 경로로 옮긴다 (삭제 아님)★
    }
    if (oldTargets.loadingFile !== oldTargets.personaFile && oldTargets.loadingFile !== newTargets.loadingFile && existsSync(oldTargets.loadingFile)) {
      rmSync(oldTargets.loadingFile, { force: true });
    }
    if (oldRuntime === "claude_channel" && targetRuntime !== "claude_channel") {
      const link = `${wsPath}/TEAM-OS.md`;
      try { if (existsSync(link)) rmSync(link, { force: true }); } catch { /* best-effort */ }
    }
    if (targetRuntime === "claude_channel" && oldRuntime !== "claude_channel") {
      // 비claude→claude: 옛 AGENTS.md(로딩파일) orphan 제거 + CLAUDE.md의 @TEAM-OS.md가 풀리는 심링크 생성
      //   (recruit 경로 L924-930과 동일 패턴 — activateMember의 step1은 claude_channel엔 심링크를 안 만든다).
      try { if (existsSync(oldAgentsMdPath)) rmSync(oldAgentsMdPath, { force: true }); } catch { /* best-effort */ }
      const link = `${wsPath}/TEAM-OS.md`;
      try { if (!existsSync(link)) symlinkSync(LIVE_TEAM_OS_PATH, link); } catch { /* best-effort */ }
    }
    steps.push({ step: "persona-transition", ok: true, detail: `${oldTargets.loadingFile} → ${newTargets.loadingFile}; persona=${newPersonaFile}` });
  } catch (e) {
    steps.push({ step: "persona-transition", ok: false, detail: (e as Error).message }); // best-effort — STEP5가 자체 write하니 치명 아님
  }

  // STEP5 — 신 런타임 활성화. 토큰은 STEP1.5(teardown 전)에서 이미 확보·검증됨(tokenForActivate, non-null 보장).
  const activateResult = await doActivateMember(db, {
    id,
    display_name: target.display_name,
    role: target.role,
    runtime: targetRuntime,
    bot_username: target.telegram_bot_username,
    // ★persona 를 전달하지 않는다 — SOUL.md 는 이미 제자리에 있다(위에서 경로가 바뀌면 옮겼다).★
    //   purpose 필드는 제거됐고(cfe8bf7) persona 값의 유일한 집은 SOUL.md 다.
    //   전달하면 savePersonaFile 이 같은 내용을 다시 써서 무의미한 .bak 만 남는다.
    //   (옛 주석: "persona:undefined 면 default 로 덮여 custom 유실" — 그 덮어쓰기 자체가 사라져서 무효)
    bot_token: tokenForActivate,
  });
  steps.push(...activateResult.steps.map((s) => ({ step: `activate:${s.step}`, ok: s.ok, detail: s.detail })));
  if (!activateResult.ok) {
    // STEP5 실패 — 위험 구간(구 런타임은 이미 죽었을 수 있음). best-effort self-heal.
    const targetTeardown = await doTeardownRuntime(id, targetRuntime, updatedEntry, {});
    steps.push({ step: "rollback-target-teardown", ok: targetTeardown.ok, detail: targetTeardown.detail });
    const rb = await rollbackSwap(db, { id, registryPath, list, idx, target, oldRuntime, oldPaths, oldLoadingFile: oldTargets.loadingFile, bakDir, personaBackedUp, loadingBackedUp, agentsMdBackedUp, doActivateMember, token: tokenForActivate ?? "" });
    return { ok: false, steps: [...steps, ...rb.steps], error: activateResult.error || "신 런타임 활성화 실패", code: "activate_failed" };
  }

  // STEP6 — audit(swap_done). 최종 사용자 감사(appendAudit DB)는 settings.ts 라우트가 남긴다(요청 흐름의
  //   관례 — activateMember/offboard도 낮은 레벨 이벤트는 appendAuditFile, 라우트가 appendAudit(DB)).
  appendAuditFile("swap", "swap_done", id, { from: oldRuntime, to: targetRuntime });
  return { ok: true, steps };
}

/**
 * openclaw 새 에이전트의 OWNER 접근(pairing) 승인 — 영입 마법사 마지막 단계(터미널 0).
 * openclaw는 새 에이전트가 "이 봇에 말할 수 있는 사람"을 모르면 access 미설정 상태라 OWNER에게
 * pairing 코드를 DM으로 보낸다. 이 함수는 pairing.json의 pending 요청(OWNER가 봇에 DM하면 생성됨)을
 * 읽어 코드를 자동 추출하고 `openclaw pairing approve` 를 executor로 실행한다.
 * = OWNER는 봇에 메시지 한번 보내고 대시보드 [접근 승인] 탭만 — 코드 복붙·터미널 불필요.
 *
 * ⚠ self-mod(접근 grant) — APPROVAL_EXECUTION_ENABLED=1(팀장 터미널-직접 무장) + 인증된 대시보드 트리거에서만.
 */
export async function approveOpenclawPairing(agentId: string): Promise<{ ok: boolean; detail: string; reason?: string }> {
  if (process.env.APPROVAL_EXECUTION_ENABLED !== "1") return { ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 팀장 인가 필요", reason: "exec_off" };
  const pf = `${HOME}/.openclaw/credentials/telegram-pairing.json`;
  let code = "";
  try {
    const j = JSON.parse(readFileSync(pf, "utf-8"));
    const reqs: any[] = Array.isArray(j.requests) ? j.requests : [];
    // 이 에이전트의 텔레그램 account(=agentId)로 온 pending 요청 중 가장 최근.
    const match = reqs
      .filter((r) => r?.meta?.accountId === agentId && r?.code)
      .sort((a, b) => String(b.lastSeenAt || b.createdAt || "").localeCompare(String(a.lastSeenAt || a.createdAt || "")))[0];
    if (!match) return { ok: false, detail: "대기 중인 접근 요청이 없습니다 — 먼저 봇에게 텔레그램 메시지를 한번 보내 주세요", reason: "no_request" };
    code = String(match.code); // 코드값은 응답/로그에 노출하지 않음
  } catch (e) {
    return { ok: false, detail: "pairing 상태 읽기 실패: " + (e as Error).message, reason: "read_fail" };
  }
  try {
    appendAuditFile("activation", "pairing_approve_start", agentId, {});
    const proc = Bun.spawn(["openclaw", "pairing", "approve", "telegram", code], {
      env: { ...process.env, PATH: `${HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}` },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* */ } }, 25_000);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const tail = (out + (err ? "\n" + err : "")).replace(/[A-Z0-9]{6,}/g, "***").trim().slice(-240); // 코드 등 마스킹
    appendAuditFile("activation", exitCode === 0 ? "pairing_approve_done" : "pairing_approve_failed", agentId, { code: exitCode });
    if (exitCode === 0) return { ok: true, detail: "접근 승인 완료 — 곧 응답합니다" };
    return { ok: false, detail: "승인 실행 실패: " + tail, reason: "approve_fail" };
  } catch (e) {
    return { ok: false, detail: "승인 실행 오류: " + (e as Error).message, reason: "spawn_fail" };
  }
}

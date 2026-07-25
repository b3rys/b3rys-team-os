import { existsSync, readFileSync } from "node:fs";
import type { AgentRecord } from "../types";
import { REPO_ROOT } from "./personaTemplates";

const HOME = process.env.HOME ?? "";

export interface EssentialCheckResult {
  ok: boolean;
  missing: string[];
  canAutoFix: boolean;
  /** ★설계상 예정된 '사람 1회 조작 대기' 상태★ — 결함이 아니다.
   *  claude_channel 첫 멤버는 allowFrom 을 복사해올 참조봇이 없어 access.json 이
   *  `dmPolicy:"pairing", allowFrom:[]` 로 시드된다(launcher.seedClaudeAccess). 남은 일은
   *  팀장이 그 봇에게 DM 을 한 번 보내는 것뿐이므로, 활성화를 '실패' 로 표시해선 안 된다.
   *  (2026-07-25 맥스튜디오 실기 클린테스트: 첫 멤버가 '활성화 실패 — 재시도 필요' 로 떴는데
   *   DM 한 통으로 재시도 없이 통과했다. 두 번째 멤버는 첫 멤버 것을 시드받아 DM 없이 통과.) */
  pendingPairing?: boolean;
}

export interface RuntimeEssentials {
  readonly runtime: string;
  check(agent: Pick<AgentRecord, "id" | "runtime" | "openclaw_agent_id" | "hermes_profile">): EssentialCheckResult | Promise<EssentialCheckResult>;
}

export interface RuntimeEssentialDeps {
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
  pidAlive?: (pid: number) => boolean;
  home?: string;
  repoRoot?: string;
}

const okResult = (): EssentialCheckResult => ({ ok: true, missing: [], canAutoFix: false });
const result = (missing: string[], canAutoFix: boolean): EssentialCheckResult => ({ ok: missing.length === 0, missing, canAutoFix });

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function readPidMarker(path: string, deps: Required<Pick<RuntimeEssentialDeps, "exists" | "readText">>): { pid: number; agentId?: string } | null {
  if (!deps.exists(path)) return null;
  const raw = deps.readText(path).trim();
  const parsed = parseJson(raw);
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const pid = Number(obj.pid);
    if (Number.isInteger(pid) && pid > 0) {
      return { pid, agentId: typeof obj.agentId === "string" ? obj.agentId : undefined };
    }
  }
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? { pid } : null;
}

function hasNonEmptyFile(path: string, deps: Required<Pick<RuntimeEssentialDeps, "exists" | "readText">>): boolean {
  try {
    return deps.exists(path) && deps.readText(path).trim().length > 0;
  } catch {
    return false;
  }
}

function hasJsonArrayKey(path: string, key: string, deps: Required<Pick<RuntimeEssentialDeps, "exists" | "readText">>): boolean {
  if (!deps.exists(path)) return false;
  const obj = parseJson(deps.readText(path));
  if (!obj || typeof obj !== "object") return false;
  const value = (obj as Record<string, unknown>)[key];
  return Array.isArray(value) && value.length > 0;
}

/** claude access.json 이 ★첫 멤버 페어링 대기★ 상태인가 — 파일이 정상 존재하고 dmPolicy 가 "pairing"
 *  이며 allowFrom 이 ★빈 배열★ 인 경우만. 파일 부재·손상·다른 정책은 진짜 설정 누락이라 false. */
function isClaudePairingPending(path: string, deps: Required<Pick<RuntimeEssentialDeps, "exists" | "readText">>): boolean {
  if (!deps.exists(path)) return false;
  const obj = parseJson(deps.readText(path));
  if (!obj || typeof obj !== "object") return false;
  const access = obj as Record<string, unknown>;
  return access.dmPolicy === "pairing" && Array.isArray(access.allowFrom) && access.allowFrom.length === 0;
}

function hasDotenvKey(path: string, key: string, deps: Required<Pick<RuntimeEssentialDeps, "exists" | "readText">>): boolean {
  if (!deps.exists(path)) return false;
  return deps.readText(path).split(/\r?\n/).some((line) => {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    return m?.[1] === key && (m[2] ?? "").trim().length > 0;
  });
}

function hasAnyDotenvKey(path: string, keys: string[], deps: Required<Pick<RuntimeEssentialDeps, "exists" | "readText">>): boolean {
  return keys.some((key) => hasDotenvKey(path, key, deps));
}

function fileContainsNonEmptyExport(path: string, key: string, deps: Required<Pick<RuntimeEssentialDeps, "exists" | "readText">>): boolean {
  if (!deps.exists(path)) return false;
  const re = new RegExp(`^\\s*export\\s+${key}="([^"]+)"`, "m");
  return re.test(deps.readText(path));
}

function openclawConfig(home: string, deps: Required<Pick<RuntimeEssentialDeps, "exists" | "readText">>): any | null {
  const path = `${home}/.openclaw/openclaw.json`;
  if (!deps.exists(path)) return null;
  const parsed = parseJson(deps.readText(path));
  return parsed && typeof parsed === "object" ? parsed : null;
}

// openclaw 소유자 allowlist 는 버전에 따라 위치가 다르다 — 정본(2026.7.x)은 `commands.ownerAllowFrom`,
// 구 스키마는 `channels.telegram.ownerAllowFrom`. 둘 중 ★값이 있는 쪽★을 채택한다(빈 배열은 미설정으로 취급).
function openclawOwnerAllowFrom(cfg: any): unknown[] | null {
  for (const candidate of [cfg?.channels?.telegram?.ownerAllowFrom, cfg?.commands?.ownerAllowFrom]) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return null;
}

function openclawAccountTokenFile(account: string, home: string, deps: Required<Pick<RuntimeEssentialDeps, "exists" | "readText">>): string | null {
  const cfg = openclawConfig(home, deps);
  const raw = cfg?.channels?.telegram?.accounts?.[account]?.tokenFile;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw.startsWith("~") ? raw.replace(/^~/, home) : raw;
}

function launchdPrefix(): string {
  const override = process.env.TEAMOS_LAUNCHD_PREFIX?.trim();
  if (override) return override.replace(/\.$/, "");
  return `com.${process.env.USER?.trim() || "local"}`;
}

export function createRuntimeEssentialsRegistry(deps: RuntimeEssentialDeps = {}): Record<string, RuntimeEssentials> {
  const d = {
    exists: deps.exists ?? existsSync,
    readText: deps.readText ?? ((path: string) => readFileSync(path, "utf-8")),
    pidAlive: deps.pidAlive ?? defaultPidAlive,
    home: deps.home ?? HOME,
    repoRoot: deps.repoRoot ?? REPO_ROOT,
  };

  class ClaudeEssentials implements RuntimeEssentials {
    readonly runtime = "claude_channel";
    check(agent: Pick<AgentRecord, "id">): EssentialCheckResult {
      const stateDir = `${d.home}/.claude/channels/telegram-${agent.id}`;
      const paths = {
        envFile: `${stateDir}/.env`,
        stateDir,
        botPid: `${stateDir}/bot.pid`,
        plist: `${d.home}/Library/LaunchAgents/${launchdPrefix()}.claude-telegram-${agent.id}.plist`,
      };
      const accessFile = `${paths.stateDir}/access.json`;
      const missing: string[] = [];
      if (!hasDotenvKey(paths.envFile, "TELEGRAM_BOT_TOKEN", d)) missing.push("token:claude .env TELEGRAM_BOT_TOKEN");
      let pendingPairing = false;
      if (!hasJsonArrayKey(accessFile, "allowFrom", d)) {
        missing.push("allowFrom:claude access.json");
        // 첫 claude 멤버는 시드 원본이 없어 pairing 대기로 시작한다 = 설계상 정상 경로.
        pendingPairing = isClaudePairingPending(accessFile, d);
      }
      const marker = readPidMarker(paths.botPid, d);
      if (marker == null) missing.push("poller:claude bot.pid");
      else if (!d.pidAlive(marker.pid)) missing.push("poller:claude bot.pid not alive");
      if (!d.exists(paths.plist)) missing.push("channel:claude LaunchAgent plist");
      return { ...result(missing, missing.length > 0), pendingPairing };
    }
  }

  class CodexEssentials implements RuntimeEssentials {
    readonly runtime = "codex";
    check(agent: Pick<AgentRecord, "id">): EssentialCheckResult {
      const label = `${launchdPrefix()}.codex-bridge-${agent.id}`;
      const paths = {
        tokenFile: `${d.repoRoot}/var/secrets/${agent.id}.bot-token`,
        pidFile: `${d.repoRoot}/var/codex-bridge/${agent.id}.pid`,
        plist: `${d.home}/Library/LaunchAgents/${label}.plist`,
        wrapper: `${d.repoRoot}/var/codex-bridge/${agent.id}-launch.sh`,
      };
      const missing: string[] = [];
      if (!hasNonEmptyFile(paths.tokenFile, d)) missing.push("token:codex bot-token");
      if (!fileContainsNonEmptyExport(paths.wrapper, "CODEX_ALLOW_FROM", d)) missing.push("allowFrom:codex CODEX_ALLOW_FROM seed");
      const marker = readPidMarker(paths.pidFile, d);
      if (marker == null) missing.push("poller:codex ready pid");
      else if (marker.agentId && marker.agentId !== agent.id) missing.push("poller:codex pid agent mismatch");
      else if (!d.pidAlive(marker.pid)) missing.push("poller:codex pid not alive");
      if (!d.exists(paths.plist) || !d.exists(paths.wrapper)) missing.push("channel:codex bridge plist/wrapper");
      return result(missing, missing.length > 0);
    }
  }

  class OpenclawEssentials implements RuntimeEssentials {
    readonly runtime = "openclaw";
    check(agent: Pick<AgentRecord, "id" | "openclaw_agent_id">): EssentialCheckResult {
      const account = agent.openclaw_agent_id ?? agent.id;
      const fallbackEnvPath = process.env.OPENCLAW_ENV ?? `${d.home}/.openclaw/openclaw.env`;
      const nativeCodexFallback =
        agent.id === "codex" &&
        hasAnyDotenvKey(fallbackEnvPath, [
          "CODEX_TELEGRAM_BOT_TOKEN",
          "CODEX_BOT_TOKEN",
          "OPENCLAW_TELEGRAM_BOT_TOKEN",
          "TELEGRAM_BOT_TOKEN",
        ], d);
      const missing: string[] = [];
      const tokenFile = openclawAccountTokenFile(account, d.home, d);
      if ((!tokenFile || !hasNonEmptyFile(tokenFile, d)) && !nativeCodexFallback) {
        missing.push("token:openclaw tokenFile");
      }
      const cfg = openclawConfig(d.home, d);
      const accountCfg = cfg?.channels?.telegram?.accounts?.[account];
      if (!accountCfg && !nativeCodexFallback) missing.push("channel:openclaw telegram account");
      if (accountCfg && accountCfg.enabled !== true) missing.push("channel:openclaw account disabled");
      const ownerAllowFrom = openclawOwnerAllowFrom(cfg);
      if (!ownerAllowFrom && !nativeCodexFallback) {
        missing.push("allowFrom:openclaw ownerAllowFrom");
      }
      return result(missing, true);
    }
  }

  class HermesEssentials implements RuntimeEssentials {
    readonly runtime = "hermes_agent";
    check(agent: Pick<AgentRecord, "id" | "hermes_profile">): EssentialCheckResult {
      const profile = agent.hermes_profile ?? agent.id;
      const profileDir = `${d.home}/.hermes/profiles/${profile}`;
      const missing: string[] = [];
      if (!hasDotenvKey(`${profileDir}/.env`, "TELEGRAM_BOT_TOKEN", d)) missing.push("token:hermes profile .env TELEGRAM_BOT_TOKEN");
      if (!d.exists(`${profileDir}/auth.json`) && !d.exists(`${d.home}/.hermes/auth.json`)) missing.push("channel:hermes auth profile");
      if (!d.exists(`${d.home}/Library/LaunchAgents/ai.hermes.gateway-${profile}.plist`)) missing.push("channel:hermes LaunchAgent plist");
      return result(missing, true);
    }
  }

  const strategies: RuntimeEssentials[] = [
    new ClaudeEssentials(),
    new OpenclawEssentials(),
    new HermesEssentials(),
    new CodexEssentials(),
  ];
  return Object.fromEntries(strategies.map((s) => [s.runtime, s]));
}

export const runtimeEssentialsRegistry = createRuntimeEssentialsRegistry();

export function checkEssentialSettings(
  agent: Pick<AgentRecord, "id" | "runtime" | "openclaw_agent_id" | "hermes_profile">,
  registry: Record<string, RuntimeEssentials> = runtimeEssentialsRegistry,
): EssentialCheckResult | Promise<EssentialCheckResult> {
  return registry[agent.runtime]?.check(agent) ?? okResult();
}

export async function waitForEssentialSettings(
  agent: Pick<AgentRecord, "id" | "runtime" | "openclaw_agent_id" | "hermes_profile">,
  timeoutMs: number,
  opts: { intervalMs?: number; registry?: Record<string, RuntimeEssentials> } = {},
): Promise<EssentialCheckResult> {
  const intervalMs = opts.intervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  let last = await checkEssentialSettings(agent, opts.registry);
  while (!last.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await checkEssentialSettings(agent, opts.registry);
  }
  return last;
}

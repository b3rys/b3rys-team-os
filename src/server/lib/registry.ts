import { readFileSync, statSync, watch as fsWatch } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import { upsertAgent, deleteAgentsNotIn, appendAudit, listAgents } from "../db/queries";
import { validateCoordinators } from "./capabilities";
import { isTeamOfficialMember } from "./agentMembership";
import { consumeForcedEmptyRegistry, writeRegistrySafely } from "./registrySafety";

export function loadRegistry(path: string): AgentRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e: any) {
    // agents.json 은 런타임 상태(untracked). 없으면 빈 로스터 = 공개 clone 첫 부팅/셋업 전. 던지지 않는다.
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("agents.json must be an array");
  return arr.map((a) => {
    const teamOfficialMember = isTeamOfficialMember(a);
    return {
    id: String(a.id),
    display_name: String(a.display_name),
    nicknames: Array.isArray(a.nicknames) ? a.nicknames.map(String).filter(Boolean) : undefined,
    role: String(a.role),
    capabilities: Array.isArray(a.capabilities) ? a.capabilities.map(String).filter(Boolean) : [],
    enabled: a.enabled !== false,
    team_official_member: teamOfficialMember,
    lead_eligible: teamOfficialMember,
    response_mode: a.response_mode ?? "mention-only",
    default_intake_scope: a.default_intake_scope ?? "none",
    default_intake_description: a.default_intake_description ?? null,
    runtime: a.runtime,
    status_provider: a.status_provider,
    tmux_session: a.tmux_session ?? null,
    telegram_bot_username: a.telegram_bot_username ?? null,
    workspace_path: String(a.workspace_path),
    persona_file: String(a.persona_file),
    moderator_eligible: Boolean(a.moderator_eligible),
    avatar_emoji: a.avatar_emoji ?? "🤖",
    icon: a.icon ?? null,
    icon_color: a.icon_color ?? null,
    slack_bot_user_id: a.slack_bot_user_id ?? null,
    slack_app_name: a.slack_app_name ?? null,
    slack_connection_mode: a.slack_connection_mode ?? null, // socket 매니저가 인메모리 agents로 mode 판별 — 누락 시 socket 에이전트 못 봄

    channel_identities: a.channel_identities ?? null, // P3 채널 신원 seam — agents.json에서 로드(없으면 legacy 폴백)

    openclaw_agent_id: a.openclaw_agent_id ?? null,
    hermes_profile: a.hermes_profile ?? null,
    state_db_path: a.state_db_path ?? null,
    hermes_alias: a.hermes_alias ?? null,
    gateway_service: a.gateway_service ?? null,
    codex_sandbox: isAgentCodexSandbox(a.codex_sandbox) ? a.codex_sandbox : null,
    codex_network_access: typeof a.codex_network_access === "boolean" ? a.codex_network_access : null,
    };
  });
}

function isAgentCodexSandbox(value: unknown): value is AgentRecord["codex_sandbox"] {
  return value === "read-only" || value === "workspace-write";
}

// ─── Ambient registry (capability resolution for id-only call sites) ───────────
// 일부 헬퍼(teamContextPolicy.canReceiveFullTeamContext(id), wakeDispatcher 의 coordinator
// 기본값)는 agent id 문자열만 받고 AgentRecord 배열을 받지 못한다(공개 시그니처 보존 — 기존
// 테스트가 string id 로 호출). 이런 경우만 여기서 agents.json 을 lazy 로드(mtime 캐시)해 capability
// 를 조회한다. 인메모리 agents 배열을 받는 호출부는 그 배열을 직접 쓰고 ambient 를 쓰지 않는다.
const AMBIENT_REGISTRY_PATH =
  process.env.TEAM_AGENT_REGISTRY ?? join(import.meta.dir, "../../../agents.json");
let _ambientCache: { mtimeMs: number; agents: AgentRecord[] } | null = null;

export function ambientAgents(): AgentRecord[] {
  try {
    const mtimeMs = statSync(AMBIENT_REGISTRY_PATH).mtimeMs;
    if (_ambientCache && _ambientCache.mtimeMs === mtimeMs) return _ambientCache.agents;
    const agents = loadRegistry(AMBIENT_REGISTRY_PATH);
    _ambientCache = { mtimeMs, agents };
    return agents;
  } catch {
    return _ambientCache?.agents ?? [];
  }
}

export function syncRegistry(db: Database, registryPath: string, repoRoot?: string): AgentRecord[] {
  let agents = loadRegistry(registryPath);
  const forcedEmpty = agents.length === 0 && consumeForcedEmptyRegistry(registryPath);
  if (agents.length === 0 && !forcedEmpty) {
    const dbAgents = listAgents(db);
    if (dbAgents.length > 0) {
      // Registry가 갑자기 []가 됐는데 DB roster는 살아 있으면 파일 유실로 판단한다.
      // agents.json.bak가 DB와 같은 roster면 원본 전용 필드(nicknames/capabilities 등)를 보존해 우선 복구하고,
      // usable backup이 없을 때만 DB snapshot을 최후 fallback으로 쓴다.
      let recoverySource: AgentRecord[] = dbAgents;
      let source = "team.db";
      try {
        const backupAgents = loadRegistry(`${registryPath}.bak`);
        const dbIds = dbAgents.map((a) => a.id).sort().join("\0");
        const backupIds = backupAgents.map((a) => a.id).sort().join("\0");
        if (backupAgents.length > 0 && backupIds === dbIds) {
          recoverySource = backupAgents;
          source = "agents.json.bak";
        }
      } catch { /* malformed/missing backup → DB fallback */ }
      writeRegistrySafely(registryPath, recoverySource, { repoRoot });
      agents = loadRegistry(registryPath);
      appendAudit(db, "system", "registry_auto_recovered", null, { count: agents.length, source });
    }
  }
  for (const a of agents) upsertAgent(db, a);
  deleteAgentsNotIn(db, agents.map((a) => a.id));
  appendAudit(db, "system", "registry_synced", null, { count: agents.length });
  // load-time coordinator 검증 — 정확히 1명이 아니면 경고 + audit(공개 사용자 agents.json 오타/누락 가시화).
  const cc = validateCoordinators(agents);
  if (!cc.ok) {
    const reason = cc.issue === "none" ? "fallback_no_coordinator" : "multiple_coordinators";
    console.warn(
      `[registry] coordinator capability ${cc.count}개(${cc.coordinatorIds.join(", ") || "없음"}) — 정확히 1명이어야 함(${reason}).`,
    );
    appendAudit(db, "system", reason, null, { count: cc.count, coordinatorIds: cc.coordinatorIds });
  }
  return agents;
}

export function watchRegistry(
  db: Database,
  registryPath: string,
  onReload: (agents: AgentRecord[]) => void,
): void {
  let pending: NodeJS.Timeout | null = null;
  const reload = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      try {
        const agents = syncRegistry(db, registryPath);
        onReload(agents);
      } catch (e) {
        console.error("[registry] reload failed:", e);
      }
    }, 300);
  };
  try {
    fsWatch(registryPath, reload);
  } catch (e: any) {
    // 파일 미존재(untracked, 셋업 전 공개 clone) — fs.watch 가 ENOENT throw. 부모 디렉터리를 감시하다
    // agents.json 이 생기면(writeAgents) reload. 그 외 에러는 그대로 던진다.
    if (e?.code !== "ENOENT") throw e;
    const base = basename(registryPath);
    fsWatch(dirname(registryPath), (_event, filename) => {
      if (filename === base) reload();
    });
  }
}

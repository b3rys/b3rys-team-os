// 에이전트 health 분류 (health-check Phase 1 — observe-only).
// agent_status(ctx_percent / state / tmux_pid / probed_at)를 읽어 ok/warn/danger 로 분류.
// 자동 조치(Phase 2)는 별도 — 여기선 판정만.
import type { AgentStatus, AgentRecord } from "../types";
import { isTeamOfficialMember } from "./agentMembership";
import { isSubscriptionNeededDetail } from "./runtimeSubscription";

export type HealthLevel = "ok" | "warn" | "danger";
export type CapacityStatus = "ok" | "limit" | "usage_credits";

export interface HealthVerdict {
  agentId: string;
  level: HealthLevel;
  livenessLevel: HealthLevel;
  capacityLevel: HealthLevel;
  capacityStatus: CapacityStatus;
  capacityLabel: string | null;
  reasons: string[];
  ctxPercent: number | null;
  state: string;
}

// 임계값 (env 로 조정 가능)
const CTX_DANGER = Number(process.env.HEALTH_CTX_DANGER ?? 90);
const CTX_WARN = Number(process.env.HEALTH_CTX_WARN ?? 75);
const PROBE_STALE_MS = Number(process.env.HEALTH_PROBE_STALE_MS ?? 120_000);

const rank: Record<HealthLevel, number> = { ok: 0, warn: 1, danger: 2 };
const worse = (a: HealthLevel, b: HealthLevel): HealthLevel => (rank[a] >= rank[b] ? a : b);

function capacityReason(line: string | null | undefined): { level: HealthLevel; status: CapacityStatus; label: string; reason: string } | null {
  if (!line) return null;
  if (/usage credits?|usage credit balance|now using usage credits/i.test(line)) {
    return { level: "danger", status: "usage_credits", label: "크레딧 사용", reason: "Claude 크레딧 사용" };
  }
  if (/weekly limit|monthly spend limit|wait for limit to reset|used 100% of your session limit/i.test(line)) {
    return { level: "danger", status: "limit", label: "리밋", reason: "Claude 리밋" };
  }
  return null;
}

function runtimeBlockedReason(line: string | null | undefined): { level: HealthLevel; reason: string } | null {
  if (!line) return null;
  if (capacityReason(line)) return null;
  if (/how is claude doing this session|enter to confirm · esc to cancel/i.test(line)) {
    return { level: "danger", reason: "런타임 확인 대기" };
  }
  if (/turn_failed/i.test(line)) {
    return { level: "danger", reason: "OpenClaw 턴 실패" };
  }
  if (/openclaw response timeout|openclaw runtime/i.test(line)) {
    return { level: "warn", reason: "OpenClaw 최근 응답 지연" };
  }
  if (/codex telegram bridge (marker missing|pid invalid|pid not running|invalid agent id)/i.test(line)) {
    return { level: "warn", reason: "Codex Telegram 브리지 점검" };
  }
  if (isSubscriptionNeededDetail(line)) {
    return { level: "danger", reason: "Codex/OpenAI 한도" };
  }
  if (/codex runtime failed:\s*exit_0\b/i.test(line)) {
    return null;
  }
  if (/codex runtime failed/i.test(line)) {
    return { level: "danger", reason: "Codex 런타임 실패" };
  }
  return null;
}

// sqlite datetime('now') 은 "YYYY-MM-DD HH:MM:SS" UTC (Z 없음) — UTC 로 파싱.
function parseUtc(ts: string | null): number | null {
  if (!ts) return null;
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  const withZ = /[Z+]/.test(iso) ? iso : iso + "Z";
  const n = Date.parse(withZ);
  return Number.isNaN(n) ? null : n;
}

/**
 * 한 에이전트 status 를 health 로 분류.
 * - 세션 offline·tmux 없음 → danger
 * - ctx 높음/포화, probe stale, 현재 출력 갱신 중 → warn
 * - claude 봇인데 tmux_pid 없음 → danger(세션 다운)
 */
export function classifyHealth(s: AgentStatus, agent?: AgentRecord, now = Date.now()): HealthVerdict {
  const reasons: string[] = [];
  const contextReasons: string[] = [];
  let livenessLevel: HealthLevel = "ok";
  let capacityLevel: HealthLevel = "ok";
  let capacityStatus: CapacityStatus = "ok";
  let capacityLabel: string | null = null;
  const ctx = s.ctx_percent ?? null;

  // 빨간 점/위험 라벨은 '응답(세션) 여부' 기준만 — 문맥(ctx)은 dot/배너 level에 반영하지 않는다(OWNER 2026-06-26).
  // ctx는 카드의 문맥 바(85%+ 빨강)와 아래 reason 노트로만 알린다(노티). 세션이 살아 응답 잘 하는데 빨강 뜨던 것 방지.
  if (ctx != null && ctx >= CTX_DANGER) {
    contextReasons.push(`문맥 ${ctx}% · compact/reset 권장`);
  } else if (ctx != null && ctx >= CTX_WARN) {
    contextReasons.push(`문맥 ${ctx}% 높음`);
  }

  // offline = 세션 다운(위험). 일반 'blocked'는 statusProbe 상 정상 활동중에도 떠서 노이즈지만,
  // rate-limit/feedback/confirm prompt처럼 입력을 점유하는 명확한 런타임 정지는 danger로 잡는다.
  const capacity = capacityReason(s.last_log_line);
  if (capacity) {
    capacityLevel = worse(capacityLevel, capacity.level);
    capacityStatus = capacity.status;
    capacityLabel = capacity.label;
    reasons.push(capacity.reason);
  }

  const blockedReason = runtimeBlockedReason(s.last_log_line);
  if (blockedReason) {
    livenessLevel = worse(livenessLevel, blockedReason.level);
    reasons.push(blockedReason.reason);
  }

  if (s.state === "offline") {
    livenessLevel = worse(livenessLevel, "danger");
    reasons.push("offline (세션 다운)");
  }

  if (agent?.runtime === "claude_channel" && s.tmux_pid == null && s.state !== "offline") {
    livenessLevel = worse(livenessLevel, "danger");
    reasons.push("tmux 세션 없음");
  }

  const probed = parseUtc(s.probed_at);
  if (probed != null && now - probed > PROBE_STALE_MS) {
    livenessLevel = worse(livenessLevel, "warn");
    reasons.push(`probe ${Math.round((now - probed) / 1000)}s 전`);
  }

  reasons.push(...contextReasons);

  return {
    agentId: s.agent_id,
    level: worse(livenessLevel, capacityLevel),
    livenessLevel,
    capacityLevel,
    capacityStatus,
    capacityLabel,
    reasons,
    ctxPercent: ctx,
    state: s.state,
  };
}

export function classifyAll(
  statuses: AgentStatus[],
  agents: AgentRecord[],
  now = Date.now(),
): HealthVerdict[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return statuses.filter((s) => {
    const agent = byId.get(s.agent_id);
    return agent != null && isTeamOfficialMember(agent);
  }).map((s) => {
    const agent = byId.get(s.agent_id);
    return classifyHealth(s, agent, now);
  });
}

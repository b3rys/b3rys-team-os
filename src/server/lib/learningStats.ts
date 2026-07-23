// self-learning 측정 (Measure) — audit 로그를 분석해 라우팅/injection/health 통계 산출.
// 팀이 잘 굴러가는지 가시화 + 튜닝 우선순위 파악용. 읽기 전용(로그 파싱), 부작용 없음.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../logs");

interface AuditLine {
  ts?: string;
  actor?: string;
  action?: string;
  target?: string;
  detail?: Record<string, unknown>;
}

export interface LearningStats {
  windowDays: number;
  routing: {
    total: number;
    byOutcome: Record<string, number>; // route / closure / ask_gd
    byReason: Record<string, number>; // explicit_mention / active_assignee_followup / ...
    byTarget: Record<string, number>; // 어느 봇으로 라우팅됐나
    askGdRate: number; // 애매(GD확인) 비율 %
  };
  injection: {
    total: number;
    ok: number;
    failed: number;
    byAgent: Record<string, { ok: number; fail: number }>;
  };
  health: { dangerEvents: number; byAgent: Record<string, number> };
}

function readAuditLines(days: number): AuditLine[] {
  const out: AuditLine[] = [];
  for (let i = 0; i < days; i++) {
    const stamp = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const f = join(LOG_DIR, `audit-${stamp}.log`);
    if (!existsSync(f)) continue;
    for (const ln of readFileSync(f, "utf8").split("\n")) {
      if (!ln.trim()) continue;
      try {
        out.push(JSON.parse(ln) as AuditLine);
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

export function computeLearningStats(days = 1): LearningStats {
  const lines = readAuditLines(days);
  const routing = {
    total: 0,
    byOutcome: {} as Record<string, number>,
    byReason: {} as Record<string, number>,
    byTarget: {} as Record<string, number>,
    askGdRate: 0,
  };
  const injection = { total: 0, ok: 0, failed: 0, byAgent: {} as Record<string, { ok: number; fail: number }> };
  const health = { dangerEvents: 0, byAgent: {} as Record<string, number> };

  for (const l of lines) {
    const d = l.detail ?? {};
    if (l.action === "route_decision") {
      routing.total++;
      inc(routing.byOutcome, String(d.outcome ?? "route"));
      inc(routing.byReason, String(d.reason ?? "?"));
      for (const t of (d.targets as string[] | undefined) ?? []) inc(routing.byTarget, t);
    } else if (l.action === "injection") {
      injection.total++;
      const a = l.target ?? "?";
      (injection.byAgent[a] ??= { ok: 0, fail: 0 });
      if (d.ok) {
        injection.ok++;
        injection.byAgent[a].ok++;
      } else {
        injection.failed++;
        injection.byAgent[a].fail++;
      }
    } else if (l.action === "openclaw_inject_failed") {
      injection.total++;
      injection.failed++;
      const a = l.target ?? "?";
      (injection.byAgent[a] ??= { ok: 0, fail: 0 }).fail++;
    } else if (l.action === "agent_danger") {
      health.dangerEvents++;
      inc(health.byAgent, l.target ?? "?");
    }
  }
  routing.askGdRate = routing.total ? Math.round(((routing.byOutcome["ask_gd"] ?? 0) / routing.total) * 100) : 0;
  return { windowDays: days, routing, injection, health };
}

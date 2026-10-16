/**
 * Team OS probe — read-only snapshot of the team's operational surface for the
 * dashboard "Team OS" view: which scripts exist, which LaunchAgents/cron jobs are
 * scheduled (and running), and what work is in flight (TODO.md).
 *
 * Design constraint: this must NOT touch the team bus's own function or
 * performance. Everything here is read-only — filesystem reads + a single cached
 * `launchctl list` spawn — on a 15s cache, hit only when the Team OS tab is open.
 * No shared state with the dispatcher, no DB writes, no hot-loop work.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { botLivenessLaunchdLabel, teamosLaunchdPrefix } from "./agentControl";
import { captureConfigStatus } from "./captureConfig";
import { fromSqliteDate } from "../scheduler/core";

// teamosProbe.ts lives in src/server/lib → three levels up is the repo root.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPTS_DIR = join(ROOT, "scripts");
const TODO_PATH = join(ROOT, "TODO.md");
const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const OPENCLAW_CRON = join(homedir(), ".openclaw", "cron", "jobs.json");
const OPENCLAW_TELEGRAM_STATUS = join(ROOT, "var", "openclaw-telegram-ingress-status.json");

export interface TeamOsScript {
  name: string;
  desc: string;
}

export interface TeamOsScheduled {
  label: string;
  kind: "service" | "scheduled" | "on-demand";
  detail: string;
  description: string; // human "what it does" — empty if unknown
  source: "launchd" | "openclaw_cron" | "scheduled_job";
  running: boolean | null;
  enabled: boolean;
  // running만으로 비활성·실패·밀림·재시도를 구분할 수 없어 문제 원인을 별도로 노출한다.
  problem?: "failed" | "overdue" | "retrying" | null;
}

/**
 * 다음 실행 시각이 이 초 이상 지났을 때만 "밀림"으로 본다.
 * 0 이면 스케줄러 tick 간격(기본 60s) 안의 정상적인 찰나까지 밀림으로 잡아 매 화면마다 거짓 경보가 난다.
 */
export const OVERDUE_GRACE_SEC = 300;

// What each launchd job does, in human terms (labels are cryptic).
function launchdDesc(): Record<string, string> {
  const prefix = teamosLaunchdPrefix();
  return {
    "ai.openclaw.gateway": "openclaw 게이트웨이 — openclaw 런타임 구동",
    [`${prefix}.caffeinate`]: "맥미니 잠들기 방지 (24/7 가동 유지)",
    [`${prefix}.team-collab`]: "팀 대시보드 · 메시지 버스 서버 (:7878)",
    [`${prefix}.team-task-review`]: "평일 06:00 Tasks active 과제 리뷰 ping",
    [`${prefix}.team-digest`]: "매일 08:00 팀 digest 발송",
    [`${prefix}.team-os-boot`]: "부팅 시 팀 운영 상태 초기 점검",
    [`${prefix}.pangyobuk-hub`]: "your-team.example.com 허브 (:3000)",
    [`${prefix}.b3rys-dev`]: "b3rys 개발용 로컬 서비스",
    [`${prefix}.claude-telegram-bill`]: "Claude 채널 팀원 텔레그램 봇 (tmux 세션)",
    [`${prefix}.claude-telegram-steve`]: "Claude 채널 팀원 텔레그램 봇 (tmux 세션)",
    [`${prefix}.claude-telegram-demis`]: "Claude 채널 팀원 텔레그램 봇 (tmux 세션)",
    [`${prefix}.claude-telegram-dbak`]: "Claude 채널 팀원 텔레그램 봇 (tmux 세션)",
    [botLivenessLaunchdLabel()]: "Claude channel bot liveness monitor · auto-heal",
    [`${prefix}.bill-context-monitor`]: "Claude 세션 컨텍스트 크기 감시 (커지면 알림)",
    [`${prefix}.bill-weekly-healthcheck`]: "주간 팀 헬스체크 리포트",
    [`${prefix}.claude-bots-weekly-restart`]: "Claude 봇 주간 자동 재시작 (컨텍스트 정리)",
  };
}

export interface TeamOsTask {
  state: "in_progress" | "pending";
  text: string;
}

export interface TeamOsSnapshot {
  generated_at: string;
  scripts: TeamOsScript[];
  scheduled: TeamOsScheduled[];
  tasks: TeamOsTask[];
  tasks_pending_total: number;
  openclaw_telegram_ingress: TeamOsOpenClawTelegramIngress | null;
  // TEAM OP(capture 봇) 실제 구성 상태 — 카드가 launchd 라벨 휴리스틱 대신 이걸로 활성/미설정 판정.
  capture: { has_capture_token: boolean; capture_group_id: string | null; router_enabled: boolean };
}

export interface TeamOsOpenClawTelegramIngress {
  generated_at: string;
  as_of: string;
  account: string;
  bot_username: string;
  state: string;
  last_state_at: string;
  last_inbound_at: string;
  last_inbound_age_sec: number;
  restart_count: number;
  backlog_latency_sec: number;
  stale_threshold_sec: number;
  cooldown_sec: number;
  auto_recover_enabled: number;
  detected: boolean;
  reason: string;
  source_log: string;
}

let cache: { at: number; data: TeamOsSnapshot } | null = null;
const TTL_MS = 15_000;

export function __resetTeamOsSnapshotCacheForTest(): void {
  cache = null;
}

function formatKst(ts: string | null): string | null {
  if (!ts) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(ts) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(ts.trim())
    ? ts.replace(" ", "T") + "Z"
    : ts.replace(" ", "T");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return ts;
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")} KST`;
}

function firstCommentLine(content: string): string {
  for (const line of content.split("\n").slice(0, 10)) {
    const m = line.match(/^\s*(?:#|\/\/|--)\s*(.+)/);
    if (m && m[1] && !m[1].startsWith("!")) return m[1].trim().slice(0, 120);
  }
  return "";
}

function listScripts(): TeamOsScript[] {
  try {
    return readdirSync(SCRIPTS_DIR)
      .filter((f) => /\.(sh|ts|py|js)$/.test(f))
      .sort()
      .map((name) => {
        let desc = "";
        try {
          desc = firstCommentLine(readFileSync(join(SCRIPTS_DIR, name), "utf-8"));
        } catch {
          /* ignore */
        }
        return { name, desc };
      });
  } catch {
    return [];
  }
}

/** Map of launchd label → running (pid present & not '-'). Single cached spawn. */
function launchctlRunning(): Map<string, boolean> {
  const map = new Map<string, boolean>();
  try {
    const proc = Bun.spawnSync(["launchctl", "list"]);
    const out = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
    for (const line of out.split("\n")) {
      // format: PID\tStatus\tLabel
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const pid = parts[0]?.trim();
      const label = parts[2]?.trim();
      if (!label) continue;
      map.set(label, pid !== "-" && pid !== "" && !Number.isNaN(Number(pid)));
    }
  } catch {
    /* launchctl unavailable — running stays unknown (null) */
  }
  return map;
}

function listLaunchd(running: Map<string, boolean>): TeamOsScheduled[] {
  let files: string[];
  const prefix = teamosLaunchdPrefix();
  const desc = launchdDesc();
  try {
    files = readdirSync(LAUNCH_AGENTS_DIR).filter(
      (f) => f.endsWith(".plist") && (f.startsWith(`${prefix}.`) || f.startsWith("ai.openclaw.")),
    );
  } catch {
    return [];
  }
  return files.sort().map((f) => {
    const label = f.replace(/\.plist$/, "");
    let kind: TeamOsScheduled["kind"] = "on-demand";
    let detail = "RunAtLoad";
    try {
      const text = readFileSync(join(LAUNCH_AGENTS_DIR, f), "utf-8");
      if (/StartCalendarInterval/.test(text)) {
        kind = "scheduled";
        detail = "예약 (calendar)";
      } else if (/StartInterval/.test(text)) {
        kind = "scheduled";
        const m = text.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
        detail = m ? `주기 ${Number(m[1])}s` : "주기 실행";
      } else if (/<key>KeepAlive<\/key>/.test(text)) {
        kind = "service";
        detail = "상시 (KeepAlive)";
      }
    } catch {
      /* ignore */
    }
    // Running detection is only reliable for direct, continuously-running services.
    // - "scheduled" (calendar/interval) jobs are idle between runs → "not running now" is NORMAL,
    //   so we report null (not false) to avoid a misleading red "멈춤".
    // - claude-telegram-* run via a detached tmux session; the LaunchAgent job exits after spawning,
    //   so launchctl shows it as not-running even though the bot is alive → report null, point users
    // to the Agent cards for real liveness.
    // Only genuine KeepAlive direct services (gateway/team-collab/pangyobuk/caffeinate) keep a
    // trustworthy running flag — red there means a real outage.
    const isTmuxBot = label.includes("claude-telegram");
    const reliable = kind !== "scheduled" && !isTmuxBot;
    const isRunning = reliable && running.has(label) ? running.get(label)! : null;
    return {
      label,
      kind,
      detail,
      description: desc[label] ?? "",
      source: "launchd",
      running: isRunning,
      enabled: true,
    };
  });
}

// scheduled_job은 launchd 목록에 없으므로 DB에서 별도로 조회해야 운영 스케줄을 빠짐없이 보여줄 수 있다.
// 실패 뒤 재예약된 잡은 last_error로 재시도 중임을 표시한다. 실행 중에는 next_run_at을 옮기지 않으므로 살아 있는 리스는 밀림에서 제외한다.
export function judgeScheduledJob(
  row: {
    enabled: number;
    status: string | null;
    next_run_at: string | null;
    last_error?: string | null;
    lock_until?: string | null;
  },
  nowMs: number,
): { running: boolean; problem: "failed" | "overdue" | "retrying" | null; overdueMin: number } {
  // 새 시각 파서를 만들지 않는다 — 스케줄러가 자기 컬럼을 읽는 방식(fromSqliteDate)을 그대로 쓴다.
  //   판정과 저장이 다른 규칙을 쓰면 KST 서버에서 정확히 9시간 어긋난다(utcTimestamp.contract.test 의 교훈).
  const overdueMs = row.next_run_at ? nowMs - fromSqliteDate(row.next_run_at).getTime() : Number.NaN;
  // 비활성 잡은 next_run_at이 과거에 멈추므로 시간 경과를 밀림으로 판정하면 안 된다.
  const isEnabled = row.enabled === 1;
  const isFailed = isEnabled && row.status === "failed";
  // 리스가 아직 살아 있는 실행 중 = 늦은 게 아니라 지금 하는 중 이다.
  const leaseMs = row.lock_until ? fromSqliteDate(row.lock_until).getTime() : Number.NaN;
  const isRunningNow = row.status === "running" && Number.isFinite(leaseMs) && leaseMs > nowMs;
  // 시각이 없거나 파싱 불가면 밀림으로 단정하지 않는다 — 모르는 것은 모른다고 둔다(거짓 경보 금지).
  const isOverdue =
    isEnabled && !isRunningNow && Number.isFinite(overdueMs) && overdueMs > OVERDUE_GRACE_SEC * 1000;
  // 재시도 대기: 다음 차례는 잡혀 있는데 직전 시도가 실패했다.
  //   last_error 는 성공 시 NULL 로 지워지고 실패 시 채워지므로 "직전 시도 결과" 신호가 된다.
  const isRetrying = isEnabled && !isFailed && !isOverdue && row.status === "pending" && !!row.last_error;
  return {
    // "예정대로 살아있나" = 켜져 있고 · 다음 실행이 잡혀 있고 · 정지/밀림/재시도 중이 아니다.
    running: isEnabled && !!row.next_run_at && !isFailed && !isOverdue && !isRetrying,
    problem: isFailed ? "failed" : isOverdue ? "overdue" : isRetrying ? "retrying" : null,
    overdueMin: Number.isFinite(overdueMs) ? Math.floor(overdueMs / 60000) : 0,
  };
}

function listScheduledJobs(db: Database): TeamOsScheduled[] {
  try {
    const rows = db.prepare(
      // last_error를 가져와야 재예약된 잡의 직전 실패를 표시할 수 있다.
      `SELECT id, title, schedule_expr, enabled, status, next_run_at, last_run_at, last_error, lock_until
         FROM scheduled_job
        WHERE kind='recurring'
          AND NOT (enabled=0 AND status='cancelled')
        ORDER BY id`,
    ).all() as Array<{
      id: string; title: string | null; schedule_expr: string | null;
      enabled: number; status: string | null; next_run_at: string | null; last_run_at: string | null;
      last_error: string | null; lock_until: string | null;
    }>;
    const nowMs = Date.now();
    return rows.map((r) => {
      let cron = "";
      try { cron = String((JSON.parse(r.schedule_expr ?? "{}") as { cron?: string }).cron ?? ""); } catch { /* 표시용이라 실패해도 넘어간다 */ }
      const next = r.next_run_at ? formatKst(r.next_run_at) : null;
      const last = r.last_run_at ? formatKst(r.last_run_at) : null;
      const v = judgeScheduledJob(r, nowMs);
      return {
        label: r.id,
        kind: "scheduled" as const,
        detail: [
          cron && `cron=${cron}`,
          `next=${next ?? "-"}`,
          `last=${last ?? "-"}`,
          v.problem === "failed" && "★실패로 정지★",
          v.problem === "overdue" && `★${v.overdueMin}분 밀림★`,
          v.problem === "retrying" && "★직전 시도 실패 — 다음 차례에 재시도★",
        ].filter(Boolean).join(" · "),
        description: r.title ?? "",
        source: "scheduled_job" as const,
        running: v.running,
        enabled: r.enabled === 1,
        problem: v.problem,
      };
    });
  } catch {
    return [];   // 테이블이 없는 설치본(구버전)에서도 뷰가 죽지 않게
  }
}

function listOpenclawCron(): TeamOsScheduled[] {
  try {
    if (!existsSync(OPENCLAW_CRON)) return [];
    type Job = {
      name?: string;
      enabled?: boolean;
      agentId?: string;
      schedule?: { kind?: string; expr?: string; tz?: string };
    };
    const parsed = JSON.parse(readFileSync(OPENCLAW_CRON, "utf-8")) as
      | Job[]
      | { jobs?: Job[] }
      | Record<string, Job>;
    // jobs.json shape is { version, jobs: [...] }. Tolerate a bare array or an
    // id-keyed object too, in case the format changes.
    const jobs: Job[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { jobs?: Job[] }).jobs)
        ? (parsed as { jobs: Job[] }).jobs
        : (Object.values(parsed as Record<string, Job>).filter((v) => v && typeof v === "object" && "schedule" in v) as Job[]);
    return jobs.map((j) => {
      const expr = j.schedule?.expr ?? j.schedule?.kind ?? "?";
      const tz = j.schedule?.tz ? ` ${j.schedule.tz}` : "";
      return {
        label: j.name ?? "(unnamed cron)",
        kind: "scheduled" as const,
        detail: `${expr}${tz}${j.agentId ? ` · ${j.agentId}` : ""}`,
        description: `openclaw 예약 작업${j.agentId ? ` (${j.agentId})` : ""} — 정해진 시각에 자동 실행`,
        source: "openclaw_cron" as const,
        running: null,
        enabled: j.enabled !== false,
      };
    });
  } catch {
    return [];
  }
}

function listTasks(): { tasks: TeamOsTask[]; pendingTotal: number } {
  try {
    const text = readFileSync(TODO_PATH, "utf-8");
    const inProgress: TeamOsTask[] = [];
    const pending: TeamOsTask[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*-?\s*\[([ ~x])\]\s*(.+)/);
      if (!m) continue;
      const mark = m[1];
      const txt = m[2]!.trim().slice(0, 140);
      if (mark === "~") inProgress.push({ state: "in_progress", text: txt });
      else if (mark === " ") pending.push({ state: "pending", text: txt });
    }
    // Show all in-progress + up to 8 pending (newest-relevant); report full pending count.
    return { tasks: [...inProgress, ...pending.slice(0, 8)], pendingTotal: pending.length };
  } catch {
    return { tasks: [], pendingTotal: 0 };
  }
}

function openclawTelegramIngress(): TeamOsOpenClawTelegramIngress | null {
  try {
    if (!existsSync(OPENCLAW_TELEGRAM_STATUS)) return null;
    const parsed = JSON.parse(readFileSync(OPENCLAW_TELEGRAM_STATUS, "utf-8")) as Partial<TeamOsOpenClawTelegramIngress>;
    return {
      generated_at: String(parsed.generated_at ?? ""),
      as_of: String(parsed.as_of ?? ""),
      account: String(parsed.account ?? "default"),
      bot_username: String(parsed.bot_username ?? ""),
      state: String(parsed.state ?? "unknown"),
      last_state_at: String(parsed.last_state_at ?? ""),
      last_inbound_at: String(parsed.last_inbound_at ?? ""),
      last_inbound_age_sec: Number(parsed.last_inbound_age_sec ?? 0),
      restart_count: Number(parsed.restart_count ?? 0),
      backlog_latency_sec: Number(parsed.backlog_latency_sec ?? 0),
      stale_threshold_sec: Number(parsed.stale_threshold_sec ?? 0),
      cooldown_sec: Number(parsed.cooldown_sec ?? 0),
      auto_recover_enabled: Number(parsed.auto_recover_enabled ?? 0),
      detected: parsed.detected === true,
      reason: String(parsed.reason ?? ""),
      source_log: String(parsed.source_log ?? ""),
    };
  } catch {
    return null;
  }
}

export function teamOsSnapshot(db: Database): TeamOsSnapshot {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  const running = launchctlRunning();
  const { tasks, pendingTotal } = listTasks();
  const data: TeamOsSnapshot = {
    generated_at: new Date().toISOString(),
    scripts: listScripts(),
    scheduled: [...listLaunchd(running), ...listScheduledJobs(db), ...listOpenclawCron()],
    tasks,
    tasks_pending_total: pendingTotal,
    openclaw_telegram_ingress: openclawTelegramIngress(),
    capture: captureConfigStatus(db),
  };
  cache = { at: now, data };
  return data;
}

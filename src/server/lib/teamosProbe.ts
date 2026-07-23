/**
 * Team OS probe — read-only snapshot of the team's operational surface for the
 * dashboard "Team OS" view: which scripts exist, which LaunchAgents/cron jobs are
 * scheduled (and running), and what work is in flight (TODO.md).
 *
 * Design constraint (GD): this must NOT touch the team bus's own function or
 * performance. Everything here is read-only — filesystem reads + a single cached
 * `launchctl list` spawn — on a 15s cache, hit only when the Team OS tab is open.
 * No shared state with the dispatcher, no DB writes, no hot-loop work.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { teamosLaunchdPrefix } from "./agentControl";
import { captureConfigStatus } from "./captureConfig";

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
}

// What each launchd job does, in human terms (labels are cryptic).
function launchdDesc(): Record<string, string> {
  const prefix = teamosLaunchdPrefix();
  return {
    "ai.openclaw.gateway": "openclaw 게이트웨이 — openclaw 런타임 구동",
    [`${prefix}.caffeinate`]: "맥미니 잠들기 방지 (24/7 가동 유지)",
    [`${prefix}.team-collab`]: "팀 대시보드 · 메시지 버스 서버 (:7878)",
    [`${prefix}.team-task-review`]: "매일 06:00 Tasks active 과제 리뷰 ping",
    [`${prefix}.team-digest`]: "매일 08:00 팀 digest 발송",
    [`${prefix}.team-os-boot`]: "부팅 시 팀 운영 상태 초기 점검",
    [`${prefix}.pangyobuk-hub`]: "your-team.example.com 허브 (:3000)",
    [`${prefix}.b3rys-dev`]: "b3rys 개발용 로컬 서비스",
    [`${prefix}.claude-telegram-bill`]: "Claude 채널 팀원 텔레그램 봇 (tmux 세션)",
    [`${prefix}.claude-telegram-steve`]: "Claude 채널 팀원 텔레그램 봇 (tmux 세션)",
    [`${prefix}.claude-telegram-demis`]: "Claude 채널 팀원 텔레그램 봇 (tmux 세션)",
    [`${prefix}.claude-telegram-dbak`]: "Claude 채널 팀원 텔레그램 봇 (tmux 세션)",
    [`${prefix}.bot-liveness-monitor`]: "Claude channel bot liveness monitor · auto-heal",
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
    //   to the Agent cards for real liveness. (GD 2026-05-31: bots were all false-red.)
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

/**
 * ★team.db 의 scheduled_job 도 운영뷰에 보여준다.★ (2026-07-17)
 *
 * 왜 필요한가: continuation guard 를 launchd → scheduled_job 으로 옮겼더니(서버가 사는 한 같이 살고
 * 퍼블릭에서도 돌게), ★대시보드에서 아예 안 보이게 됐다.★ 이 뷰가 launchd·openclaw_cron 만 봤기 때문이다.
 * ★그건 고친 게 아니라 옮긴 것이다★ — 원래 문제가 "3일 18시간 죽었는데 아무도 몰랐다" 였는데,
 * 안 보이면 또 모른다. 스케줄이 어디 얹혀 있든 ★한 화면에서 보여야★ 한다.
 *
 * launchd 와 달리 next_run_at/last_run_at 이 DB 에 있으므로 "언제 돌았나" 까지 같이 보여준다.
 */
function listScheduledJobs(db: Database): TeamOsScheduled[] {
  try {
    const rows = db.prepare(
      `SELECT id, title, schedule_expr, enabled, status, next_run_at, last_run_at
         FROM scheduled_job WHERE kind='recurring' ORDER BY id`,
    ).all() as Array<{
      id: string; title: string | null; schedule_expr: string | null;
      enabled: number; status: string | null; next_run_at: string | null; last_run_at: string | null;
    }>;
    return rows.map((r) => {
      let cron = "";
      try { cron = String((JSON.parse(r.schedule_expr ?? "{}") as { cron?: string }).cron ?? ""); } catch { /* 표시용이라 실패해도 넘어간다 */ }
      const next = r.next_run_at ? formatKst(r.next_run_at) : null;
      const last = r.last_run_at ? formatKst(r.last_run_at) : null;
      return {
        label: r.id,
        kind: "scheduled" as const,
        detail: [cron && `cron=${cron}`, `next=${next ?? "-"}`, `last=${last ?? "-"}`].filter(Boolean).join(" · "),
        description: r.title ?? "",
        source: "scheduled_job" as const,
        // ★running 은 launchd 처럼 프로세스 상주 여부가 아니다★ — 잡은 평소엔 안 떠 있는 게 정상이다.
        //   여기선 "예정대로 살아있나" = enabled && 다음 실행이 잡혀 있나 로 본다.
        running: r.enabled === 1 && !!r.next_run_at,
        enabled: r.enabled === 1,
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

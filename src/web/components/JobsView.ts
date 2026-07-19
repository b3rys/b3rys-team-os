// JobsView — read-only operational jobs screen backed by /api/teamos scheduled data.

import { apiBase } from "../ws";
import { pick } from "../i18n";

type JobKind = "service" | "scheduled" | "on-demand";
type JobSource = "launchd" | "openclaw_cron";

interface ReadOnlyJob {
  label: string;
  kind: JobKind;
  detail: string;
  description: string;
  source: JobSource;
  running: boolean | null;
  enabled: boolean;
}

interface JobGroup {
  key: string;
  title: string;
  description: string;
  jobs: ReadOnlyJob[];
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jobText(j: ReadOnlyJob): string {
  return `${j.label} ${j.description} ${j.detail} ${j.source}`.toLowerCase();
}

function groupKey(j: ReadOnlyJob): string {
  const text = jobText(j);
  if (/(task-review|team-task|continuation|tasks|digest)/.test(text)) return "task-review";
  if (/(healthcheck|health|context-monitor|liveness|monitor)/.test(text)) return "healthcheck";
  if (/(auto[- ]?heal|restart|wake|boot|caffeinate)/.test(text)) return "auto-heal";
  return "other";
}

function groupJobs(jobs: ReadOnlyJob[]): JobGroup[] {
  const groups: JobGroup[] = [
    {
      key: "auto-heal",
      title: pick("Auto-heal류", "Auto-heal"),
      description: pick("서비스 재기동·부팅 복구·상시 유지 계열", "Service restart · boot recovery · always-on"),
      jobs: [],
    },
    {
      key: "task-review",
      title: pick("과제리뷰류", "Task review"),
      description: pick("Tasks 리뷰·continuation guard·digest 계열", "Tasks review · continuation guard · digest"),
      jobs: [],
    },
    {
      key: "healthcheck",
      title: pick("Healthcheck류", "Healthcheck"),
      description: pick("상태 점검·liveness·context monitor 계열", "Status check · liveness · context monitor"),
      jobs: [],
    },
    {
      key: "other",
      title: pick("기타", "Other"),
      description: pick("런타임 서비스·봇·개별 예약 작업", "Runtime services · bots · individual scheduled jobs"),
      jobs: [],
    },
  ];
  const byKey = new Map(groups.map((g) => [g.key, g]));
  jobs.forEach((job) => byKey.get(groupKey(job))!.jobs.push(job));
  groups.forEach((g) => {
    g.jobs.sort((a, b) => a.label.localeCompare(b.label));
  });
  return groups.filter((g) => g.jobs.length > 0);
}

function jobBadge(kind: JobKind): string {
  const style: Record<JobKind, { label: string; cls: string }> = {
    service: { label: pick("상시", "Always-on"), cls: "bg-emerald-500/15 text-txt-green border-emerald-500/30" },
    scheduled: { label: pick("예약", "Scheduled"), cls: "bg-blue-500/15 text-txt-blue border-blue-500/30" },
    "on-demand": { label: pick("온디맨드", "On-demand"), cls: "bg-slate-500/15 text-slate-300 border-slate-500/30" },
  };
  const b = style[kind];
  return `<span class="rounded border px-2 py-0.5 text-[11px] font-semibold ${b.cls}">${b.label}</span>`;
}

function jobState(j: ReadOnlyJob): string {
  if (!j.enabled) {
    return `<span class="inline-flex items-center gap-1 text-xs text-status-blocked"><span class="w-2 h-2 rounded-full bg-status-blocked"></span>disabled</span>`;
  }
  if (j.running === true) {
    return `<span class="inline-flex items-center gap-1 text-xs text-slate-300"><span class="w-2 h-2 rounded-full bg-accent-green"></span>running</span>`;
  }
  if (j.running === false) {
    return `<span class="inline-flex items-center gap-1 text-xs text-status-blocked"><span class="w-2 h-2 rounded-full bg-status-blocked"></span>stopped</span>`;
  }
  return `<span class="inline-flex items-center gap-1 text-xs text-slate-400"><span class="w-2 h-2 rounded-full bg-slate-500"></span>idle/unknown</span>`;
}

function sourceLabel(source: JobSource): string {
  return source === "openclaw_cron" ? "openclaw cron" : "launchd";
}

function jobCard(j: ReadOnlyJob): string {
  const desc = j.description
    ? `<div class="mt-2 text-[13px] leading-6 text-slate-300 break-words">${escape(j.description)}</div>`
    : `<div class="mt-2 text-[13px] leading-6 text-slate-500">${pick("설명 없음", "No description")}</div>`;
  return `
    <article class="rounded-md border border-surface-3 bg-surface-2 px-3 py-3">
      <div class="flex flex-wrap items-start gap-2">
        ${jobBadge(j.kind)}
        <div class="min-w-0 flex-1">
          <div class="font-mono text-sm font-semibold text-slate-100 break-words" title="${escape(j.label)}">${escape(j.label)}</div>
          <div class="mt-1 text-xs text-slate-500 break-words">${escape(sourceLabel(j.source))}</div>
        </div>
        ${jobState(j)}
      </div>
      <div class="mt-2 rounded bg-surface-0/60 px-2 py-1 text-xs text-slate-400 break-words">
        <span class="text-slate-500">${pick("주기", "Interval")}</span> ${escape(j.detail)}
      </div>
      ${desc}
    </article>`;
}

function groupSection(g: JobGroup): string {
  return `
    <section class="border-t border-surface-3 first:border-t-0 py-4 first:pt-0 last:pb-0">
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 class="text-base font-semibold text-slate-100">${escape(g.title)}</h3>
          <p class="mt-0.5 text-[11px] text-slate-500">${escape(g.description)}</p>
        </div>
        <span class="text-xs text-slate-500">${g.jobs.length} jobs</span>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
        ${g.jobs.map(jobCard).join("")}
      </div>
    </section>`;
}

export function renderJobsView(root: HTMLElement): void {
  let jobs: ReadOnlyJob[] = [];
  let loaded = false;
  let loadError = false;

  async function loadJobs() {
    try {
      const res = await fetch(`${apiBase()}/api/teamos`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { scheduled: ReadOnlyJob[] };
      jobs = body.scheduled ?? [];
      loadError = false;
    } catch (e) {
      console.error("[loadJobs]", e);
      loadError = true;
    }
    loaded = true;
    render();
  }

  function bodyHtml(): string {
    if (!loaded) {
      return `<div class="flex-1 flex items-center justify-center text-slate-500 text-sm">${pick("job 목록을 불러오는 중...", "Loading jobs...")}</div>`;
    }
    if (loadError) {
      return `<div class="flex-1 flex flex-col items-center justify-center gap-2 text-slate-500 text-sm">
        <div>${pick("job 목록을 불러오지 못했습니다.", "Failed to load jobs.")}</div>
        <button data-refresh-jobs class="px-3 py-1 rounded bg-surface-3 hover:bg-surface-0 text-xs text-slate-200">${pick("다시 시도", "Retry")}</button>
      </div>`;
    }
    if (jobs.length === 0) {
      return `<div class="flex-1 flex items-center justify-center text-slate-500 text-sm">${pick("등록된 launchd/openclaw cron job이 없습니다.", "No launchd/openclaw cron jobs registered.")}</div>`;
    }
    const services = jobs.filter((j) => j.kind === "service").length;
    const scheduled = jobs.filter((j) => j.kind === "scheduled").length;
    const groups = groupJobs(jobs).map(groupSection).join("");
    return `
      <div class="flex-1 overflow-y-auto p-4">
        <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-lg font-semibold text-slate-100">${pick("운영 Jobs", "Operational Jobs")}</h2>
              <span class="rounded border border-accent-green/30 bg-accent-green/10 px-2 py-0.5 text-[11px] font-semibold text-accent-green">read-only</span>
            </div>
            <p class="mt-1 text-sm text-slate-500">${pick("/api/teamos scheduled snapshot을 종류별로 묶어 보여줍니다. 실행·중지·등록·삭제는 없습니다.", "Groups the /api/teamos scheduled snapshot by kind. No start, stop, register, or delete.")}</p>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs text-slate-500">${pick(`상시 ${services} · 예약 ${scheduled} · 전체 ${jobs.length}`, `Always-on ${services} · Scheduled ${scheduled} · All ${jobs.length}`)}</span>
            <button data-refresh-jobs class="rounded bg-surface-3 px-3 py-1.5 text-xs text-slate-200 hover:bg-surface-0">${pick("새로고침", "Refresh")}</button>
          </div>
        </div>
        <div class="space-y-1">${groups}</div>
      </div>`;
  }

  function render() {
    root.innerHTML = `
      <div class="flex-1 flex flex-col min-h-0">
        <div class="flex items-center justify-between px-4 py-2 border-b border-surface-3 shrink-0 bg-surface-1">
          <div class="text-sm font-semibold">${pick("Jobs · 운영 예약 작업", "Jobs · Operational scheduled jobs")}</div>
          <span class="text-[10px] text-slate-500">${loadError ? pick("오프라인", "Offline") : "read-only — /api/teamos"}</span>
        </div>
        ${bodyHtml()}
      </div>`;

    root.querySelectorAll<HTMLButtonElement>("[data-refresh-jobs]").forEach((b) =>
      b.addEventListener("click", () => void loadJobs()));
  }

  render();
  void loadJobs();
}

// TeamOS — operational surface of the team in one place: canonical docs,
// scheduled tasks / services (launchd + openclaw cron), scripts, and in-flight work.
// Read-only snapshot from /api/teamos (15s-cached server probe). Reached from the
// global top bar (⚙️ OS), not the per-agent tab strip.

import { store, type TeamOsSnapshot, type TeamOsScheduled, type TeamOsTask } from "../store";
import { apiBase } from "../ws";
import { pick } from "../i18n";

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function section(title: string, sub: string, inner: string): string {
  return `
    <div class="rounded-lg border border-surface-3 bg-surface-1 p-4">
      <div class="flex items-baseline justify-between mb-2">
        <div class="text-sm font-semibold text-slate-100">${title}</div>
        <div class="text-[10px] uppercase tracking-widest text-slate-500">${sub}</div>
      </div>
      ${inner}
    </div>`;
}

const CANONICAL_DOCS: { file: string; label: string; desc: string }[] = [
  { file: "rules/TEAM-OS.md", label: pick("TEAM-OS — 운영 규칙 + 현재 상태", "TEAM-OS — operating rules + current state"), desc: pick("팀 정체성·응답·그룹방 협업·owner 원칙(1~6·8장) + 팀원/경로/봇/서비스 현재값(7장 Current State).", "Team identity·response·group-room collaboration·owner rules (§1–6·8) + member/path/bot/service current values (§7 Current State).") },
  { file: "rules/SHARED.md", label: pick("SHARED — 팀 학습 로그", "SHARED — team learning log"), desc: pick("실제 작업에서 나온 교훈을 append-only로 기록. 흐름·큐레이션은 TEAM-OS 8장. (2026-06-01 단순화: 현재상태는 TEAM-OS 7장으로 이동)", "Records lessons from real work append-only. Flow·curation in TEAM-OS §8. (2026-06-01 simplification: current state moved to TEAM-OS §7)") },
  { file: "TEST_CASES.md", label: pick("TEST_CASES — 룰별 기대동작", "TEST_CASES — expected behavior per rule"), desc: pick("각 운영 룰을 '상황→기대동작→실패예시' 표로. 회귀 점검표.", "Each operating rule as a 'situation→expected behavior→failure example' table. Regression checklist.") },
];

function docsBlock(): string {
  const base = apiBase();
  const links = CANONICAL_DOCS.map(
    (d) =>
      `<a href="${base}/${d.file.startsWith("rules/") ? d.file : "docs/" + d.file}" target="_blank" rel="noopener" title="${escape(d.desc)}"
        class="block rounded-md border border-surface-3 bg-surface-2 px-3 py-2 hover:border-accent-green group">
        <div class="flex items-center gap-1 text-sm text-slate-100 group-hover:text-white"><span>📄</span>${escape(d.label)}</div>
        <div class="text-[12px] text-slate-400 mt-0.5">${escape(d.desc)}</div>
      </a>`,
  ).join("");
  return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">${links}</div>`;
}

const KIND_BADGE: Record<TeamOsScheduled["kind"], { label: string; color: string }> = {
  service: { label: pick("상시", "Always-on"), color: "#22c55e" },
  scheduled: { label: pick("예약", "Scheduled"), color: "#3b82f6" },
  "on-demand": { label: pick("온디맨드", "On-demand"), color: "#94a3b8" },
};

function scheduledRow(s: TeamOsScheduled): string {
  const badge = KIND_BADGE[s.kind];
  const runDot =
    s.running === null
      ? `<span class="w-2.5 h-2.5 rounded-full bg-slate-500" title="${pick("상태 미상 (cron 등 상시 프로세스 아님)", "Status unknown (not an always-on process like cron)")}"></span>`
      : s.running
        ? `<span class="w-2.5 h-2.5 rounded-full bg-accent-green" title="${pick("실행 중", "Running")}"></span>`
        : `<span class="w-2.5 h-2.5 rounded-full bg-status-blocked" title="${pick("멈춤", "Stopped")}"></span>`;
  const srcTag = s.source === "openclaw_cron" ? "openclaw" : s.source === "scheduled_job" ? "DB job" : "launchd";
  const off = s.enabled ? "" : `<span class="text-[11px] text-status-blocked">disabled</span>`;
  const desc = s.description
    ? `<div class="text-[12px] text-slate-400 mt-0.5 pl-[1.1rem]">${escape(s.description)}</div>`
    : "";
  return `
    <div class="py-1.5 border-b border-surface-3/50 last:border-0">
      <div class="flex items-center gap-2">
        ${runDot}
        <span class="inline-block rounded px-1.5 py-0.5 text-[11px] font-medium" style="background:${badge.color}28;color:${badge.color}">${badge.label}</span>
        <span class="text-sm text-slate-100 font-mono truncate flex-1 min-w-0" title="${escape(s.label)}">${escape(s.label)}</span>
        <span class="text-[11px] text-slate-400 whitespace-nowrap">${escape(s.detail)}</span>
        ${off}
        <span class="text-[10px] text-slate-500 w-14 text-right">${srcTag}</span>
      </div>
      ${desc}
    </div>`;
}

function taskRow(t: TeamOsTask): string {
  const dot =
    t.state === "in_progress"
      ? `<span class="text-status-idle font-bold">~</span>`
      : `<span class="text-slate-500">□</span>`;
  const cls = t.state === "in_progress" ? "text-slate-100" : "text-slate-300";
  return `<div class="flex gap-2 py-1 text-sm ${cls}"><span class="w-3 shrink-0 text-center">${dot}</span><span class="break-words">${escape(t.text)}</span></div>`;
}

function fmtAge(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0s";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

function ingressBlock(snap: TeamOsSnapshot): string {
  const h = snap.openclaw_telegram_ingress;
  if (!h) {
    return `
      <div class="rounded-md border border-surface-3 bg-surface-2 px-3 py-2 text-sm text-slate-400">
        ${pick("bot-liveness dry-run 뒤 표시됩니다.", "Shown after the bot-liveness dry-run.")}
      </div>`;
  }
  const level = h.detected ? "danger" : h.state === "stopped" || h.state === "disconnected" ? "warn" : "ok";
  const dot = level === "danger" ? "bg-status-blocked" : level === "warn" ? "bg-status-idle" : "bg-accent-green";
  const badge =
    level === "danger"
      ? `<span class="text-[10px] px-1.5 py-0.5 rounded font-semibold" style="background:#ef444422;color:#fca5a5">ingress stuck</span>`
      : level === "warn"
        ? `<span class="text-[10px] px-1.5 py-0.5 rounded font-semibold" style="background:#f59e0b22;color:#fbbf24">watch</span>`
        : `<span class="text-[10px] px-1.5 py-0.5 rounded font-semibold" style="background:#22c55e22;color:#86efac">ok</span>`;
  const auto = h.auto_recover_enabled
    ? `<span class="text-status-blocked font-semibold">ON</span>`
    : `<span class="text-slate-300">OFF</span>`;
  return `
    <div class="rounded-md border border-surface-3 bg-surface-2 px-3 py-2">
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-2.5 h-2.5 rounded-full ${dot}"></span>
        <span class="text-sm font-semibold text-slate-100">OpenClaw Telegram ingress</span>
        ${badge}
        <span class="text-[11px] text-slate-500 ml-auto">read-only</span>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2 text-[12px]">
        <div><div class="text-slate-500">state</div><div class="font-mono text-slate-100">${escape(h.state)}</div></div>
        <div><div class="text-slate-500">last inbound</div><div class="font-mono text-slate-100" title="${escape(h.last_inbound_at)}">${fmtAge(h.last_inbound_age_sec)}</div></div>
        <div><div class="text-slate-500">restart_count</div><div class="font-mono text-slate-100">${h.restart_count}</div></div>
        <div><div class="text-slate-500">backlog_latency</div><div class="font-mono text-slate-100">${fmtAge(h.backlog_latency_sec)}</div></div>
      </div>
      <div class="mt-2 text-[12px] text-slate-400 leading-relaxed">${escape(h.reason)}</div>
      <div class="mt-1 text-[11px] text-slate-500">
        account ${escape(h.account)} · bot ${escape(h.bot_username)} · stale ${fmtAge(h.stale_threshold_sec)} · cooldown ${fmtAge(h.cooldown_sec)} · auto gateway restart ${auto}
      </div>
    </div>`;
}

function renderInto(root: HTMLElement, snap: TeamOsSnapshot | null): void {
  if (!snap) {
    root.innerHTML = `<div class="flex-1 flex items-center justify-center text-slate-500">${pick("불러오는 중…", "Loading…")}</div>`;
    return;
  }
  const services = snap.scheduled.filter((s) => s.kind === "service");
  const scheduled = snap.scheduled.filter((s) => s.kind !== "service");
  const inProgress = snap.tasks.filter((t) => t.state === "in_progress");
  const pending = snap.tasks.filter((t) => t.state === "pending");

  // TEAM OP = the dedicated Telegram capture bot, NOT a team member.
  // ★상태는 capture 봇 실제 구성(토큰+그룹+라우터)으로 판정한다(Bill). 이전엔 `.team-collab` launchd 라벨
  //   존재로 판정했는데, launchd prefix(com.<user>)가 머신마다 달라 클린설치서 라벨을 못 찾아 늘 '상태 미상'
  //   으로 떨어졌다(GD 발견). snap.capture(=captureConfigStatus) 로 활성/부분구성/미설정을 정확히 표시.
  const cap = snap.capture;
  const capState: "active" | "partial" | "unset" =
    cap.has_capture_token && cap.capture_group_id && cap.router_enabled ? "active"
    : cap.has_capture_token ? "partial"
    : "unset";
  const infraBlock = `
    <div class="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <div class="flex items-center gap-2 mb-1">
        <span class="text-base">🛰️</span>
        <span class="text-sm font-semibold text-slate-100">TEAM OP</span>
        <span class="text-[10px] px-1.5 py-0.5 rounded font-semibold" style="background:#f59e0b22;color:#f59e0b">${pick("필수 인프라", "Required infra")}</span>
        ${capState === "active"
          ? `<span class="inline-flex items-center gap-1 text-[11px] text-slate-300"><span class="w-2 h-2 rounded-full bg-accent-green"></span>${pick("활성", "Active")}</span>`
          : capState === "partial"
          ? `<span class="inline-flex items-center gap-1 text-[11px] text-slate-300"><span class="w-2 h-2 rounded-full bg-amber-400"></span>${pick("설정 필요 (그룹/라우터)", "Setup needed (group/router)")}</span>`
          : `<span class="inline-flex items-center gap-1 text-[11px] text-slate-300"><span class="w-2 h-2 rounded-full bg-slate-500"></span>${pick("미설정", "Not configured")}</span>`}
      </div>
      <div class="text-[12px] text-slate-400 leading-relaxed">
        ${pick(
          "팀원(agent)이 <b>아닙니다</b> — 텔레그램 그룹 메시지를 수집해 버스에 적재하고 라우팅(팀원 깨우기)하는 전용 capture 봇입니다. team-collab 서버 내장(telegramCapture, CAPTURE_BOT_TOKEN). 이 봇을 그룹에서 빼거나 토큰을 폐기하면 그룹 메시지 자동 수집·라우팅이 끊깁니다.",
          "This is <b>not</b> a team member (agent) — it is a dedicated capture bot that collects Telegram group messages, loads them onto the bus, and routes them (waking members). Embedded in the team-collab server (telegramCapture, CAPTURE_BOT_TOKEN). Removing this bot from the group or revoking its token cuts off automatic group-message collection·routing.",
        )}
      </div>
    </div>`;

  root.innerHTML = `
    <div class="flex-1 overflow-y-auto p-4 space-y-4" id="teamos-scroll">
      ${section(pick("필수 인프라", "Required infra"), "required infra", infraBlock)}

      ${section("Health", "read-only", ingressBlock(snap))}

      ${section(pick("정본 문서", "Canonical docs"), "source of truth", docsBlock())}

      ${section(
        pick(`스케줄 · 서비스 (${snap.scheduled.length})`, `Schedules · services (${snap.scheduled.length})`),
        "launchd · openclaw cron",
        `<div class="flex flex-wrap items-center gap-3 mb-2.5 text-[11px] text-slate-300">
           <span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-accent-green"></span>${pick("실행 중", "Running")}</span>
           <span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-status-blocked"></span>${pick("멈춤", "Stopped")}</span>
           <span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-slate-500"></span>${pick("상태 미상(예약/cron 등 상시 아님)", "Status unknown (scheduled/cron, not always-on)")}</span>
         </div>
         <div class="text-[11px] text-slate-400 mb-1">${pick("상시 서비스 (KeepAlive)", "Always-on services (KeepAlive)")}</div>
         <div>${services.map(scheduledRow).join("") || `<div class="text-sm text-slate-400">${pick("없음", "None")}</div>`}</div>
         <div class="text-[11px] text-slate-400 mt-3 mb-1">${pick("예약 작업 (calendar/cron)", "Scheduled jobs (calendar/cron)")}</div>
         <div>${scheduled.map(scheduledRow).join("") || `<div class="text-sm text-slate-400">${pick("없음", "None")}</div>`}</div>`,
      )}

      ${section(
        pick(`스크립트 (${snap.scripts.length})`, `Scripts (${snap.scripts.length})`),
        "scripts/",
        snap.scripts.length
          ? `<div class="space-y-1">${snap.scripts
              .map(
                (s) =>
                  `<div class="flex gap-2 text-sm"><span class="font-mono text-slate-100 w-48 shrink-0 truncate">${escape(s.name)}</span><span class="text-slate-400 break-words">${escape(s.desc)}</span></div>`,
              )
              .join("")}</div>`
          : `<div class="text-sm text-slate-400">${pick("없음", "None")}</div>`,
      )}

      ${section(
        pick(`진행 중 작업 (${inProgress.length}) · 대기 ${snap.tasks_pending_total}`, `In-progress tasks (${inProgress.length}) · pending ${snap.tasks_pending_total}`),
        "TODO.md",
        `<div>${inProgress.map(taskRow).join("") || `<div class="text-sm text-slate-400">${pick("진행 중 표시(~) 없음", "No in-progress (~) items")}</div>`}</div>
         ${pending.length ? `<div class="text-[11px] text-slate-400 mt-2 mb-1">${pick("대기 (일부)", "Pending (partial)")}</div><div>${pending.map(taskRow).join("")}</div>` : ""}`,
      )}

      <div class="text-[11px] text-slate-500 text-right">${pick(`snapshot ${escape(snap.generated_at.slice(11, 19))} · 15s 캐시`, `snapshot ${escape(snap.generated_at.slice(11, 19))} · 15s cache`)}</div>
    </div>`;
}

export function renderTeamOs(root: HTMLElement): void {
  // Content signature: the 15s poll sets a new snapshot object each time (new ref). Re-render
  // only when something visible changed, and preserve scroll across the rebuild — otherwise
  // the view jumped to top every 15s (same scroll-jump symptom as the doc viewer had).
  let lastSig: string | null = null;
  const sig = (s: TeamOsSnapshot | null): string => {
    if (!s) return "";
    const sched = s.scheduled.map((x) => `${x.label}:${x.running}:${x.enabled}`).join(",");
    const tasks = s.tasks.map((t) => t.state + t.text).join(",");
    const ingress = s.openclaw_telegram_ingress
      ? `${s.openclaw_telegram_ingress.state}:${s.openclaw_telegram_ingress.last_inbound_at}:${s.openclaw_telegram_ingress.restart_count}:${s.openclaw_telegram_ingress.detected}`
      : "";
    return `${sched}|${tasks}|${s.scripts.length}|${s.tasks_pending_total}|${ingress}`;
  };
  const sync = () => {
    const cur = store.getState().teamOs;
    const s = sig(cur);
    if (s === lastSig) return;
    lastSig = s;
    const prev = root.querySelector<HTMLElement>("#teamos-scroll");
    const prevScroll = prev ? prev.scrollTop : 0;
    renderInto(root, cur);
    const next = root.querySelector<HTMLElement>("#teamos-scroll");
    if (next) next.scrollTop = prevScroll;
  };
  sync();
  store.subscribe(sync);
}

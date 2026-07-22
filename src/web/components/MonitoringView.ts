// MonitoringView — 모니터링 탭 (OWNER 2026-07-10, Bill 핸드오프). read-only.
//   ① 봇 liveness 모니터 상태  ② DM 저장(dm_message) health. 데이터: GET /api/monitoring(서버 30초 캐시).
import { apiBase } from "../ws";
import { pick } from "../i18n";

interface LivenessStatus {
  available: boolean;
  runs: number;
  lastRun: string | null; // 로그 timestamp(로컬/KST 그대로)
  healthy: boolean | null;
  lastResult: string | null;
  logMtime: string | null;
}
interface DmHealth {
  total: number;
  members: number;
  last1h: number;
  last24h: number;
  newest: string | null; // UTC
  stale: boolean;
  perMember: Array<{ memberId: string; count: number; newest: string }>;
}
interface HermesRuntimeHealth {
  total: number;
  online: number;
  blocked: number;
  offline: number;
  pending: number;
  newestProbe: string | null;
  newestActivity: string | null;
  members: Array<{
    id: string;
    displayName: string;
    state: string;
    pending: number;
    lastActivityAt: string | null;
    probedAt: string | null;
    lastLogLine: string | null;
  }>;
}
interface IngressStatus {
  available: boolean;
  generated_at: string | null;
  account: string;
  bot_username: string;
  state: string;
  last_inbound_at: string | null;
  last_inbound_age_sec: number;
  restart_count: number;
  backlog_latency_sec: number;
  stale_threshold_sec: number;
  detected: boolean;
  reason: string;
  status_mtime: string | null;
  files: { stateFiles: number; pendingFiles: number; checkedDirs: string[] };
  traffic: {
    inbound24h: number;
    outbound24h: number;
    inboundPending: number;
    outboundPending: number;
    newestInbound: string | null;
    newestOutbound: string | null;
  };
  audit: { stuck24h: number; stuck7d: number; newestStuck: string | null };
}
interface MonitoringData {
  liveness: LivenessStatus;
  dmHealth: DmHealth;
  hermes?: HermesRuntimeHealth;
  ingress: IngressStatus;
  hopMetrics: HopMetrics;
  generatedAt: string;
  cached?: boolean;
}

interface HopMemberStat { memberId: string; avg: number; min: number; max: number; count: number; }
interface HopMetrics { window24h: HopMemberStat[]; window7d: HopMemberStat[]; }

const GREEN = "rgb(34 197 94)";
const RED = "rgb(239 68 68)";
const GRAY = "rgb(148 163 184)";
const AMBER = "rgb(251 191 36)";
const EMPTY_HERMES: HermesRuntimeHealth = {
  total: 0,
  online: 0,
  blocked: 0,
  offline: 0,
  pending: 0,
  newestProbe: null,
  newestActivity: null,
  members: [],
};

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// UTC 문자열/ISO → KST 표기. (로그 lastRun 은 이미 로컬이라 이 함수 안 씀)
function kst(v: string | null): string {
  if (!v) return "—";
  const iso = v.includes("T") ? v : v.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escape(v);
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d) + " KST";
}

function dot(color: string): string {
  return `<span class="inline-block w-2.5 h-2.5 rounded-full align-middle shrink-0" style="background:${color}"></span>`;
}

function fmtAge(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

function livenessPanel(l: LivenessStatus): string {
  if (!l.available) {
    return `<div class="text-sm text-slate-400">${pick("liveness 로그 없음 — 모니터 미실행이거나 로그 경로 확인 필요.", "No liveness log — monitor not run yet, or check the log path.")}</div>`;
  }
  const color = l.healthy === true ? GREEN : l.healthy === false ? RED : GRAY;
  const statusText = l.healthy === true ? pick("정상", "Healthy") : l.healthy === false ? pick("이상", "Issue") : pick("판정불가", "Unknown");
  return `
    <div class="flex items-center gap-2 mb-2">${dot(color)}<span class="text-sm font-semibold text-slate-100">${statusText}</span></div>
    <div class="text-sm text-slate-200">${escape(l.lastResult ?? "—")}</div>
    <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-slate-400">
      <div>${pick("총 실행", "Runs")}: <span class="text-slate-100 font-medium">${l.runs.toLocaleString()}</span></div>
      <div>${pick("마지막 실행", "Last run")}: <span class="text-slate-100 font-medium">${escape(l.lastRun ?? "—")}</span></div>
    </div>`;
}

function dmPanel(d: DmHealth): string {
  const staleWarn = d.stale ? ` <span class="text-xs" style="color:${AMBER}">${pick("· 최신 30분+ 전(조용한 시간이거나 점검)", "· newest 30min+ ago")}</span>` : "";
  const rows = d.perMember.map((m) => `
    <tr class="border-t border-slate-800/60">
      <td class="py-1 pr-3 text-slate-100">${escape(m.memberId)}</td>
      <td class="py-1 pr-3 text-right text-slate-200">${m.count.toLocaleString()}</td>
      <td class="py-1 text-slate-400 text-xs">${kst(m.newest)}</td>
    </tr>`).join("");
  return `
    <div class="flex items-center gap-2 mb-2">${dot(d.total > 0 ? GREEN : GRAY)}<span class="text-sm font-semibold text-slate-100">${d.total.toLocaleString()}${pick("행 캡처", " rows")}</span>${staleWarn}</div>
    <div class="grid grid-cols-3 gap-x-4 gap-y-1 text-xs text-slate-400 mb-3">
      <div>${pick("멤버", "Members")}: <span class="text-slate-100 font-medium">${d.members}</span></div>
      <div>${pick("최근 1h", "Last 1h")}: <span class="text-slate-100 font-medium">+${d.last1h}</span></div>
      <div>${pick("24h", "24h")}: <span class="text-slate-100 font-medium">${d.last24h}</span></div>
    </div>
    <div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-xs text-slate-500 text-left">
      <th class="pb-1 font-medium">${pick("멤버", "Member")}</th><th class="pb-1 font-medium text-right">${pick("행", "Rows")}</th><th class="pb-1 font-medium">${pick("최신", "Newest")}</th>
    </tr></thead><tbody>${rows || `<tr><td colspan="3" class="py-2 text-slate-500">${pick("아직 캡처된 DM 없음", "No DMs captured yet")}</td></tr>`}</tbody></table></div>`;
}

function runtimePanel(h: HermesRuntimeHealth, i: IngressStatus): string {
  const hasIssue = h.offline > 0 || h.blocked > 0;
  const hermesColor = h.total === 0 ? GRAY : hasIssue ? AMBER : GREEN;
  const hermesStatus = h.total === 0
    ? pick("Hermes 없음", "No Hermes agents")
    : hasIssue
      ? pick("확인 필요", "Needs attention")
      : pick("정상", "Healthy");
  const openClawColor = i.detected ? RED : i.state === "stopped" || i.state === "disconnected" ? AMBER : i.available ? GREEN : GRAY;
  const openClawStatus = i.detected ? pick("수신 멈춤", "Intake stuck") : i.available ? i.state : pick("상태 없음", "No status");
  return `
    <div class="text-sm text-slate-300 leading-relaxed mb-3">${pick("OpenClaw 수신 경로와 Hermes 실행 런타임이 살아있는지만 간단히 봅니다.", "Quick check for OpenClaw intake and Hermes runtime health.")}</div>
    <div class="grid gap-2">
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-x-4 gap-y-1.5 rounded-md border border-slate-800/70 px-3 py-2 text-xs text-slate-400">
        <div class="col-span-2 lg:col-span-1 flex items-center gap-2 text-sm font-semibold text-slate-100">${dot(openClawColor)}OpenClaw</div>
        <div>${pick("상태", "State")}: <span class="text-slate-100 font-medium">${escape(openClawStatus)}</span></div>
        <div>${pick("마지막 수신", "Last in")}: <span class="text-slate-100 font-medium">${fmtAge(i.last_inbound_age_sec)} ${pick("전", "ago")}</span></div>
        <div>${pick("처리 대기", "Actionable")}: <span class="text-slate-100 font-medium">${i.traffic.inboundPending.toLocaleString()}</span></div>
        <div>${pick("장애 24h", "Stuck 24h")}: <span class="text-slate-100 font-medium">${i.audit.stuck24h.toLocaleString()}</span></div>
      </div>
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-x-4 gap-y-1.5 rounded-md border border-slate-800/70 px-3 py-2 text-xs text-slate-400">
        <div class="col-span-2 lg:col-span-1 flex items-center gap-2 text-sm font-semibold text-slate-100">${dot(hermesColor)}Hermes</div>
        <div>${pick("상태", "State")}: <span class="text-slate-100 font-medium">${escape(hermesStatus)}</span></div>
        <div>${pick("온라인", "Online")}: <span class="text-slate-100 font-medium">${h.online.toLocaleString()} / ${h.total.toLocaleString()}</span></div>
        <div>${pick("처리 대기", "Actionable")}: <span class="text-slate-100 font-medium">${h.pending.toLocaleString()}</span></div>
        <div>${pick("최근 점검", "Last probe")}: <span class="text-slate-100 font-medium">${kst(h.newestProbe)}</span></div>
      </div>
    </div>
    <div class="mt-2 text-[11px] text-slate-500">${pick("처리 대기 = 아직 open 상태인 수신 작업만 집계", "Actionable = only open recipient work")}</div>`;
}

// 낮을수록 효율(1홉=좋음), 높으면 루프 의심 → 평균 홉에 색 힌트
function hopColor(avg: number): string {
  if (avg <= 2) return GREEN;
  if (avg <= 4) return AMBER;
  return RED;
}

function hopPanel(h: HopMetrics): string {
  const rows = (stats: HopMemberStat[]): string =>
    stats.map((s) => `
      <tr class="border-t border-slate-800/60">
        <td class="py-1 pr-3 text-slate-100">${escape(s.memberId)}</td>
        <td class="py-1 pr-3 text-right font-semibold" style="color:${hopColor(s.avg)}">${s.avg}</td>
        <td class="py-1 pr-3 text-right text-slate-400">${s.min}</td>
        <td class="py-1 pr-3 text-right text-slate-400">${s.max}</td>
        <td class="py-1 text-right text-slate-500">${s.count.toLocaleString()}</td>
      </tr>`).join("");
  const table = (stats: HopMemberStat[], label: string): string => `
    <div class="mb-1 text-xs text-slate-500">${label}</div>
    <div class="overflow-x-auto mb-3"><table class="w-full text-sm"><thead><tr class="text-xs text-slate-500 text-left">
      <th class="pb-1 pr-3 font-medium">${pick("멤버", "Member")}</th>
      <th class="pb-1 pr-3 font-medium text-right">${pick("평균", "Avg")}</th>
      <th class="pb-1 pr-3 font-medium text-right">Min</th>
      <th class="pb-1 pr-3 font-medium text-right">Max</th>
      <th class="pb-1 font-medium text-right">${pick("건수", "Msgs")}</th>
    </tr></thead><tbody>${rows(stats) || `<tr><td colspan="5" class="py-2 text-slate-500">${pick("데이터 없음", "No data")}</td></tr>`}</tbody></table></div>`;
  return `
    <div class="text-xs text-slate-400 mb-2">${pick("팀원끼리 버스 왕복 홉 — 낮을수록 효율(1홉=이상적), 높으면 루프 의심", "Bus back-and-forth hops per member — lower is better (1 = ideal)")}</div>
    ${table(h.window24h, pick("최근 24시간", "Last 24h"))}
    ${table(h.window7d, pick("최근 7일", "Last 7d"))}`;
}

function card(title: string, body: string): string {
  return `<section class="rounded-lg border border-slate-800 bg-surface-2/40 p-4">
    <h3 class="text-sm font-semibold text-slate-100 mb-3">${title}</h3>${body}</section>`;
}

export function renderMonitoringView(root: HTMLElement): void {
  root.innerHTML = `<div class="p-4 text-sm text-slate-400">${pick("모니터링 불러오는 중…", "Loading monitoring…")}</div>`;
  const load = async (): Promise<void> => {
    try {
      const res = await fetch(`${apiBase()}/api/monitoring`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as MonitoringData;
      root.innerHTML = `
        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <div class="flex items-baseline justify-between gap-2 flex-wrap">
            <h2 class="text-base font-semibold text-slate-100">${pick("모니터링", "Monitoring")}</h2>
            <span class="text-xs text-slate-500">${pick("갱신", "Updated")} ${kst(d.generatedAt)}${d.cached ? " · cache" : ""}</span>
          </div>
          <div class="grid gap-4 xl:grid-cols-2">
            ${card(pick("봇 Liveness 모니터", "Bot liveness monitor"), livenessPanel(d.liveness))}
            ${card(pick("DM 저장 상태", "DM capture health"), dmPanel(d.dmHealth))}
            <div class="xl:col-span-2">${card(pick("런타임 상태", "Runtime status"), runtimePanel(d.hermes ?? EMPTY_HERMES, d.ingress))}</div>
            <div class="xl:col-span-2">${card(pick("멤버별 홉 (1턴1홉 계측)", "Hops per member (1-turn-1-hop)"), hopPanel(d.hopMetrics))}</div>
          </div>
        </div>`;
    } catch (e) {
      root.innerHTML = `<div class="p-4 text-sm" style="color:${RED}">${pick("모니터링 로드 실패", "Failed to load monitoring")}: ${escape(String((e as Error).message))}</div>`;
    }
  };
  void load();
}

import { store, type AlertEvent } from "../store";
import { getTeamName } from "./Settings";
import { renderIcon } from "../icons";
import { apiBase } from "../ws";
import { getLocale, setLocale, pick } from "../i18n";
import { parseSqliteDate } from "../lib/datetime";

// 나브 버튼 아이콘 + 라벨 (이모지 대체 — 심플 SVG 통일).
function navIcon(name: string, label: string): string {
  return `<span class="inline-flex items-center gap-1.5">${renderIcon(name, { size: 14 })}${label}</span>`;
}

function isMacClient(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || "";
  return /mac/i.test(platform) || /Macintosh|Mac OS X/i.test(navigator.userAgent);
}

let alertsOpen = false;
let tasksMenuOpen = false;
let inboxMenuOpen = false;
let docMenuOpen = false;
// hover-open 닫힘 유예 타이머 — re-render를 가로질러 유지되도록 모듈 스코프(R6.1 핫픽스).
let navCloseTimer: ReturnType<typeof setTimeout> | null = null;

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// pick()을 지연 평가(호출 시점)로 — 모듈 로드 시엔 locale이 아직 부팅 fetch 전이라 ko로 고정된다.
function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    slack_relay_failed: pick("Slack 릴레이 실패", "Slack relay failed"),
    slack_post_failed: pick("Slack 포스트 실패", "Slack post failed"),
    openclaw_inject_failed: pick("OpenClaw 주입 실패", "OpenClaw inject failed"),
    tmux_inject_failed: pick("tmux 주입 실패", "tmux inject failed"),
    hop_limit_exceeded: pick("hop limit 초과", "hop limit exceeded"),
    slack_relay_skipped_no_creds: pick("Slack creds 없어서 스킵", "Skipped: no Slack creds"),
    messages_expired: pick("메시지 만료", "Messages expired"),
  };
  return labels[action] ?? action;
}

function alertItemHtml(a: AlertEvent): string {
  const d = parseSqliteDate(a.at);
  const t = d ? hhmm(d) : "—";
  const label = actionLabel(a.action);
  const target = a.target ? ` · ${escape(a.target)}` : "";
  return `
    <div class="px-3 py-2 border-b border-surface-3 last:border-0 hover:bg-surface-3">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-xs font-semibold text-status-blocked">${escape(label)}</span>
        <span class="text-[10px] text-slate-500 font-mono">${t}</span>
      </div>
      <div class="text-[10px] text-slate-400 mt-0.5">${escape(a.actor)}${target}</div>
    </div>
  `;
}

function navBtnClass(active: boolean): string {
  return `px-2 py-1 rounded-md text-[11px] md:text-[13px] ${active ? "bg-surface-0 text-slate-100" : "text-slate-400 hover:bg-surface-3 hover:text-slate-200"}`;
}

function navMenuItem(id: string, label: string, active: boolean): string {
  return `
    <button id="${id}"
      class="w-full px-3 py-2 text-left text-xs ${active ? "bg-surface-0 text-slate-100" : "text-slate-400 hover:bg-surface-3 hover:text-slate-200"}">
      ${label}
    </button>`;
}


function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function renderMetricsBar(root: HTMLElement): void {
  const update = () => {
    // update()는 root.innerHTML을 통째로 교체하므로, 모바일 가로스크롤 메뉴바의 scrollLeft가 0으로
    // 리셋된다(GD 2026-06-24 '메뉴 클릭하면 좌로 튀네' — 오른쪽으로 스크롤해 누르면 맨 왼쪽으로 점프).
    // 교체 전 scrollLeft를 캡처해 교체 직후 복원한다(칸반 data-scroll-keep과 같은 패턴).
    const prevScrollLeft = root.querySelector<HTMLElement>(".metric-bar")?.scrollLeft ?? 0;
    const { connected, metric, agents, alerts } = store.getState();
    const cpu = metric?.cpu_percent != null ? `${metric.cpu_percent.toFixed(0)}%` : "—";
    const mem = metric?.mem_used_mb != null ? `${(metric.mem_used_mb / 1024).toFixed(0)}G` : "—";
    const load = metric?.load_1min != null ? metric.load_1min.toFixed(1) : "—";
    const ollama = metric?.ollama_running ? "●" : "○";
    const dotStyle = connected
      ? "background:#22C55E;box-shadow:0 0 6px rgba(34,197,94,.5)"
      : "background:#EF4444";

    // Claude Max 사용통계(호출수·토큰) 표시는 노이즈라 제거(GD 2026-07-01). maxGauge 자리표시자만 유지(항상 빈값).
    const maxGauge = "";

    const alertCount = alerts.length;
    const alertBadge = alertCount
      ? `<button id="alerts-toggle" class="relative px-2 py-1 rounded-md bg-surface-3 hover:bg-surface-0 text-[11px] md:text-[13px] text-slate-200 whitespace-nowrap" title="${pick(`최근 6시간 알림 ${alertCount}건`, `Recent 6h alerts: ${alertCount}`)}">
           ⚠ <span class="text-status-blocked font-semibold">${alertCount}</span>
         </button>`
      : `<button id="alerts-toggle" class="px-2 py-1 rounded-md text-[11px] md:text-[13px] text-slate-500 hover:bg-surface-3 whitespace-nowrap" title="${pick("알림 없음 (최근 6시간)", "No alerts (recent 6h)")}">
           ⚠ <span>0</span>
         </button>`;
    const macAppDownload = isMacClient()
      ? `<a id="b3os-app-download"
            href="${apiBase()}/b3os.app.zip"
            download="b3os.app.zip"
            class="hidden md:inline-flex items-center gap-1 text-[10px] md:text-[11px] font-medium text-slate-500 hover:text-accent-greenSoft whitespace-nowrap"
            title="${pick("b3os.app 다운로드 — 현재 로컬 b3os를 Mac 앱으로 열기", "Download b3os.app — open this local b3os in a Mac app")}">
            ${renderIcon("download", { size: 11, className: "shrink-0 opacity-70" })}<span>b3os.app</span>
         </a>`
      : "";

    const dropdown =
      alertsOpen
        ? `<div id="alerts-dropdown" class="absolute right-3 top-12 md:top-14 z-50 w-80 max-h-96 overflow-y-auto bg-surface-2 border border-surface-3 rounded-md shadow-xl">
             <div class="px-3 py-2 border-b border-surface-3 flex items-center justify-between">
               <span class="text-xs font-semibold uppercase tracking-widest text-slate-400">${pick("최근 알림 (6h)", "Recent alerts (6h)")}</span>
               <span class="text-[10px] text-slate-500">${alertCount}${pick("건", "")}</span>
             </div>
             ${alertCount === 0
               ? `<div class="px-3 py-6 text-xs text-slate-500 text-center">${pick("알림 없음 ✓", "No alerts ✓")}</div>`
               : alerts.map(alertItemHtml).join("")}
           </div>`
        : "";

    // Mobile: minimal (GD + agent count + CPU + Ollama + alerts). Desktop: + RAM + Load.
    root.innerHTML = `
      <div class="relative">
        <!-- ★바에 overflow-hidden 을 걸면 안 된다★ — Tasks/Inbox/Doc 드롭다운이 absolute 로 바 아래에
             펼쳐지므로 통째로 잘린다 (GD 2026-07-14 실사용 발견). 넘침 클립은 ★우측 지표 클러스터에서만★ 한다. -->
        <div class="metric-bar h-12 md:h-14 px-3 md:px-4 flex items-center justify-between bg-surface-2 border-b border-surface-3 shrink-0 gap-2">
          <div class="flex items-center gap-2 shrink-0">
            <span class="relative inline-flex shrink-0 text-accent-greenSoft" title="${pick("b3os — b3rys 팀 운영 OS", "b3os — b3rys team ops OS")}">${renderIcon("b3rys", { size: 19 })}<span style="${dotStyle};box-shadow:0 0 0 2px rgb(var(--surface-2))" class="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full"></span></span>
            <span data-team-brand title="${pick("홈 — Tasks 칸반으로", "Home — to the Tasks kanban")}" class="font-semibold text-sm md:text-base text-slate-100 cursor-pointer hover:text-accent-greenSoft transition-colors">${escape(getTeamName() || "b3rys")}</span>
            <span class="hidden sm:inline-flex items-center rounded px-1 py-px text-[9px] md:text-[10px] font-semibold uppercase tracking-[0.12em]" style="color:rgb(var(--accent)/.9);background:rgb(var(--accent)/.10);box-shadow:inset 0 0 0 1px rgb(var(--accent)/.25)" title="${pick("b3rys 팀 운영 OS", "b3rys team ops OS")}">b3os</span>
            <span class="text-slate-500 text-[10px] md:text-xs whitespace-nowrap">${agents.length} agents</span>
            <div class="relative ml-1" data-navmenu="tasks">
              <button id="global-tasks-menu"
                class="${navBtnClass(store.getState().mainView === "tasks" || store.getState().mainView === "jobs")}"
                title="${pick("Tasks — 전체 과제와 운영 Jobs", "Tasks — all tasks and operational Jobs")}">
                Tasks ▾
              </button>
              ${tasksMenuOpen ? `<div id="tasks-menu-dropdown" class="absolute left-0 top-full z-50 w-40 overflow-hidden rounded-md border border-surface-3 bg-surface-2 shadow-xl">
                ${navMenuItem("global-tasks-tab", pick("전체 과제", "All Tasks"), store.getState().mainView === "tasks")}
                ${navMenuItem("global-jobs-tab", "Jobs", store.getState().mainView === "jobs")}
              </div>` : ""}
            </div>
            <div class="relative" data-navmenu="inbox">
              <button id="global-inbox-menu"
                class="${navBtnClass(store.getState().mainView === "inbox" || store.getState().mainView === "audit" || store.getState().mainView === "proposals")}"
                title="${pick("Inbox — 메시지 처리상태, Audit, Proposal", "Inbox — message status, Audit, Proposal")}">
                Inbox ▾
              </button>
              ${inboxMenuOpen ? `<div id="inbox-menu-dropdown" class="absolute left-0 top-full z-50 w-44 overflow-hidden rounded-md border border-surface-3 bg-surface-2 shadow-xl">
                ${navMenuItem("global-inbox-tab", "Inbox", store.getState().mainView === "inbox")}
                ${navMenuItem("global-audit-tab", "Audit", store.getState().mainView === "audit")}
                ${navMenuItem("global-proposals-tab", "Proposal", store.getState().mainView === "proposals")}
              </div>` : ""}
            </div>
            <button id="global-bus-tab"
              class="px-2 py-1 rounded-md text-[11px] md:text-[13px] ${store.getState().mainView === "busflow" ? "bg-surface-0 text-slate-100" : "text-slate-400 hover:bg-surface-3 hover:text-slate-200"}"
              title="${pick("팀 버스 실시간 흐름", "Team bus real-time flow")}">
              ${navIcon("activity", "Bus")}
            </button>
            <button id="global-teamos-tab"
              class="px-2 py-1 rounded-md text-[11px] md:text-[13px] ${store.getState().mainView === "teamos" ? "bg-surface-0 text-slate-100" : "text-slate-400 hover:bg-surface-3 hover:text-slate-200"}"
              title="${pick("팀 OS — 스크립트·스케줄·정본 문서", "Team OS — scripts, schedules, canonical docs")}">
              ${navIcon("terminal", "OS")}
            </button>
            <button id="global-topology-tab"
              class="px-2 py-1 rounded-md text-[11px] md:text-[13px] ${store.getState().mainView === "topology" ? "bg-surface-0 text-slate-100" : "text-slate-400 hover:bg-surface-3 hover:text-slate-200"}"
              title="${pick("버스 토폴로지 — 팀원별 pending·전송중·stuck", "Bus topology — per-member pending·sending·stuck")}">
              ${navIcon("share-2", "Topo")}
            </button>
            <div class="relative" data-navmenu="doc">
              <button id="global-doc-menu"
                class="${navBtnClass(store.getState().mainView === "doc" || store.getState().mainView === "reports")}"
                title="${pick("Doc — 팀 운영 문서와 Reports", "Doc — team ops docs and Reports")}">
                Doc ▾
              </button>
              ${docMenuOpen ? `<div id="doc-menu-dropdown" class="absolute left-0 top-full z-50 w-40 overflow-hidden rounded-md border border-surface-3 bg-surface-2 shadow-xl">
                ${navMenuItem("global-doc-tab", "Doc", store.getState().mainView === "doc")}
                ${navMenuItem("global-reports-tab", "Reports", store.getState().mainView === "reports")}
              </div>` : ""}
            </div>
            <button id="global-search-tab"
              class="px-2 py-1 rounded-md text-[11px] md:text-[13px] inline-flex items-center gap-1 ${store.getState().mainView === "search" ? "bg-surface-0 text-slate-100" : "text-slate-400 hover:bg-surface-3 hover:text-slate-200"}"
              title="${pick("팀 기록 검색 (개발중 — 벡터검색은 진화 중, 현재 텍스트검색)", "Search team records (in development — vector search evolving, lexical for now)")}">
              ${navIcon("search", "Search")}<span class="ml-0.5 text-amber-400 shrink-0" title="${pick("개발중 (실험적 기능)", "In development (experimental)")}">${renderIcon("flask-triangle", { size: 13 })}</span>
            </button>
            <button id="global-settings-tab"
              class="px-2 py-1 rounded-md text-[11px] md:text-[13px] ${store.getState().mainView === "settings" ? "bg-surface-0 text-slate-100" : "text-slate-400 hover:bg-surface-3 hover:text-slate-200"}"
              title="${pick("팀 설정 — 팀명·미션·팀원", "Team settings — team name·mission·members")}">
              ${navIcon("settings", "Settings")}
            </button>
          </div>
          <div class="flex items-center justify-end gap-2 md:gap-3 text-[10px] md:text-[11px] min-w-0 shrink overflow-hidden">
            <span class="hidden lg:inline-flex items-center gap-1 font-mono tabular-nums text-slate-500 whitespace-nowrap" title="${pick("실시간 CPU 사용률", "Live CPU usage")}">
              <span class="h-1 w-1 rounded-full bg-accent-greenSoft/70 animate-pulse"></span>
              <span>CPU</span><span class="text-slate-300">${cpu}</span>
            </span>
            <span class="hidden xl:inline-flex items-center gap-1 font-mono tabular-nums text-slate-500 whitespace-nowrap" title="${pick("실시간 메모리 사용량", "Live memory usage")}">
              <span class="h-1 w-1 rounded-full bg-accent-greenSoft/70 animate-pulse"></span>
              <span>MEM</span><span class="text-slate-300">${mem}</span>
            </span>
            <span class="hidden 2xl:inline text-slate-400 whitespace-nowrap">Load <span class="text-slate-200">${load}</span></span>
            <span class="hidden lg:inline text-slate-400 whitespace-nowrap">Ollama <span class="text-slate-200">${ollama}</span></span>
            ${maxGauge}
            ${macAppDownload}
            ${alertBadge}
            <button id="global-monitoring-tab"
              class="inline-flex h-7 w-7 items-center justify-center rounded-md ${store.getState().mainView === "monitoring" ? "bg-surface-0 text-slate-100" : "text-slate-400 hover:bg-surface-3 hover:text-slate-200"} shrink-0"
              title="${pick("Monitoring — 봇 상태·DM저장·ingress health", "Monitoring — bot liveness·DM storage·ingress health")}"
              aria-label="${pick("모니터링", "Monitoring")}">
              ${renderIcon("monitor", { size: 15 })}
            </button>
            <button id="locale-flag" class="px-1.5 py-0.5 rounded-md text-[11px] md:text-[12px] font-semibold tracking-wide leading-none hover:bg-surface-3 shrink-0" title="${getLocale() === "en" ? "Language: EN → KO (click)" : "언어: KO → EN (클릭)"}"><span class="${getLocale() === "ko" ? "text-accent-greenSoft" : "text-slate-500"}">KO</span><span class="text-slate-600">/</span><span class="${getLocale() === "en" ? "text-accent-greenSoft" : "text-slate-500"}">EN</span></button>
          </div>
        </div>
        <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px" style="background:linear-gradient(90deg, rgb(var(--accent)/.6), rgb(var(--accent)/.15) 28%, transparent 55%)"></div>
        ${dropdown}
      </div>
    `;

    // 교체 직후(페인트 전) 가로스크롤 위치 복원 — 메뉴 클릭 시 좌로 튀는 것 방지.
    if (prevScrollLeft) {
      const mb = root.querySelector<HTMLElement>(".metric-bar");
      if (mb) mb.scrollLeft = prevScrollLeft;
    }

    const toggle = root.querySelector<HTMLButtonElement>("#alerts-toggle");
    toggle?.addEventListener("click", (e) => {
      e.stopPropagation();
      alertsOpen = !alertsOpen;
      tasksMenuOpen = false;
      inboxMenuOpen = false;
      docMenuOpen = false;
      update();
    });
    // b3os.app zip 다운로드: 맥앱(WKWebView)에선 download 링크가 webview 네비게이션이 되어 화면이 갇힘
    // → 시스템 브라우저(Safari)로 넘겨 받게 한다(GD 2026-07-02, reports 다운로드와 동일 패턴).
    // 일반 브라우저는 bridge 없음 → 기본 download 동작.
    const b3osDl = root.querySelector<HTMLAnchorElement>("#b3os-app-download");
    b3osDl?.addEventListener("click", (e) => {
      const bridge = (window as unknown as {
        webkit?: { messageHandlers?: { bridge?: { postMessage: (b: unknown) => void } } };
      }).webkit?.messageHandlers?.bridge;
      if (!bridge) return;
      bridge.postMessage({ command: "shell.openExternal", payload: { url: b3osDl.href } });
      e.preventDefault();
    });
    // 언어 깃발 토글(우상단 구석) — ko↔en 전환 + 즉시 반영. persist 후 reload로 전 컴포넌트 재렌더(GD 2026-07-01).
    const localeFlag = root.querySelector<HTMLButtonElement>("#locale-flag");
    localeFlag?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const next = getLocale() === "en" ? "ko" : "en";
      setLocale(next);
      try {
        await fetch(`${apiBase()}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: next }) });
      } catch { /* best-effort persist */ }
      location.reload();
    });
    const tasksMenuBtn = root.querySelector<HTMLButtonElement>("#global-tasks-menu");
    tasksMenuBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      tasksMenuOpen = !tasksMenuOpen;
      inboxMenuOpen = false;
      docMenuOpen = false;
      alertsOpen = false;
      update();
    });
    const inboxMenuBtn = root.querySelector<HTMLButtonElement>("#global-inbox-menu");
    inboxMenuBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      inboxMenuOpen = !inboxMenuOpen;
      tasksMenuOpen = false;
      docMenuOpen = false;
      alertsOpen = false;
      update();
    });
    const docMenuBtn = root.querySelector<HTMLButtonElement>("#global-doc-menu");
    docMenuBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      docMenuOpen = !docMenuOpen;
      tasksMenuOpen = false;
      inboxMenuOpen = false;
      alertsOpen = false;
      update();
    });
    // 네비 드롭다운 hover-open (GD R6) — 마우스 오버 시 펼침, 벗어나면 닫힘. 상태가 실제로 바뀔 때만
    // update()해 무한 re-render 방지. 모바일(hover 없음)은 위 click 토글이 폴백.
    const flags = { tasks: () => tasksMenuOpen, inbox: () => inboxMenuOpen, doc: () => docMenuOpen };
    const setOnly = (key: "tasks" | "inbox" | "doc" | null) => {
      tasksMenuOpen = key === "tasks";
      inboxMenuOpen = key === "inbox";
      docMenuOpen = key === "doc";
    };
    const cancelClose = () => {
      if (navCloseTimer) { clearTimeout(navCloseTimer); navCloseTimer = null; }
    };
    root.querySelectorAll<HTMLElement>("[data-navmenu]").forEach((wrap) => {
      const key = wrap.dataset.navmenu as "tasks" | "inbox" | "doc";
      // mouseenter — 진입(버튼이든 드롭다운이든 wrapper descendant)하면 닫힘 예약을 취소하고 연다.
      // 이미 열려 있으면 타이머만 끄고 재렌더 안 함(루프 방지).
      wrap.addEventListener("mouseenter", () => {
        cancelClose();
        if (flags[key]()) return;
        setOnly(key);
        alertsOpen = false;
        update();
      });
      // mouseleave — 즉시 닫지 않고 grace delay(140ms). 버튼↔드롭다운 사이 갭을 지나는 잠깐 동안
      // mouseleave가 튀어도, 드롭다운에 재진입하면 mouseenter의 cancelClose가 닫힘을 취소한다.
      wrap.addEventListener("mouseleave", () => {
        if (!flags[key]()) return;
        cancelClose();
        navCloseTimer = setTimeout(() => {
          navCloseTimer = null;
          if (flags[key]()) { setOnly(null); update(); }
        }, 140);
      });
    });
    const inboxBtn = root.querySelector<HTMLButtonElement>("#global-inbox-tab");
    inboxBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      inboxMenuOpen = false;
      docMenuOpen = false;
      store.getState().setMainView("inbox");
      store.getState().setMobilePane("main");
    });
    const auditBtn = root.querySelector<HTMLButtonElement>("#global-audit-tab");
    auditBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      inboxMenuOpen = false;
      docMenuOpen = false;
      store.getState().setMainView("audit");
      store.getState().setMobilePane("main");
    });
    const proposalsBtn = root.querySelector<HTMLButtonElement>("#global-proposals-tab");
    proposalsBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      inboxMenuOpen = false;
      docMenuOpen = false;
      store.getState().setMainView("proposals");
      store.getState().setMobilePane("main");
    });
    const tasksBtn = root.querySelector<HTMLButtonElement>("#global-tasks-tab");
    tasksBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      tasksMenuOpen = false;
      docMenuOpen = false;
      store.getState().setMainView("tasks");
      store.getState().setMobilePane("main");
    });
    // 팀이름(브랜드) 클릭 = 홈 = Tasks 칸반 기본 표시 (GD 2026-06-21 R4).
    root.querySelector<HTMLElement>("[data-team-brand]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      tasksMenuOpen = false;
      docMenuOpen = false;
      store.getState().setMainView("tasks");
      store.getState().setMobilePane("main");
    });
    const jobsBtn = root.querySelector<HTMLButtonElement>("#global-jobs-tab");
    jobsBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      tasksMenuOpen = false;
      docMenuOpen = false;
      store.getState().setMainView("jobs");
      store.getState().setMobilePane("main");
    });
    const monitoringBtn = root.querySelector<HTMLButtonElement>("#global-monitoring-tab");
    monitoringBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      tasksMenuOpen = false;
      docMenuOpen = false;
      store.getState().setMainView("monitoring");
      store.getState().setMobilePane("main");
    });
    const docBtn = root.querySelector<HTMLButtonElement>("#global-doc-tab");
    docBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      docMenuOpen = false;
      store.getState().setMainView("doc");
      store.getState().setMobilePane("main");
    });
    const busBtn = root.querySelector<HTMLButtonElement>("#global-bus-tab");
    busBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      docMenuOpen = false;
      store.getState().setMainView("busflow");
      store.getState().setMobilePane("main");
    });
    const teamosBtn = root.querySelector<HTMLButtonElement>("#global-teamos-tab");
    teamosBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      docMenuOpen = false;
      store.getState().setMainView("teamos");
      store.getState().setMobilePane("main");
    });
    const topoBtn = root.querySelector<HTMLButtonElement>("#global-topology-tab");
    topoBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      docMenuOpen = false;
      store.getState().setMainView("topology");
      store.getState().setMobilePane("main");
    });
    const searchBtn = root.querySelector<HTMLButtonElement>("#global-search-tab");
    searchBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      docMenuOpen = false;
      store.getState().setMainView("search");
      store.getState().setMobilePane("main");
    });
    const reportsBtn = root.querySelector<HTMLButtonElement>("#global-reports-tab");
    reportsBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      docMenuOpen = false;
      store.getState().setMainView("reports");
      store.getState().setMobilePane("main");
    });
    const settingsBtn = root.querySelector<HTMLButtonElement>("#global-settings-tab");
    settingsBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      docMenuOpen = false;
      store.getState().setMainView("settings");
      store.getState().setMobilePane("main");
    });
  };
  update();
  store.subscribe(update);

  // Close dropdown when clicking outside.
  document.addEventListener("click", (e) => {
    const dd = root.querySelector("#alerts-dropdown");
    const tg = root.querySelector("#alerts-toggle");
    if (alertsOpen && dd && !dd.contains(e.target as Node) && tg && !tg.contains(e.target as Node)) {
      alertsOpen = false;
      // re-render via store touch
      store.getState().setAlerts([...store.getState().alerts]);
    }
    const tasksDd = root.querySelector("#tasks-menu-dropdown");
    const tasksBtn = root.querySelector("#global-tasks-menu");
    const inboxDd = root.querySelector("#inbox-menu-dropdown");
    const inboxBtn = root.querySelector("#global-inbox-menu");
    const docDd = root.querySelector("#doc-menu-dropdown");
    const docBtn = root.querySelector("#global-doc-menu");
    let changed = false;
    if (tasksMenuOpen && tasksDd && !tasksDd.contains(e.target as Node) && tasksBtn && !tasksBtn.contains(e.target as Node)) {
      tasksMenuOpen = false;
      changed = true;
    }
    if (inboxMenuOpen && inboxDd && !inboxDd.contains(e.target as Node) && inboxBtn && !inboxBtn.contains(e.target as Node)) {
      inboxMenuOpen = false;
      changed = true;
    }
    if (docMenuOpen && docDd && !docDd.contains(e.target as Node) && docBtn && !docBtn.contains(e.target as Node)) {
      docMenuOpen = false;
      changed = true;
    }
    if (changed) update();
  });
}

import "./styles.css";
import { connectWs, loadInitialLog, loadInitialMetric, loadThreads, loadAllAgentStats, loadAlerts, loadClaudeUsage, loadBusFlow, loadTeamOs, loadBusMembers } from "./ws";
import { store, type DocSection, type MainView } from "./store";
import { renderMetricsBar } from "./components/MetricsBar";
import { renderAgentSidebar } from "./components/AgentCard";
import { renderTmuxPane } from "./components/TmuxPane";
import { renderThreadList } from "./components/ThreadList";
import { renderAgentActivity } from "./components/AgentActivity";
import { renderAgentConfig } from "./components/AgentConfig";
import { renderAgentSetup } from "./components/AgentSetup";
import { renderBusFlow } from "./components/BusFlow";
import { renderTeamOs } from "./components/TeamOS";
import { renderTopology } from "./components/TopologyView";
import { renderTasksKanban } from "./components/TasksKanban";
import { renderJobsView } from "./components/JobsView";
import { renderTeamSearch } from "./components/TeamSearch";
import { renderReports } from "./components/Reports";
import { renderInboxView } from "./components/InboxView";
import { renderAuditView } from "./components/AuditView";
import { renderProposalsView } from "./components/ProposalsView";
import { renderMonitoringView } from "./components/MonitoringView";
import { renderSettings, initTeamTitle, refreshSettingsSlack, refreshSettingsMembers } from "./components/Settings";
import { pick } from "./i18n";
import { renderChat } from "./components/Chat";
import { renderHealthBanner } from "./components/HealthBanner";
import { renderMobileTabBar } from "./components/MobileTabBar";
import { renderOnboarding } from "./components/Onboarding";
import { renderUpdateCheck } from "./components/UpdateCheck";
import { renderLiveBadge } from "./components/LiveBadge";
import { renderIcon } from "./icons";

const VIEW_GROUPS: Array<{ views: MainView[]; tabs: Array<{ id: MainView; label: string }> }> = [
  { views: ["tasks", "jobs"], tabs: [{ id: "tasks", label: "Tasks" }, { id: "jobs", label: "Jobs" }] },
  { views: ["inbox", "audit", "proposals"], tabs: [{ id: "inbox", label: "Inbox" }, { id: "audit", label: "Audit" }, { id: "proposals", label: "Proposal" }] },
  { views: ["doc", "reports"], tabs: [{ id: "doc", label: "Doc" }, { id: "reports", label: "Reports" }] },
];
const VALID_MAIN_VIEWS: MainView[] = ["tasks", "jobs", "monitoring", "busflow", "teamos", "topology", "search", "reports", "doc", "settings", "inbox", "audit", "proposals", "log", "thread", "config", "chat"];
const VIEW_STORAGE_KEY = "bill-dash-main-view";

function isMainView(v: string | null): v is MainView {
  return !!v && VALID_MAIN_VIEWS.includes(v as MainView);
}

function groupedViewTabs(mainView: MainView): Array<{ id: MainView; label: string }> | null {
  return VIEW_GROUPS.find((g) => g.views.includes(mainView))?.tabs ?? null;
}

function viewTabClass(active: boolean): string {
  return `px-3 py-1.5 text-xs font-semibold rounded-t-md transition-colors whitespace-nowrap shrink-0 ${active ? "bg-surface-2 text-slate-100 border-b-2 border-accent-green" : "text-slate-500 hover:text-slate-200 hover:bg-surface-2/70"}`;
}

function bootstrap() {
  const app = document.getElementById("app")!;
  // deep-link: /team?view=reports (top-level /reports redirect 등) → 해당 탭으로 부팅 (OWNER 2026-06-07)
  const _bootParams = new URLSearchParams(location.search);
  const _bootView = _bootParams.get("view");
  const _savedView = localStorage.getItem(VIEW_STORAGE_KEY);
  if (isMainView(_bootView)) {
    store.getState().setMainView(_bootView as MainView);
  } else if (isMainView(_savedView)) {
    store.getState().setMainView(_savedView);
  }
  const _bootDoc = _bootParams.get("doc");
  if (_bootDoc && ["policy", "architecture", "routing", "learning", "qa", "search"].includes(_bootDoc)) {
    store.getState().setDocSection(_bootDoc as DocSection);
  }
  let lastPersistedView = store.getState().mainView;
  localStorage.setItem(VIEW_STORAGE_KEY, lastPersistedView);
  app.innerHTML = `
    <div id="metrics-bar"></div>
    <div id="health-banner"></div>
    <div class="flex-1 flex min-h-0 overflow-hidden bg-surface-2 gap-1 px-3 pb-3 pt-1.5">
      <div id="agent-sidebar-wrap" class="flex md:contents"></div>
      <div class="resize-handle" data-resize="sidebar" title="드래그하여 너비 조절"></div>
      <div id="main-panel-wrap" class="flex-1 flex flex-col min-h-0 min-w-0 float-panel overflow-hidden">
        <div id="main-tabs" class="min-h-[2.25rem] border-b border-surface-3 shrink-0 flex flex-nowrap items-center px-2 gap-1 overflow-x-auto md:h-9"></div>
        <div id="main-content" class="flex-1 flex flex-col min-h-0"></div>
      </div>
      <div class="resize-handle" data-resize="thread" title="드래그하여 너비 조절"></div>
      <div id="activity-panel-wrap" class="flex md:contents"></div>
    </div>
    <button id="thread-panel-toggle" class="thread-panel-toggle" type="button" title="THREADS 패널 접기/펼치기" aria-label="THREADS 패널 접기/펼치기"></button>
    <div id="mobile-tabs"></div>
  `;

  // Sidebar
  const sidebarWrap = document.getElementById("agent-sidebar-wrap")!;
  const sidebar = document.createElement("div");
  sidebar.id = "agent-sidebar";
  sidebar.className = "w-full md:w-sidebar shrink-0 float-panel overflow-y-auto";
  sidebarWrap.appendChild(sidebar);
  renderAgentSidebar(sidebar);

  // Activity (thread list)
  const activityWrap = document.getElementById("activity-panel-wrap")!;
  const activity = document.createElement("div");
  activity.className = "w-full md:w-activity shrink-0 float-panel flex flex-col overflow-hidden";
  activity.innerHTML = `
    <div class="px-4 pt-4 pb-2">
      <div class="text-xs font-semibold uppercase tracking-widest text-slate-500">THREADS</div>
    </div>
    <div id="thread-list" class="flex-1 overflow-y-auto px-2 pb-3"></div>
  `;
  activityWrap.appendChild(activity);
  renderThreadList(document.getElementById("thread-list")!);

  renderMetricsBar(document.getElementById("metrics-bar")!);
  renderHealthBanner(document.getElementById("health-banner")!);
  renderTabs(document.getElementById("main-tabs")!);
  renderMainContent(document.getElementById("main-content")!);
  renderMobileTabBar(document.getElementById("mobile-tabs")!);
  renderOnboarding(app);
  renderUpdateCheck(app);
  renderLiveBadge(app);
  setupResizers();
  setupThreadPanelToggle();

  // Drive responsive layout via body data-attribute (CSS handles the rest).
  const syncBodyPane = () => {
    document.body.dataset.mobilePane = store.getState().mobilePane;
  };
  syncBodyPane();
  store.subscribe(syncBodyPane);

  store.subscribe((s) => {
    if (s.mainView === lastPersistedView) return;
    lastPersistedView = s.mainView;
    localStorage.setItem(VIEW_STORAGE_KEY, s.mainView);
    const url = new URL(location.href);
    url.searchParams.set("view", s.mainView);
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  });

  void loadInitialMetric();
  void loadThreads();
  void initTeamTitle();   // 팀명을 대시보드(브라우저) 타이틀에 반영

  let initialLogLoaded = false;
  store.subscribe(() => {
    const s = store.getState();
    if (!initialLogLoaded && s.selectedAgentId && s.agents.length > 0) {
      initialLogLoaded = true;
      void loadInitialLog(s.selectedAgentId);
    }
  });

  connectWs();

  // Global-view polling: only while the relevant view is open, stopped on leave.
  // Bus flow — new messages arrive via the 'message' WS event, but delivery-state
  // transitions (pending→dispatching→completed…) are the dispatcher's own DB writes,
  // so we poll the snapshot every 3s. Team OS — launchd/cron status is 15s-cached
  // server-side, so a 15s client poll is plenty. Both are read-only, no bus impact.
  let viewPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastPollView: MainView | null = null;
  const syncViewPoll = () => {
    const view = store.getState().mainView;
    const pollView = view === "busflow" || view === "teamos" || view === "jobs" || view === "topology" || view === "inbox" ? view : null;
    if (pollView === lastPollView) return;
    lastPollView = pollView;
    if (viewPollTimer) {
      clearInterval(viewPollTimer);
      viewPollTimer = null;
    }
    if (pollView === "busflow" || pollView === "inbox") {
      // Inbox renders the same /bus/flow data, focused on recipient_state (SLG B).
      void loadBusFlow();
      viewPollTimer = setInterval(() => void loadBusFlow(), 3000);
    } else if (pollView === "teamos" || pollView === "jobs") {
      void loadTeamOs();
      viewPollTimer = setInterval(() => void loadTeamOs(), 15000);
    } else if (pollView === "topology") {
      void loadBusMembers();
      viewPollTimer = setInterval(() => void loadBusMembers(), 3000);
    }
  };
  syncViewPoll();
  store.subscribe(syncViewPoll);

  // Periodic refresh: stats every 60s, alerts every 30s.
  // ws "hello" does the initial load; these intervals catch slow-changing aggregates
  // (e.g. 7d windows rolling over) and surface new alerts on idle dashboards.
  setInterval(() => {
    void loadAllAgentStats();
  }, 60_000);
  setInterval(() => {
    void loadAlerts();
  }, 30_000);
  setInterval(() => {
    void loadClaudeUsage();
  }, 60_000);
}

function renderTabs(root: HTMLElement) {
  const update = () => {
    const { mainView, selectedAgentId, agents } = store.getState();
    const agentName = agents.find((a) => a.id === selectedAgentId)?.display_name ?? "—";
    const groupTabs = groupedViewTabs(mainView);
    const groupTabsHtml = groupTabs?.map((t) => `
      <button data-main-tab="${t.id}"
        class="${viewTabClass(mainView === t.id)}">
        ${t.label}
      </button>
    `).join("") ?? "";

    // Global views (bus flow, team OS) replace the per-agent tab strip with a title.
    // They are entered from the top MetricsBar and exited by selecting an agent.
    if (groupTabs) {
      root.innerHTML = groupTabsHtml;
      root.querySelectorAll<HTMLButtonElement>("[data-main-tab]").forEach((btn) => {
        btn.addEventListener("click", () => {
          store.getState().setMainView(btn.dataset.mainTab as MainView);
          store.getState().setMobilePane("main");
        });
      });
      return;
    }
    if (mainView === "busflow" || mainView === "teamos" || mainView === "topology" || mainView === "search" || mainView === "settings" || mainView === "monitoring") {
      const label = mainView === "busflow" ? pick("Team Bus · 실시간 흐름", "Team Bus · Live flow")
        : mainView === "teamos" ? "Team OS"
        : mainView === "topology" ? pick("버스 토폴로지", "Bus topology")
        : mainView === "search" ? pick("Team Search · 팀 기록 검색", "Team Search · Records")
        : mainView === "monitoring" ? pick("Monitoring · 운영 상태", "Monitoring · Operations health")
        : mainView === "settings" ? pick("Settings · 팀 설정", "Settings · Team settings")
        : pick("Team Tasks · 전체 과제", "Team Tasks · All tasks");
      root.innerHTML = `<div class="px-3 py-1.5 text-xs font-semibold text-slate-200 whitespace-nowrap">${label}</div>`;
      return;
    }
    // Live (tmux pane) first; Thread is the per-agent message activity feed.
    root.innerHTML = `
      <button data-tab="log"
        class="${viewTabClass(mainView === "log")}">
        Live · ${agentName}
      </button>
      <button data-tab="thread"
        class="${viewTabClass(mainView === "thread")}">
        Thread · ${agentName}
      </button>
      <button data-tab="chat"
        class="${viewTabClass(mainView === "chat")}">
        <span class="inline-flex items-center gap-1.5">${renderIcon("message-square", { size: 14, className: "shrink-0" })}1:1</span>
      </button>
      <button data-tab="config"
        class="${viewTabClass(mainView === "config")}">
        Settings · ${agentName}
      </button>
    `;
    root.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.tab as MainView;
        store.getState().setMainView(v);
      });
    });
  };
  update();
  store.subscribe(update);
}

function renderMainContent(root: HTMLElement) {
  let logEl: HTMLDivElement | null = null;
  let activityEl: HTMLDivElement | null = null;
  let configEl: HTMLDivElement | null = null;
  let chatEl: HTMLDivElement | null = null;
  let docEl: HTMLDivElement | null = null;
  let busEl: HTMLDivElement | null = null;
  let teamosEl: HTMLDivElement | null = null;
  let topoEl: HTMLDivElement | null = null;
  let tasksEl: HTMLDivElement | null = null;
  let jobsEl: HTMLDivElement | null = null;
  let monitoringEl: HTMLDivElement | null = null;
  let searchEl: HTMLDivElement | null = null;
  let reportsEl: HTMLDivElement | null = null;
  let settingsEl: HTMLDivElement | null = null;
  let inboxEl: HTMLDivElement | null = null;
  let auditEl: HTMLDivElement | null = null;
  let proposalsEl: HTMLDivElement | null = null;
  let logRendered = false;
  let activityRendered = false;
  let configRendered = false;
  let chatRendered = false;
  let docRendered = false;
  let busRendered = false;
  let teamosRendered = false;
  let topoRendered = false;
  let tasksRendered = false;
  let jobsRendered = false;
  let monitoringRendered = false;
  let searchRendered = false;
  let reportsRendered = false;
  let settingsRendered = false;
  let inboxRendered = false;
  let auditRendered = false;
  let proposalsRendered = false;

  let prevMainView: MainView | null = null; // 뷰 전환 감지용 — settings 재진입 때만 새로고침(매 store update마다 X)
  const update = () => {
    const { mainView } = store.getState();
    const enteredSettings = mainView === "settings" && prevMainView !== "settings"; // 다른 뷰→settings 전환 순간만 true
    prevMainView = mainView;
    if (!logEl) {
      logEl = document.createElement("div");
      logEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(logEl);
    }
    if (!activityEl) {
      activityEl = document.createElement("div");
      activityEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(activityEl);
    }
    if (!configEl) {
      configEl = document.createElement("div");
      configEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(configEl);
    }
    if (!chatEl) {
      chatEl = document.createElement("div");
      chatEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(chatEl);
    }
    if (!docEl) {
      docEl = document.createElement("div");
      docEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(docEl);
    }
    if (!busEl) {
      busEl = document.createElement("div");
      busEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(busEl);
    }
    if (!teamosEl) {
      teamosEl = document.createElement("div");
      teamosEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(teamosEl);
    }
    if (!topoEl) {
      topoEl = document.createElement("div");
      topoEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(topoEl);
    }
    if (!tasksEl) {
      tasksEl = document.createElement("div");
      tasksEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(tasksEl);
    }
    if (!jobsEl) {
      jobsEl = document.createElement("div");
      jobsEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(jobsEl);
    }
    if (!monitoringEl) {
      monitoringEl = document.createElement("div");
      monitoringEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(monitoringEl);
    }
    if (!searchEl) {
      searchEl = document.createElement("div");
      searchEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(searchEl);
    }
    if (!reportsEl) {
      reportsEl = document.createElement("div");
      reportsEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(reportsEl);
    }
    if (!settingsEl) {
      settingsEl = document.createElement("div");
      settingsEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(settingsEl);
    }
    if (!inboxEl) {
      inboxEl = document.createElement("div");
      inboxEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(inboxEl);
    }
    if (!auditEl) {
      auditEl = document.createElement("div");
      auditEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(auditEl);
    }
    if (!proposalsEl) {
      proposalsEl = document.createElement("div");
      proposalsEl.className = "flex-1 flex flex-col min-h-0";
      root.appendChild(proposalsEl);
    }
    logEl.style.display = mainView === "log" ? "flex" : "none";
    activityEl.style.display = mainView === "thread" ? "flex" : "none";
    configEl.style.display = mainView === "config" ? "flex" : "none";
    chatEl.style.display = mainView === "chat" ? "flex" : "none";
    docEl.style.display = mainView === "doc" ? "flex" : "none";
    busEl.style.display = mainView === "busflow" ? "flex" : "none";
    teamosEl.style.display = mainView === "teamos" ? "flex" : "none";
    topoEl.style.display = mainView === "topology" ? "flex" : "none";
    tasksEl.style.display = mainView === "tasks" ? "flex" : "none";
    jobsEl.style.display = mainView === "jobs" ? "flex" : "none";
    monitoringEl.style.display = mainView === "monitoring" ? "flex" : "none";
    searchEl.style.display = mainView === "search" ? "flex" : "none";
    reportsEl.style.display = mainView === "reports" ? "flex" : "none";
    settingsEl.style.display = mainView === "settings" ? "flex" : "none";
    inboxEl.style.display = mainView === "inbox" ? "flex" : "none";
    auditEl.style.display = mainView === "audit" ? "flex" : "none";
    proposalsEl.style.display = mainView === "proposals" ? "flex" : "none";
    if (mainView === "log" && !logRendered) {
      renderTmuxPane(logEl);
      logRendered = true;
    } else if (mainView === "thread" && !activityRendered) {
      renderAgentActivity(activityEl);
      activityRendered = true;
    } else if (mainView === "config" && !configRendered) {
      renderAgentConfig(configEl);
      configRendered = true;
    } else if (mainView === "chat" && !chatRendered) {
      renderChat(chatEl);
      chatRendered = true;
    } else if (mainView === "doc" && !docRendered) {
      renderAgentSetup(docEl);
      docRendered = true;
    } else if (mainView === "busflow" && !busRendered) {
      renderBusFlow(busEl);
      busRendered = true;
    } else if (mainView === "teamos" && !teamosRendered) {
      renderTeamOs(teamosEl);
      teamosRendered = true;
    } else if (mainView === "topology" && !topoRendered) {
      renderTopology(topoEl);
      topoRendered = true;
    } else if (mainView === "tasks" && !tasksRendered) {
      renderTasksKanban(tasksEl);
      tasksRendered = true;
    } else if (mainView === "jobs" && !jobsRendered) {
      renderJobsView(jobsEl);
      jobsRendered = true;
    } else if (mainView === "monitoring" && !monitoringRendered) {
      renderMonitoringView(monitoringEl);
      monitoringRendered = true;
    } else if (mainView === "search" && !searchRendered) {
      renderTeamSearch(searchEl);
      searchRendered = true;
    } else if (mainView === "reports" && !reportsRendered) {
      renderReports(reportsEl);
      reportsRendered = true;
    } else if (mainView === "settings") {
      if (!settingsRendered) { renderSettings(settingsEl); settingsRendered = true; }
      else if (enteredSettings) { void refreshSettingsSlack(); void refreshSettingsMembers(); } // 재진입(전환) 순간만 재조회 — 팀원 로스터도(퇴사/영입 후 stale 방지) · 매 update마다 X(스크롤 jank 방지)
    } else if (mainView === "inbox" && !inboxRendered) {
      renderInboxView(inboxEl);
      inboxRendered = true;
    } else if (mainView === "audit" && !auditRendered) {
      renderAuditView(auditEl);
      auditRendered = true;
    } else if (mainView === "proposals" && !proposalsRendered) {
      renderProposalsView(proposalsEl);
      proposalsRendered = true;
    }
  };
  update();
  store.subscribe(update);
}

// Draggable column widths (desktop only). The handles set CSS vars --sidebar-w / --thread-w,
// which styles.css consumes ONLY inside the md+ media query — so mobile's single-pane layout is
// untouched. Widths persist in localStorage. (OWNER 2026-05-31)
function setupResizers() {
  const root = document.documentElement;
  const LS = { sidebar: "bill-dash-sidebar-w", thread: "bill-dash-thread-w" } as const;
  const DEF = { sidebar: 280, thread: 300 } as const;
  const CLAMP = { sidebar: [180, 480], thread: [220, 560] } as const;
  const apply = (key: "sidebar" | "thread", px: number): number => {
    const [min, max] = CLAMP[key];
    const w = Math.max(min, Math.min(max, Math.round(px)));
    root.style.setProperty(key === "sidebar" ? "--sidebar-w" : "--thread-w", `${w}px`);
    return w;
  };
  (["sidebar", "thread"] as const).forEach((k) => {
    const saved = Number(localStorage.getItem(LS[k]));
    apply(k, Number.isFinite(saved) && saved > 0 ? saved : DEF[k]);
  });

  document.querySelectorAll<HTMLElement>(".resize-handle").forEach((handle) => {
    const key = handle.dataset.resize as "sidebar" | "thread";
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const row = handle.parentElement!.getBoundingClientRect();
      handle.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      const widthAt = (clientX: number) => (key === "sidebar" ? clientX - row.left : row.right - clientX);
      const onMove = (ev: MouseEvent) => apply(key, widthAt(ev.clientX));
      const onUp = (ev: MouseEvent) => {
        const w = apply(key, widthAt(ev.clientX));
        localStorage.setItem(LS[key], String(w));
        handle.classList.remove("dragging");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });
}

function setupThreadPanelToggle() {
  const btn = document.getElementById("thread-panel-toggle") as HTMLButtonElement | null;
  if (!btn) return;
  const key = "bill-dash-thread-collapsed";
  const apply = (collapsed: boolean) => {
    document.body.classList.toggle("thread-panel-collapsed", collapsed);
    btn.innerHTML = renderIcon(collapsed ? "panel-right-open" : "panel-right-close", { size: 18 });
    btn.title = collapsed ? "THREADS 패널 펼치기" : "THREADS 패널 접기";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", collapsed ? "true" : "false");
  };
  apply(localStorage.getItem(key) === "1");
  btn.addEventListener("click", () => {
    const collapsed = !document.body.classList.contains("thread-panel-collapsed");
    localStorage.setItem(key, collapsed ? "1" : "0");
    apply(collapsed);
  });
}

bootstrap();

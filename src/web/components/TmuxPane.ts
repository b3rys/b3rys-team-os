import { store } from "../store";
import { agentIconName, renderIcon } from "../icons";
import { renderAgentIcon } from "../agentColors";
import { pick } from "../i18n";

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderTmuxPane(root: HTMLElement): void {
  let lastRenderedAgentId: string | null = null;
  let lastLineCount = 0;
  let pauseAutoScroll = false;

  const render = () => {
    const { selectedAgentId, agents, logsByAgent, statuses } = store.getState();
    const agent = agents.find((a) => a.id === selectedAgentId) ?? null;
    if (!agent) {
      root.innerHTML = `
        <div class="flex-1 flex items-center justify-center text-slate-500">
          ${pick("좌측에서 agent 선택", "Select an agent on the left")}
        </div>`;
      return;
    }
    const status = statuses.get(agent.id);
    const lines = logsByAgent.get(agent.id) ?? [];
    const targetLabel =
      agent.status_provider === "claude_tmux"
        ? `tmux:${agent.tmux_session}`
        : agent.status_provider === "hermes_gateway"
          ? `hermes:${agent.hermes_profile ?? agent.id}`
          : `openclaw:${agent.workspace_path.split("/").pop()}`;

    if (lastRenderedAgentId !== agent.id) {
      root.innerHTML = `
        <div class="flex-1 flex flex-col min-h-0">
          <div class="h-10 flex items-center justify-between gap-2 px-4 border-b border-surface-3 shrink-0 bg-surface-1">
            <div class="text-sm font-semibold flex items-center gap-2 min-w-0">
              <span class="shrink-0">${renderAgentIcon(agentIconName(agent.id), agent.icon_color, 16)}</span>
              <span class="shrink-0">${agent.display_name}</span>
              <span class="text-slate-400 font-normal truncate min-w-0">· ${agent.role}</span>
            </div>
            <div class="text-xs text-slate-500 flex items-center gap-3 shrink-0">
              <span class="hidden md:inline">${targetLabel}</span>
              <span class="hidden sm:inline">state: <span class="text-slate-300">${status?.state ?? "—"}</span></span>
              <button data-pause title="${pick("새 로그가 와도 화면을 따라 내리지 않게 고정합니다 (tmux 동기화는 계속됨)", "Keeps the view fixed so it won't follow new logs as they arrive (tmux sync continues)")}" class="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-surface-3 hover:bg-surface-3 shrink-0 whitespace-nowrap ${pauseAutoScroll ? "text-accent-greenSoft border-accent-green/40" : "text-slate-300"}">${renderIcon(pauseAutoScroll ? "play" : "pause", { size: 12 })}<span class="hidden sm:inline">${pauseAutoScroll ? pick("자동스크롤 재개", "Resume auto-scroll") : pick("자동스크롤 정지", "Stop auto-scroll")}</span></button>
            </div>
          </div>
          <div class="flex-1 overflow-y-auto bg-surface-0 font-mono text-sm leading-normal text-slate-200 p-4" id="tmux-log-body"></div>
        </div>`;
      lastRenderedAgentId = agent.id;
      lastLineCount = 0;
      // pause 토글은 전체 재렌더하지 않는다 — 예전엔 lastRenderedAgentId=null로 innerHTML을 통째로
      // 다시 그려 로그 본문 scrollTop이 0으로 튀었다(OWNER R4). 이제 버튼 라벨만 제자리 갱신하고
      // 스크롤 위치는 그대로 둔다. 정지=현 위치 고정, 재개=맨 아래로 따라붙기 시작.
      const pauseBtn = root.querySelector<HTMLButtonElement>("[data-pause]");
      pauseBtn?.addEventListener("click", () => {
        pauseAutoScroll = !pauseAutoScroll;
        if (pauseBtn) {
          pauseBtn.innerHTML = `${renderIcon(pauseAutoScroll ? "play" : "pause", { size: 12 })}<span class="hidden sm:inline">${pauseAutoScroll ? pick("자동스크롤 재개", "Resume auto-scroll") : pick("자동스크롤 정지", "Stop auto-scroll")}</span>`;
          pauseBtn.className = `inline-flex items-center gap-1 px-2 py-0.5 rounded border border-surface-3 hover:bg-surface-3 shrink-0 whitespace-nowrap ${pauseAutoScroll ? "text-accent-greenSoft border-accent-green/40" : "text-slate-300"}`;
        }
        if (!pauseAutoScroll) {
          const b = root.querySelector<HTMLElement>("#tmux-log-body");
          if (b) b.scrollTop = b.scrollHeight; // 재개 시 즉시 맨 아래로
        }
      });
    }

    const body = root.querySelector<HTMLElement>("#tmux-log-body");
    if (!body) return;

    if (lines.length === 0) {
      const hint =
        agent.status_provider === "claude_tmux"
          ? pick("tmux 세션 확인", "Check the tmux session")
          : agent.status_provider === "hermes_gateway"
            ? pick("Hermes gateway 상태는 Settings/status에서 확인", "Check Hermes gateway status in Settings/status")
            : pick("OpenClaw runtime — Phase 1 에선 로그 캡처 X", "OpenClaw runtime — no log capture in Phase 1");
      body.innerHTML = `<div class="text-slate-500">${pick("로그 없음", "No logs")} — ${hint}</div>`;
      lastLineCount = 0;
      return;
    }

    if (lastLineCount === 0) {
      body.innerHTML = lines.map((l) => `<div class="whitespace-pre-wrap">${escape(l.line)}</div>`).join("");
      lastLineCount = lines.length;
    } else if (lines.length > lastLineCount) {
      const newOnes = lines.slice(lastLineCount);
      const html = newOnes
        .map((l) => `<div class="whitespace-pre-wrap tmux-line">${escape(l.line)}</div>`)
        .join("");
      body.insertAdjacentHTML("beforeend", html);
      lastLineCount = lines.length;
    } else if (lines.length < lastLineCount) {
      // log was trimmed (rolling buffer); re-render
      body.innerHTML = lines.map((l) => `<div class="whitespace-pre-wrap">${escape(l.line)}</div>`).join("");
      lastLineCount = lines.length;
    }

    if (!pauseAutoScroll) {
      body.scrollTop = body.scrollHeight;
    }
  };

  render();
  store.subscribe(render);
}

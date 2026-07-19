// HealthBanner — first-screen one-line health signal (busviz UX #1).
// Answers OWNER's "지금 문제 있나?" in 0.5s: shows ONLY what needs attention, nothing else.
// Global data only (no new fetch): store.statuses (offline), store.agentHealth (danger/warn),
// store.alerts (recent failures, already 6h-filtered by the loader). When nothing is wrong it
// collapses to a slim green "✓ 전원 정상". Bill places it (MetricsBar 아래 · main 위) in main.ts;
// this file only exports the renderer and never touches store/layout.

import { store, type AgentHealth } from "../store";
import { pick } from "../i18n";

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const nameOf = (id: string): string =>
  store.getState().agents.find((a) => a.id === id)?.display_name ?? id;

// Short reason for a member chip — prefer a high context-window % (the usual danger), else the
// first reason string the health prober gave.
function healthReason(h: AgentHealth): string {
  const text = h.reasons.join(" ");
  if (/Claude|monthly spend limit|session limit|사용량 한도/i.test(text)) return pick("Claude 한도", "Claude limit");
  if (/OpenClaw|브리지|response timeout|turn_failed/i.test(text)) return pick("응답 지연", "Slow response");
  if (/Codex\/OpenAI 한도|OpenAI.*한도|rate limit|quota|429|insufficient_quota|billing|credit|subscription|usage limit/i.test(text)) return pick("OpenAI 한도", "OpenAI limit");
  if (/프롬프트|confirm|확인 대기/i.test(text)) return pick("확인 대기", "Awaiting confirm");
  if (/tmux/i.test(text)) return pick("tmux 없음", "No tmux");
  if (/offline|세션 다운/i.test(text)) return pick("세션 다운", "Session down");
  if (/probe/i.test(text)) return pick("probe 지연", "Probe delay");
  if (h.ctxPercent != null && h.ctxPercent >= 80) return `ctx ${Math.round(h.ctxPercent)}%`;
  const first = h.reasons[0] ?? (h.level === "danger" ? pick("위험", "Danger") : pick("주의", "Warning"));
  return first.split("·")[0]?.trim().slice(0, 18) || first;
}

function displayLevel(h: AgentHealth): AgentHealth["level"] {
  const reason = healthReason(h);
  if (h.level === "danger" && reason === pick("응답 지연", "Slow response")) return "warn";
  return h.level;
}

export function renderHealthBanner(root: HTMLElement): void {
  function collect() {
    const s = store.getState();
    const healthLoaded = s.agentHealthLoaded;
    const offlineIds: string[] = [];
    s.statuses.forEach((st, id) => {
      if (st.state === "offline") offlineIds.push(id);
    });
    // danger/warn members, excluding offline ones (offline is the stronger, separate signal).
    // danger before warn.
    const health = Array.from(s.agentHealth.values())
      .filter((h) => (h.level === "danger" || h.level === "warn") && !offlineIds.includes(h.agentId))
      .sort((a, b) => (displayLevel(a) === "danger" ? 0 : 1) - (displayLevel(b) === "danger" ? 0 : 1));
    return { offlineIds, health, alertCount: s.alerts.length, healthLoaded };
  }

  function chip(content: string, color: string, member?: string): string {
    const attr = member ? ` data-member="${escape(member)}" style="cursor:pointer"` : "";
    return `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium shrink-0"
      style="background:${color}22;color:${color}"${attr}>${content}</span>`;
  }

  function render() {
    const { offlineIds, health, alertCount, healthLoaded } = collect();
    const issueCount = offlineIds.length + health.length + (alertCount > 0 ? 1 : 0);

    let inner: string;
    let accent: string;
    if (!healthLoaded) {
      accent = "#94a3b8";
      inner = `<span class="text-[12px] text-slate-400 font-medium">${pick("상태 확인 중", "Checking status")}</span>`;
    } else if (issueCount === 0) {
      accent = "#22c55e";
      inner = `<span class="text-[12px] text-accent-green font-medium">${pick("✓ 전원 정상", "✓ All healthy")}</span>`;
    } else {
      const hasDanger = offlineIds.length > 0 || health.some((h) => displayLevel(h) === "danger");
      accent = hasDanger ? "#ef4444" : "#f59e0b";
      const parts: string[] = [];
      offlineIds.forEach((id) => parts.push(chip(`${escape(nameOf(id))} offline`, "#ef4444", id)));
      health.forEach((h) => {
        const level = displayLevel(h);
        const c = level === "danger" ? "#ef4444" : "#f59e0b";
        const word = level === "danger" ? pick("위험", "Danger") : pick("주의", "Warning");
        parts.push(chip(`${escape(nameOf(h.agentId))} ${word}(${escape(healthReason(h))})`, c, h.agentId));
      });
      if (alertCount > 0) parts.push(chip(pick(`알림 ${alertCount}건`, `${alertCount} alerts`), "#f59e0b"));
      inner = parts.join("");
    }

    root.innerHTML = `
      <div class="h-8 flex items-center gap-2 px-3 border-b border-surface-3 bg-surface-1 overflow-x-auto whitespace-nowrap"
        style="border-left:3px solid ${accent}">
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${accent}"></span>
        <div class="flex items-center gap-1.5">${inner}</div>
      </div>`;

    // member chip → jump to that agent's Live view (selectAgent sets mainView=log + mobilePane=main).
    root.querySelectorAll<HTMLElement>("[data-member]").forEach((el) =>
      el.addEventListener("click", () => store.getState().selectAgent(el.dataset.member!)));
  }

  // Only re-render when a relevant slice changes. The store fires on every log line / metric tick;
  // statuses/agentHealth/alerts are replaced by reference on their own updates, so ref-compare skips
  // the noise (and avoids resetting horizontal scroll on mobile).
  let lastStatuses = store.getState().statuses;
  let lastHealth = store.getState().agentHealth;
  let lastAlerts = store.getState().alerts;
  let lastAgents = store.getState().agents;
  render();
  store.subscribe(() => {
    const s = store.getState();
    if (s.statuses === lastStatuses && s.agentHealth === lastHealth && s.alerts === lastAlerts && s.agents === lastAgents) return;
    lastStatuses = s.statuses;
    lastHealth = s.agentHealth;
    lastAlerts = s.alerts;
    lastAgents = s.agents;
    render();
  });
}

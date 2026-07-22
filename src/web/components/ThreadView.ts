import { store, type Message } from "../store";
import { sendMessage } from "../ws";
import { formatDistanceToNow } from "date-fns";
import { ko } from "date-fns/locale/ko";
import { enUS } from "date-fns/locale/en-US";
import { agentIconName, renderIcon } from "../icons";
import { pick, getLocale } from "../i18n";
import { parseSqliteDate } from "../lib/datetime";

function safeRelative(s: string | null): string {
  const d = parseSqliteDate(s);
  if (!d) return "—";
  try {
    return formatDistanceToNow(d, { addSuffix: true, locale: getLocale() === "en" ? enUS : ko });
  } catch {
    return "—";
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SOURCE_BORDER: Record<string, string> = {
  agent: "border-l-status-idle",
  user: "border-l-status-info",
  system: "border-l-status-offline",
};

export function renderThreadView(root: HTMLElement): void {
  let lastRenderedThreadId: string | null = null;

  const update = () => {
    const { selectedThreadId, threads, threadMessages, agents } = store.getState();
    if (!selectedThreadId) {
      root.innerHTML = `
        <div class="flex-1 flex items-center justify-center text-slate-500">
          ${pick("우측에서 thread 선택", "Select a thread on the right")}
        </div>`;
      lastRenderedThreadId = null;
      return;
    }
    const t = threads.find((x) => x.id === selectedThreadId);
    const msgs = threadMessages.get(selectedThreadId) ?? [];
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    if (lastRenderedThreadId !== selectedThreadId) {
      root.innerHTML = `
        <div class="flex-1 flex flex-col min-h-0">
          <div class="h-10 flex items-center justify-between px-4 border-b border-surface-3 shrink-0 bg-surface-1">
            <div class="text-sm font-semibold truncate">
              ${t ? `${escape(t.title)}` : selectedThreadId}
            </div>
            <div class="text-xs text-slate-500 flex items-center gap-3">
              ${t ? `<span>${pick(`${t.participants.length}명`, `${t.participants.length} members`)}</span>` : ""}
              ${t ? `<span>${t.kind}</span>` : ""}
              ${t ? `<span>${t.status}</span>` : ""}
            </div>
          </div>
          <div class="flex-1 overflow-y-auto p-4 space-y-3" id="thread-msgs"></div>
          <form class="border-t border-surface-3 p-3 flex gap-2" id="thread-form">
            <input type="text" id="thread-input"
              class="flex-1 bg-surface-0 border border-surface-3 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-accent-green text-slate-100"
              placeholder="${pick("thread 에 메시지 (Enter 전송)...", "Message the thread (Enter to send)...")}" autocomplete="off" />
            <button type="submit"
              class="px-3 py-1.5 rounded-md bg-accent-btn text-accent-on text-sm font-semibold hover:bg-accent-btnHover">
              ${pick("전송", "Send")}
            </button>
          </form>
        </div>`;
      lastRenderedThreadId = selectedThreadId;
      const form = root.querySelector<HTMLFormElement>("#thread-form");
      const input = root.querySelector<HTMLInputElement>("#thread-input");
      form?.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!input || !input.value.trim()) return;
        const body = input.value.trim();
        input.value = "";
        const recipients = (t?.participants ?? []).filter((p) => p !== "user");
        const to = recipients[0] ?? "bill";
        const result = await sendMessage({
          from_agent_id: "user",
          to_agent_id: to,
          body,
          thread_id: selectedThreadId,
          source: "user",
        });
        if (!result.ok) {
          alert(pick(`전송 실패: ${result.error}`, `Send failed: ${result.error}`));
          input.value = body;
        }
      });
    }
    const body = root.querySelector<HTMLElement>("#thread-msgs");
    if (!body) return;

    body.innerHTML = msgs
      .map((m: Message) => {
        const borderClass = SOURCE_BORDER[m.source] ?? "border-l-status-offline";
        const fromAgent = agentMap.get(m.from_agent_id);
        const iconName =
          m.from_agent_id === "user"
            ? "user-circle"
            : m.from_agent_id === "system"
              ? "circle-dot"
              : agentIconName(m.from_agent_id);
        const iconHtml = renderIcon(iconName, { size: 18, className: "text-accent-greenSoft" });
        const name = fromAgent?.display_name ?? m.from_agent_id;
        const time = safeRelative(m.created_at);
        const hopBadge = m.hop_count >= 3
          ? `<span class="text-[10px] text-status-idle ml-1">↻${m.hop_count}</span>`
          : "";
        const expiredBadge = m.delivery_status === "expired"
          ? `<span class="text-[10px] text-status-blocked ml-1">${pick("만료", "Expired")}</span>`
          : "";
        return `
          <div class="flex gap-3 border-l-4 ${borderClass} pl-3 py-1">
            <div class="shrink-0 w-7 h-7 flex items-center justify-center rounded-md bg-surface-0">${iconHtml}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-baseline gap-2 mb-0.5">
                <span class="text-sm font-semibold">${escape(name)}</span>
                <span class="text-[10px] text-slate-500">→ ${escape(m.to_agent_id)}</span>
                <span class="text-[10px] text-slate-500">${time}</span>
                ${hopBadge}${expiredBadge}
              </div>
              <div class="text-sm text-slate-200 whitespace-pre-wrap">${escape(m.body)}</div>
            </div>
          </div>`;
      })
      .join("");
    body.scrollTop = body.scrollHeight;
  };

  update();
  store.subscribe(update);
}

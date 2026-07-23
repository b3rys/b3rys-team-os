import { store, type Thread } from "../store";
import { loadThread } from "../ws";
import { formatDistanceToNow } from "date-fns";
import { ko } from "date-fns/locale/ko";
import { enUS } from "date-fns/locale/en-US";
import { agentIconName, threadKindIcon, renderIcon } from "../icons";
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

const STATUS_DOT: Record<string, string> = {
  open: "#22C55E",
  paused: "#FBBF24",
  closed: "#64748B",
  failed: "#EF4444",
};

export function renderThreadList(root: HTMLElement): void {
  const update = () => {
    const { threads, selectedThreadId, agents } = store.getState();
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const KIND_LABEL: Record<string, string> = {
      dm: "DM",
      meeting: pick("회의", "Meeting"),
      broadcast: pick("공지", "Notice"),
    };

    if (threads.length === 0) {
      root.innerHTML = `
        <div class="text-xs text-slate-500 leading-relaxed">
          ${pick("아직 thread 가 없습니다.", "No threads yet.")}<br>
          ${pick("API 로 메시지 보내거나 (아래) 입력박스로 시작:", "Send a message via the API (below) or start with the input box:")}
          <pre class="mt-2 text-[10px] text-slate-600 bg-surface-0 p-2 rounded">curl -X POST /team/api/inbox \\
  -d '{"from_agent_id":"bill",
       "to_agent_id":"steve",
       "body":"안녕"}'</pre>
        </div>`;
      return;
    }
    root.innerHTML = threads
      .map((t: Thread) => {
        const selected = t.id === selectedThreadId;
        const dot = STATUS_DOT[t.status] ?? "#64748B";
        const last = safeRelative(t.last_message_at);
        const kindIconHtml = renderIcon(threadKindIcon(t.kind), { size: 12, className: "text-slate-500" });
        const kindLabel = KIND_LABEL[t.kind] ?? t.kind;
        const partsIcons = t.participants
          .map((p) => {
            const agent = agentById.get(p) as { display_name?: string | null; name?: string | null } | undefined;
            const label = agent?.display_name || agent?.name || p;
            const iconName = agent ? agentIconName(p) : "user";
            return `
              <span class="inline-flex items-center gap-0.5 min-w-0 max-w-[5.5rem]">
                <span class="text-accent-greenSoft shrink-0">${renderIcon(iconName, { size: 12 })}</span>
                <span class="truncate text-[10px] normal-case font-medium text-slate-400">${escape(label)}</span>
              </span>`;
          })
          .join("");
        return `
          <button data-thread-id="${t.id}"
            class="w-full text-left p-2.5 rounded-md transition-colors mb-1 ${selected ? "bg-surface-3" : "hover:bg-surface-2"}">
            <div class="flex items-center justify-between gap-2 mb-1">
              <div class="flex items-center gap-1.5 min-w-0">
                <span style="background:${dot}" class="inline-block w-1.5 h-1.5 rounded-full shrink-0"></span>
                <span class="flex items-center gap-0.5 text-[10px] text-slate-500 uppercase font-semibold">${kindIconHtml}${kindLabel}</span>
                <span class="flex items-center gap-1 min-w-0 overflow-hidden">${partsIcons}</span>
              </div>
              <span class="text-[10px] text-slate-500">${last}</span>
            </div>
            <div class="text-xs text-slate-300 truncate">${escape(t.title)}</div>
          </button>`;
      })
      .join("");
    root.querySelectorAll<HTMLButtonElement>("[data-thread-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.threadId!;
        store.getState().selectThread(id);
        void loadThread(id);
      });
    });
  };
  update();
  store.subscribe(update);
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

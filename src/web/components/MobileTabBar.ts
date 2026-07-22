import { store, type MobilePane } from "../store";
import { renderIcon } from "../icons";

const TABS: Array<{ id: MobilePane; label: string; icon: string }> = [
  { id: "agents", label: "Agents", icon: "users" },
  { id: "main", label: "View", icon: "monitor" },
  { id: "threads", label: "Threads", icon: "message-square" },
];

export function renderMobileTabBar(root: HTMLElement): void {
  const update = () => {
    const { mobilePane, threads } = store.getState();
    const threadCount = threads.length > 0 ? `<span class="ml-1 text-[10px] text-slate-400">${threads.length}</span>` : "";
    root.innerHTML = `
      <div class="h-14 border-t border-surface-3 bg-surface-1 flex shrink-0">
        ${TABS.map((t) => {
          const active = t.id === mobilePane;
          const badge = t.id === "threads" ? threadCount : "";
          return `
            <button data-pane="${t.id}"
              class="flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${active ? "text-accent-green border-t-2 border-accent-green -mt-0.5" : "text-slate-400 hover:text-slate-200"}">
              <span>${renderIcon(t.icon, { size: 20 })}</span>
              <span class="text-[10px] font-semibold">${t.label}${badge}</span>
            </button>
          `;
        }).join("")}
      </div>
    `;
    root.querySelectorAll<HTMLButtonElement>("[data-pane]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pane = btn.dataset.pane as MobilePane;
        store.getState().setMobilePane(pane);
      });
    });
  };
  update();
  store.subscribe(update);
}

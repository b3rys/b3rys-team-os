import { pick } from "../i18n";

function escape(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface DialogOptions {
  title?: string;
  message?: string;
  messageHtml?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

function dialogShell(opts: DialogOptions, mode: "alert" | "confirm"): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/55 px-4 py-6 backdrop-blur-sm sm:items-center";
    const okCls = opts.danger
      ? "border-status-blocked/40 bg-status-blocked/85 text-white hover:bg-status-blocked"
      : "border-accent-green/40 bg-accent-green/85 text-white hover:bg-accent-green";
    const title = opts.title ?? (mode === "confirm" ? pick("확인", "Confirm") : pick("알림", "Notice"));
    const okLabel = opts.okLabel ?? (mode === "confirm" ? pick("확인", "Confirm") : pick("닫기", "Close"));
    const cancelLabel = opts.cancelLabel ?? pick("취소", "Cancel");
    const message = opts.messageHtml ?? escape(opts.message ?? "");

    overlay.innerHTML = `
      <div class="w-full max-w-md rounded-md border border-surface-3 bg-surface-1 p-4 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 id="app-dialog-title" class="text-base font-semibold text-slate-100">${escape(title)}</h3>
            <div class="mt-2 whitespace-pre-line break-words text-sm leading-6 text-slate-300">${message}</div>
          </div>
          <button type="button" data-dialog-cancel class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-surface-3 bg-surface-2 text-slate-400 hover:text-slate-100" aria-label="${pick("닫기", "Close")}">
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          ${mode === "confirm" ? `<button type="button" data-dialog-cancel class="rounded-md border border-surface-3 bg-surface-2 px-3 py-2 text-xs font-semibold text-slate-300 hover:text-slate-100">${escape(cancelLabel)}</button>` : ""}
          <button type="button" data-dialog-ok class="rounded-md border px-3 py-2 text-xs font-semibold ${okCls}">${escape(okLabel)}</button>
        </div>
      </div>`;

    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(false);
      if (mode === "alert" && e.key === "Enter") done(true);
    };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(false); });
    overlay.querySelectorAll("[data-dialog-cancel]").forEach((el) => el.addEventListener("click", () => done(false)));
    overlay.querySelector("[data-dialog-ok]")?.addEventListener("click", () => done(true));
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>("[data-dialog-ok]")?.focus();
  });
}

export function showConfirm(opts: DialogOptions | string): Promise<boolean> {
  return dialogShell(typeof opts === "string" ? { message: opts } : opts, "confirm");
}

export async function showAlert(opts: DialogOptions | string): Promise<void> {
  await dialogShell(typeof opts === "string" ? { message: opts } : opts, "alert");
}

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

/** 텍스트를 받아야 하는 모달의 추가 옵션. */
interface PromptOptions extends DialogOptions {
  defaultValue?: string;
  placeholder?: string;
}

type DialogMode = "alert" | "confirm" | "prompt";

/** 모드별 차이를 분기 대신 표로 둔다 — 모드가 늘 때 고칠 곳이 한 군데다. */
const MODE_SPEC: Record<DialogMode, {
  title: () => string;
  okLabel: () => string;
  /** 취소 버튼을 보여주나 */
  cancel: boolean;
  /** 취소·Escape·바깥 클릭이 돌려주는 값 */
  cancelValue: boolean | null;
}> = {
  alert: { title: () => pick("알림", "Notice"), okLabel: () => pick("닫기", "Close"), cancel: false, cancelValue: false },
  confirm: { title: () => pick("확인", "Confirm"), okLabel: () => pick("확인", "Confirm"), cancel: true, cancelValue: false },
  // prompt 의 취소는 false 가 아니라 ★null★ 이다 — 빈 문자열 입력("지우기")과 취소를 구분해야 한다.
  prompt: { title: () => pick("입력", "Input"), okLabel: () => pick("확인", "Confirm"), cancel: true, cancelValue: null },
};

function dialogShell(opts: PromptOptions, mode: DialogMode): Promise<boolean | string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/55 px-4 py-6 backdrop-blur-sm sm:items-center";
    const okCls = opts.danger
      ? "border-status-blocked/40 bg-status-blocked/85 text-white hover:bg-status-blocked"
      : "border-accent-green/40 bg-accent-green/85 text-white hover:bg-accent-green";
    const spec = MODE_SPEC[mode];
    const title = opts.title ?? spec.title();
    const okLabel = opts.okLabel ?? spec.okLabel();
    const cancelLabel = opts.cancelLabel ?? pick("취소", "Cancel");
    const message = opts.messageHtml ?? escape(opts.message ?? "");
    const inputHtml = mode === "prompt"
      ? `<input type="text" data-dialog-input value="${escape(opts.defaultValue ?? "")}" placeholder="${escape(opts.placeholder ?? "")}"
           class="mt-3 w-full rounded-md border border-surface-3 bg-surface-2 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent-green/40 placeholder:text-slate-600" />`
      : "";

    overlay.innerHTML = `
      <div class="w-full max-w-md rounded-md border border-surface-3 bg-surface-1 p-4 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 id="app-dialog-title" class="text-base font-semibold text-slate-100">${escape(title)}</h3>
            <div class="mt-2 whitespace-pre-line break-words text-sm leading-6 text-slate-300">${message}</div>
            ${inputHtml}
          </div>
          <button type="button" data-dialog-cancel class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-surface-3 bg-surface-2 text-slate-400 hover:text-slate-100" aria-label="${pick("닫기", "Close")}">
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          ${spec.cancel ? `<button type="button" data-dialog-cancel class="rounded-md border border-surface-3 bg-surface-2 px-3 py-2 text-xs font-semibold text-slate-300 hover:text-slate-100">${escape(cancelLabel)}</button>` : ""}
          <button type="button" data-dialog-ok class="rounded-md border px-3 py-2 text-xs font-semibold ${okCls}">${escape(okLabel)}</button>
        </div>
      </div>`;

    const input = overlay.querySelector<HTMLInputElement>("[data-dialog-input]");
    let settled = false;
    const done = (value: boolean | string | null) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    // 확인을 눌렀을 때 무엇을 돌려주나 — prompt 는 입력값, 나머지는 true.
    const accept = () => done(mode === "prompt" ? (input?.value ?? "") : true);
    const cancel = () => done(spec.cancelValue);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
      if (e.key === "Enter" && mode !== "confirm") accept();
    };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cancel(); });
    overlay.querySelectorAll("[data-dialog-cancel]").forEach((el) => el.addEventListener("click", cancel));
    overlay.querySelector("[data-dialog-ok]")?.addEventListener("click", accept);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    // 입력이 있으면 거기로 — 열자마자 타이핑할 수 있어야 한다.
    if (input) { input.focus(); input.select(); }
    else overlay.querySelector<HTMLButtonElement>("[data-dialog-ok]")?.focus();
  });
}

export function showConfirm(opts: DialogOptions | string): Promise<boolean> {
  return dialogShell(typeof opts === "string" ? { message: opts } : opts, "confirm") as Promise<boolean>;
}

export async function showAlert(opts: DialogOptions | string): Promise<void> {
  await dialogShell(typeof opts === "string" ? { message: opts } : opts, "alert");
}

/**
 * 텍스트 한 줄을 받는 인페이지 모달. ★네이티브 prompt() 를 쓰지 않는다★ —
 * 앱 웹뷰(WKWebView)에서 네이티브 다이얼로그가 억제되면 prompt() 는 조용히 null 을 돌려주고,
 * 그러면 버튼을 눌러도 아무 일도 일어나지 않는다(2026-07-30 팀장님 실측: "태그 관리가 안 눌린다").
 * @returns 입력값(빈 문자열 포함) 또는 취소 시 null. ★빈 문자열과 취소는 다르다.★
 */
export function showPrompt(opts: PromptOptions | string): Promise<string | null> {
  return dialogShell(typeof opts === "string" ? { message: opts } : opts, "prompt") as Promise<string | null>;
}

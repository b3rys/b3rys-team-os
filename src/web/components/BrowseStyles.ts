/** Shared Reports/Projects browsing density and theme tokens. */
export const browseListClass = "w-full max-w-[1400px] mx-auto px-4 md:px-8 pb-20";
export const browseRowClass = "group relative w-full text-left border-b border-surface-3 px-2 py-3.5 hover:bg-surface-0/70 transition-colors overflow-hidden";
export const browseDetailClass = "w-full max-w-[1400px] mx-auto px-4 md:px-8 py-5 min-w-0";
export function browseTabClass(active: boolean): string {
  return `h-7 px-2.5 rounded-md text-[12px] font-semibold uppercase tracking-wide transition-colors ${active ? "bg-accent-green/12 text-txt-green" : "text-slate-400 hover:text-slate-100"}`;
}

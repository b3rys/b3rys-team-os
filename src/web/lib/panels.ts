// 대시보드 좌우 패널(왼쪽 팀원 창 · 오른쪽 THREADS) 접기 상태 — 한 곳에서 관리한다.
// 표시는 body 클래스(styles.css 가 md+ 에서만 소비 → 모바일 단일 페인은 그대로), 저장은 localStorage(try/catch).
// 화면(Projects 문서 등)이 "잠깐 접기" 를 하고 되돌릴 수 있게 persist 없는 apply 도 둔다.

export type Panel = "sidebar" | "thread";

interface PanelDef { key: string; cls: string }
const PANELS: Record<Panel, PanelDef> = {
  sidebar: { key: "bill-dash-sidebar-collapsed", cls: "sidebar-collapsed" },
  thread: { key: "bill-dash-thread-collapsed", cls: "thread-panel-collapsed" },
};
export const PANEL_IDS = Object.keys(PANELS) as Panel[];

type Listener = (panel: Panel, collapsed: boolean, source: "user" | "auto") => void;
const listeners = new Set<Listener>();

function lsGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, v: string): void { try { localStorage.setItem(key, v); } catch { /* 저장 불가(사파리 비공개 등) — 표시만 */ } }

/** 저장된 선호(사용자가 마지막으로 고른 상태). 없으면 펼침. */
export function savedPanelCollapsed(panel: Panel): boolean { return lsGet(PANELS[panel].key) === "1"; }
/** 지금 화면에 보이는 상태(body 클래스). */
export function isPanelCollapsed(panel: Panel): boolean { return document.body.classList.contains(PANELS[panel].cls); }

/** 표시만 바꾼다(저장 X). 화면이 잠깐 접었다 되돌릴 때. */
export function applyPanelCollapsed(panel: Panel, collapsed: boolean, source: "user" | "auto" = "auto"): void {
  document.body.classList.toggle(PANELS[panel].cls, collapsed);
  listeners.forEach((fn) => fn(panel, collapsed, source));
}
/** 사용자가 고른 상태 — 표시 + 저장. */
export function setPanelCollapsed(panel: Panel, collapsed: boolean): void {
  lsSet(PANELS[panel].key, collapsed ? "1" : "0");
  applyPanelCollapsed(panel, collapsed, "user");
}
export function togglePanel(panel: Panel): void { setPanelCollapsed(panel, !isPanelCollapsed(panel)); }

/** 부팅: 저장된 선호를 body 에 올린다. */
export function initPanels(): void {
  for (const p of PANEL_IDS) applyPanelCollapsed(p, savedPanelCollapsed(p));
}
export function onPanelChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 테스트용 — body 클래스·리스너 초기화. */
export function resetPanelsState(): void {
  for (const p of PANEL_IDS) document.body.classList.remove(PANELS[p].cls);
  listeners.clear();
}

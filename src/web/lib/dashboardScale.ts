/** One scale for the dashboard, including dialogs mounted outside #app. */
export const DASHBOARD_SCALE_STEPS = [90, 100, 110, 125, 150] as const;
export const DASHBOARD_SCALE_KEY = "b3os-dashboard-scale";
let percent = 100;
const listeners = new Set<(value: number) => void>();
const boundDocuments = new WeakSet<Document>();

export function dashboardScale(): number { return percent; }
export function dashboardScaleFactor(): number { return percent / 100; }
/** DOM rectangles/pointer positions use viewport pixels; styles and scroll offsets use layout pixels. */
export function layoutPixels(viewportPixels: number): number { return viewportPixels / dashboardScaleFactor(); }
export function onDashboardScaleChange(listener: (value: number) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setDashboardScale(value: number): void {
  if (!(DASHBOARD_SCALE_STEPS as readonly number[]).includes(value)) return;
  percent = value;
  document.documentElement.style.setProperty("--dashboard-scale", String(dashboardScaleFactor()));
  try { window.localStorage.setItem(DASHBOARD_SCALE_KEY, String(value)); } catch { /* The current view still scales. */ }
  listeners.forEach(listener => listener(value));
}
export function handleDashboardScaleKey(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  const index = (DASHBOARD_SCALE_STEPS as readonly number[]).indexOf(percent);
  let next: number;
  if (event.key === "=" || event.key === "+") next = DASHBOARD_SCALE_STEPS[Math.min(index + 1, DASHBOARD_SCALE_STEPS.length - 1)]!;
  else if (event.key === "-" || event.key === "_") next = DASHBOARD_SCALE_STEPS[Math.max(index - 1, 0)]!;
  else if (event.key === "0") next = 100;
  else return false;
  event.preventDefault();
  setDashboardScale(next);
  return true;
}
export function initDashboardScale(): void {
  let stored = 100;
  try { stored = Number(window.localStorage.getItem(DASHBOARD_SCALE_KEY)); } catch { /* Use the default. */ }
  setDashboardScale((DASHBOARD_SCALE_STEPS as readonly number[]).includes(stored) ? stored : 100);
  if (!boundDocuments.has(document)) {
    document.addEventListener("keydown", handleDashboardScaleKey, { capture: true });
    boundDocuments.add(document);
  }
}

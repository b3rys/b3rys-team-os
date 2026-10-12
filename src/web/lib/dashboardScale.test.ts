import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { DASHBOARD_SCALE_KEY, dashboardScale, handleDashboardScaleKey, initDashboardScale, layoutPixels, setDashboardScale } from "./dashboardScale";

let win: Window;
const previous = { window: globalThis.window, document: globalThis.document };
beforeAll(() => {
  win = new Window({ url: "http://localhost/team" });
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  Object.assign(globalThis, { window: win, document: win.document });
});
afterAll(() => { Object.assign(globalThis, previous); });
beforeEach(() => { win.localStorage.clear(); setDashboardScale(100); });
function press(key: string, options: Record<string, boolean> = {}) {
  const event = new win.KeyboardEvent("keydown", { key, metaKey: true, cancelable: true, ...options });
  const handled = handleDashboardScaleKey(event as unknown as KeyboardEvent);
  return { handled, prevented: event.defaultPrevented };
}
describe("dashboard scale", () => {
  test("all steps, limits, reset, and browser default prevention", () => {
    for (const expected of [110, 125, 150, 150]) { expect(press("=")).toEqual({ handled: true, prevented: true }); expect(dashboardScale()).toBe(expected); }
    for (const expected of [125, 110, 100, 90, 90]) { press("-"); expect(dashboardScale()).toBe(expected); }
    press("0"); expect(dashboardScale()).toBe(100);
    expect(press("r")).toEqual({ handled: false, prevented: false });
    expect(press("=", { metaKey: false })).toEqual({ handled: false, prevented: false });
    expect(press("=", { altKey: true })).toEqual({ handled: false, prevented: false });
  });
  test("restores valid scale, rejects invalid persisted values, and converts positions", () => {
    win.localStorage.setItem(DASHBOARD_SCALE_KEY, "125"); initDashboardScale();
    expect(dashboardScale()).toBe(125);
    expect(document.documentElement.style.getPropertyValue("--dashboard-scale")).toBe("1.25");
    expect(layoutPixels(250)).toBe(200);
    win.localStorage.setItem(DASHBOARD_SCALE_KEY, "999"); initDashboardScale();
    expect(dashboardScale()).toBe(100);
  });
  test("storage read/write failure still permits scaling", () => {
    const storage = win.localStorage;
    const saved = { get: storage.getItem, set: storage.setItem };
    storage.getItem = () => { throw new Error("disabled"); };
    storage.setItem = () => { throw new Error("disabled"); };
    try {
      initDashboardScale(); expect(dashboardScale()).toBe(100);
      press("="); expect(dashboardScale()).toBe(110);
      expect(document.documentElement.style.getPropertyValue("--dashboard-scale")).toBe("1.1");
    } finally { storage.getItem = saved.get; storage.setItem = saved.set; }
  });
  test("capture listener handles focused input and binding twice does not double-scale", () => {
    initDashboardScale(); initDashboardScale();
    document.body.innerHTML = '<input id="focused">';
    const input = document.querySelector<HTMLInputElement>("input")!;
    input.focus();
    const event = new win.KeyboardEvent("keydown", { key: "=", metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event as unknown as Event);
    expect(dashboardScale()).toBe(110); expect(event.defaultPrevented).toBe(true);
  });
});

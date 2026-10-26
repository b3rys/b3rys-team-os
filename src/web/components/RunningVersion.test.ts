import { expect, test } from "bun:test";
import { renderRunningVersion, versionLabel } from "./RunningVersion";
import { Window } from "happy-dom";
test("label distinguishes valid running metadata from unavailable data", () => {
  expect(versionLabel({ version: "0.7.0", commit: "abcdef12" })).toBe("b3os v0.7.0 · abcdef12");
  expect(versionLabel({ version: "0.7.0", commitsSinceTag: 12, commit: "abcdef12" })).toBe("b3os v0.7.0 +12 · abcdef12");
  expect(versionLabel({ version: null, commit: null })).toBe("b3os version unavailable · commit unavailable");
});
test("footer renders server metadata and keeps failure explicit", async () => {
  const win = new Window();
  const target = win.document.createElement("footer") as unknown as HTMLElement;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ version: "0.7.0", commit: "abcdef12" }))) as unknown as typeof fetch;
    await renderRunningVersion(target);
    expect(target.textContent).toBe("b3os v0.7.0 · abcdef12");
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    await renderRunningVersion(target);
    expect(target.textContent).toBe("b3os version unavailable");
  } finally { globalThis.fetch = originalFetch; win.happyDOM.abort(); }
});

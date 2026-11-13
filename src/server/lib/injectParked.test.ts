import { describe, expect, test } from "bun:test";
import { injectOrPark, type ParkDeps, type ParkSettled } from "./injectParked";
import type { InjectPromptOptions, InjectResult } from "./tmuxInject";

const mk = (session: string, messageId: string) => ({ session, fromLabel: "t", threadId: "th", messageId, body: "b", source: "slack", kind: "slack", agentId: "bill" }) as InjectPromptOptions;

// 창 상태를 시험이 정하는 가짜 주입. delivered = 실제로 붙여넣은 글(messageId) 순서.
function fakeWorld() {
  const w = { open: true, delivered: [] as string[], attempts: 0 };
  const inject = (async (o: InjectPromptOptions): Promise<InjectResult> => {
    w.attempts++;
    if (w.open) return { ok: false, reason: "permission_prompt" };
    w.delivered.push(o.messageId);
    return { ok: true };
  }) as ParkDeps["inject"];
  let t = 0;
  const deps: ParkDeps = { inject, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => (t += 1000), retryMs: 1, maxMs: 1e15 };
  return { w, deps };
}
const settle = () => { const out: ParkSettled[] = []; let done!: () => void; const p = new Promise<void>((r) => (done = r)); return { out, cb: (r: ParkSettled) => { out.push(r); done(); }, p }; };

describe("injectOrPark", () => {
  test("prompt open: nothing delivered, parked; closed later: delivered exactly once", async () => {
    const { w, deps } = fakeWorld(); const s = settle();
    const first = await injectOrPark(mk("s1", "m1"), s.cb, deps);
    expect(first).toMatchObject({ ok: false, parked: true, reason: "permission_prompt" });
    expect(w.delivered).toEqual([]);
    await Bun.sleep(5); // 창이 열린 채 여러 번 다시 본다
    expect(w.delivered).toEqual([]);
    expect(w.attempts).toBeGreaterThan(2);
    w.open = false;
    await s.p;
    expect(w.delivered).toEqual(["m1"]);
    expect(s.out).toEqual([{ ok: true }]);
    await Bun.sleep(5);
    expect(w.delivered).toEqual(["m1"]); // 더 넣지 않는다
  });
  test("prompt closed from the start: delivered at once, not parked", async () => {
    const { w, deps } = fakeWorld(); w.open = false; const s = settle();
    expect(await injectOrPark(mk("s2", "m1"), s.cb, deps)).toEqual({ ok: true });
    expect(w.delivered).toEqual(["m1"]);
    expect(s.out).toEqual([]);
  });
  test("a message arriving while another is parked does not jump ahead of it", async () => {
    const { w, deps } = fakeWorld(); const a = settle(), b = settle();
    await injectOrPark(mk("s3", "m1"), a.cb, deps);
    expect(await injectOrPark(mk("s3", "m2"), b.cb, deps)).toMatchObject({ parked: true });
    w.open = false;
    await Promise.all([a.p, b.p]);
    expect(w.delivered).toEqual(["m1", "m2"]);
  });
  test("a prompt that never closes expires instead of waiting forever", async () => {
    const { w, deps } = fakeWorld(); const s = settle();
    await injectOrPark(mk("s4", "m1"), s.cb, { ...deps, maxMs: 5000 });
    await s.p;
    expect(s.out[0]).toMatchObject({ ok: false, expired: true });
    expect(w.delivered).toEqual([]);
  });
  test("a non-deferrable failure is returned as is (not parked)", async () => {
    const s = settle();
    const r = await injectOrPark(mk("s5", "m1"), s.cb, { inject: (async () => ({ ok: false })) as ParkDeps["inject"] });
    expect(r).toEqual({ ok: false });
  });
});

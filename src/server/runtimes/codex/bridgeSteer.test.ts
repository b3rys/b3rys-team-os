import { test, expect } from "bun:test";
import { createSteerQueue } from "../../lib/steerQueue";
import { captureActiveTurnSteer, registerActiveTurn, unregisterActiveTurn } from "./activeTurns";
import { captureConversationSteer, routeIncoming } from "./bridge";

test("captured sender cannot be replaced or reused for a different turn in the same room", async () => {
  const received: string[] = [];
  const old = { currentTurnId: "one", steer: async (t: string) => { received.push(t); } };
  const replacement = { currentTurnId: "two", steer: async (t: string) => { received.push(t); } };
  registerActiveTurn("pinned", old);
  const send = captureActiveTurnSteer("pinned")!;
  registerActiveTurn("pinned", replacement);
  expect(await send("old approval")).toBe(false);
  expect(received).toEqual([]);
  unregisterActiveTurn("pinned", replacement);
  registerActiveTurn("pinned", old);
  const reused = captureActiveTurnSteer("pinned")!;
  old.currentTurnId = "three";
  expect(await reused("old approval")).toBe(false);
  expect(received).toEqual([]);
  unregisterActiveTurn("pinned", old);
});

test("ordinary input delayed by attachments falls back in original room when active turn changes", async () => {
  const steerQueue = createSteerQueue();
  let current = 2;
  const received: string[] = [];
  const queued: Array<() => Promise<void>> = [];
  const old = { currentTurnId: "one", steer: async (t: string) => { received.push(t); } };
  const other = { currentTurnId: "two", steer: async (t: string) => { received.push(t); } };
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((v) => (started = v));
  registerActiveTurn("attachments", old);
  let ran = false;
  const call = routeIncoming(2, "ordinary message", {
    isRunning: (c) => c === current,
    captureSteer: () => captureConversationSteer(2, {
      isRunning: (c) => c === current,
      steerQueue,
      captureSend: () => captureActiveTurnSteer("attachments"),
      fetchAttachments: async () => { started(); await new Promise<void>((v) => (release = v)); return { files: [], failed: [], imagePaths: [] }; },
    }),
    steer: async () => false,
    enqueue: (run) => queued.push(run),
    runTurnFor: async () => { ran = true; },
  });
  await entered;
  current = 3;
  registerActiveTurn("attachments", other);
  release();
  expect(await call).toBe("newTurn");
  expect(received).toEqual([]);
  expect(queued).toHaveLength(1);
  await queued[0]!();
  expect(ran).toBe(true);
  unregisterActiveTurn("attachments", other);
});

test("steers for one conversation are sent in order and a rejected steer does not block the next", async () => {
  const queue = createSteerQueue();
  const order: string[] = [];
  let release!: (x: boolean) => void;
  let started!: () => void;
  const entered = new Promise<void>((v) => (started = v));
  const first = queue.steer(2, "a", async (body) => { order.push(body); started(); return await new Promise<boolean>((v) => (release = v)); });
  await entered;
  const second = queue.steer(2, "b", async (body) => { order.push(body); return true; });
  expect(order).toEqual(["a"]);
  release(true);
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(order).toEqual(["a", "b"]);
  await expect(queue.steer(2, "bad", async () => { throw new Error("injected"); })).rejects.toThrow("injected");
  expect(await queue.steer(2, "next", async () => true)).toBe(true);
});

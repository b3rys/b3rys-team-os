// codex 퇴사 정리 — 끈 브리지(와 자식)가 정말 사라진 뒤에 파일을 지운다. 가짜 프로세스(sleep)로 잰다.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { teardownRuntime } from "./activation";
import { descendantPids, readBridgePid, waitForExit } from "../runtimes/codex/bridgeProcess";

const kids: ChildProcess[] = [];
function fakeBridge(): ChildProcess {
  const c = spawn("sleep", ["30"], { stdio: "ignore" });
  kids.push(c);
  return c;
}
afterEach(() => { for (const c of kids.splice(0)) { try { c.kill("SIGKILL"); } catch { /* 이미 끝남 */ } } });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("teardownRuntime(codex) — 끄고 기다리고 지운다", () => {
  test("끈 뒤 프로세스가 늦게 사라져도, 사라진 뒤에 지운다", async () => {
    const b = fakeBridge();
    const order: string[] = [];
    const r = await teardownRuntime("zzfake", "codex", undefined, {
      codexBridgePids: () => [b.pid!],
      // bootout 이 신호만 보내고 프로세스는 조금 뒤에 끝나는 모양
      setAgentEnabled: (async () => { order.push("bootout"); setTimeout(() => b.kill("SIGTERM"), 150); return { ok: true, detail: "" }; }) as never,
      removeCodexBridgeFiles: (() => { order.push(`remove(alive=${alive(b.pid!)})`); }) as never,
      codexExitWaitMs: 3000,
    });
    expect(order).toEqual(["bootout", "remove(alive=false)"]);
    expect(r.detail).toContain("종료 확인");
  });

  test("상한 안에 안 사라지면 그래도 지우고, 미확인이라고 남긴다", async () => {
    const b = fakeBridge();
    const order: string[] = [];
    const r = await teardownRuntime("zzfake", "codex", undefined, {
      codexBridgePids: () => [b.pid!],
      setAgentEnabled: (async () => { order.push("bootout"); return { ok: true, detail: "" }; }) as never,
      removeCodexBridgeFiles: (() => { order.push("remove"); }) as never,
      codexExitWaitMs: 200,
    });
    expect(order).toEqual(["bootout", "remove"]);
    expect(r.detail).toContain("미확인");
  });

  test("ready 표시가 없으면(기다릴 것 없음) 바로 지운다", async () => {
    const order: string[] = [];
    const t = Date.now();
    await teardownRuntime("zzfake", "codex", undefined, {
      codexBridgePids: () => [],
      setAgentEnabled: (async () => { order.push("bootout"); return { ok: true, detail: "" }; }) as never,
      removeCodexBridgeFiles: (() => { order.push("remove"); }) as never,
    });
    expect(order).toEqual(["bootout", "remove"]);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  test("자식까지 기다린다 — 브리지는 끝났는데 자식(app-server)이 남아 있으면 그 자식이 끝난 뒤", async () => {
    const parent = fakeBridge();
    const child = fakeBridge();
    const order: string[] = [];
    await teardownRuntime("zzfake", "codex", undefined, {
      codexBridgePids: () => [parent.pid!, child.pid!],
      setAgentEnabled: (async () => {
        order.push("bootout");
        parent.kill("SIGTERM");
        setTimeout(() => child.kill("SIGTERM"), 200);
        return { ok: true, detail: "" };
      }) as never,
      removeCodexBridgeFiles: (() => { order.push(`remove(child=${alive(child.pid!)})`); }) as never,
      codexExitWaitMs: 3000,
    });
    expect(order).toEqual(["bootout", "remove(child=false)"]);
  });
});

describe("부품", () => {
  test("readBridgePid — 그 팀원 표시만, 깨진 파일은 null", () => {
    const d = mkdtempSync(join(tmpdir(), "b3pid-"));
    const f = join(d, "x.pid");
    writeFileSync(f, JSON.stringify({ pid: 4242, agentId: "zz", readyAt: "t" }));
    expect(readBridgePid(f, "zz")).toBe(4242);
    expect(readBridgePid(f, "other")).toBeNull();
    writeFileSync(f, "not json");
    expect(readBridgePid(f, "zz")).toBeNull();
    writeFileSync(f, JSON.stringify({ pid: 1, agentId: "zz" }));
    expect(readBridgePid(f, "zz")).toBeNull(); // init(1) 은 기다리지 않는다
    expect(readBridgePid(join(d, "none.pid"), "zz")).toBeNull();
  });
  test("descendantPids — 손자까지, 자기 자신·중복 없이", () => {
    const tree: Record<number, number[]> = { 10: [11, 12], 11: [13], 12: [], 13: [10] };
    expect(descendantPids(10, (p) => tree[p] ?? [])).toEqual([11, 12, 13]);
  });
  test("waitForExit — 다 사라지면 참, 상한 넘으면 거짓", async () => {
    const b = fakeBridge();
    expect(await waitForExit([b.pid!], { timeoutMs: 150, pollMs: 20 })).toBe(false);
    b.kill("SIGKILL");
    expect(await waitForExit([b.pid!], { timeoutMs: 2000, pollMs: 20 })).toBe(true);
    expect(await waitForExit([], { timeoutMs: 10 })).toBe(true);
  });
});

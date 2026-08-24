import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callCodexBridge } from "./codexBridgeClient";
import { writeWindowFile, type BridgeWindowRequest } from "../runtimes/codex/bridgeWindow";

const TOKEN = "a".repeat(64);

function seedWindow(agentId = "dex", port = 51234): { pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "cbc-"));
  const pidFile = join(dir, `${agentId}.pid`);
  writeWindowFile(join(dir, `${agentId}.window.json`), { port, token: TOKEN, pid: 1, agentId });
  return { pidFile };
}

const REQ: BridgeWindowRequest = {
  agentId: "dex",
  groupId: "-100",
  threadId: "tg--100",
  messageId: "tg-1",
  body: "@덱스 들려?",
};

describe("callCodexBridge", () => {
  test("★202 는 접수★ — queued 이지 '답했다' 가 아니다", async () => {
    const { pidFile } = seedWindow();
    const r = await callCodexBridge(REQ, {
      pidFile,
      fetchImpl: (async () => new Response("{}", { status: 202 })) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true, duplicate: false });
  });

  test("200 은 이미 접수된 중복", async () => {
    const { pidFile } = seedWindow();
    const r = await callCodexBridge(REQ, {
      pidFile,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true, duplicate: true });
  });

  test("★토큰을 헤더에 싣고 127.0.0.1 로만 부른다★", async () => {
    const { pidFile } = seedWindow("dex", 45678);
    let seenUrl = "";
    let seenToken = "";
    await callCodexBridge(REQ, {
      pidFile,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = String(url);
        seenToken = String((init.headers as Record<string, string>)["x-b3os-token"]);
        return new Response("{}", { status: 202 });
      }) as unknown as typeof fetch,
    });
    expect(seenUrl).toBe("http://127.0.0.1:45678/turn");
    expect(seenToken).toBe(TOKEN);
  });

  test("★창구 파일이 없으면 no_window★ — 조용히 성공으로 읽지 않는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbc-"));
    const r = await callCodexBridge(REQ, { pidFile: join(dir, "dex.pid") });
    expect(r).toEqual({ ok: false, reason: "no_window" });
  });

  test("pidFile 자체가 없으면 no_window", async () => {
    const r = await callCodexBridge(REQ, { pidFile: undefined });
    expect(r).toEqual({ ok: false, reason: "no_window" });
  });

  test("★남의 창구 파일이면 부르지 않는다★ (stale 파일 방지)", async () => {
    const { pidFile } = seedWindow("dex");
    const r = await callCodexBridge({ ...REQ, agentId: "codex" }, { pidFile });
    expect(r).toEqual({ ok: false, reason: "no_window" });
  });

  test("★끊긴 것과 늦은 것을 가른다 — unreachable★", async () => {
    const { pidFile } = seedWindow();
    const r = await callCodexBridge(REQ, {
      pidFile,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, reason: "unreachable" });
  });

  test("★타임아웃은 timeout 으로 갈린다★ — 재시도하지 않으므로 사유가 남아야 한다", async () => {
    const { pidFile } = seedWindow();
    const r = await callCodexBridge(REQ, {
      pidFile,
      timeoutMs: 10,
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        })) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, reason: "timeout" });
  });

  test("401 등 거절은 rejected + status", async () => {
    const { pidFile } = seedWindow();
    const r = await callCodexBridge(REQ, {
      pidFile,
      fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, reason: "rejected", status: 401 });
  });

  test("★매 호출마다 파일을 다시 읽는다★ — 재기동하면 포트가 바뀐다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbc-"));
    const pidFile = join(dir, "dex.pid");
    const wf = join(dir, "dex.window.json");
    const ports: number[] = [];
    const impl = (async (url: string) => {
      ports.push(Number(String(url).split(":")[2]?.split("/")[0]));
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;

    writeWindowFile(wf, { port: 1111, token: TOKEN, pid: 1, agentId: "dex" });
    await callCodexBridge(REQ, { pidFile, fetchImpl: impl });
    writeWindowFile(wf, { port: 2222, token: TOKEN, pid: 2, agentId: "dex" });
    await callCodexBridge(REQ, { pidFile, fetchImpl: impl });

    expect(ports).toEqual([1111, 2222]);
  });
});

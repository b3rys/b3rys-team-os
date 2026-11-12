// injectPrompt 의 권한 창 가드를 가짜 tmux(TMUX_BIN)로 시험한다 — 창이 열려 있으면 load-buffer·paste-buffer·send-keys 가 한 번도 불리면 안 된다.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectPrompt } from "./tmuxInject";

let dir: string, log: string, paneFile: string, failFile: string, prevBin: string | undefined;
const OPEN = ["Bash command", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel"].join("\n");
const IDLE = "──────\n❯ \n──────";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-tmux-"));
  log = join(dir, "calls.log"); paneFile = join(dir, "pane.txt"); failFile = join(dir, "capture-fails");
  const bin = join(dir, "tmux");
  writeFileSync(bin, `#!/bin/sh
echo "$1" >> "${log}"
case "$1" in
  capture-pane) [ -f "${failFile}" ] && exit 1; cat "${paneFile}" ;;
  load-buffer) cat > /dev/null ;;
esac
exit 0
`);
  chmodSync(bin, 0o755);
  prevBin = process.env.TMUX_BIN;
  process.env.TMUX_BIN = bin;
});
afterAll(() => {
  if (prevBin === undefined) delete process.env.TMUX_BIN; else process.env.TMUX_BIN = prevBin;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(log, { force: true }); rmSync(failFile, { force: true }); writeFileSync(paneFile, IDLE); });

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
const opts = { session: "s", fromLabel: "t", threadId: "th", messageId: "m1", body: "안녕", source: "bus", kind: "teammate", agentId: "bill" } as const;

describe("injectPrompt — 권한 창 가드", () => {
  test("prompt open: nothing is loaded, pasted or submitted; the caller is told to defer", async () => {
    writeFileSync(paneFile, OPEN);
    expect(await injectPrompt(opts)).toEqual({ ok: false, reason: "permission_prompt" });
    expect(calls().filter((c) => c !== "has-session" && c !== "capture-pane")).toEqual([]);
  });
  test("capture-pane fails: fail closed — nothing is pasted", async () => {
    writeFileSync(failFile, "1");
    expect(await injectPrompt(opts)).toEqual({ ok: false, reason: "capture_failed" });
    expect(calls().filter((c) => c !== "has-session" && c !== "capture-pane")).toEqual([]);
  });
  test("prompt closed: pasted once and submitted", async () => {
    const r = await injectPrompt(opts);
    expect(r.ok).toBe(true);
    expect(calls().filter((c) => c === "paste-buffer")).toHaveLength(1);
    expect(calls().filter((c) => c === "load-buffer")).toHaveLength(1);
    expect(calls().filter((c) => c === "send-keys")).toHaveLength(1);
  });
});

/**
 * reply-guard 의 기록 지연 대응 — 훅이 돌 때 transcript 에 이번 턴 reply 줄이 아직 없을 수 있다.
 * ★훅을 실제로 실행해서 잰다★ (replyGuardScope.test.ts 와 같은 방식).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "reply-guard.py");
const DM_CHAT = "9999999999";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  dirs = [];
});

const userTurn = {
  type: "user",
  uuid: "u1",
  message: { role: "user", content: `<channel source="plugin:telegram:telegram" chat_id="${DM_CHAT}" message_id="1" user="gd">질문</channel>` },
};
const replyToolUse = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__plugin_telegram_telegram__reply", input: { chat_id: DM_CHAT, text: "답" } }] },
};
const thinkingOnly = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "생각 중" }] } };

function setup(events: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "b3os-guard-lag-"));
  dirs.push(dir);
  const tp = join(dir, "transcript.jsonl");
  writeFileSync(tp, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { dir, tp };
}
function runSync(input: Record<string, unknown>, env: Record<string, string> = {}): string {
  return execFileSync("python3", [HOOK], { input: JSON.stringify(input), encoding: "utf-8", env: { ...process.env, ...env } });
}
function decisions(dir: string): Array<{ decision: string; source: string; waited_ms: number }> {
  const p = join(dir, ".reply-guard-decisions.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("훅 입력(stdin)으로 먼저 판정", () => {
  test("tool_calls 에 reply 가 있으면 transcript 에 없어도 통과", () => {
    const { dir, tp } = setup([userTurn, thinkingOnly]);
    const out = runSync({ transcript_path: tp, tool_calls: [{ tool_name: "mcp__plugin_telegram_telegram__reply", tool_use_id: "t1" }] }, { REPLY_GUARD_RETRY_MS: "0" });
    expect(out).toBe("");
    expect(decisions(dir).at(-1)).toMatchObject({ decision: "allow", source: "stdin" });
  });
  test("last_assistant_message 에 reply tool_use 가 있으면 통과", () => {
    const { tp } = setup([userTurn, thinkingOnly]);
    const out = runSync({ transcript_path: tp, last_assistant_message: { role: "assistant", content: replyToolUse.message.content } }, { REPLY_GUARD_RETRY_MS: "0" });
    expect(out).toBe("");
  });
  test("tool_calls 에 reply 가 없으면 여전히 막는다 (진짜 누락)", () => {
    const { dir, tp } = setup([userTurn, thinkingOnly]);
    const out = runSync({ transcript_path: tp, tool_calls: [{ tool_name: "Bash", tool_use_id: "t1" }] }, { REPLY_GUARD_RETRY_MS: "0" });
    expect(out).toContain('"block"');
    expect(decisions(dir).at(-1)).toMatchObject({ decision: "block", source: "stdin_no_send" });
  });
});

describe("transcript 기록 지연 — 잠깐 다시 읽는다", () => {
  test("훅이 도는 중에 reply 줄이 늦게 써지면 통과", async () => {
    const { dir, tp } = setup([userTurn, thinkingOnly]);
    const child = spawn("python3", [HOOK], { env: { ...process.env, REPLY_GUARD_RETRY_MS: "2000" } });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stdin.end(JSON.stringify({ transcript_path: tp }));
    setTimeout(() => appendFileSync(tp, JSON.stringify(replyToolUse) + "\n"), 400);
    await new Promise((r) => child.on("close", r));
    expect(out).toBe("");
    const last = decisions(dir).at(-1)!;
    expect(last).toMatchObject({ decision: "allow", source: "transcript_retry" });
    expect(last.waited_ms).toBeGreaterThan(0);
  });
  test("끝까지 없으면 막되, 경고문이 '이미 보냈으면 다시 보내지 마라' 를 먼저 말한다", () => {
    const { dir, tp } = setup([userTurn, thinkingOnly]);
    const out = runSync({ transcript_path: tp }, { REPLY_GUARD_RETRY_MS: "250" });
    const reason = JSON.parse(out).reason as string;
    expect(reason.indexOf("다시 보내지 말고")).toBeGreaterThanOrEqual(0);
    expect(reason.indexOf("다시 보내지 말고")).toBeLessThan(reason.indexOf("reply 도구로 답을 보내지 않았습니다"));
    expect(decisions(dir).at(-1)).toMatchObject({ decision: "block", source: "stdin_none", waited_ms: 250 });
  });
  test("transcript 에 이미 있으면 기다리지 않고 통과", () => {
    const { dir, tp } = setup([userTurn, replyToolUse]);
    const t0 = Date.now();
    expect(runSync({ transcript_path: tp })).toBe("");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(decisions(dir).at(-1)).toMatchObject({ decision: "allow", source: "transcript", waited_ms: 0 });
  });
});

/**
 * reply-guard 의 기록 지연 대응 — 훅이 돌 때 transcript 에 이번 턴 reply 줄이 아직 없을 수 있다.
 * 표식(PostToolUse --mark)이 먼저, transcript 가 다음, 표식 배선 전에만 잠깐 다시 읽는다.
 * ★훅을 실제로 실행해서 잰다★ (replyGuardScope.test.ts 와 같은 방식).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installReplyGuardHook, uninstallReplyGuardHook, REPLY_GUARD_MARK_MATCHER } from "./launcher";

const HOOK = join(import.meta.dir, "reply-guard.py");
const DM_CHAT = "9999999999";
const SID = "sess-1";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  dirs = [];
});

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const userTurn = (ts: string) => ({
  type: "user",
  uuid: "u1",
  timestamp: ts,
  message: { role: "user", content: `<channel source="plugin:telegram:telegram" chat_id="${DM_CHAT}" message_id="1" user="gd">질문</channel>` },
});
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
function run(args: string[], input: Record<string, unknown>, env: Record<string, string> = {}): string {
  return execFileSync("python3", [HOOK, ...args], { input: JSON.stringify(input), encoding: "utf-8", env: { ...process.env, ...env } });
}
const stop = (tp: string, env: Record<string, string> = {}) => run([], { transcript_path: tp, session_id: SID }, env);
const markSend = (tp: string, tool = "mcp__plugin_telegram_telegram__reply", sid = SID) =>
  run(["--mark"], { transcript_path: tp, session_id: sid, tool_name: tool });
function decisions(dir: string): Array<{ decision: string; source: string; waited_ms: number }> {
  const p = join(dir, ".reply-guard-decisions.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}
const marks = (dir: string) => {
  const p = join(dir, ".reply-guard-sent.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as Record<string, number>) : {};
};

describe("--mark (PostToolUse)", () => {
  test("reply·edit_message 는 세션 표식을 남긴다", () => {
    const { dir, tp } = setup([userTurn(iso(5000))]);
    expect(markSend(tp)).toBe("");
    expect(typeof marks(dir)[SID]).toBe("number");
    markSend(tp, "mcp__plugin_telegram_telegram__edit_message", "sess-2");
    expect(typeof marks(dir)["sess-2"]).toBe("number");
  });
  test("다른 도구는 표식을 남기지 않는다", () => {
    const { dir, tp } = setup([userTurn(iso(5000))]);
    markSend(tp, "mcp__plugin_telegram_telegram__react");
    markSend(tp, "Bash");
    expect(marks(dir)).toEqual({});
  });
});

describe("Stop — 표식이 먼저", () => {
  test("이번 턴 뒤에 찍힌 표식이 있으면 transcript 에 reply 가 없어도 통과(기다리지 않음)", () => {
    const { dir, tp } = setup([userTurn(iso(3000)), thinkingOnly]);
    markSend(tp);
    const t0 = Date.now();
    expect(stop(tp)).toBe("");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(decisions(dir).at(-1)).toMatchObject({ decision: "allow", source: "marker" });
  });
  test("표식이 지난 턴 것이면(트리거보다 앞) 진짜 누락 — 기다리지 않고 막는다", () => {
    const { dir, tp } = setup([userTurn(iso(3000)), thinkingOnly]);
    markSend(tp);
    // 새 트리거가 표식보다 뒤에 들어온 턴
    writeFileSync(tp, [userTurn(iso(3000)), thinkingOnly, replyToolUse, userTurn(new Date(Date.now() + 1000).toISOString()), thinkingOnly].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const t0 = Date.now();
    const out = stop(tp);
    expect(out).toContain('"block"');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(decisions(dir).at(-1)).toMatchObject({ decision: "block", source: "marker_wired_no_send", waited_ms: 0 });
  });
  test("다른 세션의 표식은 이번 세션을 통과시키지 않는다", () => {
    const { tp } = setup([userTurn(iso(3000)), thinkingOnly]);
    markSend(tp, "mcp__plugin_telegram_telegram__reply", "other-session");
    expect(stop(tp, { REPLY_GUARD_RETRY_MS: "0" })).toContain('"block"');
  });
});

describe("표식 배선 전 — transcript 를 잠깐 다시 읽는다", () => {
  test("훅이 도는 중에 reply 줄이 늦게 써지면 통과", async () => {
    const { dir, tp } = setup([userTurn(iso(3000)), thinkingOnly]);
    const child = spawn("python3", [HOOK], { env: { ...process.env, REPLY_GUARD_RETRY_MS: "2000" } });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stdin.end(JSON.stringify({ transcript_path: tp, session_id: SID }));
    setTimeout(() => appendFileSync(tp, JSON.stringify(replyToolUse) + "\n"), 400);
    await new Promise((r) => child.on("close", r));
    expect(out).toBe("");
    const last = decisions(dir).at(-1)!;
    expect(last).toMatchObject({ decision: "allow", source: "transcript_retry" });
    expect(last.waited_ms).toBeGreaterThan(0);
  });
  test("끝까지 없으면 막되, 경고문이 '이미 보냈으면 다시 보내지 마라' 를 먼저 말한다", () => {
    const { dir, tp } = setup([userTurn(iso(3000)), thinkingOnly]);
    const reason = JSON.parse(stop(tp, { REPLY_GUARD_RETRY_MS: "250" })).reason as string;
    expect(reason.indexOf("다시 보내지 말고")).toBeGreaterThanOrEqual(0);
    expect(reason.indexOf("다시 보내지 말고")).toBeLessThan(reason.indexOf("reply 도구로 답을 보내지 않았습니다"));
    expect(decisions(dir).at(-1)).toMatchObject({ decision: "block", source: "no_marker", waited_ms: 250 });
  });
  test("transcript 에 이미 있으면 기다리지 않고 통과", () => {
    const { dir, tp } = setup([userTurn(iso(3000)), replyToolUse]);
    const t0 = Date.now();
    expect(stop(tp)).toBe("");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(decisions(dir).at(-1)).toMatchObject({ decision: "allow", source: "transcript", waited_ms: 0 });
  });
});

describe("설치·제거 배선", () => {
  const setupRoots = () => {
    const root = mkdtempSync(join(tmpdir(), "b3os-guard-install-"));
    dirs.push(root);
    const membersRoot = join(root, "members");
    const repoRoot = join(root, "repo");
    mkdirSync(join(repoRoot, "src/server/runtimes/claude"), { recursive: true });
    writeFileSync(join(repoRoot, "src/server/runtimes/claude/reply-guard.py"), readFileSync(HOOK, "utf-8"));
    mkdirSync(join(membersRoot, "m1", ".claude"), { recursive: true });
    return { membersRoot, repoRoot, settings: () => JSON.parse(readFileSync(join(membersRoot, "m1/.claude/settings.json"), "utf-8")) };
  };
  test("설치하면 Stop 과 PostToolUse(--mark, reply·edit_message) 가 한 번씩, 두 번 해도 그대로", () => {
    const r = setupRoots();
    installReplyGuardHook("m1", r);
    installReplyGuardHook("m1", r);
    const h = r.settings().hooks;
    expect(JSON.stringify(h.Stop).match(/reply-guard\.py/g)!.length).toBe(1);
    expect(h.PostToolUse.length).toBe(1);
    expect(h.PostToolUse[0].matcher).toBe(REPLY_GUARD_MARK_MATCHER);
    expect(h.PostToolUse[0].hooks[0].command).toContain("--mark");
    expect(new RegExp(`^(?:${REPLY_GUARD_MARK_MATCHER})$`).test("mcp__plugin_telegram_telegram__reply")).toBe(true);
    expect(new RegExp(`^(?:${REPLY_GUARD_MARK_MATCHER})$`).test("mcp__plugin_telegram_telegram__react")).toBe(false);
  });
  test("제거하면 Stop·PostToolUse 배선과 파일이 모두 빠진다", () => {
    const r = setupRoots();
    installReplyGuardHook("m1", r);
    uninstallReplyGuardHook("m1", { membersRoot: r.membersRoot });
    const s = JSON.stringify(r.settings().hooks);
    expect(s).not.toContain("reply-guard.py");
    expect(existsSync(join(r.membersRoot, "m1/.claude/hooks/reply-guard.py"))).toBe(false);
  });
});

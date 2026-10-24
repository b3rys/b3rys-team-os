import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipSummary, collect, entryOf, projectDirName, render } from "./session-handoff";

const line = (o: unknown) => JSON.stringify(o);

describe("claude session handoff", () => {
  test("작업 폴더 → 프로젝트 폴더 이름 규칙", () => {
    expect(projectDirName("/Users/gdmini/Development/bill")).toBe("-Users-gdmini-Development-bill");
    expect(projectDirName("/a/b.c_d")).toBe("-a-b-c-d");
  });

  test("넘기는 글: 사람 말·답 글·텔레그램 답장만, 도구 결과·알림 줄은 뺀다", () => {
    expect(entryOf({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } })).toBeNull();
    expect(entryOf({ type: "user", message: { content: "<system-reminder>a</system-reminder>" } })).toBeNull();
    expect(entryOf({ type: "user", isMeta: true, message: { content: "meta" } })).toBeNull();
    expect(entryOf({ type: "user", message: { content: "팀장: 해 줘" } })?.entries?.[0]?.text).toBe("팀장: 해 줘");
    const a = entryOf({
      type: "assistant",
      message: { content: [
        { type: "thinking", thinking: "속생각" },
        { type: "text", text: "답" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", name: "mcp__plugin_telegram_telegram__reply", input: { text: "보낸 말" } },
      ] },
    });
    expect(a?.entries?.map((e) => e.text)).toEqual(["답", "보낸 말"]);
  });

  test("마지막 압축 요약 뒤의 글만 모으고, 요약 끝의 하네스 안내는 뺀다", () => {
    const dir = mkdtempSync(join(tmpdir(), "handoff-"));
    const p = join(dir, "s.jsonl");
    writeFileSync(p, [
      line({ type: "user", message: { content: "요약 전 글" } }),
      line({ type: "user", isCompactSummary: true, message: { content: "Summary: 하던 일 X\nContinue the conversation from where it left off without asking" } }),
      line({ type: "user", message: { content: "요약 뒤 지시" } }),
      "깨진 줄 {",
      line({ type: "assistant", message: { content: [{ type: "text", text: "요약 뒤 답" }] } }),
    ].join("\n") + "\n");
    const { summary, entries } = collect(p, 20);
    expect(summary).toContain("하던 일 X");
    expect(summary).not.toContain("Continue the conversation");
    expect(entries.map((e) => e.text)).toEqual(["요약 뒤 지시", "요약 뒤 답"]);
  });

  test("긴 요약은 끝(남은 일·하던 일)을 더 많이 남긴다", () => {
    const s = "머리" + "a".repeat(10000) + "꼬리-남은일";
    const c = clipSummary(s, 1000);
    expect(c.startsWith("머리")).toBe(true);
    expect(c.endsWith("꼬리-남은일")).toBe(true);
    expect(c.length).toBeLessThan(1100);
  });

  test("글자 상한을 넘으면 오래된 글부터 버리고, 토큰은 가린다", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ role: "나" as const, text: `글${i} ` + "y".repeat(300) }));
    entries.push({ role: "나", text: "마지막 bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    const out = render(null, entries, 3000, "s.jsonl", new Date());
    expect(out.length).toBeLessThan(3600);
    expect(out).toContain("마지막 bot<redacted>");
    expect(out).not.toContain("글0 ");
    expect(out).toContain("지난 세션 마지막 기록");
  });
});

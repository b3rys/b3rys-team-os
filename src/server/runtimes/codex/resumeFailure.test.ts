import { test, expect, describe } from "bun:test";
import { CodexAppServerClient, resumeFailureLine } from "./appServerClient";

/**
 * ★이어받기 실패가 보이는가.★
 *
 * 이 로그는 ★시험이 없으면 지워도 아무도 모른다.★ 그런데 이게 없으면
 * "이어받았다" 와 "실패해서 새로 시작했다" 가 기록에서 같은 모양이라,
 * 사람이 "왜 앞 얘기를 잊었냐" 고 물어도 답할 수 없다(2026-08-19 실측 — 그 상황이 실제로 났다).
 */
describe("실패 사유 한 줄", () => {
  test("★어느 대화였는지와 왜 실패했는지가 둘 다 들어간다★", () => {
    const line = resumeFailureLine("01a01826-aaaa", new Error("already has an active writer"));
    expect(line).toContain("01a01826-aaaa");
    expect(line).toContain("active writer");
  });

  test("★앞 맥락이 없다는 것을 말한다★ — 이게 사람이 겪는 증상이다", () => {
    expect(resumeFailureLine("t", new Error("x"))).toContain("앞 맥락 없음");
  });

  test("Error 가 아닌 것이 와도 사유가 비지 않는다", () => {
    expect(resumeFailureLine("t", "그냥 문자열")).toContain("그냥 문자열");
  });
});

describe("★실패하면 실제로 그 줄이 나오고, 새 대화로 떨어진다★", () => {
  function stubbed(opts: { resumeFails: boolean }) {
    const lines: string[] = [];
    const c = new CodexAppServerClient({ warn: (l) => lines.push(l) });
    const calls: string[] = [];
    // ★프로세스를 띄우지 않고 분기만 밟는다★ — 이 분기가 도는지가 재려는 것이다.
    (c as unknown as { request: (m: string, p: unknown) => Promise<unknown> }).request = async (method) => {
      calls.push(method);
      if (method === "thread/resume") {
        if (opts.resumeFails) throw new Error("already has an active writer");
        return { thread: { id: "old-thread" } };
      }
      if (method === "thread/start") return { thread: { id: "new-thread" } };
      return {};
    };
    return { c, lines, calls };
  }

  test("★이어받기 실패 → 로그가 남고 새 thread 로 간다★ (조용히 삼키지 않는다)", async () => {
    const { c, lines, calls } = stubbed({ resumeFails: true });
    const id = await c.startThread({ resumeThreadId: "old-thread" });
    expect(lines, "실패가 기록에 남아야 한다").toHaveLength(1);
    expect(lines[0]).toContain("thread/resume 실패");
    expect(lines[0]).toContain("old-thread");
    expect(calls, "실패했으면 새 thread 로 떨어진다").toEqual(["thread/resume", "thread/start"]);
    expect(id, "새 대화로 진행한다 — 대화를 끊지 않는다").toBe("new-thread");
  });

  test("★대조군 — 이어받기 성공이면 아무 말도 안 한다★ (성공을 실패처럼 적지 않는다)", async () => {
    const { c, lines, calls } = stubbed({ resumeFails: false });
    const id = await c.startThread({ resumeThreadId: "old-thread" });
    expect(lines, "성공했는데 경고를 남기면 진짜 실패를 못 찾는다").toHaveLength(0);
    expect(calls, "성공했으면 새 thread 를 만들지 않는다").toEqual(["thread/resume"]);
    expect(id).toBe("old-thread");
  });

  test("★대조군 — 이어받을 게 없으면 시도 자체를 안 한다★", async () => {
    const { c, lines, calls } = stubbed({ resumeFails: true });
    await c.startThread({});
    expect(calls).toEqual(["thread/start"]);
    expect(lines).toHaveLength(0);
  });
});

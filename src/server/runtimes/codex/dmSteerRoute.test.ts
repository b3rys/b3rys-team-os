import { test, expect, describe } from "bun:test";
import { routeIncoming, buildDmSteerText, type IncomingRouteDeps } from "./bridge";

type Calls = {
  steered: string[];
  enqueued: number;
  ran: number;
};

function harness(opts: {
  running: boolean;
  steerResult?: boolean | (() => Promise<boolean>);
}): { deps: IncomingRouteDeps; calls: Calls } {
  const calls: Calls = { steered: [], enqueued: 0, ran: 0 };
  const deps: IncomingRouteDeps = {
    isRunning: () => opts.running,
    steer: async (t) => {
      calls.steered.push(t);
      if (typeof opts.steerResult === "function") return opts.steerResult();
      return opts.steerResult ?? true;
    },
    enqueue: (run) => {
      calls.enqueued += 1;
      void run();
    },
    runTurnFor: async () => {
      calls.ran += 1;
    },
  };
  return { deps, calls };
}

describe("1:1 — 작업 중에 온 말을 어디로 보내나", () => {
  test("작업이 도는 중이면 ★그 작업에 밀어 넣는다★ — 새 작업으로 줄 세우지 않는다", async () => {
    const { deps, calls } = harness({ running: true, steerResult: true });
    const route = await routeIncoming(7066867819, "잠시만", deps);
    expect(route).toBe("steered");
    expect(calls.steered).toHaveLength(1);
    expect(calls.enqueued, "밀어 넣었으면 새 작업은 안 만든다").toBe(0);
  });

  test("★대조군 — 도는 작업이 없으면 새 작업으로 간다★", async () => {
    const { deps, calls } = harness({ running: false });
    const route = await routeIncoming(7066867819, "기사 분석해줘", deps);
    expect(route).toBe("newTurn");
    expect(calls.steered, "도는 게 없는데 밀어 넣으려 하면 안 된다").toHaveLength(0);
    expect(calls.enqueued).toBe(1);
    expect(calls.ran).toBe(1);
  });

  test("★밀어 넣기가 실패하면 새 작업으로 되돌린다★ — 그 자리에서 멈추면 말이 사라진다", async () => {
    // 번호가 아직 없는 찰나(막 시작한 턴)에 말이 오면 steer 가 false 를 준다.
    // 여기서 return 하면 그 말은 아무 데도 안 간다 — 사람은 무시당했다고 느낀다.
    const { deps, calls } = harness({ running: true, steerResult: false });
    const route = await routeIncoming(7066867819, "로그인 안되면 알려줘", deps);
    expect(route, "실패했으면 새 작업이어야 한다").toBe("newTurn");
    expect(calls.steered, "시도는 했다").toHaveLength(1);
    expect(calls.enqueued, "실패를 조용히 삼키지 않는다").toBe(1);
    expect(calls.ran).toBe(1);
  });

  test("밀어 넣는 문구에 ★반영하라 + 이 말에도 답하라★ 가 들어간다 — 없으면 읽고 지나친다", async () => {
    const { deps, calls } = harness({ running: true, steerResult: true });
    await routeIncoming(1, "5까지만", deps);
    const sent = calls.steered[0]!;
    expect(sent).toContain("5까지만");
    expect(sent).toContain("반영");
    expect(sent).toContain("답해라");
    expect(sent).toBe(buildDmSteerText("5까지만"));
  });

  test("steer 가 던져도 말은 살아남는다 — 새 작업으로 내려간다", async () => {
    const { deps, calls } = harness({
      running: true,
      steerResult: async () => {
        throw new Error("app-server 연결 끊김");
      },
    });
    const route = await routeIncoming(1, "잠시만", deps).catch(() => "threw" as const);
    expect(route, "예외로 말을 잃으면 안 된다").toBe("newTurn");
    expect(calls.enqueued).toBe(1);
  });
});

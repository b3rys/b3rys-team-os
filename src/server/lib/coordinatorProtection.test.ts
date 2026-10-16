// 코디네이터는 복구를 맡으므로 전체 정지에서 제외하고 마지막에 재시작한다. 특정 ID에 의존하지 않는지도 검사한다.
import { afterEach, describe, expect, test } from "bun:test";
import { partitionForRestart, stopAll } from "./agentControl";

const prev = process.env.APPROVAL_EXECUTION_ENABLED;
afterEach(() => {
  if (prev === undefined) delete process.env.APPROVAL_EXECUTION_ENABLED;
  else process.env.APPROVAL_EXECUTION_ENABLED = prev;
});

const m = (id: string, capabilities: string[] = []) => ({ id, runtime: "claude_channel", capabilities });

describe("재시작 — 코디네이터가 맨 마지막", () => {
  test("★코디는 뒤로 미뤄진다★ — 먼저 재시작되면 복구할 사람이 먼저 죽는다", () => {
    const { others, coordinators } = partitionForRestart([
      m("kim"),
      m("park", ["coordinator"]),
      m("lee"),
    ]);
    expect(others.map((x) => x.id)).toEqual(["kim", "lee"]);
    expect(coordinators.map((x) => x.id)).toEqual(["park"]);
  });

  test("코디가 명부 맨 앞에 있어도 뒤로 간다", () => {
    const { others, coordinators } = partitionForRestart([m("park", ["coordinator"]), m("kim")]);
    expect(others.map((x) => x.id)).toEqual(["kim"]);
    expect(coordinators.map((x) => x.id)).toEqual(["park"]);
  });

  test("코디가 없으면 아무도 미뤄지지 않는다", () => {
    const { others, coordinators } = partitionForRestart([m("kim"), m("lee")]);
    expect(others).toHaveLength(2);
    expect(coordinators).toHaveLength(0);
  });

  test("★`recovery` 능력은 더 이상 특별하지 않다★ — 통합이 반쪽이면 여기서 걸린다", () => {
    const { others, coordinators } = partitionForRestart([m("kim", ["recovery"])]);
    expect(coordinators).toHaveLength(0);
    expect(others.map((x) => x.id)).toEqual(["kim"]);
  });
});

describe("전원 정지 — 코디네이터는 제외", () => {
  test("★코디는 정지되지 않고 kept 로 표시된다★", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "1";
    // 코디 한 명만 넘긴다 — 루프가 setAgentEnabled 를 안 부르므로 부작용이 없다.
    const out = await stopAll([m("park", ["coordinator"])]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("park");
    expect(out[0]!.kept).toBe(true);
  });

  test("★`recovery` 만 있는 멤버는 이제 보호되지 않는다★ — 통합 확인", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "0"; // 실행 OFF — 부작용 없이 게이트만 확인
    const out = await stopAll([m("kim", ["recovery"])]);
    expect(out[0]!.ok).toBe(false); // 실행 OFF 응답 — recovery 로 인한 kept 가 아니다
    expect(out[0]!.kept).toBeUndefined();
  });
});

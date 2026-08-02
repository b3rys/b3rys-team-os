/**
 * 코디네이터는 ★두 가지★ 로 보호된다 — `stop_all` 에서 제외되고, `restart_all` 에서 ★맨 마지막★ 이다.
 *
 * 예전에는 이 둘이 `recovery` 라는 별도 능력에 걸려 있었고, `coordinator` 로 합쳤다.
 * ★"이름 바꾸기" 가 아니다★ — 두 동작 중 하나를 잃으면 조용히 사라진다:
 *   · `stop_all` 쪽을 잃으면 ★복구할 사람까지 같이 멈춘다★
 *   · 재시작 순서를 잃으면 ★복구할 사람이 먼저 죽는다★
 *
 * ★"어디서도 안 부른다" 로는 확인할 수 없다★ — 안 부르는 게 정상인지 기능이 사라진 건지
 * 구분이 안 되기 때문이다. 그래서 ★두 동작을 각각 직접 잰다.★
 *
 * 코디네이터는 ★우리 팀 이름이 아닌 id★ 로 둔다 — 이름에 기대지 않는다는 것도 같이 고정한다.
 */
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

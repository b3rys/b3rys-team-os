/**
 * `stopAll` 은 ★일부러 제외한 멤버를 `kept` 로 표시한다.★
 *
 * 표시가 없으면 화면이 ★이름으로 다시 추측★ 해야 하고(예전엔 `id !== "bill"`),
 * 그러면 코디네이터가 바뀌거나 그런 이름이 없는 설치에서 틀린다.
 *
 * ★부작용 없는 경로만 잰다★ — 명단을 복구 코디 한 명으로 두면 루프가 `setAgentEnabled` 를
 * 부르지 않고 바로 skip 한다. 실제 프로세스·launchctl 을 건드리지 않는다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { stopAll } from "./agentControl";

const prev = process.env.APPROVAL_EXECUTION_ENABLED;
afterEach(() => {
  if (prev === undefined) delete process.env.APPROVAL_EXECUTION_ENABLED;
  else process.env.APPROVAL_EXECUTION_ENABLED = prev;
});

describe("stopAll — 제외한 멤버를 표시한다", () => {
  test("★복구 코디는 kept: true 로 표시된다★ (이름과 무관하다)", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "1";
    // ★우리 팀 이름이 아닌 id★ — 이름에 기대지 않는다는 걸 같이 잰다.
    const out = await stopAll([{ id: "kim", runtime: "claude_channel", capabilities: ["recovery"] }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("kim");
    expect(out[0]!.ok).toBe(true);
    expect(out[0]!.kept).toBe(true);
  });

  test("실행 OFF 면 아무것도 안 한다", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "0";
    const out = await stopAll([{ id: "kim", runtime: "claude_channel", capabilities: ["recovery"] }]);
    expect(out[0]!.ok).toBe(false);
  });
});

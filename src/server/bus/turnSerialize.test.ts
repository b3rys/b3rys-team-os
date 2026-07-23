/**
 * ★한 팀원의 턴이 도는 중이면 다음 wake 를 미룬다.★ (2026-07-13)
 *
 * ═══ 왜 이게 필요한가 — 실측 ═══
 * `rate-final-hermes-1`: 기여자 두 명의 답이 ★각각 wake 를 일으켰다.★
 *   10:15:57  dbak → hermes   (wake 1)
 *   10:16:14  steve → hermes  (wake 2)
 *   10:16:23  hermes → 팀장   ★완전한 종합★
 *   10:16:33  hermes → 팀장   ★똑같은 종합 (중복)★
 * 두 턴이 ★10초 간격으로 겹쳐 돌았다.★
 *
 * 룰은 "★이미 보냈으면 또 보내지 마라★" 라고 시켰다. ★그런데 지킬 수가 없었다★ —
 * 두 번째 턴의 프롬프트 문맥은 ★첫 번째 종합이 나가기 전에★ 만들어졌기 때문이다.
 * ★룰이 볼 게 없었다.★ ★"시켰는데 안 한다" 가 아니라 "볼 수 없게 해놓고 시켰다".★
 *
 * → ★앞 턴이 끝난 뒤 깨우면★ 두 번째 턴의 문맥에 첫 종합이 들어온다 → ★스스로 침묵한다.★
 *
 * ═══ 같은 변경이 어제의 다른 버그도 고친다 ═══
 * 턴 중에 주입된 메시지를 ★openclaw TUI 는 버리고★, ★hermes REPL 은 돌던 턴을 죽인다(msg=interrupt).★
 * 어제 실측한 ★조용한 유실★ 이 그것이다. 직렬화하면 애초에 턴 중 주입이 없다.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "wakeDispatcher.ts"), "utf8");

describe("★턴 직렬화 — 도는 중이면 미룬다★", () => {
  it("★같은 팀원의 in-flight 턴이 있으면 이번 tick 을 건너뛴다★", () => {
    // 키가 `${message_id}:${agent_id}` 이므로, 그 팀원의 항목이 하나라도 있으면 바쁘다.
    expect(SRC).toContain("k.endsWith(`:${row.agent_id}`)");
    expect(SRC).toContain("if (busy) {");
    // ★조용히 밀리면 아무도 모른다★ (Steve 조건②) — 미룬 wake 는 audit 으로 남는다
    expect(SRC).toContain('"wake_deferred_turn_busy"');
  });

  it("★claude 는 제외한다★ — 입력을 큐잉하므로 안 잃는다 (직렬화하면 팀장 메시지만 느려진다)", () => {
    expect(SRC).toContain('runtime !== "claude_channel"');
  });

  it("★row 를 버리지 않는다★ — pending 그대로 두고 다음 tick 에 다시 온다 (retry 소모 없음)", () => {
    // `continue` 는 claim(markDispatching) ★이전★ 에 와야 한다. 클레임 후 건너뛰면 row 가 붙잡힌 채 남는다.
    const gate = SRC.indexOf("if (busy) {");
    const claim = SRC.indexOf("const claimed = markDispatching(");
    expect(gate).toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(gate); // 게이트가 클레임보다 먼저
  });

  it("★영구 정체가 없다★ — self-heal 이 grace 지난 in-flight 를 비운다 (죽은 턴도 결국 풀린다)", () => {
    expect(SRC).toContain("inFlight.delete(key)");
    expect(SRC).toContain("graceMs");
  });
});

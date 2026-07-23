/**
 * ★깨우기가 죽었으면 요청자에게 알린다.★ (2026-07-13 — 팀장 라이브 테스트에서 드러남)
 *
 * ═══ 실측 ═══
 *   16:22:01  steve → hermes   [팀장 지시 수집] 질문 (팀장이 단톡방에서 시킨 일)
 *   16:23:32  hermes 턴 ★타임아웃★ → delivery_state=expired · last_error=hermes_timeout
 *             ★steve 에게는 아무도 안 알려줬다.★
 *   → steve 는 ★오지 않을 답을 영원히 기다린다.★ 팀장은 "스티브 응답 대기중" 만 본다.
 *
 * 룰: "끝내 침묵하는 사람이 있으면 보고하고 ★누가 안 했는지 밝혀라★"
 * ★steve 는 그걸 하고 싶어도 못 한다 — hermes 가 죽었다는 사실 자체가 안 보이니까.★
 * ★"룰이 시켰는데 안 한다" 가 아니라 "볼 수 없게 해놓고 시켰다".★ (오늘 이 패턴만 여섯 번째)
 *
 * ★재시도는 여전히 안 한다★ — hermes/openclaw 는 턴 도중 이미 팬아웃을 보낸다 → 재시도 = 중복 위임.
 * 대신 ★사실을 알려준다.★ 판단은 팀원이 한다(미응답으로 마감할지, 다시 물을지).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "wakeDispatcher.ts"), "utf8");

describe("★만료 통지 — 요청자가 영원히 기다리지 않게★", () => {
  it("★expire_no_retry 두 경로 모두에서 알린다★ (하나만 걸면 나머지로 새어 나간다 — 오늘 세 번 당했다)", () => {
    const calls = SRC.match(/notifyRequesterOfExpiry\(db, row, roster,/g) ?? [];
    expect(calls.length).toBe(2);   // exception 경로 + failure 경로
  });

  it("★그 팀원이 한 말이 아니다★ — source='system' · from='system' 으로 넣는다", () => {
    expect(SRC).toContain('from_agent_id: "system"');
    expect(SRC).toMatch(/source: "system",\s*\/\/ ★그 팀원이 한 말이 아니다★/);
  });

  it("★같은 실패로 두 번 알리지 않는다★ (dedupe_key)", () => {
    expect(SRC).toContain("dedupe_key: `expiry-notice:${row.message_id}:${row.agent_id}`");
  });

  it("★팀원→팀원 요청일 때만 알린다★ (팀장/시스템 발신은 요청자가 사람/서버라 통지 대상이 아니다)", () => {
    expect(SRC).toContain('if (row.source !== "agent") return;');
    expect(SRC).toContain("if (!requester || requester === row.agent_id) return;");
  });

  it("★요청자가 실재 팀원인지 확인한다 — roster 로★ (targetAgent 만 넘기면 요청자를 못 찾아 통지가 영영 안 나간다)", () => {
    // 내가 처음에 [targetAgent] 를 넘겼다. 요청자(steve)는 그 안에 없으니 ★통지가 절대 안 나갔다.★
    expect(SRC).toContain("if (!agents.some((a) => a.id === requester)) return;");
    expect(SRC).toContain("recordDispatchOutcome(db, row, plan.targetAgent, outcome, syncDeps, agents);");
  });

  it("★재시도는 여전히 안 한다★ (통지를 넣었다고 재시도를 되살리면 중복 팬아웃이 난다)", () => {
    expect(SRC).toMatch(/\["hermes_agent", "expire_no_retry"\]/);
    expect(SRC).toMatch(/\["openclaw", "expire_no_retry"\]/);
  });
});

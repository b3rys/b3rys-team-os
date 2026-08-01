/**
 * ★@all 은 정식 팀원에게만 가고, 주입문은 소유권을 단정하지 않는다.★ (GD 2026-08-01)
 *
 * ═══ 실제로 터진 일 ═══
 * ① `broadcastTargets` 가 `BUS_DISPATCH_AGENTS` env(손으로 유지하는 두 번째 명단)를 읽었다.
 *    env 7명 vs 정식팀원 8명 → ★lui·ames 가 @all 에서 통째로 빠졌다.★
 *    `message_recipient` 에 두 사람 행이 ★아예 없었다★ (안 읽은 게 아니라 안 갔다).
 * ② 그룹 주입문이 수신자 ★전원에게★ "그룹 라우터가 당신에게 배정했습니다" 라고 말했다.
 *    → 깨어난 사람 전원이 자기가 owner 라고 읽고 답했다. ★sticky·@mention 규칙이 무력화됐다.★
 *    실측: 25분에 방 broadcast 28건(서로 "확인했습니다" 를 주고받는 연쇄).
 *
 * ★demis 지적 반영★: "지금 명단으로 테스트를 짜면 그 테스트도 같이 통과해버린다."
 * → 그래서 이 테스트는 ★이름을 하드코딩하지 않고★, 새 정식 팀원을 넣었을 때 따라오는지로 잰다.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTmuxInjectionPrompt } from "../tmuxInject";

const SRC = readFileSync(
  join(import.meta.dir, "ownerDecision.ts"),
  "utf8",
);
// ★소스가 아니라 실제 렌더 결과를 잰다★ — 소스를 grep 하면 '뺐다' 고 적은 주석까지 걸린다(내가 그랬다).
const INJECT = buildTmuxInjectionPrompt({
  session: "claude-t", fromLabel: "bill", locale: "ko",
  threadId: "tg--2000000000001", messageId: "m1", inReplyTo: "p1", hopCount: 1,
  body: "hi", source: "telegram", kind: "group", agentId: "t",
} as never);

describe("★@all 대상은 agents.json 의 정식 팀원 하나만 본다★", () => {
  it("두 번째 명단(BUS_DISPATCH_AGENTS env)을 읽지 않는다 — 갈라지는 원인이었다", () => {
    const fn = SRC.slice(SRC.indexOf("function broadcastTargets"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body, "★broadcastTargets 가 다시 env 를 읽는다★ — 명단이 둘이 되면 후입 팀원이 또 빠진다.")
      .not.toContain("BUS_DISPATCH_AGENTS");
    expect(body, "정식 팀원 플래그를 봐야 한다").toContain("team_official_member");
  });

  it("★새 정식 팀원을 넣으면 자동으로 대상에 들어온다★ — 이름을 세지 않고 규칙으로 잰다", () => {
    const fn = SRC.slice(SRC.indexOf("function broadcastTargets"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    // 명단을 나열하는 대신 roster 를 필터하는 형태여야 새 멤버가 따라온다.
    expect(body).toMatch(/agents\s*\n?\s*\.filter/);
    expect(body, "비활성 팀원은 제외해야 한다").toContain("enabled");
  });

  it("wake allowlist 와 섞지 않는다 — 관심사가 다르다", () => {
    const fn = SRC.slice(SRC.indexOf("function broadcastTargets"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toContain("busDispatchAllowlist");
    expect(body).not.toContain("bus-wake-extra");
  });
});

describe("★그룹 주입문은 소유권을 단정하지 않는다 — sticky 를 무력화했었다★", () => {
  it("'당신에게 배정했습니다' 를 수신자 전원에게 말하지 않는다", () => {
    expect(INJECT, "★소유권 단정이 되살아났다★ — 깨어난 전원이 자기가 owner 라고 읽는다.")
      .not.toContain("그룹 라우터가 당신에게 배정했습니다");
    expect(INJECT).not.toContain("The group router assigned this message to you");
  });

  it("owner 규칙을 주입문에 ★적지도 않는다★ — 룰이 정본이고 두 곳에 적으면 어긋난다", () => {
    // 이 파일의 기존 계약(tmuxInject.test.ts)이 그렇게 못박고 있다: 주입문은 '사실' 만 준다.
    // 그래서 소유권 단정을 빼되, owner 규칙을 대신 넣지도 않는다. 남는 건 "어느 방·어느 스레드" 뿐이다.
    expect(INJECT).toContain("이 방에 올라온 메시지입니다");   // ko 렌더
    expect(INJECT).not.toContain("owner 규칙이 정합니다");
    const en = buildTmuxInjectionPrompt({
      session: "claude-t", fromLabel: "bill", locale: "en",
      threadId: "tg--2000000000001", messageId: "m1", inReplyTo: "p1", hopCount: 1,
      body: "hi", source: "telegram", kind: "group", agentId: "t",
    } as never);
    expect(en).toContain("A message arrived in this group room");
    expect(en).not.toContain("The group router assigned this message to you");
  });
});

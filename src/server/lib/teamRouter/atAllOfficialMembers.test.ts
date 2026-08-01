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
import { buildTmuxInjectionPrompt } from "../tmuxInject";
import { broadcastAudience, routeTeamMessage } from "./ownerDecision";
import { broadcastRecipientIds } from "../agentMembership";

// ★소스가 아니라 실제 렌더 결과를 잰다★ — 소스를 grep 하면 '뺐다' 고 적은 주석까지 걸린다(내가 그랬다).
const INJECT = buildTmuxInjectionPrompt({
  session: "claude-t", fromLabel: "bill", locale: "ko",
  threadId: "tg--2000000000001", messageId: "m1", inReplyTo: "p1", hopCount: 1,
  body: "hi", source: "telegram", kind: "group", agentId: "t",
} as never);

// ★소스 텍스트가 아니라 동작을 잰다.★ 예전 판은 `broadcastTargets` 의 본문을 grep 했는데,
// 규칙을 공용 함수로 모으자 ★동작이 그대로인데도 시험이 깨졌다.★ 문구를 재고 있었기 때문이다.
// 지금은 라우터를 실제로 호출하고, 기대값은 같은 명부에서 규칙으로 다시 계산해 비교한다.
const roster = (extra: Array<Record<string, unknown>> = []) =>
  [
    { id: "m1", display_name: "M1", team_official_member: true },
    { id: "m2", display_name: "M2", team_official_member: true },
    { id: "observer", display_name: "Ob", team_official_member: false },
    { id: "paused", display_name: "Pa", team_official_member: true, enabled: false },
    ...extra,
  ] as never;

const atAll = (agents: unknown) => routeTeamMessage("@all 대답해봐", agents as never).targetAgentIds.slice().sort();

describe("★@all 대상은 agents.json 의 정식 팀원 하나만 본다★", () => {
  it("두 번째 명단(BUS_DISPATCH_AGENTS env)이 있어도 ★결과가 안 바뀐다★", () => {
    const before = atAll(roster());
    const prev = process.env.BUS_DISPATCH_AGENTS;
    process.env.BUS_DISPATCH_AGENTS = "m1"; // 예전엔 이 값이 대상을 m1 하나로 좁혔다
    try {
      expect(atAll(roster()), "★env 가 다시 대상을 좁힌다★ — 명단이 둘이 되면 후입 팀원이 또 빠진다.")
        .toEqual(before);
    } finally {
      if (prev === undefined) delete process.env.BUS_DISPATCH_AGENTS;
      else process.env.BUS_DISPATCH_AGENTS = prev;
    }
  });

  it("★새 정식 팀원을 넣으면 자동으로 대상에 들어온다★ — 이름을 세지 않고 규칙으로 잰다", () => {
    const added = { id: "newbie", display_name: "New", team_official_member: true };
    expect(atAll(roster([added]))).toContain("newbie");
    // 비정식·정지 팀원은 따라오지 않는다
    expect(atAll(roster())).not.toContain("observer");
    expect(atAll(roster())).not.toContain("paused");
  });

  it("★두 경로가 같은 답을 낸다★ — 팬아웃과 @all 이 갈리는 게 이 결함이었다", () => {
    const agents = roster();
    expect(atAll(agents)).toEqual(broadcastRecipientIds(agents as never).slice().sort());
  });

  it("★플래그를 아무도 안 쓰는 명부에서 대상이 0명이 되지 않는다★ (공개 설치)", () => {
    const flagless = [{ id: "a", display_name: "A" }, { id: "b", display_name: "B" }] as never;
    expect(atAll(flagless)).toEqual(["a", "b"]);
  });

  it("★팀원 방 발언이 0명이어도 팀장님 메시지의 sticky 경로는 그대로 동작한다★", () => {
    // 두 사다리는 ★별개★ 다. 이번 변경은 팀원 방 발언(전달 대상)만 건드리고,
    // 팀장님 메시지의 owner 판정(@이름 > 답장 > sticky > coordinator)은 손대지 않는다.
    // ★설계 논의 중 이 둘을 섞은 적이 있다★ — 다음 사람도 헷갈리니 시험이 막는다.
    const agents = roster();

    // 팀원 방 발언: 멘션 없음 → 전달 0명
    expect(broadcastAudience("네 확인했습니다").kind).not.toBe("all_hands");

    // 팀장님 메시지: 멘션 없음이어도 sticky 가 받는다 (사다리 그대로)
    const d = routeTeamMessage("그럼 그거 진행해줘", agents as never, { activeAssigneeIds: ["m2"] });
    expect(d.targetAgentIds, "★팀장님 sticky 경로가 같이 죽었다★").toEqual(["m2"]);
    expect(d.reason).toBe("active_assignee_followup");
  });

  it("★wake allowlist 를 켜도 @all 대상이 안 바뀐다★ — 관심사가 다르다", () => {
    // 예전 판은 소스를 grep 해서 `busDispatchAllowlist` 문자열이 없는지 봤다. ★문구를 재고 있었다.★
    // 지금은 그 allowlist 를 실제로 좁혀놓고 ★결과가 바뀌는지★ 로 잰다.
    const before = atAll(roster());
    const prev = process.env.BUS_DISPATCH_AGENTS;
    process.env.BUS_DISPATCH_AGENTS = "m1"; // wake allowlist 를 한 명으로 좁힌다
    try {
      expect(atAll(roster()), "★wake allowlist 가 @all 수신자를 좁혔다★ — 두 관심사가 섞였다")
        .toEqual(before);
    } finally {
      if (prev === undefined) delete process.env.BUS_DISPATCH_AGENTS;
      else process.env.BUS_DISPATCH_AGENTS = prev;
    }
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

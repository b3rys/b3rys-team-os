// 대상은 정식 명부를 따라야 하며 wake 자체가 소유권을 뜻하지 않는다. 새 팀원을 추가해도 대상을 누락하지 않는지 검사한다.
import { describe, expect, it, test } from "bun:test";
import { buildTmuxInjectionPrompt } from "../tmuxInject";
import { broadcastAudience, hasBroadcastAllMarker, routeTeamMessage } from "./ownerDecision";
import { broadcastRecipientIds } from "../agentMembership";

// 소스 주석이 아닌 실제 렌더 결과에서 소유권 단정을 검사한다.
const INJECT = buildTmuxInjectionPrompt({
  session: "claude-t", fromLabel: "bill", locale: "ko",
  threadId: "tg--2000000000001", messageId: "m1", inReplyTo: "p1", hopCount: 1,
  body: "hi", source: "telegram", kind: "group", agentId: "t",
} as never);

// 소스 문구에 의존하면 함수 추출만으로 실패할 수 있어 라우터 결과를 명부 기반 기대값과 비교한다.
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
    process.env.BUS_DISPATCH_AGENTS = "m1"; // wake allowlist와 broadcast 수신 명부는 별개다.
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
    // 두 사다리는 별개 다. 이번 변경은 팀원 방 발언(전달 대상)만 건드리고,
    // 팀장님 메시지의 owner 판정(@이름 > 답장 > sticky > coordinator)은 손대지 않는다.
    // 설계 논의 중 이 둘을 섞은 적이 있다 — 다음 사람도 헷갈리니 시험이 막는다.
    const agents = roster();

    // 팀원 방 발언 → 전달 0명.
    // source 를 반드시 넘긴다. optional 이라 빼면 어떤 입력이든 통과해서
    // 이 단언이 아무것도 안 지키게 된다. 그리고 마커까지 붙여서
    // "멘션이 없어서 0명" 이 아니라 "팀원이라서 0명" 을 재게 한다.
    expect(broadcastAudience("네 확인했습니다", "agent").kind).not.toBe("all_hands");
    expect(broadcastAudience("@all 다들 확인", "agent").kind).not.toBe("all_hands");
    // 반대 축이 같이 죽지 않았는지 — 팀장님 것은 그대로여야 한다
    expect(broadcastAudience("@all 다들 확인", "user").kind).toBe("all_hands");

    // 팀장님 메시지: 멘션 없음이어도 sticky 가 받는다 (사다리 그대로)
    const d = routeTeamMessage("그럼 그거 진행해줘", agents as never, { activeAssigneeIds: ["m2"] });
    expect(d.targetAgentIds, "★팀장님 sticky 경로가 같이 죽었다★").toEqual(["m2"]);
    expect(d.reason).toBe("active_assignee_followup");
  });

  it("★wake allowlist 를 켜도 @all 대상이 안 바뀐다★ — 관심사가 다르다", () => {
    // wake allowlist를 좁혀도 정식 명부 기반의 broadcast 수신 대상은 달라지면 안 된다.
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

// 라우팅과 깨움이 같은 전체 호출 판정을 써야 인용·예시의 @all이 한쪽만 발동시키지 않는다.
describe("hasBroadcastAllMarker — 무엇이 마커이고 무엇이 아닌가", () => {
  test("맨 본문의 @all·@b3rys·@group 은 마커다", () => {
    expect(hasBroadcastAllMarker("@all 다들 확인")).toBe(true);
    expect(hasBroadcastAllMarker("@b3rys 공지")).toBe(true);
    expect(hasBroadcastAllMarker("@group 확인")).toBe(true);
  });

  test("★코드펜스 안의 @all 은 마커가 아니다★ — 예시를 보여준 것뿐이다", () => {
    expect(hasBroadcastAllMarker("```\n@all\n```\n이렇게 쓰면 됩니다")).toBe(false);
  });

  test("★구분선 아래의 @all 은 마커가 아니다★ — 원문 인용부다", () => {
    expect(hasBroadcastAllMarker("제 의견입니다\n---\n@all 원문")).toBe(false);
  });

  test("★인용줄(> @all)은 여전히 마커다★ — stripQuotedForRouting 이 제거 대상으로 안 잡는다", () => {
    // 직관과 어긋나지만 기존 동작이고 라우팅도 같게 판정한다.
    // 바꾸려면 두 경로가 같이 움직이므로 여기부터 고쳐라.
    expect(hasBroadcastAllMarker("> @all 원문입니다\n네 확인했습니다")).toBe(true);
  });

  test("멘션이 없으면 마커가 아니다", () => {
    expect(hasBroadcastAllMarker("팀 참고만 하십시오")).toBe(false);
  });
});

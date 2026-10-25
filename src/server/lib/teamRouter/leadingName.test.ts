import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../../types";
import { broadcastAudience, routeTeamMessage, routeTeamMessageHybrid } from "./ownerDecision";
import { detectLeadingNameTargets } from "./mention";

const agents = [
  { id: "bill", display_name: "Bill", nicknames: ["빌"], capabilities: [] },
  { id: "steve", display_name: "스티브", capabilities: [] },
  { id: "hermes", display_name: "헤르메스", capabilities: [] },
  { id: "demis", display_name: "데미스", capabilities: [] },
  { id: "coord", display_name: "조율", capabilities: ["coordinator", "restricted_mention"] },
  { id: "guest", display_name: "손님", team_official_member: false },
  { id: "disabled", display_name: "꺼짐", enabled: false },
] as AgentRecord[];

const cases: [string, string[]][] = [
  ["스티브, 빌하고 뭐 해봐", ["steve"]],
  ["빌 스티브랑 데미스랑 뭐 해봐", ["bill"]],
  ["빌, 스티브도 해봐", ["bill", "steve"]],
  ["헤르메스도 이거 들려?", ["hermes"]],
  ["헤르메스야 들려?", ["hermes"]], ["빌은 어때?", ["bill"]], ["빌님 확인", ["bill"]],
  ["빌한테 물어봐", []],
  ...["하고", "랑", "이랑", "한테", "에게", "께", "의", "를", "을", "님께", "님에게", "만"].flatMap(
    (suffix): [string, string[]][] => [
      [`스티브${suffix} 데미스 확인`, []],
      [`빌, 스티브${suffix} 데미스 확인`, ["bill"]],
    ],
  ),
  ...["빌딩", "빌려줘", "스티브잡스", "모두의 마블", "올해"].map(
    (text): [string, string[]] => [text, []],
  ),
  ["헤르메스, 이거 들려?", ["hermes"]], ["헤르메스 이거 들려?", ["hermes"]],
  ["빌도 들려?", ["bill"]], ["빌, 스티브도 들려?", ["bill", "steve"]],
  ["빌도 스티브는 확인", ["bill", "steve"]],
  ...["도", "야", "아", "는", "은", "이", "가", "님", "씨", "님도"].map(
    (suffix): [string, string[]] => [`헤르메스${suffix} 확인해 주세요`, ["hermes"]],
  ),
  ...["빌딩 확인", "빌려 주세요", "스티브잡스 확인", "빌도움 확인", "빌에게서 확인", "빌한테서 확인", "모두의 마블", "올해 새 호출"].map(
    (text): [string, string[]] => [text, []],
  ),
  ["빌, 이거 봐", ["bill"]], ["빌아 들려?", ["bill"]], ["빌야 확인", ["bill"]],
  ["스티브 이거 확인해", ["steve"]], ["데미스님 확인", ["demis"]],
  ["빌.", ["bill"]], ["빌", ["bill"]], [" bill 확인", ["bill"]],
  ["Bill 확인", ["bill"]], ["coord 확인", ["coord"]],
  ["빌, 스티브 확인", ["bill", "steve"]], ["빌아 데미스님 확인", ["bill", "demis"]],
  ["빌, 빌 확인", ["bill"]],
  ["이거 빌 확인해", []], ["빌이 말한 거", ["bill"]], ["스티브가 만든 거", ["steve"]],
  ["빌은 전에 확인", ["bill"]], ["빌의 말한 내용", []], ["빌 말한 거", ["bill"]],
  ["빌드 돌려", []], ["빌아무개 확인", []], ["빌님들 확인", []],
  ["빌~ 확인", ["bill"]], ["빌!\n확인", ["bill"]], ["스티브? 확인", ["steve"]], ["빌아~ 확인", ["bill"]],
  ["빌님~ 확인", ["bill"]], ["빌… 확인", ["bill"]], ["빌, 스티브~ 확인", ["bill", "steve"]],
  ["빌이랑 얘기했어", []], ["빌한테 물어봐", []], ["빌한테~ 물어봐", []], ["빌딩~ 확인", []], ["빌드! 돌려", []],
  ["빌, 확인하고 스티브 봐줘", ["bill"]], ["빌, 스티브가 만든 거", ["bill", "steve"]],
];

describe("선두 이름 호출", () => {
  test("off는 기존 main 호출 및 직전 담당 판정을 보존하고 on으로 복구된다", async () => {
    const previous = process.env.ROUTER_LEADING_NAME_PARTICLES;
    const legacyCases: [string, string[]][] = [
      ["빌, 이거 봐", ["bill"]], ["빌아 들려?", ["bill"]], ["빌야 확인", ["bill"]],
      ["스티브 이거 확인해", ["steve"]], ["데미스님 확인", ["demis"]],
      ["빌~ 확인", ["bill"]], ["스티브! 확인", ["steve"]], ["데미스? 확인", ["demis"]], ["빌아~ 확인", ["bill"]],
      ["빌.", ["bill"]], ["빌", ["bill"]], [" bill 확인", ["bill"]],
      ["Bill 확인", ["bill"]], ["coord 확인", ["coord"]],
      ["빌, 스티브 확인", ["bill", "steve"]], ["빌아 데미스님 확인", ["bill", "demis"]],
      ["빌, 빌 확인", ["bill"]],
      ["이거 빌 확인해", []], ["빌이 말한 거", []], ["스티브가 만든 거", []],
      ["빌은 전에 확인", []], ["빌의 말한 내용", []], ["빌 말한 거", []],
      ["빌드 돌려", []], ["빌아무개 확인", []], ["빌님들 확인", []],
      ["빌, 확인하고 스티브 봐줘", ["bill"]], ["빌, 스티브가 만든 거", ["bill"]],
      ["스티브, 빌하고 뭐 해봐", ["steve"]],
      ["빌 스티브랑 데미스랑 뭐 해봐", ["bill"]],
      ["빌, 스티브도 해봐", ["bill"]],
      ["헤르메스도 이거 들려?", []],
      ["헤르메스야 들려?", ["hermes"]],
      ["빌은 어때?", []], ["빌님 확인", ["bill"]],
      ["빌한테 물어봐", []], ["빌씨 확인", []],
    ];
    try {
      process.env.ROUTER_LEADING_NAME_PARTICLES = "off";
      for (const [text, targets] of legacyCases) {
        expect(detectLeadingNameTargets(text, agents)).toEqual(targets);
        for (const route of [routeTeamMessage, routeTeamMessageHybrid]) {
          const reply = await route(text, agents, { source: "user", replyToAgentId: "demis", activeAssigneeId: "coord" });
          expect(reply.targetAgentIds).toEqual(targets.length ? targets : ["demis"]);
          const sticky = await route(text, agents, { source: "user", activeAssigneeId: "coord" });
          expect(sticky.targetAgentIds).toEqual(targets.length ? targets : ["coord"]);
        }
      }
      for (const mode of ["off", "on"]) {
        process.env.ROUTER_LEADING_NAME_PARTICLES = mode;
        for (const text of ["모두도 확인", "다들도 확인"]) {
          expect(broadcastAudience(text, "user").kind).toBe("none");
          for (const route of [routeTeamMessage, routeTeamMessageHybrid]) {
            expect((await route(text, agents, { source: "user", activeAssigneeId: "coord" })).targetAgentIds).toEqual(["coord"]);
          }
        }
      }
      for (const mode of [undefined, "on"]) {
        if (mode === undefined) delete process.env.ROUTER_LEADING_NAME_PARTICLES;
        else process.env.ROUTER_LEADING_NAME_PARTICLES = mode;
        expect(detectLeadingNameTargets("빌, 스티브도 해봐", agents)).toEqual(["bill", "steve"]);
      }
    } finally {
      if (previous === undefined) delete process.env.ROUTER_LEADING_NAME_PARTICLES;
      else process.env.ROUTER_LEADING_NAME_PARTICLES = previous;
    }
  });
  for (const [text, targets] of cases) {
    test(text, async () => {
      expect(detectLeadingNameTargets(text, agents)).toEqual(targets);
      for (const route of [routeTeamMessage, routeTeamMessageHybrid]) {
        const result = await route(text, agents, { source: "user", replyToAgentId: "demis", activeAssigneeId: "coord" });
        expect(result.targetAgentIds).toEqual(targets.length ? targets : ["demis"]);
        expect(result.reason).toBe(targets.length ? "explicit_mention" : "reply_author");
        const sticky = await route(text, agents, { source: "user", activeAssigneeId: "coord" });
        expect(sticky.targetAgentIds).toEqual(targets.length ? targets : ["coord"]);
        expect(sticky.reason).toBe(targets.length ? "explicit_mention" : "active_assignee_followup");
      }
    });
  }
  test("명시 멘션과 합집합, 전원 마커 우선", async () => {
    for (const route of [routeTeamMessage, routeTeamMessageHybrid]) {
      expect((await route("빌, @스티브 확인", agents, { source: "user" })).targetAgentIds).toEqual(["steve", "bill"]);
      expect((await route("빌, @all 확인", agents, { source: "user" })).targetAgentIds).toEqual(["bill", "steve", "hermes", "demis", "coord"]);
    }
  });
  test("팀원과 발신자 미확인 메시지에는 적용하지 않음", async () => {
    for (const source of ["agent", "system", undefined]) {
      for (const route of [routeTeamMessage, routeTeamMessageHybrid]) {
        for (const text of ["빌, 확인", "모두 확인"]) {
          expect((await route(text, agents, { source, replyToAgentId: "coord" })).targetAgentIds).toEqual(["coord"]);
          expect(broadcastAudience(text, source).kind).toBe("none");
        }
      }
    }
  });
  test("선두 전원 호칭은 게시와 wake가 같은 정식 활성 명부를 사용", async () => {
    for (const word of ["모두", "다들", "전체", "얘들아", "all", "ALL", "All", "올", "여러분"]) {
      for (const suffix of ["", ", 확인", ". 확인", " 확인"]) {
        const text = word + suffix;
        expect(broadcastAudience(text, "user").kind).toBe("all_hands");
        for (const route of [routeTeamMessage, routeTeamMessageHybrid]) {
          const result = await route(text, agents, { source: "user", replyToAgentId: "guest" });
          expect(result.targetAgentIds).toEqual(["bill", "steve", "hermes", "demis", "coord"]);
          expect(result.reason).toBe("broadcast_marker");
        }
      }
    }
    for (const text of ["올해 회의", "allow 확인", "alliance", "여러분의 의견", "이거 모두 확인", "전체적으로 확인", "모두가 말한 거", "모두도 확인", "다들도 확인", "모두의 마블", "```모두 확인```", "예시\n---\n모두 확인"]) {
      expect(broadcastAudience(text, "user").kind).toBe("none");
    }
  });
});

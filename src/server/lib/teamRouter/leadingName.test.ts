import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../../types";
import { broadcastAudience, routeTeamMessage, routeTeamMessageHybrid } from "./ownerDecision";
import { detectLeadingNameTargets } from "./mention";

const agents = [
  { id: "bill", display_name: "Bill", nicknames: ["빌"], capabilities: [] },
  { id: "steve", display_name: "스티브", capabilities: [] },
  { id: "demis", display_name: "데미스", capabilities: [] },
  { id: "coord", display_name: "조율", capabilities: ["coordinator", "restricted_mention"] },
  { id: "guest", display_name: "손님", team_official_member: false },
  { id: "disabled", display_name: "꺼짐", enabled: false },
] as AgentRecord[];

const cases: [string, string[]][] = [
  ["빌, 이거 봐", ["bill"]], ["빌아 들려?", ["bill"]], ["빌야 확인", ["bill"]],
  ["스티브 이거 확인해", ["steve"]], ["데미스님 확인", ["demis"]],
  ["빌.", ["bill"]], ["빌", ["bill"]], [" bill 확인", ["bill"]],
  ["Bill 확인", ["bill"]], ["coord 확인", ["coord"]],
  ["빌, 스티브 확인", ["bill", "steve"]], ["빌아 데미스님 확인", ["bill", "demis"]],
  ["빌, 빌 확인", ["bill"]],
  ["이거 빌 확인해", []], ["빌이 말한 거", []], ["스티브가 만든 거", []],
  ["빌은 전에 확인", []], ["빌의 말한 내용", []], ["빌 말한 거", []],
  ["빌드 돌려", []], ["빌아무개 확인", []], ["빌님들 확인", []],
  ["빌, 확인하고 스티브 봐줘", ["bill"]], ["빌, 스티브가 만든 거", ["bill"]],
];

describe("선두 이름 호출", () => {
  for (const [text, targets] of cases) {
    test(text, async () => {
      expect(detectLeadingNameTargets(text, agents)).toEqual(targets);
      for (const route of [routeTeamMessage, routeTeamMessageHybrid]) {
        const result = await route(text, agents, { source: "user", replyToAgentId: "demis", activeAssigneeId: "coord" });
        expect(result.targetAgentIds).toEqual(targets.length ? targets : ["demis"]);
        expect(result.reason).toBe(targets.length ? "explicit_mention" : "reply_author");
      }
    });
  }
  test("명시 멘션과 합집합, 전원 마커 우선", async () => {
    for (const route of [routeTeamMessage, routeTeamMessageHybrid]) {
      expect((await route("빌, @스티브 확인", agents, { source: "user" })).targetAgentIds).toEqual(["steve", "bill"]);
      expect((await route("빌, @all 확인", agents, { source: "user" })).targetAgentIds).toEqual(["bill", "steve", "demis", "coord"]);
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
          expect(result.targetAgentIds).toEqual(["bill", "steve", "demis", "coord"]);
          expect(result.reason).toBe("broadcast_marker");
        }
      }
    }
    for (const text of ["올해 회의", "allow 확인", "alliance", "여러분의 의견", "이거 모두 확인", "전체적으로 확인", "모두가 말한 거", "```모두 확인```", "예시\n---\n모두 확인"]) {
      expect(broadcastAudience(text, "user").kind).toBe("none");
    }
  });
});

/**
 * Owner routing — GD 라이브 테스트 케이스 회귀 스위트 (2026-06-05).
 *
 * GD 가 텔레그램에서 직접 친 케이스들을 결정론 회귀 테스트로 고정한다.
 * owner 룰(GD 커뮤니케이션 기본룰): @멘션 > 답장(원문작성자) > sticky(이전 owner 유지) > 기본.
 * topic_shift/closure 자동감지는 2026-06-05 제거됨 — owner 는 GD 명시행동(@멘션/답장) 전엔 안 바뀜.
 *
 * 이 7개는 전부 결정론(멘션/답장/sticky)이라 regex 라우터와 hybrid 라우터가 동일 결과를 내야 한다.
 * (hybrid 는 이 신호들에서 LLM 을 타지 않고 early-return → 비결정 exaone 의존 없음)
 *
 * case 6(받은 팀원이 GD 에게 직접 응답 = direct_to_gd 플래그)은 라우팅 결정이 아니라
 * Bill 의 플래그 부착 + 수신자 bridge 동작이라 directReplyFlag.test.ts 에서 별도 검증.
 */
import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../types";
import { routeTeamMessage, routeTeamMessageHybrid, type RouterContext } from "./teamRouter";

const agents: AgentRecord[] = [
  mkAgent("bill", "Bill", "Infra", "claude_channel", "example_dev_bot", "claude-bill"),
  mkAgent("codex", "Codex", "Step", "openclaw", "example_openclaw_bot", null),
  mkAgent("steve", "Steve", "Frontend", "claude_channel", "example_dev_steve_bot", "claude-steve"),
  mkAgent("demis", "Demis", "AI Research", "claude_channel", "example_dev_demis_bot", "claude-demis"),
];

function mkAgent(
  id: string,
  display_name: string,
  role: string,
  runtime: AgentRecord["runtime"],
  telegram_bot_username: string,
  tmux_session: string | null,
): AgentRecord {
  const caps: Record<string, string[]> = {
    codex: ["coordinator", "restricted_mention", "native_routing", "full_context"],
    bill: ["full_context", "recovery"],
    brief: ["non_interactive"],
  };
  const nicks: Record<string, string[]> = {
    bill: ["bill", "빌"],
    codex: ["codex", "코덱스"],
    steve: ["steve", "스티브"],
    demis: ["demis", "데미스"],
  };
  return {
    id,
    display_name,
    nicknames: nicks[id] ?? [id],
    role,
    capabilities: caps[id] ?? [],
    runtime,
    status_provider: runtime === "openclaw" ? "openclaw_gateway" : "claude_tmux",
    tmux_session,
    telegram_bot_username,
    workspace_path: "",
    persona_file: "",
    moderator_eligible: true,
    avatar_emoji: "",
  } as AgentRecord;
}

interface LiveCase {
  n: number;
  label: string;
  text: string;
  ctx: RouterContext;
  expectTargets: string[];
  expectReason: string;
}

// GD 가 실제로 친 메시지/시나리오 그대로.
const CASES: LiveCase[] = [
  {
    n: 1,
    label: "@빌 단독 멘션 → 빌만",
    text: "@빌 테스트 메시지야. 간단응답만",
    ctx: {},
    expectTargets: ["bill"],
    expectReason: "explicit_mention",
  },
  {
    n: 2,
    label: "@코덱스 단독 멘션 → 코덱스만",
    text: "@코덱스 테스트 메시지야 간단 응답",
    ctx: {},
    expectTargets: ["codex"],
    expectReason: "explicit_mention",
  },
  {
    n: 3,
    label: "codex 메시지 답장 + @빌 → 빌만 (멘션이 답장 이김, 오늘의 버그)",
    text: "@빌 코덱스 메시지 답장 테스트야",
    ctx: { replyToAgentId: "codex" },
    expectTargets: ["bill"],
    expectReason: "explicit_mention",
  },
  {
    n: 4,
    label: "codex 메시지 답장 (멘션 없음) → 코덱스 (원문작성자)",
    text: "이건 그냥 답장 테스트",
    ctx: { replyToAgentId: "codex" },
    expectTargets: ["codex"],
    expectReason: "reply_author",
  },
  {
    n: 5,
    label: "@빌 @코덱스 멀티멘션 → 둘 다",
    text: "@빌 @코덱스 2명 @멘션 테스트",
    ctx: {},
    expectTargets: ["bill", "codex"],
    expectReason: "explicit_mention",
  },
  {
    n: 6,
    label: "무멘션 + sticky 단일(bill) → 이전 owner 유지",
    text: "이어서 봐줘",
    ctx: { activeAssigneeIds: ["bill"] },
    expectTargets: ["bill"],
    expectReason: "active_assignee_followup",
  },
  {
    n: 7,
    label: "무멘션 + sticky 복수(bill,codex) → 멀티 owner 유지 (스티키 테스트)",
    text: "스티키 테스트 누가 답을 할까?",
    ctx: { activeAssigneeIds: ["bill", "codex"] },
    expectTargets: ["bill", "codex"],
    expectReason: "active_assignee_followup",
  },
];

describe("owner routing — GD 라이브 케이스 회귀 (결정론)", () => {
  for (const c of CASES) {
    test(`[${c.n}] ${c.label} — regex`, () => {
      const d = routeTeamMessage(c.text, agents, c.ctx);
      expect([...d.targetAgentIds].sort()).toEqual([...c.expectTargets].sort());
      expect(d.reason as string).toBe(c.expectReason);
    });

    test(`[${c.n}] ${c.label} — hybrid (결정론 경로, LLM 미사용)`, async () => {
      const d = await routeTeamMessageHybrid(c.text, agents, c.ctx);
      expect([...d.targetAgentIds].sort()).toEqual([...c.expectTargets].sort());
      expect(d.reason as string).toBe(c.expectReason);
    });
  }

  // --- 오늘 수정(topic_shift/closure 제거) 회귀 가드 ---
  describe("topic_shift/closure 제거 회귀 가드 (2026-06-05)", () => {
    test("주제전환 문구 + sticky → owner 안 바뀜 (sticky 유지)", () => {
      const d = routeTeamMessage("오케이 이건 됐고 다음 거 하자", agents, {
        activeAssigneeIds: ["bill"],
      });
      expect(d.targetAgentIds).toEqual(["bill"]);
      expect(d.reason).toBe("active_assignee_followup");
      expect(d.shouldResetThread).toBe(false);
    });

    test('closure 부정문("안됐어") + sticky → owner 안 바뀜 (옛 됐어$ 오판 버그 회귀)', () => {
      const d = routeTeamMessage("마지막 테스트는 아직 검증 안됐어", agents, {
        activeAssigneeIds: ["bill"],
      });
      expect(d.targetAgentIds).toEqual(["bill"]);
      expect(d.reason).toBe("active_assignee_followup");
    });

    test("종료어 + sticky → owner 안 비움 (closure 자동처리 제거)", () => {
      const d = routeTeamMessage("이건 됐어 그만", agents, { activeAssigneeIds: ["bill"] });
      expect(d.targetAgentIds).toEqual(["bill"]);
      expect(d.reason).toBe("active_assignee_followup");
    });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRecord } from "../types";
import { routeTeamMessage, routeTeamMessageHybrid, detectExplicitTargets, isConfidentOwner, shouldSuppress } from "./teamRouter";

const agents: AgentRecord[] = [
  {
    id: "bill",
    display_name: "Bill",
    nicknames: ["bill", "빌"],
    role: "Infra",
    capabilities: ["full_context", "recovery"],
    runtime: "claude_channel",
    status_provider: "claude_tmux",
    tmux_session: "claude-bill",
    telegram_bot_username: "example_dev_bot",
    workspace_path: "",
    persona_file: "",
    moderator_eligible: true,
    avatar_emoji: "",
  },
  {
    id: "codex",
    display_name: "Codex",
    nicknames: ["codex", "코덱스"],
    role: "Step",
    capabilities: ["coordinator", "restricted_mention", "native_routing", "full_context"],
    runtime: "openclaw",
    status_provider: "openclaw_gateway",
    tmux_session: null,
    telegram_bot_username: "example_openclaw_bot",
    workspace_path: "",
    persona_file: "",
    moderator_eligible: true,
    avatar_emoji: "",
  },
  {
    id: "steve",
    display_name: "Steve",
    nicknames: ["steve", "스티브"],
    role: "Frontend",
    runtime: "claude_channel",
    status_provider: "claude_tmux",
    tmux_session: "claude-steve",
    telegram_bot_username: "example_dev_steve_bot",
    workspace_path: "",
    persona_file: "",
    moderator_eligible: true,
    avatar_emoji: "",
  },
  {
    id: "dbak",
    display_name: "Dbak",
    nicknames: ["dbak", "드박", "디박", "cfo"],
    role: "CFO",
    runtime: "claude_channel",
    status_provider: "claude_tmux",
    tmux_session: "claude-dbak",
    telegram_bot_username: "example_cfo_dbak_bot",
    workspace_path: "",
    persona_file: "",
    moderator_eligible: true,
    avatar_emoji: "",
  },
  {
    id: "brief",
    display_name: "Brief",
    nicknames: ["brief", "브리프"],
    role: "Digest",
    capabilities: ["non_interactive"],
    runtime: "openclaw",
    status_provider: "openclaw_gateway",
    tmux_session: null,
    telegram_bot_username: "example_trend_digest_bot",
    workspace_path: "",
    persona_file: "",
    moderator_eligible: false,
    avatar_emoji: "",
  },
];

function targets(text: string, activeAssigneeId?: string | null) {
  return routeTeamMessage(text, agents, { activeAssigneeId }).targetAgentIds;
}

describe("team router", () => {
  test("defaults unaddressed new topics to Codex", () => {
    const decision = routeTeamMessage("팀 대시보드 업무 리뷰하자", agents);
    expect(decision.targetAgentIds).toEqual(["codex"]);
    expect(decision.reason).toBe("default_step");
  });

  test("routes at-mentions directly", () => {
    expect(targets("@example_dev_steve_bot 버블버블 게임 만들어보자")).toEqual(["steve"]);
    expect(targets("@example_dev_bot @codex 이거 같이 봐줘")).toEqual(["bill", "codex"]);
  });

  test("routes explicit @ aliases", () => {
    expect(targets("@빌, 텔레그램 브리지 확인해줘")).toEqual(["bill"]);
    expect(targets("@Bill 텔레그램 브리지 확인해줘")).toEqual(["bill"]);
    expect(targets("@코덱스 이건 OpenClaw 쪽에서 봐줘")).toEqual(["codex"]);
  });

  test("Codex only wakes on exact allowed mentions", () => {
    expect(targets("빌하고 얘기 중인데 코덱스 설정은 나중에 보자", "bill")).toEqual(["bill"]);
    expect(targets("@코덱스야 이건 봐줘", "bill")).toEqual(["codex"]);
    expect(targets("오케이. @코덱스가 수행해.", "bill")).toEqual(["codex"]);
    expect(targets("@codex 확인해줘", "bill")).toEqual(["codex"]);
    expect(targets("@Codex 확인해줘", "bill")).toEqual(["codex"]);
    expect(targets("@example_openclaw_bot 확인해줘", "bill")).toEqual(["codex"]);
  });

  test("does not route plain mid-sentence names as calls", () => {
    expect(targets("게임을 만들고 싶은데 스티브가 해보자")).toEqual(["codex"]);
  });

  test("keeps active assignee for follow-up answers", () => {
    const decision = routeTeamMessage("버블버블 게임이야", agents, { activeAssigneeId: "steve" });
    expect(decision.targetAgentIds).toEqual(["steve"]);
    expect(decision.reason).toBe("active_assignee_followup");
  });

  test("keeps multi active assignees for follow-up answers", () => {
    const decision = routeTeamMessage("지금 이 메세지는 누가 대답해야지?", agents, {
      activeAssigneeIds: ["bill", "codex"],
    });
    expect(decision.targetAgentIds).toEqual(["bill", "codex"]);
    expect(decision.reason).toBe("active_assignee_followup");
  });

  // 2026-06-05: topic_shift/closure 자동감지 제거(GD). 주제전환 문구가 있어도 owner(sticky)는
  // 명시적 @멘션/답장 전까진 유지된다. 자동 추정으로 codex 로 넘기지 않는다.
  test("topic shift phrase no longer reassigns — sticky persists", () => {
    const decision = routeTeamMessage("오케이 이건 됐고 팀 대시보드 업무 리뷰하자", agents, {
      activeAssigneeId: "steve",
    });
    expect(decision.targetAgentIds).toEqual(["steve"]);
    expect(decision.reason).toBe("active_assignee_followup");
    expect(decision.shouldResetThread).toBe(false);
  });

  test("does not treat historical references as calls", () => {
    expect(targets("빌이 전에 말한 설정 뭐였지?")).toEqual(["codex"]);
    expect(targets("스티브 의견을 요약해줘")).toEqual(["codex"]);
  });

  test("routes domain aliases", () => {
    expect(targets("@CFO 포트폴리오 비중 다시 봐줘")).toEqual(["dbak"]);
    expect(targets("@브리프 이번 주 AI 업데이트 정리해줘")).toEqual(["brief"]);
  });

  test("keeps explicit mention precedence even after a topic shift phrase", () => {
    const decision = routeTeamMessage("오케이 이건 됐고 @빌, team-collab 라우터 봐줘", agents, {
      activeAssigneeId: "steve",
    });
    expect(decision.targetAgentIds).toEqual(["bill"]);
    expect(decision.reason).toBe("explicit_mention");
    expect(decision.shouldResetThread).toBe(false);
  });

  test("ignores stale active assignee ids", () => {
    const decision = routeTeamMessage("이어서 해줘", agents, { activeAssigneeId: "unknown" });
    expect(decision.targetAgentIds).toEqual(["codex"]);
    expect(decision.reason).toBe("default_step");
  });

  test("supports the expected Steve game thread scenario", () => {
    const first = routeTeamMessage("게임을 만들고 싶은데 @스티브가 해보자", agents);
    expect(first.targetAgentIds).toEqual(["steve"]);

    const followup = routeTeamMessage("버블버블 게임이야", agents, { activeAssigneeId: "steve" });
    expect(followup.targetAgentIds).toEqual(["steve"]);

    // 2026-06-05: topic_shift 제거 → 주제전환 문구로도 owner 안 바뀜. sticky=steve 유지.
    const reset = routeTeamMessage("오케이 이건 됐고 팀 대시보드 업무 리뷰하자", agents, {
      activeAssigneeId: "steve",
    });
    expect(reset.targetAgentIds).toEqual(["steve"]);
    expect(reset.shouldResetThread).toBe(false);
  });

  test("routes several natural multi-agent calls", () => {
    expect(targets("@빌, @코덱스 둘 다 이거 봐줘")).toEqual(["bill", "codex"]);
    expect(targets("@스티브, @빌 구현이랑 배포 나눠서 봐줘")).toEqual(["bill", "steve"]);
  });
});

describe("owner inference fallback", () => {
  const originalFetch = globalThis.fetch;

  function mockRouter(reply: Record<string, unknown>): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: { content: JSON.stringify(reply) } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("routes infra/team-collab operations to Bill without explicit mention", async () => {
    mockRouter({ outcome: "route", responder: "bill", domain: "infra_ops", needs_gd_confirm: false });
    const d = await routeTeamMessageHybrid("team-collab 라우터 상태 좀 봐야겠네", agents);
    expect(d.outcome).toBe("route");
    expect(d.reason).toBe("default_intake");
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.domain).toBe("owner_inference:infra_ops");
  });

  test("routes general PM/coordination messages to Codex without explicit mention", async () => {
    mockRouter({ outcome: "route", responder: "codex", domain: "general_pm", needs_gd_confirm: false });
    const d = await routeTeamMessageHybrid("팀원 영입 절차를 정리하고 다음 진행 계획 잡자", agents, {}, { timeoutMs: 10 });
    expect(d.outcome).toBe("route");
    expect(d.reason).toBe("default_step");
    expect(d.targetAgentIds).toEqual(["codex"]);
    expect(d.domain).toBe("owner_inference:general_pm");
  });

  test("delegates unowned owner inference to local LLM using roles instead of default-intake fields", async () => {
    const scoped = agents.map((a) =>
      a.id === "steve"
        ? { ...a, role: "Infra operations and team-collab runtime" }
        : a.id === "dbak"
          ? { ...a, role: "Team PM and coordination" }
          : { ...a },
    );
    const calls: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      calls.push(body.messages[0]?.content ?? "");
      const user = JSON.parse(body.messages[1]?.content ?? "{}") as { new_message?: string };
      const reply = user.new_message?.includes("team-collab")
        ? { outcome: "route", responder: "steve", domain: "ops_from_role", needs_gd_confirm: false }
        : { outcome: "route", responder: "dbak", domain: "pm_from_role", needs_gd_confirm: false };
      return new Response(JSON.stringify({ message: { content: JSON.stringify(reply) } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const infra = await routeTeamMessageHybrid("team-collab 라우터 상태 좀 봐야겠네", scoped, {}, { timeoutMs: 10 });
    expect(infra.targetAgentIds).toEqual(["steve"]);
    expect(infra.domain).toBe("owner_inference:ops_from_role");

    const pm = await routeTeamMessageHybrid("팀원 영입 절차를 정리하고 다음 진행 계획 잡자", scoped, {}, { timeoutMs: 10 });
    expect(pm.targetAgentIds).toEqual(["dbak"]);
    expect(pm.domain).toBe("owner_inference:pm_from_role");
    expect(calls.join("\n")).not.toContain("default_intake_scope=");
    expect(calls.join("\n")).toContain("Infra operations and team-collab runtime");
    expect(calls.join("\n")).toContain("Team PM and coordination");
  });

  test("routes pure decision/approval messages to Codex default owner", async () => {
    mockRouter({ outcome: "ask_gd", suggested: [], domain: "decision", needs_gd_confirm: false });
    const d = await routeTeamMessageHybrid("이건 최종 결정이 필요하겠네", agents, {}, { timeoutMs: 10 });
    expect(d.outcome).toBe("route");
    expect(d.reason).toBe("default_step");
    expect(d.targetAgentIds).toEqual(["codex"]);
  });

  test("marks risky owner-inferred work as needing GD confirmation", async () => {
    mockRouter({ outcome: "route", responder: "bill", domain: "ops", needs_gd_confirm: true });
    const d = await routeTeamMessageHybrid("team-collab 배포하고 서비스 재시작해야겠네", agents);
    expect(d.outcome).toBe("route");
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.needsGdConfirm).toBe(true);
  });

  test("routes ambiguous casual messages to Codex default owner", async () => {
    mockRouter({ outcome: "ask_gd", suggested: [], domain: "ambiguous", needs_gd_confirm: false });
    const d = await routeTeamMessageHybrid("음 이건 좀 애매하네", agents, {}, { timeoutMs: 10 });
    expect(d.outcome).toBe("route");
    expect(d.reason).toBe("default_step");
    expect(d.targetAgentIds).toEqual(["codex"]);
  });

  test("routes unknown @mentions through owner inference when there is no reply or sticky owner", async () => {
    mockRouter({ outcome: "route", responder: "bill", domain: "infra_ops", needs_gd_confirm: false });
    const d = await routeTeamMessageHybrid("@클로드테스트 상태 확인", agents, {}, { timeoutMs: 10 });
    expect(d.outcome).toBe("route");
    expect(d.reason).toBe("default_intake");
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.domain).toBe("owner_inference:infra_ops");
  });

  test("allows role-clear owner inference to mention-only agents", async () => {
    const withTemp: AgentRecord[] = [
      ...agents,
      {
        id: "testclaude",
        display_name: "Claude Temp",
        nicknames: ["testclaude", "클로드테스트"],
        role: "Temporary Claude Channel lifecycle rehearsal member",
        response_mode: "mention-only",
        runtime: "claude_channel",
        status_provider: "claude_tmux",
        tmux_session: "claude-testclaude",
        telegram_bot_username: null,
        workspace_path: "/Users/you/Development/testclaude",
        persona_file: "/Users/you/Development/testclaude/CLAUDE.md",
        moderator_eligible: false,
        avatar_emoji: "T",
      },
    ];
    mockRouter({ outcome: "route", responder: "testclaude", domain: "temp_member", needs_gd_confirm: false });
    const d = await routeTeamMessageHybrid("클로드테스트 상태 확인", withTemp, {}, { timeoutMs: 10 });
    expect(d.outcome).toBe("route");
    expect(d.targetAgentIds).toEqual(["testclaude"]);
    expect(d.domain).toBe("owner_inference:temp_member");
  });
});

// ─── Bug A fix: @all/@b3rys/@group broadcast marker ──────────────────────────
describe("broadcast marker (@all / @b3rys / @group)", () => {
  const ALL_IDS = agents.map((a) => a.id);

  test("@all → targets all agents in roster, reason=broadcast_marker", () => {
    const d = routeTeamMessage("@all 대답해봐", agents);
    expect(d.reason).toBe("broadcast_marker");
    expect(d.targetAgentIds.sort()).toEqual(ALL_IDS.sort());
  });

  test("@b3rys → same as @all", () => {
    const d = routeTeamMessage("@b3rys 이거 봐줘", agents);
    expect(d.reason).toBe("broadcast_marker");
    expect(d.targetAgentIds.sort()).toEqual(ALL_IDS.sort());
  });

  test("@group → same as @all", () => {
    const d = routeTeamMessage("@group 모두 의견 줘", agents);
    expect(d.reason).toBe("broadcast_marker");
    expect(d.targetAgentIds.sort()).toEqual(ALL_IDS.sort());
  });

  test("@ALL case-insensitive", () => {
    const d = routeTeamMessage("@ALL 다 봐줘", agents);
    expect(d.reason).toBe("broadcast_marker");
  });

  test("broadcast_marker takes precedence over explicit_mention", () => {
    // @all + @빌 → broadcast_marker wins (checked first)
    const d = routeTeamMessage("@all @빌 다 봐줘", agents);
    expect(d.reason).toBe("broadcast_marker");
    expect(d.targetAgentIds.sort()).toEqual(ALL_IDS.sort());
  });

  test("broadcast_marker takes precedence over active_assignee_followup", () => {
    const d = routeTeamMessage("@all 의견", agents, { activeAssigneeId: "bill" });
    expect(d.reason).toBe("broadcast_marker");
    expect(d.targetAgentIds.sort()).toEqual(ALL_IDS.sort());
  });

  test("bare 'all' without @ does NOT trigger broadcast_marker", () => {
    const d = routeTeamMessage("all 봐줘", agents);
    expect(d.reason).not.toBe("broadcast_marker");
  });

  test("@alliance does NOT trigger broadcast_marker (word boundary)", () => {
    const d = routeTeamMessage("@alliance 이건 뭐야", agents);
    expect(d.reason).not.toBe("broadcast_marker");
  });
});

// ─── Bug B fix: recipient rows limited to router decision targets ─────────────
// These are unit-level checks on detectExplicitTargets to confirm single vs multi
// results that telegramCapture uses to decide type/to_agent_id/explicit_recipients.
describe("recipient scope (explicit targets count)", () => {
  test("single @mention → 1 target (dm)", () => {
    const t = detectExplicitTargets("@빌 텔레그램 봐줘", agents);
    expect(t).toEqual(["bill"]);
  });

  test("multi @mention → 2 targets (broadcast to those 2)", () => {
    const t = detectExplicitTargets("@빌 @코덱스 둘 다 봐줘", agents);
    expect(t.sort()).toEqual(["bill", "codex"]);
  });

  test("bare name (코덱스, 데미스) without @ → NOT a target (0 explicit targets)", () => {
    // bare names should not create recipient rows via detectExplicitTargets
    const t = detectExplicitTargets("코덱스랑 데미스가 전에 말한 거", agents);
    expect(t).toEqual([]);
  });
});

// ─── reply-owner: 답장은 원문 작성자가 owner (@멘션 > 답장 > sticky) ──────────────
describe("reply-owner (답장 원문 작성자)", () => {
  test("답장(멘션없음) → 원문 작성자가 owner, reason=reply_author", () => {
    const d = routeTeamMessage("확인했어 고마워", agents, { replyToAgentId: "codex" });
    expect(d.targetAgentIds).toEqual(["codex"]);
    expect(d.reason).toBe("reply_author");
  });

  test("@멘션은 답장보다 우선", () => {
    const d = routeTeamMessage("@빌 이거 봐줘", agents, { replyToAgentId: "codex" });
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.reason).toBe("explicit_mention");
  });

  test("답장은 sticky 보다 우선", () => {
    const d = routeTeamMessage("그럼 그렇게 해", agents, {
      replyToAgentId: "steve",
      activeAssigneeId: "bill",
    });
    expect(d.targetAgentIds).toEqual(["steve"]);
    expect(d.reason).toBe("reply_author");
  });

  test("알 수 없는 원문 작성자(GD 본인 답장 등)는 무시 → sticky/default", () => {
    const d = routeTeamMessage("이어서 해줘", agents, {
      replyToAgentId: "gd_user",
      activeAssigneeId: "bill",
    });
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.reason).toBe("active_assignee_followup");
  });

  test("hybrid도 @멘션 > 답장 원문 작성자 > sticky 순서를 지킨다", async () => {
    const replyOwner = await routeTeamMessageHybrid("이건 자기한테 한 메시지인데?", agents, {
      replyToAgentId: "codex",
      activeAssigneeId: "bill",
    });
    expect(replyOwner.targetAgentIds).toEqual(["codex"]);
    expect(replyOwner.reason).toBe("reply_author");

    const explicit = await routeTeamMessageHybrid("@빌 이 부분 확인해줘", agents, {
      replyToAgentId: "codex",
      activeAssigneeId: "steve",
    });
    expect(explicit.targetAgentIds).toEqual(["bill"]);
    expect(explicit.reason).toBe("explicit_mention");
  });
});

// ─── nicknames registry: 별칭 정본 = agents.json nicknames (코드 수정 불필요) ──────
describe("nicknames registry (agents.json 자동 로드)", () => {
  const withNick: AgentRecord[] = [
    { ...(agents[0] as AgentRecord) }, // bill — nicknames(["bill","빌"]) 보유
    {
      id: "hermes",
      display_name: "Hermes",
      nicknames: ["hermes", "헤르메스", "헤르", "cso"],
      role: "CSO",
      runtime: "hermes_agent",
      status_provider: "hermes_gateway",
      tmux_session: null,
      telegram_bot_username: "example_hermes_bot",
      workspace_path: "",
      persona_file: "",
      moderator_eligible: true,
      avatar_emoji: "",
    },
  ];

  test("nicknames 필드의 별칭으로 @멘션 인식 (코드 BUILTIN 없이)", () => {
    expect(detectExplicitTargets("@헤르 이거 봐줘", withNick)).toEqual(["hermes"]);
    expect(detectExplicitTargets("@헤르메스 봐줘", withNick)).toEqual(["hermes"]);
    expect(detectExplicitTargets("@hermes check", withNick)).toEqual(["hermes"]);
  });

  test("nicknames 보유 에이전트는 별칭으로 인식 (BUILTIN_ALIASES 폴백 제거됨)", () => {
    expect(detectExplicitTargets("@빌 봐줘", withNick)).toEqual(["bill"]);
  });
});

// ─── owner-gate regression: 2026-06-02 GD 라이브 검증 세트 (T1~T6) ───────────────
// 그룹 owner-gate(A안) 도입의 근거가 된, GD가 팀방에서 직접 보낸 검증 문장들.
// 게이트는 라우터 결정을 "강제"만 하므로, 이 세트가 green = 게이트가 차단/통과할 정답 기준.
// 주요 라우터/캡처/게이트 수정 배포 전 이 세트를 반드시 돌린다.
describe("owner-gate regression (2026-06-02 GD 검증 세트)", () => {
  test("T1: @빌 단독 → bill (explicit_mention)", () => {
    const d = routeTeamMessage("@빌 라우터 health 한 줄로", agents);
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.reason).toBe("explicit_mention");
  });

  test("T2: @코덱스 단독 → codex, 빌은 침묵 (explicit_mention)", () => {
    const d = routeTeamMessage("@코덱스 검색 인덱스 상태 봐줘", agents);
    expect(d.targetAgentIds).toEqual(["codex"]);
    expect(d.targetAgentIds).not.toContain("bill");
  });

  test("T3: @빌 @코덱스 → 둘 다 (explicit_mention)", () => {
    const d = routeTeamMessage("@빌 @코덱스 게이트 우선순위 의견 줘", agents);
    expect(d.targetAgentIds.sort()).toEqual(["bill", "codex"]);
    expect(d.reason).toBe("explicit_mention");
  });

  test("T4: 코덱스 메시지에 답장(@멘션 없음) → codex, 빌은 침묵 (reply_author)", () => {
    const d = routeTeamMessage("이거 어떻게 처리할까?", agents, { replyToAgentId: "codex" });
    expect(d.targetAgentIds).toEqual(["codex"]);
    expect(d.reason).toBe("reply_author");
    expect(d.targetAgentIds).not.toContain("bill");
  });

  test("T5: 빌 메시지에 답장(@멘션 없음) → bill (reply_author)", () => {
    const d = routeTeamMessage("이 부분 더 줄여줘", agents, { replyToAgentId: "bill" });
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.reason).toBe("reply_author");
  });

  test("T6: 멘션·답장 없음 + sticky=bill → bill (active_assignee_followup)", () => {
    const d = routeTeamMessage("다음 작업 뭐 할까?", agents, { activeAssigneeId: "bill" });
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.reason).toBe("active_assignee_followup");
  });

  test("T7: 멘션·답장 없음 + sticky=bill,codex → 둘 다 owner 유지", () => {
    const d = routeTeamMessage("지금 이 메세지는 누가 대답해야지?", agents, {
      activeAssigneeIds: ["bill", "codex"],
    });
    expect(d.targetAgentIds).toEqual(["bill", "codex"]);
    expect(d.reason).toBe("active_assignee_followup");
  });
});

// ─── 예시 구분선 "—-" 아래 @멘션 억제 (ROUTER_EXAMPLE_SEPARATOR, GD 개인 컨벤션, config-gated) ───
describe("example-separator @멘션 억제 (—- 아래는 예시)", () => {
  const text = "@빌 이건 진짜 호출\n—-\n@코덱스 이건 예시 속 멘션이야";

  test("env on → —- 아래 @멘션은 무시, 위 @멘션만 호출", () => {
    process.env.ROUTER_EXAMPLE_SEPARATOR = "on";
    try {
      expect(detectExplicitTargets(text, agents)).toEqual(["bill"]);
    } finally {
      delete process.env.ROUTER_EXAMPLE_SEPARATOR;
    }
  });

  test("env 미설정(공개 기본) → 억제 없음, 둘 다 호출(false-drop 없음)", () => {
    delete process.env.ROUTER_EXAMPLE_SEPARATOR;
    expect(detectExplicitTargets(text, agents).sort()).toEqual(["bill", "codex"]);
  });

  test("env on이라도 —- 없으면 그대로(영역 밖 @멘션 보존)", () => {
    process.env.ROUTER_EXAMPLE_SEPARATOR = "on";
    try {
      expect(detectExplicitTargets("@빌 @코덱스 둘 다 봐줘", agents).sort()).toEqual(["bill", "codex"]);
    } finally {
      delete process.env.ROUTER_EXAMPLE_SEPARATOR;
    }
  });

  test("env on → ''' ''' 펜스 안 @멘션 무시, 밖 @멘션만 호출", () => {
    process.env.ROUTER_EXAMPLE_SEPARATOR = "on";
    try {
      const t = "@빌 진짜 호출\n예시:\n'''\n@코덱스 펜스 안 멘션\n'''";
      expect(detectExplicitTargets(t, agents)).toEqual(["bill"]);
    } finally {
      delete process.env.ROUTER_EXAMPLE_SEPARATOR;
    }
  });

  test("env 미설정 → ''' ''' 안 @멘션도 그대로 호출(억제 없음)", () => {
    delete process.env.ROUTER_EXAMPLE_SEPARATOR;
    const t = "@빌 호출\n'''\n@코덱스 펜스 안\n'''";
    expect(detectExplicitTargets(t, agents).sort()).toEqual(["bill", "codex"]);
  });
});

// ─── owner-gate suppress 규칙 (커뮤니케이션 룰 spec — 이 블록만 봐도 누가 응답/👀 하는지 보임) ───
// gate(owner-gate/react 훅)는 라우터 reason이 "확실 owner"이고 자기가 targets 에 없으면 응답·👀 차단.
//   확실 owner reason = explicit_mention · reply_author · active_assignee_followup(sticky).
//   추측성(default_intake/default_step)·broadcast_marker·라우터 에러 = fail-open(통과, 👀 유지).
// 배경: v1은 explicit_mention 만 막아 무-@멘션 sticky non-owner(#2066)를 못 막던 갭 → confident owner 로 확장(GD 2080/2082).
describe("owner-gate suppress 규칙 — shouldSuppress 단일 출처 (커뮤니케이션 룰 spec)", () => {
  // 훅(owner-gate/react)은 thin-client로 이 함수 결과만 obey. 이 블록만 봐도 "누가 응답·👀 하나"가 보인다.
  // 억제(suppress) = 확실 owner(explicit_mention·reply_author·active_assignee_followup)가 있는데 내가 그 owner가 아님.
  // 추측성(default_*)·전체(broadcast)·에러 = 억제 안 함(fail-open, false-drop 방지).

  test("isConfidentOwner: 확실 owner reason만 true", () => {
    expect(isConfidentOwner("explicit_mention")).toBe(true);
    expect(isConfidentOwner("reply_author")).toBe(true);
    expect(isConfidentOwner("active_assignee_followup")).toBe(true);
    expect(isConfidentOwner("default_intake")).toBe(false);
    expect(isConfidentOwner("default_step")).toBe(false);
    expect(isConfidentOwner("broadcast_marker")).toBe(false);
  });

  test("@멘션 다른사람 → 비-owner suppress, owner는 통과", () => {
    expect(shouldSuppress("explicit_mention", ["codex"], "bill")).toBe(true);
    expect(shouldSuppress("explicit_mention", ["bill", "codex"], "bill")).toBe(false); // 내가 포함
  });

  test("#2066: sticky(active_assignee_followup)=codex → bill suppress, codex 통과", () => {
    expect(shouldSuppress("active_assignee_followup", ["codex"], "bill")).toBe(true);
    expect(shouldSuppress("active_assignee_followup", ["codex"], "codex")).toBe(false);
  });

  test("답장(reply_author) 다른사람 → 비-owner suppress", () => {
    expect(shouldSuppress("reply_author", ["codex"], "bill")).toBe(true);
  });

  test("추측성 default → 억제 안 함(fail-open)", () => {
    expect(shouldSuppress("default_intake", ["codex"], "bill")).toBe(false);
    expect(shouldSuppress("default_step", ["codex"], "bill")).toBe(false);
  });

  test("broadcast(전체) → 억제 안 함", () => {
    expect(shouldSuppress("broadcast_marker", ["codex", "demis"], "bill")).toBe(false);
  });

  // 라우터 결정이 위 reason을 실제로 내는지 (end-to-end 연결 확인)
  test("#2066 end-to-end: 무-@멘션 + sticky=codex → active_assignee_followup/codex", () => {
    const d = routeTeamMessage("헤르메스 게이트웨이 수정하면 덮어써지나", agents, { activeAssigneeId: "codex" });
    expect(d.targetAgentIds).toEqual(["codex"]);
    expect(d.reason).toBe("active_assignee_followup");
    expect(shouldSuppress(d.reason, d.targetAgentIds, "bill")).toBe(true);
  });

  test("#2113: 설명 문장 속 단독 @는 sticky=codex를 깨지 않음", async () => {
    const d = await routeTeamMessageHybrid(
      '명시적인 @은 붙는거 확인.. 그런데 그 다음 메시지인 "이번엔 sticky 테스트야. 누가 대답할까?" 는 리액션 뿐만 아니라 응답도 안한거임. 처리가 필요함.',
      agents,
      { activeAssigneeId: "codex" },
      { timeoutMs: 10 },
    );
    expect(d.targetAgentIds).toEqual(["codex"]);
    expect(d.reason).toBe("active_assignee_followup");
    expect(shouldSuppress(d.reason, d.targetAgentIds, "bill")).toBe(true);
  });
});

describe("인용/예시 멘션 무시 (stripQuotedForRouting, GD 2026-06-25)", () => {
  test("'—-' 구분선 아래 멘션은 트리거 안 함 — 상단 라이브 멘션만", () => {
    const d = routeTeamMessage("@빌 이거 봐줘\n—-\n@스티브 [붙여넣은 예시] 처리해", agents);
    expect(d.targetAgentIds).toEqual(["bill"]);
  });
  test("코드펜스(''' ''') 안 멘션 무시", () => {
    const d = routeTeamMessage("@빌 확인\n'''\n@스티브 예시 멘션\n'''", agents);
    expect(d.targetAgentIds).toEqual(["bill"]);
  });
  test("펜스 안 @all 은 broadcast 트리거 안 함 (상단 라이브 멘션만)", () => {
    const d = routeTeamMessage('"""\n@all 예시\n"""\n@빌 진짜 작업', agents);
    expect(d.targetAgentIds).toEqual(["bill"]);
  });
  test("인용 없는 일반 @멘션은 그대로 트리거", () => {
    const d = routeTeamMessage("@스티브 이거 해줘", agents);
    expect(d.targetAgentIds).toEqual(["steve"]);
  });
});

describe("hybrid 라우터도 인용/펜스 멘션 무시 (routeTeamMessageHybrid, GD 2026-06-25)", () => {
  test("'—-' 아래 멘션은 hybrid에서도 무시 — 상단 라이브만", async () => {
    const d = await routeTeamMessageHybrid("@빌 확인해줘\n—-\n@코덱스 @스티브 예시 멘션", agents);
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.reason).toBe("explicit_mention");
  });
});

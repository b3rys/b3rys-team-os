// LLM 라우터(EXAONE/Ollama) 통합 테스트 — 논의(multi) vs 구현(single) intent + GD 시나리오.
// Ollama 가 떠 있어야 함. (없으면 regex 폴백 → intent='other' 라 intent 단정은 skip 처리)
import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../types";
import { routeTeamMessageHybrid, routeTeamMessageLLM } from "./teamRouter";

const agents: AgentRecord[] = (
  [
    ["bill", "Bill", "claude_channel", "claude_tmux", "claude-bill", "example_dev_bot"],
    ["codex", "Codex", "openclaw", "openclaw_gateway", null, "example_openclaw_bot"],
    ["steve", "Steve", "claude_channel", "claude_tmux", "claude-steve", "example_dev_steve_bot"],
    ["demis", "Demis", "claude_channel", "claude_tmux", "claude-demis", "example_dev_demis_bot"],
    ["dbak", "Dbak", "claude_channel", "claude_tmux", "claude-dbak", "example_cfo_dbak_bot"],
    ["brief", "Brief", "openclaw", "openclaw_gateway", null, "example_trend_digest_bot"],
  ] as const
).map(([id, dn, rt, sp, tm, tg]) => ({
  id, display_name: dn, role: id, runtime: rt, status_provider: sp,
  nicknames: ({
    bill: ["bill", "빌"], codex: ["codex", "코덱스"], steve: ["steve", "스티브"],
    demis: ["demis", "데미스"], dbak: ["dbak", "드박", "디박", "cfo"], brief: ["brief", "브리프"],
  } as Record<string, string[]>)[id] ?? [id],
  capabilities: ({
    // codex=coordinator(PM/조율 + sync fallback), bill=ambiguous_owner(애매→빌이 GD 께 문의, GD 2026-07-10).
    // 두 capability 를 분리 시드 — defaultIntake 의 애매 라우팅은 ambiguous_owner(빌)를 따른다.
    codex: ["coordinator", "restricted_mention", "native_routing", "full_context"],
    bill: ["ambiguous_owner", "full_context", "recovery"],
    brief: ["non_interactive"],
  } as Record<string, string[]>)[id] ?? [],
  tmux_session: tm, telegram_bot_username: tg, workspace_path: "", persona_file: "",
  moderator_eligible: true, avatar_emoji: "",
} as AgentRecord));

const TIMEOUT = 20_000;

describe("LLM team router (EXAONE)", () => {
  test("explicit name → that agent, execution", async () => {
    const d = await routeTeamMessageLLM("빌 대시보드 좀 고쳐줘", agents);
    expect(d.targetAgentIds).toContain("bill");
    if (d.via === "llm") expect(d.intent).toBe("execution");
  }, TIMEOUT);

  test("opinion question → discussion (multi)", async () => {
    const d = await routeTeamMessageLLM("전용 앱으로 가는 게 맞을까? 의견 줘", agents);
    if (d.via === "llm") expect(d.intent).toBe("discussion");
  }, TIMEOUT);

  test("explicit multi-mention", async () => {
    const d = await routeTeamMessageLLM("빌 코덱스 둘 다 의견 줘", agents);
    expect(d.targetAgentIds).toEqual(expect.arrayContaining(["bill", "codex"]));
  }, TIMEOUT);

  test("unaddressed general → codex default", async () => {
    const d = await routeTeamMessageLLM("팀 업무 진행상황 알려줘", agents);
    expect(d.targetAgentIds).toContain("codex");
  }, TIMEOUT);

  test("finance domain → dbak", async () => {
    const d = await routeTeamMessageLLM("이 사업 투자할 만해?", agents);
    expect(d.targetAgentIds).toContain("dbak");
  }, TIMEOUT);

  test("sticky follow-up keeps active assignee", async () => {
    const d = await routeTeamMessageLLM("버블버블 게임이야", agents, { activeAssigneeId: "steve" });
    expect(d.targetAgentIds).toContain("steve");
  }, TIMEOUT);

  test("topic shift resets sticky", async () => {
    const d = await routeTeamMessageLLM("오케이 이건 됐고 팀 대시보드 리뷰하자", agents, {
      activeAssigneeId: "steve",
    });
    expect(d.targetAgentIds).not.toContain("steve");
  }, TIMEOUT);

  test("returns a usable decision even if Ollama down (fallback)", async () => {
    const d = await routeTeamMessageLLM("아무 메시지", agents);
    expect(Array.isArray(d.targetAgentIds)).toBe(true);
    expect(d.targetAgentIds.length).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ─── HYBRID 라우터: 결정론 신호(명시/주제전환/sticky)는 regex 라 100% 안정. ───
// 도메인만 LLM. → 순수-LLM 변동 케이스를 regex 로 고정해 신뢰도↑.
describe("HYBRID team router (regex 확실신호 + LLM 도메인)", () => {
  // --- 결정론 영역: 매 실행 100% 동일해야 함 ---
  test("[결정론] 명시 이름 → 그 에이전트", async () => {
    const d = await routeTeamMessageHybrid("@빌 대시보드 좀 고쳐줘", agents);
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.reason).toBe("explicit_mention");
  }, TIMEOUT);

  test("[결정론] 명시 멀티멘션", async () => {
    const d = await routeTeamMessageHybrid("@빌 @코덱스 둘 다 의견 줘", agents);
    expect(d.targetAgentIds).toEqual(expect.arrayContaining(["bill", "codex"]));
    expect(d.reason).toBe("explicit_mention");
  }, TIMEOUT);

  test("[결정론] sticky 후속 — 이름없으면 현재담당 유지", async () => {
    const d = await routeTeamMessageHybrid("버블버블 게임이야", agents, { activeAssigneeId: "steve" });
    expect(d.targetAgentIds).toEqual(["steve"]);
    expect(d.reason).toBe("active_assignee_followup");
  }, TIMEOUT);

  // 2026-06-05: topic_shift 자동감지 제거(GD). 주제전환 문구가 있어도 sticky 유지 — owner 안 바뀜.
  test("[결정론] 주제전환 문구 — topic_shift 제거 → sticky 유지", async () => {
    const d = await routeTeamMessageHybrid("오케이 이건 됐고 팀 대시보드 리뷰하자", agents, {
      activeAssigneeId: "steve",
    });
    expect(d.shouldResetThread).toBe(false);
    expect(d.targetAgentIds).toEqual(["steve"]);
    expect(d.reason).toBe("active_assignee_followup");
  }, TIMEOUT);

  test("[결정론] sticky 중 다른 이름 호출 → 그 이름이 sticky 덮음", async () => {
    const d = await routeTeamMessageHybrid("@코덱스 이건 어떻게 생각해?", agents, { activeAssigneeId: "bill" });
    expect(d.targetAgentIds).toEqual(["codex"]);
    expect(d.reason).toBe("explicit_mention");
  }, TIMEOUT);

  test("[결정론] 구현 의도 → execution", async () => {
    const d = await routeTeamMessageHybrid("@빌 이거 배포 스크립트 만들어줘", agents);
    expect(d.intent).toBe("execution");
  }, TIMEOUT);

  // --- 애매(이름없음) → ambiguous_owner(bill) 라우팅 ---
  // GD 2026-07-10 결정: 오너 애매한 메시지는 코덱스(coordinator)가 아니라 빌(ambiguous_owner)이 받아서 GD 께 문의한다.
  // → defaultIntake 의 default/fallback 담당을 coordinator 와 분리(ambiguous_owner capability). 빌 persona 가 "누가 볼지 GD 께 확인" 처리.
  test("[route] 이름없는 도메인 → ambiguous_owner(bill) 라우팅", async () => {
    const d = await routeTeamMessageHybrid("이 사업 투자할 만해?", agents);
    expect(d.outcome).toBe("route");
    expect(d.targetAgentIds).toEqual(["bill"]);
  }, TIMEOUT);

  test("[route] 이름없는 일반/잡담 → ambiguous_owner(bill) 라우팅", async () => {
    const d = await routeTeamMessageHybrid("ㅋㅋ 굿", agents);
    expect(d.outcome).toBe("route");
    expect(d.targetAgentIds).toEqual(["bill"]);
  }, TIMEOUT);

  // 2026-06-05: closure 자동감지 제거(GD). 종료어가 있어도 자동으로 owner 를 비우지 않는다.
  test("[closure 제거] 종료어 있어도 자동 closure 처리 안 함", async () => {
    const d = await routeTeamMessageHybrid(
      "코덱스 지금까지 얘기한 건 해결해서 빌이 처리했어. 더 이상 대답안해도 돼.",
      agents,
    );
    expect(d.outcome).not.toBe("closure"); // closure 자동감지 제거
  }, TIMEOUT);

  test("[closure] 종료어 있어도 새 작업이면 closure 아님", async () => {
    const d = await routeTeamMessageHybrid("@빌 이건 됐고 대시보드 새로 만들어줘", agents);
    expect(d.outcome).not.toBe("closure"); // 새 실행 작업 → 정상 라우팅
    expect(d.targetAgentIds).toContain("bill");
  }, TIMEOUT);

  // --- 위임/중계: 2026-06-05 (GD) 라우터는 좁히지 않는다. @멘션은 최상위 — 잡힌 전원에게 라우팅하고,
  //     "전달해/보고해" 같은 위임·보고 판단은 멘션 받은 에이전트(LLM)가 내용을 읽고 한다. ---
  test("[위임] '@코덱스 @브리프한테 전달' → @멘션 전원 라우팅 (위임 해석은 에이전트)", async () => {
    const d = await routeTeamMessageHybrid("@코덱스. 위 메시지는 @브리프한테 전달해서 의견을 받도록 해", agents);
    expect(d.targetAgentIds).toEqual(expect.arrayContaining(["codex", "brief"]));
    expect(d.reason).toBe("explicit_mention");
    expect(d.domain).not.toContain("delegation"); // 라우터는 위임 좁히기를 하지 않음
  }, TIMEOUT);

  test("[위임] 멀티 fan-out 도 @멘션 전원 라우팅 (보고/컨펌은 에이전트가 내용 보고 판단)", async () => {
    const d = await routeTeamMessageHybrid(
      "@브리프. 내가 어제 알려준 AI 툴 업데이트는 @빌, @코덱스한테도 전달해 주고, @빌 @코덱스는 전달 받아서 어떻게 할 지 나한테 보고해",
      agents,
    );
    expect(d.targetAgentIds).toEqual(expect.arrayContaining(["brief", "bill", "codex"]));
    expect(d.reason).toBe("explicit_mention");
  }, TIMEOUT);

  test("[위임 회귀] 중계동사 없는 멀티멘션은 둘 다 유지", async () => {
    const d = await routeTeamMessageHybrid("@빌 @코덱스 둘 다 의견 줘", agents);
    expect(d.targetAgentIds).toEqual(expect.arrayContaining(["bill", "codex"]));
    expect(d.domain).not.toContain("delegation");
  }, TIMEOUT);

  // GD 2026-07-10: 애매 라우팅 대상 = ambiguous_owner(bill). 이름 나열/스코프 언급뿐인(무-@멘션) 메시지는
  // 특정 스페셜리스트를 깨우지 않고 빌이 받아 GD 께 문의한다.
  // TODO(team-lead): 이름나열-only 메시지 spurious wake — no-prompt wake-guard 후보(후속 과제).
  test("[route] specialist 이름 나열/스코프 언급 → ambiguous_owner(bill) (스페셜리스트는 안 깨움)", async () => {
    const d = await routeTeamMessageHybrid(
      "코덱스만 하는 건 아니고 빌, 코덱스, 스티브, 데미스, 드박이 self-learning 대상이겠지.",
      agents,
    );
    expect(d.targetAgentIds).toEqual(["bill"]);
    expect(d.targetAgentIds).not.toContain("steve");
    expect(d.targetAgentIds).not.toContain("demis");
    expect(d.targetAgentIds).not.toContain("dbak");
  }, TIMEOUT);

  test("[wake guard] specialist 상태 참조는 호출이 아님", async () => {
    const d = await routeTeamMessageHybrid("지금도 Demis 가 일어났네. 라우팅 규칙을 바꾸자.", agents);
    expect(d.targetAgentIds).not.toContain("demis");
  }, TIMEOUT);

  test("[wake guard] specialist 직접 호격+실행동사는 호출", async () => {
    const d = await routeTeamMessageHybrid("@데미스, 이 구조 의견 줘", agents);
    expect(d.targetAgentIds).toEqual(["demis"]);
  }, TIMEOUT);

  test("[fix 2026-05-25] 여러 스페셜리스트 명시 @멘션 → 다 깨움 (lead 한 명만 아님)", async () => {
    const d = await routeTeamMessageHybrid("@드박, @데미스, @스티브 내 말 들려? 들리면 대답해", agents);
    expect(d.targetAgentIds).toEqual(expect.arrayContaining(["dbak", "demis", "steve"]));
  }, TIMEOUT);

  test("[정책 2026-05-26] @멘션 어디서든 우선 — scope단어/나열이어도 명시 @멘션이면 깨움", async () => {
    // GD 정책: 명시 @멘션은 어떤 상황에서도 우선. (bare 이름 나열은 @ 없어 여전히 안 깨움.)
    const d = await routeTeamMessageHybrid("self-learning 대상은 @빌 @드박 @데미스 @스티브 범위로 하자", agents);
    expect(d.targetAgentIds).toEqual(expect.arrayContaining(["dbak", "demis", "steve"]));
  }, TIMEOUT);

  test("[fix 2026-05-26] @멘션 뒤 과거참조('어제')여도 직접 호출이면 깨움 (796 회귀)", async () => {
    const d = await routeTeamMessageHybrid("@데미스 @스티브 이거 보여. 어제 모했어", agents);
    expect(d.targetAgentIds).toEqual(expect.arrayContaining(["demis", "steve"]));
  }, TIMEOUT);

  test("[over-summon] bare 이름(@ 없음) 나열은 안 깨움", async () => {
    const d = await routeTeamMessageHybrid("self-learning 대상은 빌 드박 데미스 스티브 범위로 하자", agents);
    expect(d.targetAgentIds).not.toContain("dbak");
    expect(d.targetAgentIds).not.toContain("demis");
    expect(d.targetAgentIds).not.toContain("steve");
  }, TIMEOUT);

  test("[fix 2026-05-25b] scope단어('정책') 들어가도 명시 요청이면 전원 깨움 (ask_gd 오판 X)", async () => {
    const d = await routeTeamMessageHybrid(
      "@스티브 @데미스 @드박 팀방인데 들리면 답장 간단히 해봐. 각자 팀 정책 오늘 빌이 전파했는데 알고 있어?",
      agents,
    );
    expect(d.targetAgentIds).toEqual(expect.arrayContaining(["steve", "demis", "dbak"]));
  }, TIMEOUT);
});

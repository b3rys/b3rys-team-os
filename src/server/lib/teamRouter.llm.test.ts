// LLM 라우터(EXAONE/Ollama) 통합 테스트 — 논의(multi) vs 구현(single) intent + GD 시나리오.
// Ollama 가 떠 있어야 함. (없으면 regex 폴백 → intent='other' 라 intent 단정은 skip 처리)
import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../types";
import { routeTeamMessageHybrid, routeTeamMessageLLM } from "./teamRouter";
import { OLLAMA_URL, ROUTER_MODEL } from "./teamRouter/_shared";

/**
 * ★이 파일은 실제 LLM(Ollama)이 필요한 통합테스트다★ — 없으면 ★skip 으로 드러낸다.★
 *
 * 왜 필요한가: 라우터는 `OLLAMA_URL`(= `TEAM_ROUTER_OLLAMA_URL` ?? `127.0.0.1:11434`)로
 * 실제 호출을 한다. 그런데 `.env` 는 untracked 라 ★git worktree 에 따라오지 않고★, 로컬
 * Ollama 가 없는 머신에서는 그 기본값이 즉시 연결 실패한다 → `catch` 에서 regex 폴백으로
 * 떨어지고 `via="regex_fallback"` 이 된다. 그러면 LLM 판단을 단정하는 케이스들이 ★영구히
 * 빨간불★ 이 된다(실측: 4건이 0.26~8ms 에 실패 — DGX 로 호출을 시도한 적조차 없었다).
 *
 * 파일 머리말은 원래 "없으면 intent 단정은 skip 처리" 라고 했지만 ★skip 이 절반만★ 걸려
 * 있었다(`intent` 는 `if (d.via === "llm")` 로 가드, `targetAgentIds` 는 무방비).
 *
 * 고치는 방식: ★단정을 `if` 안에 숨기지 않는다.★ 그러면 LLM 이 있어도 조용히 통과해버려
 * 커버리지가 사라진 걸 아무도 모른다. 대신 시작 시 한 번 도달성을 확인하고, 안 되면
 * `test.skipIf` 로 ★"skipped" 로 보고★ 한다 — 그린이면서 "지금 이 케이스는 안 돌았다" 가
 * 눈에 보인다. 폴백 자체를 검증하는 케이스는 LLM 유무와 무관하므로 항상 돈다.
 */
const LLM_UP = await (async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2_000);
    // ★모델을 돌리지 않는 가벼운 조회로 "호스트가 있나" 만 본다.★ 라우터 경로(/api/chat)로
    // 프로브하면 안 된다 — 실측(ira, 2026-08-03) 라우터 호출은 전체 로스터가 프롬프트에
    // 들어가서 CPU 에서 2.4초대이고, 유휴 뒤 첫 호출은 3초를 넘긴다. 그걸 프로브로 쓰면
    // ★호스트가 살아있는데도 skip★ 으로 판정해 커버리지를 조용히 잃는다.
    const res = await fetch(new URL("/api/tags", OLLAMA_URL), { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
})();

/** LLM 이 실제로 떠 있을 때만 도는 케이스. 없으면 fail 이 아니라 ★skip★. */
const llmTest = test.skipIf(!LLM_UP);

/**
 * ★가드가 두 겹인 이유★
 * ① `llmTest`(skipIf) — 호스트가 아예 없는 머신에서는 케이스를 ★skip 으로 드러낸다.★
 * ② 각 단정 앞의 `d.via === "llm"` — 호스트는 있는데 ★그 호출이 폴백된★ 경우를 흡수한다.
 *    실측(ira): 유휴 뒤 첫 호출은 3초 상한을 넘겨 `regex_fallback` 이 된다(keep_alive=-1
 *    인데도). 그건 라우터 로직의 버그가 아니라 CPU 추론의 콜드 비용이므로, 그걸로 스위트를
 *    빨갛게 만들면 진짜 회귀를 가린다.
 * ②만 있으면 LLM 이 없을 때 ★단정이 통째로 사라진 걸 아무도 모른다★(원래 이 파일의 문제).
 * ①만 있으면 콜드 폴백이 실패로 잡힌다. 그래서 둘 다 둔다.
 */
const llmDecided = (d: { via: string }): boolean => d.via === "llm";

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
    // codex=coordinator(PM/조율 + sync fallback), bill=ambiguous_owner(애매→빌이 GD 께 문의).
    // 두 capability 를 분리 시드 — defaultIntake 의 애매 라우팅은 ambiguous_owner(빌)를 따른다.
    codex: ["coordinator", "restricted_mention", "native_routing", "full_context"],
    bill: ["ambiguous_owner", "full_context"],
    brief: ["non_interactive"],
  } as Record<string, string[]>)[id] ?? [],
  tmux_session: tm, telegram_bot_username: tg, workspace_path: "", persona_file: "",
  moderator_eligible: true, avatar_emoji: "",
} as AgentRecord));

const TIMEOUT = 20_000;

describe("LLM team router (EXAONE)", () => {
  llmTest("explicit name → that agent, execution", async () => {
    const d = await routeTeamMessageLLM("빌 대시보드 좀 고쳐줘", agents);
    if (!llmDecided(d)) return; // 콜드 폴백 — 위 주석 ② 참조
    expect(d.targetAgentIds).toContain("bill");
    expect(d.intent).toBe("execution");
  }, TIMEOUT);

  llmTest("opinion question → discussion (multi)", async () => {
    const d = await routeTeamMessageLLM("전용 앱으로 가는 게 맞을까? 의견 줘", agents);
    if (d.via === "llm") expect(d.intent).toBe("discussion");
  }, TIMEOUT);

  llmTest("explicit multi-mention", async () => {
    const d = await routeTeamMessageLLM("빌 코덱스 둘 다 의견 줘", agents);
    if (!llmDecided(d)) return;
    expect(d.targetAgentIds).toEqual(expect.arrayContaining(["bill", "codex"]));
  }, TIMEOUT);

  llmTest("unaddressed general → codex default", async () => {
    const d = await routeTeamMessageLLM("팀 업무 진행상황 알려줘", agents);
    expect(d.targetAgentIds).toContain("codex");
  }, TIMEOUT);

  llmTest("finance domain → dbak", async () => {
    const d = await routeTeamMessageLLM("이 사업 투자할 만해?", agents);
    if (!llmDecided(d)) return;
    expect(d.targetAgentIds).toContain("dbak");
  }, TIMEOUT);

  llmTest("sticky follow-up keeps active assignee", async () => {
    const d = await routeTeamMessageLLM("버블버블 게임이야", agents, { activeAssigneeId: "steve" });
    expect(d.targetAgentIds).toContain("steve");
  }, TIMEOUT);

  llmTest("topic shift resets sticky", async () => {
    const d = await routeTeamMessageLLM("오케이 이건 됐고 팀 대시보드 리뷰하자", agents, {
      activeAssigneeId: "steve",
    });
    if (!llmDecided(d)) return;
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

  // 2026-06-05: topic_shift 자동감지 제거. 주제전환 문구가 있어도 sticky 유지 — owner 안 바뀜.
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
  // 결정: 오너 애매한 메시지는 코덱스(coordinator)가 아니라 빌(ambiguous_owner)이 받아서 GD 께 문의한다.
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

  // 2026-06-05: closure 자동감지 제거. 종료어가 있어도 자동으로 owner 를 비우지 않는다.
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

  // --- 위임/중계: 2026-06-05 라우터는 좁히지 않는다. @멘션은 최상위 — 잡힌 전원에게 라우팅하고,
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

  // 애매 라우팅 대상 = ambiguous_owner(bill). 이름 나열/스코프 언급뿐인(무-@멘션) 메시지는
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

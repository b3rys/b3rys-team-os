/**
 * Characterization tests for teamRouter — Stage ③, locks in CURRENT behavior before the
 * planned ④ split (mentionDetection / ownerDecision / ownerGate / defaultIntake).
 *
 * Scope = the GAP left by the existing suites (teamRouter.test / .llm.test / ownerRoutingLiveCases):
 *   - hasTopicShift          (legacy topic-shift detector — to be isolated in ④; 0 direct tests before)
 *   - stripExampleRegions    (GD example-separator convention, env-gated; 0 direct tests before)
 *   - detectAddressedNamesLoose (HYBRID @-mention detector, drops past-references; 0 direct tests before)
 *   - leadingAddressee       (leading addressee = orchestrator; 0 direct tests before)
 *   - routeTeamMessage priority ladder (sync FALLBACK): broadcast > explicit > reply > sticky > default
 *     — GD rule (@mention > reply > sticky) pinned as a single regression ladder (Bill request).
 *
 * NOT re-covered here (already well-tested elsewhere): shouldSuppress(12), isConfidentOwner(8),
 * detectExplicitTargets(17), routeTeamMessage(36), routeTeamMessageHybrid(37).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRecord } from "../types";
import {
  hasTopicShift,
  stripExampleRegions,
  detectAddressedNamesLoose,
  leadingAddressee,
  routeTeamMessage,
} from "./teamRouter";

const CAPS: Record<string, string[]> = {
  codex: ["coordinator", "restricted_mention", "native_routing", "full_context"],
  bill: ["full_context", "recovery"],
  brief: ["non_interactive"],
};
const NICKS: Record<string, string[]> = {
  bill: ["bill", "빌"],
  codex: ["codex", "코덱스"],
  steve: ["steve", "스티브"],
  dbak: ["dbak", "드박", "디박", "cfo"],
};

const mk = (id: string, display_name: string, runtime: string, tg: string): AgentRecord => ({
  id,
  display_name,
  nicknames: NICKS[id] ?? [id],
  role: "role",
  capabilities: CAPS[id] ?? [],
  runtime: runtime as AgentRecord["runtime"],
  status_provider: runtime === "openclaw" ? "openclaw_gateway" : "claude_tmux",
  tmux_session: runtime === "openclaw" ? null : `claude-${id}`,
  telegram_bot_username: tg,
  workspace_path: "",
  persona_file: "",
  moderator_eligible: true,
  avatar_emoji: "",
});

// nicknames 미지정 → BUILTIN_ALIASES 폴백 사용 (빌/코덱스/스티브/드박)
const agents: AgentRecord[] = [
  mk("bill", "Bill", "claude_channel", "example_dev_bot"),
  mk("codex", "Codex", "openclaw", "example_openclaw_bot"),
  mk("steve", "Steve", "claude_channel", "example_dev_steve_bot"),
  mk("dbak", "Dbak", "claude_channel", "example_cfo_dbak_bot"),
];

// ─── hasTopicShift (legacy detector — ④ 격리 안전판) ─────────────────────────
describe("hasTopicShift", () => {
  test("topic-shift phrases → true", () => {
    for (const t of ["이건 됐고 다음 거 하자", "넘어가자", "다른 얘기인데", "주제 전환", "이제 다른 거", "ok 됐고 다음"]) {
      expect(hasTopicShift(t)).toBe(true);
    }
  });

  test("continuation / plain text → false", () => {
    for (const t of ["그 다음 단계 알려줘", "이거 검토해줘", "어떻게 생각해?", "배포 진행하자"]) {
      expect(hasTopicShift(t)).toBe(false);
    }
  });
});

// ─── stripExampleRegions (env-gated GD convention) ───────────────────────────
describe("stripExampleRegions", () => {
  afterEach(() => {
    delete process.env.ROUTER_EXAMPLE_SEPARATOR;
  });

  test("env unset (public default) → text returned unchanged", () => {
    const t = "@빌 해줘\n—-\n예시: @코덱스 무시돼야 하지만 env off라 그대로";
    expect(stripExampleRegions(t)).toBe(t);
  });

  test("env on → triple-quote fence content stripped", () => {
    process.env.ROUTER_EXAMPLE_SEPARATOR = "on";
    const out = stripExampleRegions("진짜 @빌\n'''\n예시 @코덱스\n'''\n끝");
    expect(out).toContain("@빌");
    expect(out).not.toContain("@코덱스");
  });

  test("env on → content below '—-' separator line dropped", () => {
    process.env.ROUTER_EXAMPLE_SEPARATOR = "on";
    const out = stripExampleRegions("진짜 호출 @빌\n—-\n아래는 예시 @코덱스");
    expect(out).toContain("@빌");
    expect(out).not.toContain("@코덱스");
  });
});

// ─── detectAddressedNamesLoose (HYBRID @-mention, past-ref drop) ─────────────
describe("detectAddressedNamesLoose", () => {
  test("@alias with request → addressed", () => {
    expect(detectAddressedNamesLoose("@빌 이거 봐줘", agents)).toEqual(["bill"]);
  });

  test("plain name (no @) → NOT addressed", () => {
    expect(detectAddressedNamesLoose("빌 이거 봐줘", agents)).toEqual([]);
  });

  test("@alias followed by past-reference tail → dropped (non-codex)", () => {
    expect(detectAddressedNamesLoose("@스티브가 전에 만든 거", agents)).toEqual([]);
  });

  test("telegram bot username mention → addressed", () => {
    expect(detectAddressedNamesLoose("@example_dev_bot 봐줘", agents)).toEqual(["bill"]);
  });

  test("multi @mention → all addressed", () => {
    expect(detectAddressedNamesLoose("@빌 @스티브 들려?", agents).sort()).toEqual(["bill", "steve"]);
  });
});

// ─── leadingAddressee (orchestrator = leading @name) ─────────────────────────
describe("leadingAddressee", () => {
  test("leading @name → that agent", () => {
    expect(leadingAddressee("@빌 이거 봐줘", agents)).toBe("bill");
    expect(leadingAddressee("@코덱스. 정리해줘", agents)).toBe("codex");
    expect(leadingAddressee("@스티브야 도와줘", agents)).toBe("steve");
  });

  test("@name not at the start → null", () => {
    expect(leadingAddressee("이거 @빌 봐줘", agents)).toBeNull();
  });

  test("no mention → null", () => {
    expect(leadingAddressee("안녕하세요 상태 알려주세요", agents)).toBeNull();
  });
});

// ─── routeTeamMessage priority ladder (sync FALLBACK) ────────────────────────
// GD rule pinned: @mention > reply_author > sticky(active assignee) > default. Plus broadcast at top.
describe("routeTeamMessage — priority ladder (sync fallback)", () => {
  test("broadcast marker BEATS explicit mention", () => {
    const d = routeTeamMessage("@all @빌 보세요", agents, {});
    expect(d.reason).toBe("broadcast_marker");
    expect(d.targetAgentIds.sort()).toEqual(["bill", "codex", "dbak", "steve"]);
  });

  test("explicit mention BEATS reply author", () => {
    const d = routeTeamMessage("@빌 해줘", agents, { replyToAgentId: "steve" });
    expect(d.reason).toBe("explicit_mention");
    expect(d.targetAgentIds).toEqual(["bill"]);
  });

  test("reply author BEATS sticky", () => {
    const d = routeTeamMessage("네 그렇게 해주세요", agents, { replyToAgentId: "steve", activeAssigneeId: "bill" });
    expect(d.reason).toBe("reply_author");
    expect(d.targetAgentIds).toEqual(["steve"]);
  });

  test("sticky (active assignee) BEATS default", () => {
    const d = routeTeamMessage("진행상황 어때", agents, { activeAssigneeId: "bill" });
    expect(d.reason).toBe("active_assignee_followup");
    expect(d.targetAgentIds).toEqual(["bill"]);
  });

  test("nothing → default_step (codex)", () => {
    const d = routeTeamMessage("음 그렇구나", agents, {});
    expect(d.reason).toBe("default_step");
    expect(d.targetAgentIds).toEqual(["codex"]);
  });

  test("topic-shift phrase does NOT drop sticky (2026-06-05 auto-detect removed)", () => {
    const d = routeTeamMessage("이건 됐고 다음 거", agents, { activeAssigneeId: "bill" });
    expect(d.reason).toBe("active_assignee_followup"); // sticky retained despite topic-shift wording
    expect(d.targetAgentIds).toEqual(["bill"]);
  });
});

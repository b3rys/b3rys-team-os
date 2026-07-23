import { describe, expect, test } from "bun:test";
import { classifyAll, classifyHealth } from "./health";
import type { AgentStatus, AgentRecord } from "../types";

const claudeAgent = {
  id: "steve", display_name: "Steve", role: "steve", runtime: "claude_channel",
  status_provider: "claude_tmux", tmux_session: "claude-steve", telegram_bot_username: null,
  workspace_path: "", persona_file: "", moderator_eligible: true, avatar_emoji: "",
} as AgentRecord;
const openclawAgent = {
  ...claudeAgent,
  id: "codex",
  display_name: "Codex",
  runtime: "openclaw",
  status_provider: "openclaw_gateway",
  tmux_session: null,
} as AgentRecord;

const now = Date.now();
const mk = (over: Partial<AgentStatus>): AgentStatus => ({
  agent_id: "steve", state: "running", last_activity_at: null, last_log_line: null,
  tmux_pid: 123, ctx_percent: 10, probed_at: new Date(now).toISOString(), ...over,
} as AgentStatus);

describe("classifyHealth", () => {
  // GD 2026-06-26: 빨간 점/위험 라벨은 응답(세션) 기준만. 문맥(ctx)은 level에 반영하지 않고 reason 노트만(노티는 카드 문맥 바).
  test("ctx 95% → 세션 정상이면 level ok 유지 + 문맥 reason만", () => {
    const v = classifyHealth(mk({ ctx_percent: 95 }), claudeAgent, now);
    expect(v.level).toBe("ok");
    expect(v.reasons.some((r) => r.includes("문맥 95%"))).toBe(true);
  });
  test("ctx 80% → level ok 유지 + 문맥 높음 reason", () => {
    const v = classifyHealth(mk({ ctx_percent: 80 }), claudeAgent, now);
    expect(v.level).toBe("ok");
    expect(v.reasons.some((r) => r.includes("문맥 80%"))).toBe(true);
  });
  test("ctx 10% → ok", () => {
    expect(classifyHealth(mk({ ctx_percent: 10 }), claudeAgent, now).level).toBe("ok");
  });
  test("offline → danger", () => {
    expect(classifyHealth(mk({ state: "offline", tmux_pid: null }), claudeAgent, now).level).toBe("danger");
  });
  test("claude 봇 tmux 없음 → danger", () => {
    expect(classifyHealth(mk({ tmux_pid: null }), claudeAgent, now).level).toBe("danger");
  });
  test("probe 5분 전 → 최소 warn", () => {
    const v = classifyHealth(mk({ probed_at: new Date(now - 300_000).toISOString() }), claudeAgent, now);
    expect(["warn", "danger"]).toContain(v.level);
  });
  test("blocked(정상 활동) → ok (노이즈라 안 잡음)", () => {
    expect(classifyHealth(mk({ state: "blocked" }), claudeAgent, now).level).toBe("ok");
  });
  test("blocked + monthly spend limit prompt → danger", () => {
    const v = classifyHealth(
      mk({ state: "blocked", last_log_line: "You've hit your monthly spend limit.", ctx_percent: 89 }),
      claudeAgent,
      now,
    );
    expect(v.level).toBe("danger");
    expect(v.livenessLevel).toBe("ok");
    expect(v.capacityLevel).toBe("danger");
    expect(v.capacityStatus).toBe("limit");
    expect(v.capacityLabel).toBe("리밋");
    expect(v.reasons[0]).toBe("Claude 리밋");
  });
  test("weekly limit prompt → capacity danger even while liveness is running", () => {
    const v = classifyHealth(
      mk({ state: "running", last_log_line: "You've hit your weekly limit.", ctx_percent: 12 }),
      claudeAgent,
      now,
    );
    expect(v.level).toBe("danger");
    expect(v.livenessLevel).toBe("ok");
    expect(v.capacityLevel).toBe("danger");
    expect(v.capacityStatus).toBe("limit");
    expect(v.capacityLabel).toBe("리밋");
  });
  test("Now using usage credits → capacity danger with short credits label", () => {
    const v = classifyHealth(
      mk({ state: "running", last_log_line: "Now using usage credits.", ctx_percent: 12 }),
      claudeAgent,
      now,
    );
    expect(v.level).toBe("danger");
    expect(v.livenessLevel).toBe("ok");
    expect(v.capacityLevel).toBe("danger");
    expect(v.capacityStatus).toBe("usage_credits");
    expect(v.capacityLabel).toBe("크레딧 사용");
  });
  test("confirm prompt that can hold an agent open → danger", () => {
    const v = classifyHealth(
      mk({ state: "blocked", last_log_line: "Enter to confirm · Esc to cancel" }),
      claudeAgent,
      now,
    );
    expect(v.level).toBe("danger");
  });
  test("openclaw response timeout → warn", () => {
    const v = classifyHealth(
      mk({ agent_id: "codex", state: "blocked", last_log_line: "openclaw runtime openclaw response timeout", tmux_pid: null }),
      openclawAgent,
      now,
    );
    expect(v.level).toBe("warn");
    expect(v.reasons.join(" ")).toContain("OpenClaw 최근 응답 지연");
  });
  test("openclaw turn_failed → danger", () => {
    const v = classifyHealth(
      mk({ agent_id: "codex", state: "blocked", last_log_line: "openclaw runtime turn_failed:failed", tmux_pid: null }),
      openclawAgent,
      now,
    );
    expect(v.level).toBe("danger");
    expect(v.reasons.join(" ")).toContain("OpenClaw 턴 실패");
  });
  test("codex/openai quota failure → danger", () => {
    const v = classifyHealth(
      mk({ agent_id: "cody", state: "blocked", last_log_line: "codex runtime failed: 429 rate limit", tmux_pid: null }),
      { ...openclawAgent, id: "cody", runtime: "codex", status_provider: "codex_cli" } as AgentRecord,
      now,
    );
    expect(v.level).toBe("danger");
    expect(v.reasons.join(" ")).toContain("Codex/OpenAI");
  });
  test("codex telegram bridge marker missing → warn (bus runner와 분리)", () => {
    const v = classifyHealth(
      mk({ agent_id: "cody", state: "blocked", last_log_line: "codex telegram bridge marker missing", tmux_pid: null }),
      { ...openclawAgent, id: "cody", runtime: "codex", status_provider: "codex_cli" } as AgentRecord,
      now,
    );
    expect(v.level).toBe("warn");
    expect(v.reasons.join(" ")).toContain("Codex Telegram 브리지 점검");
  });
  test("codex runtime failed without quota words → danger", () => {
    const v = classifyHealth(
      mk({ agent_id: "cody", state: "blocked", last_log_line: "codex runtime failed: exit_1", tmux_pid: null }),
      { ...openclawAgent, id: "cody", runtime: "codex", status_provider: "codex_cli" } as AgentRecord,
      now,
    );
    expect(v.level).toBe("danger");
    expect(v.reasons.join(" ")).toContain("Codex 런타임 실패");
  });
  test("codex exit_0 empty reply는 OpenAI 한도/런타임 사망으로 보지 않음", () => {
    const v = classifyHealth(
      mk({ agent_id: "cody", state: "blocked", last_log_line: "codex runtime failed: exit_0", tmux_pid: null }),
      { ...openclawAgent, id: "cody", runtime: "codex", status_provider: "codex_cli" } as AgentRecord,
      now,
    );
    expect(v.level).toBe("ok");
    expect(v.reasons.join(" ")).not.toContain("Codex/OpenAI");
    expect(v.reasons.join(" ")).not.toContain("Codex 런타임 실패");
  });
  test("OpenAI라는 단어가 작업 제목에 있을 뿐이면 한도 danger로 보지 않음", () => {
    const v = classifyHealth(
      mk({ state: "blocked", last_log_line: "general-purpose Research OpenAI + frameworks agent loops" }),
      claudeAgent,
      now,
    );
    expect(v.level).toBe("ok");
    expect(v.reasons.join(" ")).not.toContain("Codex/OpenAI");
  });
  test("ctx null + running + tmux 있음 → ok", () => {
    expect(classifyHealth(mk({ ctx_percent: null }), claudeAgent, now).level).toBe("ok");
  });
});

describe("classifyAll", () => {
  test("비정식 agent와 registry에 없는 stale status는 팀 health에서 제외", () => {
    const nonOfficial = { ...openclawAgent, id: "dex", team_official_member: false } as AgentRecord;
    const verdicts = classifyAll(
      [
        mk({ agent_id: "steve" }),
        mk({ agent_id: "dex", state: "offline", last_log_line: "codex telegram bridge pid invalid" }),
        mk({ agent_id: "removed", state: "offline" }),
      ],
      [claudeAgent, nonOfficial],
      now,
    );
    expect(verdicts.map((v) => v.agentId)).toEqual(["steve"]);
  });

  test("Claude usage limit은 해당 팀원만 danger로 표시하고 다른 Claude 팀원에는 전파하지 않음", () => {
    const otherClaude = { ...claudeAgent, id: "demis", display_name: "Demis" } as AgentRecord;
    const verdicts = classifyAll(
      [
        mk({ agent_id: "steve", state: "blocked", last_log_line: "You've hit your monthly spend limit." }),
        mk({ agent_id: "demis", state: "blocked", last_log_line: "  -- INSERT --" }),
        mk({ agent_id: "codex", state: "idle", last_log_line: "gateway healthy", tmux_pid: null }),
      ],
      [claudeAgent, otherClaude, openclawAgent],
      now,
    );
    expect(verdicts.find((v) => v.agentId === "steve")?.level).toBe("danger");
    expect(verdicts.find((v) => v.agentId === "demis")?.level).toBe("ok");
    expect(verdicts.find((v) => v.agentId === "demis")?.reasons.join(" ")).not.toContain("Claude 한도 대기");
    expect(verdicts.find((v) => v.agentId === "codex")?.level).toBe("ok");
  });
});

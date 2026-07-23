import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../types";
import { learningLoopPmId } from "./capabilities";

function agent(id: string, capabilities: string[] = []): AgentRecord {
  return {
    id,
    display_name: id,
    role: "test",
    runtime: "openclaw",
    status_provider: "openclaw_gateway",
    tmux_session: null,
    telegram_bot_username: null,
    workspace_path: "/tmp",
    persona_file: "/tmp/SOUL.md",
    moderator_eligible: true,
    avatar_emoji: "T",
    capabilities,
  };
}

describe("learningLoopPmId", () => {
  test("learning_loop_pm capability 보유자를 우선한다", () => {
    const agents = [agent("coord", ["coordinator"]), agent("pm", ["learning_loop_pm"])];
    expect(learningLoopPmId(agents)).toBe("pm");
  });

  test("learning_loop_pm 이 없으면 coordinator 로 fallback 한다", () => {
    const agents = [agent("coord", ["coordinator"]), agent("worker")];
    expect(learningLoopPmId(agents)).toBe("coord");
  });
});

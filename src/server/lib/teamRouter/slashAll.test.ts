import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../../types";
import { isConfidentOwner, routeTeamMessage, routeTeamMessageHybrid } from "../teamRouter";

const mk = (id: string, name: string, nick: string, extra: Partial<AgentRecord> = {}) =>
  ({ id, display_name: name, nicknames: [nick], role: "r", capabilities: [], runtime: "claude_channel", enabled: true, ...extra }) as unknown as AgentRecord;
const agents = [mk("bill", "Bill", "빌", { telegram_bot_username: "bill_test_bot" }), mk("dex", "Dex", "덱스"), mk("off", "Off", "오프", { enabled: false })];
const ALL = ["bill", "dex"];
const user = { source: "user" };

describe("/all recognition", () => {
  for (const text of ["/all", "/all@martin_bot", "/all 회의 시작합니다", "  /ALL 대문자도", "/all\n두 줄 본문"]) {
    test(`"${text.replace("\n", "\\n")}" → post only, whole roster is the audience, nobody woken`, () => {
      const d = routeTeamMessage(text, agents, user);
      expect(d.reason).toBe("broadcast_post_only");
      expect(d.targetAgentIds).toEqual([]);
      expect(d.postOnly?.audienceIds).toEqual(ALL);
      expect(isConfidentOwner(d.reason)).toBe(false);
    });
  }

  test("a teammate's /all is ignored", () => {
    for (const source of [undefined, "agent", "bill"]) {
      const d = routeTeamMessage("/all 공지", agents, { source });
      expect(d.postOnly).toBeUndefined();
      expect(d.reason).not.toBe("broadcast_post_only");
    }
  });

  test("/all inside a code fence or below a separator is ignored", () => {
    expect(routeTeamMessage("예시입니다\n```\n/all 공지\n```", agents, user).postOnly).toBeUndefined();
    expect(routeTeamMessage("본문\n---\n/all 공지", agents, user).postOnly).toBeUndefined();
  });

  test("not a command: /allegro, /all in mid-sentence, path-like", () => {
    for (const text of ["/allegro 안녕", "여기서 /all 을 쓰면", "/all/b", "all 안녕"]) {
      expect(routeTeamMessage(text, agents, user).postOnly).toBeUndefined();
    }
  });
});

describe("/all with names", () => {
  test("@name and leading name wake only that member; audience stays everyone", () => {
    for (const text of ["/all @빌 확인해줘", "/all 빌, 확인해줘", "/all@martin_bot @bill_test_bot 확인"]) {
      const d = routeTeamMessage(text, agents, user);
      expect(d.targetAgentIds).toEqual(["bill"]);
      expect(d.postOnly?.audienceIds).toEqual(ALL);
      expect(d.reason).toBe("explicit_mention");
    }
  });

  test("a name in the middle of a plain sentence does not wake anyone", () => {
    const d = routeTeamMessage("/all 어제 빌이 만든 문서 공유", agents, user);
    expect(d.targetAgentIds).toEqual([]);
    expect(d.postOnly?.audienceIds).toEqual(ALL);
  });

  test("/all wins over @all in the same message (no wake-all)", () => {
    const d = routeTeamMessage("/all @all 공지", agents, user);
    expect(d.reason).toBe("broadcast_post_only");
    expect(d.targetAgentIds).toEqual([]);
  });

  test("a disabled member is not in the audience nor woken by name", () => {
    const d = routeTeamMessage("/all @오프 확인", agents, user);
    expect(d.postOnly?.audienceIds).toEqual(ALL);
    expect(d.targetAgentIds).toEqual([]);
  });
});

describe("/all through the hybrid router", () => {
  test("same decision, outcome=route, no LLM needed", async () => {
    const d = await routeTeamMessageHybrid("/all 공지", agents, user, { timeoutMs: 5 });
    expect(d.outcome).toBe("route");
    expect(d.reason).toBe("broadcast_post_only");
    expect(d.targetAgentIds).toEqual([]);
    expect(d.postOnly?.audienceIds).toEqual(ALL);
    const named = await routeTeamMessageHybrid("/all @덱스 봐줘", agents, user, { timeoutMs: 5 });
    expect(named.targetAgentIds).toEqual(["dex"]);
    expect(named.postOnly?.audienceIds).toEqual(ALL);
  });

  test("teammate /all is not post-only", async () => {
    const d = await routeTeamMessageHybrid("/all 공지", agents, { source: "agent" }, { timeoutMs: 5 });
    expect(d.postOnly).toBeUndefined();
  });
});

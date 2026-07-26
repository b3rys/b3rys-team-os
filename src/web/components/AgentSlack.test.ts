import { describe, expect, test } from "bun:test";
import { socketManifest } from "./AgentSlack";

/* 2026-07-26: 공개 URL 이 없을 때 서버가 event_subscriptions 를 통째로 빼도록 고쳤더니, Socket 매니페스트에
 * ★app_mention 구독이 사라졌다.★ 그러면 사용자는 앱을 만들 수는 있는데 ★봇이 멘션에 반응하지 않는다.★
 * scope(app_mentions:read)만으로는 이벤트가 오지 않는다 — 구독이 함께 있어야 한다.
 * 여기서는 ★사용자가 실제로 붙여넣는 최종 JSON★ 을 검증한다(중간 단계가 아니라). */
describe("socketManifest — 사용자가 붙여넣는 최종 JSON", () => {
  const base = (withUrl: boolean) => ({
    display_information: { name: "gd lisa" },
    features: { bot_user: { display_name: "gd_lisa", always_online: true } },
    oauth_config: { scopes: { bot: ["app_mentions:read", "chat:write"] } },
    settings: {
      event_subscriptions: { ...(withUrl ? { request_url: "https://x.test/team/api/slack/events" } : {}), bot_events: ["app_mention"] },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
    },
  });

  test("★공개 URL 이 없어도 app_mention 구독이 남는다★ (없으면 봇이 멘션을 못 받는다)", () => {
    const m = socketManifest(base(false)) as any;
    expect(m.settings.socket_mode_enabled).toBe(true);
    expect(m.settings.event_subscriptions?.bot_events).toEqual(["app_mention"]);
    expect(m.settings.event_subscriptions?.request_url).toBeUndefined();
  });

  test("공개 URL 이 있어도 Socket 변환은 request_url 만 지운다", () => {
    const m = socketManifest(base(true)) as any;
    expect(m.settings.event_subscriptions?.bot_events).toEqual(["app_mention"]);
    expect(m.settings.event_subscriptions?.request_url).toBeUndefined();
    expect(m.oauth_config.scopes.bot).toContain("app_mentions:read");
  });
});

import { describe, expect, test } from "bun:test";
import { socketManifest, webhookBlockedNotice } from "./AgentSlack";

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

/* ★네 사분면 중 하나(공개URL 없음 × Event URL)를 아무도 안 찍어봤다★ — #73 을 놓친 것과 같은 종류의
 * 사각이다. 그 조합의 매니페스트는 Slack 이 거부한다:
 *   "Event Subscription requires either Request URL or Socket Mode Enabled"
 * request_url 도 없고 socket_mode_enabled 도 false 면 event_subscriptions 블록 자체가 불법이다.
 * 그래서 화면에서 그 조합을 못 고르게 막았고, 여기서는 ★왜 막아야 하는지(=불법 조합)★ 를 고정한다. */
describe("공개 URL 없이 Event URL 모드 — Slack 이 거부하는 조합", () => {
  const serverManifest = (withUrl: boolean) => ({
    settings: {
      event_subscriptions: { ...(withUrl ? { request_url: "https://x.test/e" } : {}), bot_events: ["app_mention"] },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
    },
  });
  // Slack 규격: event_subscriptions 가 있으면 request_url 또는 socket_mode_enabled 중 하나는 있어야 한다.
  const slackAccepts = (m: any): boolean => {
    const ev = m?.settings?.event_subscriptions;
    if (!ev) return true;
    return Boolean(ev.request_url) || m?.settings?.socket_mode_enabled === true;
  };

  test("★공개 URL 없음 × Event URL = 거부되는 조합★ (그래서 화면에서 막는다)", () => {
    expect(slackAccepts(serverManifest(false))).toBe(false);
  });

  test("나머지 세 조합은 통과한다", () => {
    expect(slackAccepts(serverManifest(true))).toBe(true);                          // URL 있음 × Event URL
    expect(slackAccepts(socketManifest(serverManifest(false)))).toBe(true);         // URL 없음 × Socket
    expect(slackAccepts(socketManifest(serverManifest(true)))).toBe(true);          // URL 있음 × Socket
  });
});

/* ★안내는 그 사람이 실제로 할 수 있는 행동이어야 한다.★
 * 처음엔 "Socket Mode 를 선택하세요" 라고 썼는데, 방식 선택 토글을 없앤 뒤라 ★고를 버튼이 없었다★ —
 * 막다른 안내였다(코덱스 리뷰). 오늘 하루 우리가 고친 게 정확히 그 형태인데 내가 다시 만들었다. */
describe("webhookBlockedNotice — 실행 가능한 행동만 안내한다", () => {
  test("★기존 Event URL 멤버 + 공개 URL 없음 → 공개 주소 설정을 안내★", () => {
    const n = webhookBlockedNotice("webhook", null);
    expect(n).toBeTruthy();
    expect(n).toContain("TEAM_PUBLIC_BASE_URL");
    // ★없는 버튼을 누르라고 하지 않는다★ — 토글은 제거됐다
    expect(n).not.toContain("Socket Mode 를 선택");
    expect(n).not.toContain("choose Socket Mode");
  });

  test("공개 URL 이 있으면 막지 않는다", () => {
    expect(webhookBlockedNotice("webhook", "https://x.test/e")).toBeNull();
  });

  test("Socket 모드는 공개 URL 과 무관하게 막지 않는다", () => {
    expect(webhookBlockedNotice("socket", null)).toBeNull();
    expect(webhookBlockedNotice("socket", "https://x.test/e")).toBeNull();
  });
});

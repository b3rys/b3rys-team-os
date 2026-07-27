import { describe, expect, test } from "bun:test";
import { socketManifest, webhookBlockedNotice, wizardSteps } from "./AgentSlack";

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
      ...(withUrl ? { event_subscriptions: { request_url: "https://x.test/team/api/slack/events", bot_events: ["app_mention"] } } : {}),
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

/* ★네 사분면 중 하나(공개URL 없음 × Event URL)를 아무도 안 찍어봤다★ — #73 을 놓친 것과 같은 사각이다.
 * 그 조합의 매니페스트는 Slack 이 거부한다:
 *   "Event Subscription requires either Request URL or Socket Mode Enabled"
 *
 * ★그런데 앞선 판의 이 테스트는 손으로 쓴 픽스처만 검사했다★ — "그 조합은 불법이다" 는 알지만
 * ★서버가 실제로 그걸 내보내는지는 아무도 안 봤다.★ 그래서 #74 가 불법 매니페스트를 내보내게 됐는데도
 * 여기는 초록이었다(2026-07-27 Steve 리뷰). 실제 서버 출력에 대한 검증은 settings.test.ts 에 있다.
 * 여기서는 ★클라이언트 변환(socketManifest)이 어떤 입력을 받아도 유효한 결과를 낸다★ 를 고정한다. */
describe("Slack 규격 — 어떤 입력이 와도 최종 JSON 은 유효해야 한다", () => {
  // Slack 규격: event_subscriptions 가 있으면 request_url 또는 socket_mode_enabled 중 하나는 있어야 한다.
  const slackAccepts = (m: any): boolean => {
    const ev = m?.settings?.event_subscriptions;
    if (!ev) return true;
    return Boolean(ev.request_url) || m?.settings?.socket_mode_enabled === true;
  };

  // 서버가 낼 수 있는 두 형태 (수정 후: URL 없으면 블록 자체가 없다)
  const serverWithUrl = { settings: { event_subscriptions: { request_url: "https://x.test/e", bot_events: ["app_mention"] }, org_deploy_enabled: false, socket_mode_enabled: false } };
  const serverNoUrl = { settings: { org_deploy_enabled: false, socket_mode_enabled: false } };

  test("webhook 매니페스트는 두 경우 다 유효하다", () => {
    expect(slackAccepts(serverWithUrl)).toBe(true);   // URL 있음 → request_url 로 성립
    expect(slackAccepts(serverNoUrl)).toBe(true);     // URL 없음 → 블록이 없어서 성립
  });

  test("★Socket 변환은 서버가 블록을 안 줘도 구독을 만들어 넣는다★ (보존이 아니라 주입)", () => {
    const m = socketManifest(serverNoUrl) as any;
    expect(m.settings.socket_mode_enabled).toBe(true);
    expect(m.settings.event_subscriptions?.bot_events).toEqual(["app_mention"]);  // ← 없으면 멘션 못 받는다
    expect(slackAccepts(m)).toBe(true);
  });

  test("Socket 변환은 URL 이 있던 경우에도 유효하다", () => {
    const m = socketManifest(serverWithUrl) as any;
    expect(m.settings.event_subscriptions?.request_url).toBeUndefined();
    expect(m.settings.event_subscriptions?.bot_events).toEqual(["app_mention"]);
    expect(slackAccepts(m)).toBe(true);
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

/* ★안내에서 '이벤트 구독 켜기' 단계가 통째로 빠져 있었다★ (2026-07-27 GD 실측 — 리사 앱을 만들다 헤맸다).
 * 매니페스트에는 app_mention 이 들어 있다. 그런데 ★매니페스트에 있다는 것과 그 앱에서 켜져 있다는 것은 다르다★ —
 * GD 는 Slack 화면에서 직접 Enable Events 토글을 올려야 했다. 꺼져 있으면 ★봇이 멘션을 무시하고 오류도 안 난다.★
 * 오늘 하루 반복된 형태 그대로다: 있는데 도달하지 못한다. 그래서 ★안내 문구 자체를 회귀로 고정한다.★ */
describe("wizardSteps — 이벤트 구독 켜는 단계가 반드시 있다", () => {
  const opts = { appLink: "<a>apps</a>", scopes: "app_mentions:read, chat:write", channel: "#team", eventUrl: "https://x.test/team/api/slack/events" };
  const joined = (isSocket: boolean) => wizardSteps({ ...opts, isSocket }).join("\n");

  for (const isSocket of [true, false]) {
    const label = isSocket ? "Socket Mode" : "Event URL";

    test(`★${label}: Enable Events → app_mention → Save 순서가 안내된다★`, () => {
      const s = joined(isSocket);
      expect(s).toContain("Enable Events");          // ← 토글을 켜라는 말이 없으면 사용자는 못 찾는다
      expect(s).toContain("Subscribe to bot events");
      expect(s).toContain("app_mention");
      expect(s).toContain("Save Changes");           // ← 저장 안 하면 위를 다 해도 적용 안 된다
    });

    test(`${label}: 단계는 앱 생성 → 이벤트 구독 순서다 (앱이 없으면 켤 화면이 없다)`, () => {
      const steps = wizardSteps({ ...opts, isSocket });
      const created = steps.findIndex((x) => x.includes("From a manifest"));
      const events = steps.findIndex((x) => x.includes("Enable Events"));
      expect(created).toBeGreaterThanOrEqual(0);
      expect(events).toBeGreaterThan(created);
    });

    test(`${label}: 채널 초대·토큰 복사 단계는 그대로 남아 있다 (단계 추가가 기존 안내를 밀어내지 않는다)`, () => {
      const s = joined(isSocket);
      expect(s).toContain("/invite");
      expect(s).toContain("xoxb");
    });
  }

  test("Socket 방식만 App-Level Token(xapp) 단계를 안내한다", () => {
    expect(joined(true)).toContain("xapp");
    expect(joined(false)).not.toContain("xapp");
  });

  test("Event URL 방식은 Request URL 등록 단계를 유지한다", () => {
    expect(joined(false)).toContain("Request URL");
  });
});

/* ★단계를 추가하면서 순서를 틀릴 뻔했다★ — 처음엔 'Enable Events' 를 2번, 'Request URL 등록' 을 마지막 6번에
 * 뒀다. 그런데 Event URL 방식은 Enable Events 를 켜는 순간 Slack 이 ★Request URL 검증부터★ 요구한다.
 * 그 순서면 사용자는 2번에서 저장을 못 하고 막힌 채 6번을 못 본다 — ★고치려던 것과 똑같은 막다른 안내★ 다.
 * 그래서 한 단계로 합쳤고, 여기서 그걸 고정한다. */
describe("wizardSteps — Event URL 방식은 URL 검증이 구독 저장보다 먼저다", () => {
  const base = { appLink: "<a>apps</a>", scopes: "chat:write", channel: "#team" };
  const url = "https://x.test/team/api/slack/events";

  test("★Enable Events 와 Request URL 은 같은 단계다★ (쪼개면 저장에서 막힌다)", () => {
    const steps = wizardSteps({ ...base, isSocket: false, eventUrl: url });
    const step = steps.find((s) => s.includes("Enable Events"));
    expect(step).toBeTruthy();
    expect(step).toContain("Request URL");
    expect(step).toContain(url);                       // 값까지 그 자리에 있어야 복붙으로 끝난다
    expect(step!.indexOf("Request URL")).toBeLessThan(step!.indexOf("Save Changes"));
  });

  test("Request URL 안내는 한 번만 나온다 (중복 단계가 남아 있지 않다)", () => {
    const steps = wizardSteps({ ...base, isSocket: false, eventUrl: url });
    expect(steps.filter((s) => s.includes("Request URL")).length).toBe(1);
  });

  test("공개 URL 이 아직 없으면 값 대신 어디서 찾는지 안내한다", () => {
    const step = wizardSteps({ ...base, isSocket: false, eventUrl: null }).find((s) => s.includes("Enable Events"));
    expect(step).toContain("Event URL");
    expect(step).not.toContain("null");                 // ★빈 값을 그대로 그리지 않는다★
  });

  test("★Socket 방식엔 Request URL 이 아예 안 나온다★ (없는 걸 시키면 막다른 안내다)", () => {
    const steps = wizardSteps({ ...base, isSocket: true, eventUrl: url });
    expect(steps.join("\n")).toContain("Enable Events");
    expect(steps.join("\n")).not.toContain("Request URL");
  });
});

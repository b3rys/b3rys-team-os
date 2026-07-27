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
  const opts = { appLink: "<a>apps</a>", scopes: "app_mentions:read, chat:write", channel: "#team" };
  const joined = () => wizardSteps(opts).join("\n");

  for (const isSocket of [true, false]) {
    const label = isSocket ? "Socket Mode" : "Event URL";

    test(`★${label}: Enable Events → app_mention → Save 순서가 안내된다★`, () => {
      const s = joined();
      expect(s).toContain("Enable Events");          // ← 토글을 켜라는 말이 없으면 사용자는 못 찾는다
      expect(s).toContain("Subscribe to bot events");
      expect(s).toContain("app_mention");
      expect(s).toContain("Save Changes");           // ← 저장 안 하면 위를 다 해도 적용 안 된다
    });

    test(`${label}: 단계는 앱 생성 → 이벤트 구독 순서다 (앱이 없으면 켤 화면이 없다)`, () => {
      const steps = wizardSteps(opts);
      const created = steps.findIndex((x) => x.includes("From a manifest"));
      const events = steps.findIndex((x) => x.includes("Enable Events"));
      expect(created).toBeGreaterThanOrEqual(0);
      expect(events).toBeGreaterThan(created);
    });

    test(`${label}: 채널 초대·토큰 복사 단계는 그대로 남아 있다 (단계 추가가 기존 안내를 밀어내지 않는다)`, () => {
      const s = joined();
      expect(s).toContain("/invite");
      expect(s).toContain("xoxb");
    });
  }

  test("★App-Level Token(xapp) 단계를 안내한다★ — Socket Mode 에 필수다", () => {
    expect(joined()).toContain("xapp");
  });

  test("★Request URL·Signing Secret 은 안내하지 않는다★ (Event URL 방식은 지원하지 않는다)", () => {
    expect(joined()).not.toContain("Request URL");
    expect(joined()).not.toContain("Signing Secret");
  });
});

/* ★슬랙 정본은 Socket Mode 다★ — Event URL(request_url) 방식은 지원 대상이 아니다(GD, 2026-07-27).
 * 코드에 webhook 분기가 남아 있는 것은 ★기존에 그렇게 붙어 있는 멤버를 안 깨뜨리려는 것★ 일 뿐이다.
 * 나는 이 구분을 놓치고 Socket 안내에까지 Request URL 을 끌어들일 뻔했다. 그래서 여기서 고정한다. */
describe("Socket Mode 가 정본 — 안내에 Event URL 을 섞지 않는다", () => {
  const base = { appLink: "<a>apps</a>", scopes: "chat:write", channel: "#team" };

  test("★Socket 안내에는 Request URL·Signing Secret 이 나오지 않는다★", () => {
    const s = wizardSteps(base).join("\n");
    expect(s).not.toContain("Request URL");
    expect(s).not.toContain("Signing Secret");
    expect(s).toContain("xapp");                    // Socket 은 App-Level Token 을 쓴다
  });

  test("이벤트 구독 단계는 GD 가 준 4단계 그대로다 (덧붙이지 않는다)", () => {
    const step = wizardSteps(base).find((x) => x.includes("Enable Events"))!;
    const order = ["Enable Events", "Subscribe to bot events", "Add Bot User Event", "app_mention", "Save Changes"];
    let at = -1;
    for (const token of order) {
      const next = step.indexOf(token);
      expect(next).toBeGreaterThan(at);             // 순서가 어긋나면 실패
      at = next;
    }
    expect(step).not.toContain("Request URL");      // ★추측으로 끼워 넣지 않는다★
  });
});

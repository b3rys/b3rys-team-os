import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRecord } from "../types";
import { reactTelegramAsHermes, postTelegramAsHermes, buildPrompt } from "./hermesBridge";

const hermes: AgentRecord = {
  id: "hermes",
  display_name: "Hermes",
  role: "CSO",
  runtime: "hermes_agent",
  status_provider: "hermes_gateway",
  tmux_session: null,
  telegram_bot_username: "example_hermes_bot",
  workspace_path: "/tmp",
  persona_file: "",
  moderator_eligible: true,
  avatar_emoji: "",
  hermes_profile: undefined,
};

const originalFetch = globalThis.fetch;
const originalToken = process.env.HERMES_TELEGRAM_BOT_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.HERMES_TELEGRAM_BOT_TOKEN;
  else process.env.HERMES_TELEGRAM_BOT_TOKEN = originalToken;
});

/** external_message 봉투에서 인용부호로 감싼 속성값을 뽑는다 (source·kind·from·thread·msg·in_reply_to). */
const envAttr = (p: string, name: string): string | null =>
  p.match(new RegExp('<external_message[^>]*\\b' + name + '="([^"]*)"'))?.[1] ?? null;
/** hop_count 는 openclaw/claude 봉투와 동일하게 따옴표 없이 렌더된다. */
const envHop = (p: string): string | null =>
  p.match(/<external_message[^>]*\bhop_count=(\d+)/)?.[1] ?? null;

// 답 주소는 호출부가 준 kind와 AGENTS.md의 매핑으로 결정한다. 봉투가 별도로 주소를 계산하면 계약이 갈릴 수 있다.
describe("buildPrompt — 봉투 kind 노출 + source=bus (2026-07-15)", () => {
  const base = {
    agent: { id: "hermes", display_name: "Hermes" } as AgentRecord,
    threadId: "biS95LYk",
    messageId: "MSGab12cd34", // nanoid(12) — safe 여야 in_reply_to 가 실린다 (짧으면 생략)
    body: "이 코드 어떻게 생각해?",
    fromLabel: "codex",
    replyRoute: { kind: "teammate" as const, to: "codex" },
    locale: "ko" as const,
  };

  test("★source 는 'bus' 로 통일됐다★ (더 이상 team_bus 아님 — 런타임 통일)", () => {
    const p = buildPrompt(base);
    expect(envAttr(p, "source")).toBe("bus");
    expect(p).not.toContain('source="team_bus"');
  });

  test("★봉투가 route.kind 를 그대로 싣는다★ (teammate/group/direct_to_gd/slack/notice)", () => {
    const cases = [
      [{ kind: "teammate" as const, to: "codex" }, "teammate"],
      [{ kind: "group" as const }, "group"],
      [{ kind: "direct_to_gd" as const }, "direct_to_gd"],
      [{ kind: "slack" as const }, "slack"],
      [{ kind: "notice" as const }, "notice"],
    ] as const;
    for (const [route, kind] of cases) {
      expect(envAttr(buildPrompt({ ...base, replyRoute: route }), "kind")).toBe(kind);
    }
  });

  // 핵심 회귀 방어: 서버가 답 주소 명령을 다시 찍기 시작하면(룰과 봉투가 둘 다 주소를 정함) 갈라진다.
  test("★서버가 '답: send.sh …' 명령을 더 이상 찍지 않는다★ — 주소는 kind 로 팀원(룰)이 정한다", () => {
    for (const route of [
      { kind: "teammate" as const, to: "codex" },
      { kind: "group" as const },
      { kind: "direct_to_gd" as const },
      { kind: "slack" as const },
      { kind: "notice" as const },
    ]) {
      for (const locale of ["ko", "en"] as const) {
        const p = buildPrompt({ ...base, replyRoute: route, locale });
        expect(p).not.toContain("답:");
        expect(p).not.toContain("Answer:");
        expect(p).not.toContain("send.sh"); // 봉투는 이제 어떤 send.sh 명령도 찍지 않는다
      }
    }
  });

  test("★in_reply_to·hop_count 는 openclaw/claude 봉투와 대칭★ (hermes 의 유일 pingpong 방어선)", () => {
    const p = buildPrompt({ ...base, hopCount: 2 });
    expect(envAttr(p, "in_reply_to")).toBe("MSGab12cd34"); // 이 메시지 id 를 참조해 답하도록
    expect(envHop(p)).toBe("3"); // (hopCount 2) + 1
  });

  test("hopCount 미지정 → hop_count=1 (기본 0 + 1)", () => {
    expect(envHop(buildPrompt(base))).toBe("1");
  });
});

describe("buildPrompt — direct_to_gd 자가발송 금지 지시", () => {
  const base = {
    agent: { id: "ames", display_name: "Ames" } as AgentRecord,
    threadId: "biS95LYk",
    messageId: "MSGab12cd34",
    body: "팀장님께 이거 전달해줘",
    fromLabel: "codex",
    replyRoute: { kind: "teammate" as const, to: "codex" },
    locale: "ko" as const,
  };
  test("directReport=true → 자가발송 금지 노트 없음(2026-07-10 제거, 어댑터 fix로 대체)", () => {
    const p = buildPrompt({ ...base, directReport: true });
    expect(p).not.toContain("발신 도구를 직접 호출하지 마세요");
  });
  test("directReport 미지정 → 자가발송 금지 지시 없음(일반 턴)", () => {
    const p = buildPrompt(base);
    expect(p).not.toContain("발신 도구를 직접 호출하지 마세요");
  });
  // trailer 정리 — '너는 b3rys 팀원' 제거 + direct_to_gd 시 '그룹 표시' 문구 상충 제거
  test("trailer: 'b3rys 팀의 <name>' 문구 제거(매 턴)", () => {
    expect(buildPrompt(base)).not.toContain("b3rys 팀의");
    expect(buildPrompt({ ...base, locale: "en" })).not.toContain("on the b3rys team");
  });
  // 턴 본문은 자동 게시되지 않으므로 발신 도구를 직접 실행해야 한다. 침묵에는 별도 토큰이 필요 없다.
  test("★surface 문구가 뒤집혔다★: '브릿지가 전달' 이 사라지고 ★자가발신 지시★ 가 들어왔다", () => {
    const p = buildPrompt(base);
    // ① [A] 문구는 사라졌다 — 되살아나면 침묵이 다시 불가능해진다
    expect(p).not.toContain("버스/그룹에 전달");
    expect(p).not.toContain("브릿지가 최종 답변");
    // ② [B] 불변식이 명시 된다
    expect(p).toContain("★말하려면 직접 보내세요. 안 보내면 아무 말도 안 한 것입니다.★");
    expect(p).toContain("당신의 메모"); // 답 주소 선택지를 제시하면 이미 결정된 경로를 모델이 다시 고를 수 있어 kind만 제공한다.
    expect(p).not.toContain("· 팀원에게 →");
    expect(p).not.toContain("· 단톡방에 →");
    expect(p).not.toContain("· 팀장께 직보 →");
    expect(envAttr(p, "kind")).toBe("teammate"); // route 가 준 사실은 봉투 kind 로만 표현
    // ④ 침묵 = 그냥 안 보내기 (우회 토큰 불필요)
    expect(p).toContain("★할 말이 없으면 그냥 안 보내면 됩니다★");
    expect(p).not.toContain("[NO_REPLY]");
  });

  test("★팀장 직보는 ★route★ 가 정한다 — 봉투 kind 로 표현되고 명령은 안 찍는다★", () => {
    const direct = buildPrompt({ ...base, replyRoute: { kind: "direct_to_gd" } });
    expect(envAttr(direct, "kind")).toBe("direct_to_gd");
    expect(direct).not.toContain("답:"); // 서버가 주소 명령을 찍지 않는다
    expect(direct).toContain("★말하려면 직접 보내세요. 안 보내면 아무 말도 안 한 것입니다.★");
    expect(direct).not.toContain("[NO_REPLY]");

    const toTeammate = buildPrompt(base); // 팀원에게 답하는 턴
    expect(envAttr(toTeammate, "kind")).toBe("teammate"); // 고를 여지를 주지 않는다 — 사실 하나
  });

  test("★답은 여전히 1회 terminal★ — 그러나 봉투는 '보내지 마세요/함수호출 문구' 를 더 이상 싣지 않는다", () => {
    const p = buildPrompt(base);
    expect(p).not.toContain("다시 보내지 마세요");
    // 함수호출/수집 계약은 이제 AGENTS.md(룰) 소유 — 봉투에서 빠졌다(중복 계약 방지).
    expect(p).not.toContain("요청 1개 → 답 1개 → 끝");
    expect(p).not.toContain("팀버스 = 함수 호출");
    // [B] 불변식은 봉투에 남는다: 말하려면 직접 보낸다
    expect(p).toContain("★말하려면 직접 보내세요. 안 보내면 아무 말도 안 한 것입니다.★");
  });
});

// 수집 절차는 AGENTS.md가 정한다. 봉투가 지원하지 않는 번들·--collect 기능을 안내하면 안 된다.
describe("buildPrompt — 수집 계약은 봉투에서 빠졌다 (룰 이관)", () => {
  const base = {
    agent: { id: "hermes", display_name: "Hermes" } as AgentRecord,
    threadId: "collect-1",
    messageId: "MSGab12cd34",
    body: "steve랑 dbak한테 물어봐서 종합해줘",
    fromLabel: "bill",
    replyRoute: { kind: "teammate" as const, to: "bill" },
    locale: "ko" as const,
  };

  test("★봉투에 수집 절차가 더 이상 없다★ (팬아웃/종합 주소는 AGENTS.md 가 정한다)", () => {
    for (const locale of ["ko", "en"] as const) {
      const p = buildPrompt({ ...base, locale });
      expect(p).not.toContain("각 팀원에게 한 번씩");
      expect(p).not.toContain("Ask each member once");
      expect(p).not.toContain("다 모이면 종합 1개");
      expect(p).not.toContain("When all are in, one synthesis");
      expect(p).not.toContain("send.sh"); // 팬아웃/종합 명령도 봉투에서 사라졌다
    }
  });

  // 없는 기능을 시키지 않는다 — 이 불변식은 봉투에서 계속 지킨다 (collectRemoved.test.ts 와 대칭)
  test("★'--collect'·'서버가 모아준다' 같은 없는 기능을 여전히 약속하지 않는다★", () => {
    for (const locale of ["ko", "en"] as const) {
      const p = buildPrompt({ ...base, locale });
      expect(p).not.toContain("--collect"); // send.sh 파서가 unknown arg 로 죽는다
      expect(p).not.toContain("서버가 모아");
      expect(p).not.toContain("bundle");
    }
  });

  test("수집 위임(버스 1:1)도 kind=teammate 로만 표현된다 (종합은 위임자에게 — 룰이 정한다)", () => {
    expect(envAttr(buildPrompt(base), "kind")).toBe("teammate");
    expect(envAttr(buildPrompt({ ...base, threadId: "tg--100", replyRoute: { kind: "group" } }), "kind")).toBe("group");
  });
});

// threadId는 외부 입력이다. 셸 인자에 복사될 수 있으므로 안전하지 않은 값은 프롬프트 전체에서 제외한다.
describe("thread id injection 방어 (allowlist)", () => {
  const base = {
    agent: { id: "hermes", display_name: "Hermes" } as AgentRecord,
    threadId: "th1",
    messageId: "m1",
    body: "steve랑 dbak한테 물어봐서 종합해줘",
    fromLabel: "bill",
    replyRoute: { kind: "teammate" as const, to: "bill" },
    locale: "ko" as const,
  };
  const unsafe = [
    ["백틱", "a`whoami`b"],
    ["따옴표", "a\" ; rm -rf / ; \"b"],
    ["공백", "abc def"],
    ["개행", "abc\ndef"],
    ["선행하이픈(argv 옵션 주입)", "--NQw-Op"],
    ["$(...)", "a$(id)b"],
  ] as const;
  // 핵심 assertion: prompt 전체에 원문이 없어야 한다. 태그 속성(thread="...")으로도 새면 안 된다.
  for (const [label, tid] of unsafe) {
    test(`unsafe thread(${label}) → 프롬프트 ★전체★ 어디에도 원문 부재 (ko/en)`, () => {
      for (const locale of ["ko", "en"] as const) {
        const p = buildPrompt({ ...base, threadId: tid, locale });
        expect(p).not.toContain(tid); // 태그 속성 포함 전 구간
        expect(p).toContain("(redacted)"); // 태그에서 redact 됨
      }
    });
  }
  test("safe thread(nanoid·tg--100…·slug) → 봉투 thread 속성에 리터럴 유지 (redact 안 됨)", () => {
    for (const tid of ["V1StGXR8_Z5j", "tg--2000000000001", "collectfix-hermes-load"]) {
      const p = buildPrompt({ ...base, threadId: tid });
      expect(envAttr(p, "thread")).toBe(tid); // 봉투 속성에 그대로
      expect(p).not.toContain("(redacted)");
    }
  });
});

// fromLabel은 수신 주소가 아니므로 답 경로를 추측하지 않고 호출부의 kind를 사용한다.
describe("buildPrompt — ★답 주소는 호출부가 준다 → 봉투 kind★", () => {
  const base = {
    agent: { id: "hermes", display_name: "Hermes" } as AgentRecord,
    threadId: "collect-1",
    messageId: "MSGab12cd34",
    body: "이 코드 어떻게 생각해?",
    fromLabel: "steve",
    locale: "ko" as const,
  };

  test("★버스 1:1 → kind=teammate★ (물어본 팀원에게 — 룰이 --to <from> 으로 푼다)", () => {
    const p = buildPrompt({ ...base, replyRoute: { kind: "teammate", to: "steve" } });
    expect(envAttr(p, "kind")).toBe("teammate");
    expect(envAttr(p, "from")).toBe("steve");
  });

  test("★★단톡방 → kind=group (steve 가 경고한 '입 막힘' 회귀 방어)★★", () => {
    // 팀장님이 단톡방에서 부른 경우. fromLabel 은 사람이 읽는 fromLabel라 팀원 id 가 아니다.
    const p = buildPrompt({
      ...base,
      threadId: "tg--2000000000001",
      fromLabel: "팀장 (그룹 라우터)",
      replyRoute: { kind: "group" },
    });
    expect(envAttr(p, "kind")).toBe("group");
    expect(p).not.toContain("팀장 (그룹 라우터) 에게"); // 이름표로 주소를 짓지 않는다
  });

  test("★팀장 직보 → kind=direct_to_gd (위임자 bill 에게가 아니다)★", () => {
    const p = buildPrompt({ ...base, fromLabel: "bill", replyRoute: { kind: "direct_to_gd" } });
    expect(envAttr(p, "kind")).toBe("direct_to_gd");
  });

  test("★슬랙 → kind=slack (슬랙 유저 id 를 --to 에 지어넣지 않는다)★", () => {
    const p = buildPrompt({ ...base, threadId: "slack-1", fromLabel: "U01ABCDEF", replyRoute: { kind: "slack" } });
    expect(envAttr(p, "kind")).toBe("slack");
    // from= 속성에 슬랙 유저가 보이는 건 맞다(누가 보냈는지). send.sh --to 명령 자체가 봉투에 없다
    expect(p).not.toContain("--to U01ABCDEF");
    expect(p).not.toContain("send.sh");
  });

  test("★'팀장께 답하라' 가 어디에도 없다★ (이 문구가 87건을 방으로 보냈다)", () => {
    for (const r of [
      { kind: "teammate" as const, to: "steve" },
      { kind: "group" as const },
      { kind: "slack" as const },
    ]) {
      expect(buildPrompt({ ...base, replyRoute: r })).not.toContain("팀장께 받은 언어로");
    }
  });

  test("승인 게이트는 여전히 팀장 (큰 변경 = 팀장 확인) — 답 주소와 무관", () => {
    expect(buildPrompt({ ...base, replyRoute: { kind: "group" } })).toContain("팀장 확인이 필요합니다");
  });

  test("unsafe thread → 봉투 어디에도 원문을 안 넣는다 (셸 injection 가드 유지)", () => {
    const p = buildPrompt({ ...base, threadId: "`rm -rf /`", replyRoute: { kind: "teammate", to: "steve" } });
    expect(p).not.toContain("rm -rf");
    expect(p).toContain("(redacted)");
  });
});

describe("reactTelegramAsHermes", () => {
  test("calls Telegram setMessageReaction with the Hermes bot token", async () => {
    process.env.HERMES_TELEGRAM_BOT_TOKEN = "test-token";
    let capturedUrl = "";
    let capturedBody: unknown;
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(reactTelegramAsHermes(hermes, "-1009999999999", "1947")).resolves.toBe(true);
    expect(capturedUrl).toBe("https://api.telegram.org/bottest-token/setMessageReaction");
    expect(capturedBody).toEqual({
      chat_id: "-1009999999999",
      message_id: 1947,
      reaction: [{ type: "emoji", emoji: "👀" }],
    });
  });

  test("returns false when there is no usable message id", async () => {
    process.env.HERMES_TELEGRAM_BOT_TOKEN = "test-token";
    await expect(reactTelegramAsHermes(hermes, "-1009999999999", "not-a-number")).resolves.toBe(false);
  });
});

describe("postTelegramAsHermes", () => {
  test("calls Telegram sendMessage with the Hermes bot token (no CLI spawn)", async () => {
    process.env.HERMES_TELEGRAM_BOT_TOKEN = "test-token";
    let capturedUrl = "";
    let capturedBody: unknown;
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(postTelegramAsHermes(hermes, "1000000001", "직보 본문")).resolves.toBe(true);
    expect(capturedUrl).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(capturedBody).toEqual({ chat_id: "1000000001", text: "직보 본문", disable_notification: true });
  });

  test("returns false when Telegram reports ok:false", async () => {
    process.env.HERMES_TELEGRAM_BOT_TOKEN = "test-token";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(postTelegramAsHermes(hermes, "1000000001", "x")).resolves.toBe(false);
  });

  test("returns false when the agent has no bot token", async () => {
    delete process.env.HERMES_TELEGRAM_BOT_TOKEN;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(postTelegramAsHermes(hermes, "1000000001", "x")).resolves.toBe(false);
    expect(called).toBe(false);
  });
});

describe("buildPrompt — ★주동사는 '실행해서 보내라' 다★ (2026-08-03 실측)", () => {
  // stdout의 명령 텍스트는 발신이 아니다. 팀원 규칙의 명령 형식과 주입문의 실행 지시를 함께 요구한다.
  const base2 = {
    agent: { id: "member-b", display_name: "Member B" } as AgentRecord,
    threadId: "biS95LYk",
    messageId: "MSGab12cd34",
    body: "확인해줘",
    fromLabel: "member-a",
    replyRoute: { kind: "teammate" as const, to: "member-a" },
    locale: "ko" as const,
  };

  test("한국어 주입문이 ★실행★ 을 요구한다(‘답하고’ 로 되돌아가지 않는다)", () => {
    const p = buildPrompt({ ...base2, locale: "ko" as const });
    expect(p).toContain("발신 도구를 실제로 실행해서");
    expect(p).toContain("발신 명령을 글로 적는 것은 발신이 아닙니다");
    // 회귀가드: 옛 주동사로 되돌아가면 이 계열 모델이 다시 조용히 침묵한다.
    expect(p).not.toContain("간결하게 답하고");
  });

  test("영어 주입문도 ★run your send tool★ 을 요구한다", () => {
    const p = buildPrompt({ ...base2, locale: "en" as const });
    expect(p).toContain("run your send tool");
    expect(p).toContain("writing the send command as text is not sending");
    expect(p).not.toContain("Answer concisely,");
  });

  test("★2026-07-15 계약 유지★ — 도구 이름도 주소도 봉투에 넣지 않는다", () => {
    for (const locale of ["ko", "en"] as const) {
      const p = buildPrompt({ ...base2, locale });
      expect(p).not.toContain("send.sh"); // 명령/도구 이름 렌더 금지(기존 계약)
      expect(p).not.toContain("--to");    // 주소 계산 금지
    }
  });

  test("★정의 문장이 trailer 안에 있다★ — 방아쇠만 남기면 실패한다(변형B 0/5)", () => {
    // D(중간을 원문 "답하고" 로 되돌리고 맨 끝 방아쇠만) → 0/5, api_calls=1. 정의가 없으면 이 모델은
    // 명령을 글로 쓰는 것을 발신으로 여긴다. 그래서 이 문장은 "중복" 이 아니라 필수다.
    const p = buildPrompt({ ...base2, locale: "ko" as const });
    expect(p).toContain("발신 명령을 글로 적는 것은 발신이 아닙니다");
    expect(p).not.toContain("간결하게 답하고"); // 옛 주동사로 되돌아가면 D 와 같아진다
  });

  test("★방아쇠가 trailer 맨 마지막에 온다★ (2026-08-03 A/B: 정의만으로는 0/5)", () => {
    // 실측: 명령형이 중간에 있으면 이 모델은 도구를 아예 호출하지 않는다(api_calls=1, 5/5 —
    // 명령을 완벽히 조립해서 글로만 출력). 맨 끝으로 옮기면 15/15 전부 호출한다.
    // 그래서 "문구가 있다" 로는 부족하고 끝에 있다 를 잠근다.
    for (const locale of ["ko", "en"] as const) {
      const p = buildPrompt({ ...base2, locale }).trimEnd();
      const tail = locale === "ko" ? "전달되지 않습니다.★" : "reaches no one.★";
      expect(p.endsWith(tail)).toBe(true);
    }
  });

  test("★침묵 허용 문구는 보존된다★ — 지우지 않고 순서만 바꿨다", () => {
    expect(buildPrompt({ ...base2, locale: "ko" as const })).toContain("할 말이 없으면 그냥 안 보내면 됩니다");
  });
});

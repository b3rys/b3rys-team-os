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
/** hop_count 는 openclaw/claude 봉투와 동일하게 ★따옴표 없이★ 렌더된다. */
const envHop = (p: string): string | null =>
  p.match(/<external_message[^>]*\bhop_count=(\d+)/)?.[1] ?? null;

// ═══════════════════════════════════════════════════════════════════════════════
// ★2026-07-15 kind 전환★: 봉투가 답 주소 명령("답: send.sh …")을 찍어주던 걸 없애고,
//   ★봉투 kind★ 를 실어 팀원(AGENTS.md 룰 9039834)이 답 주소를 정하게 통일했다.
//   서버는 사실(kind)만 싣고, 주소 계산은 하지 않는다.
// ═══════════════════════════════════════════════════════════════════════════════
describe("buildPrompt — 봉투 kind 노출 + source=bus (2026-07-15)", () => {
  const base = {
    agent: { id: "hermes", display_name: "Hermes" } as AgentRecord,
    threadId: "biS95LYk",
    messageId: "MSGab12cd34", // ★nanoid(12)★ — safe 여야 in_reply_to 가 실린다 (짧으면 생략)
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

  // ★핵심 회귀 방어★: 서버가 답 주소 명령을 다시 찍기 시작하면(룰과 봉투가 둘 다 주소를 정함) 갈라진다.
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
  // 2026-07-10 GD 결정: directReportNote 제거. 이중발송 진짜 원인=어댑터 double-post(별도 fix, direct_to_gd시
  //   요청자 버스 insert 스킵)였고 hermes 자가발송이 아니었음(필요성 테스트=노트 없이도 자가발송0). 전제 오진이라 제거.
  test("directReport=true → 자가발송 금지 노트 없음(2026-07-10 제거, 어댑터 fix로 대체)", () => {
    const p = buildPrompt({ ...base, directReport: true });
    expect(p).not.toContain("발신 도구를 직접 호출하지 마세요");
  });
  test("directReport 미지정 → 자가발송 금지 지시 없음(일반 턴)", () => {
    const p = buildPrompt(base);
    expect(p).not.toContain("발신 도구를 직접 호출하지 마세요");
  });
  // GD 2026-07-09: trailer 정리 — '너는 b3rys 팀원' 제거 + direct_to_gd 시 '그룹 표시' 문구 상충 제거
  test("trailer: 'b3rys 팀의 <name>' 문구 제거(매 턴)", () => {
    expect(buildPrompt(base)).not.toContain("b3rys 팀의");
    expect(buildPrompt({ ...base, locale: "en" })).not.toContain("on the b3rys team");
  });
  /**
   * ★[B] 전환 — surfaceNote 가 정반대가 됐다.★ (GD 2026-07-13: "팀원한테 맡겨. 다 빼.")
   *
   * ═══ 예전 계약 [A] ═══
   *   surfaceNote = "브릿지가 당신의 최종 답변을 ★버스/그룹에 전달★합니다 — 발신 도구로 다시 보내지 마세요."
   *   즉 ★턴 본문 = 발행물★ 이었다. 그래서 hermes 는 ★뭘 쓰든 나갔다.★
   *
   * ═══ 왜 뒤집혔나 ═══
   *   ★"아무 말도 안 하기" 가 불가능했다★ → 룰대로 침묵을 택해도 그 문장이 그대로 발송됐다 →
   *   `[NO_REPLY]` 라는 우회 토큰이 생겼고 → 가드를 발행 지점마다 달았고 → ★하나를 놓쳤고★ →
   *   ★"GD CSO HERMES : [NO_REPLY]" 가 팀장 단톡방에 문자 그대로 찍혔다★ (2026-07-13 라이브).
   *
   * ═══ 지금 계약 [B] ═══
   *   ★턴 본문은 hermes 의 메모다. 아무 데도 안 간다.★ 말하려면 ★자기 손으로 보낸다.★
   */
  test("★surface 문구가 뒤집혔다★: '브릿지가 전달' 이 사라지고 ★자가발신 지시★ 가 들어왔다", () => {
    const p = buildPrompt(base);
    // ① [A] 문구는 ★사라졌다★ — 되살아나면 침묵이 다시 불가능해진다
    expect(p).not.toContain("버스/그룹에 전달");
    expect(p).not.toContain("브릿지가 최종 답변");
    // ② [B] 불변식이 ★명시★ 된다
    expect(p).toContain("★말하려면 직접 보내세요. 안 보내면 아무 말도 안 한 것입니다.★");
    expect(p).toContain("당신의 메모"); // 턴 본문 = 메모 (왜 보내야 하는지의 '이유')
    // ③ ★주소 메뉴를 주지 않는다★ (GD 2026-07-14 / hermes 본인 증언)
    //    예전엔 "· 팀원에게 → … · 단톡방에 → … · 팀장께 직보 → …" 라고 ★선택지 3개★ 를 줬다.
    //    ★hermes:★ "그 선택지가 붙어 있으면 상위 지시의 '팀장께' 가 routing intent 처럼 보입니다."
    //    답 주소는 ★이미 정해져 있다★ (호출부가 안다) → 이제 봉투 kind 로만 표현한다.
    expect(p).not.toContain("· 팀원에게 →");
    expect(p).not.toContain("· 단톡방에 →");
    expect(p).not.toContain("· 팀장께 직보 →");
    expect(envAttr(p, "kind")).toBe("teammate"); // ★route 가 준 사실은 봉투 kind 로만 표현★
    // ④ 침묵 = 그냥 안 보내기 (우회 토큰 불필요)
    expect(p).toContain("★할 말이 없으면 그냥 안 보내면 됩니다★");
    expect(p).not.toContain("[NO_REPLY]");
  });

  test("★팀장 직보는 ★route★ 가 정한다 — 봉투 kind 로 표현되고 명령은 안 찍는다★", () => {
    // 예전엔 프롬프트가 세 경로를 ★메뉴★ 로 줬고, hermes 가 골랐다(그리고 틀렸다).
    // 이제 호출부가 사실을 준다: direct_to_gd 위임이면 봉투 kind=direct_to_gd, 아니면 kind=teammate.
    const direct = buildPrompt({ ...base, replyRoute: { kind: "direct_to_gd" } });
    expect(envAttr(direct, "kind")).toBe("direct_to_gd");
    expect(direct).not.toContain("답:"); // 서버가 주소 명령을 찍지 않는다
    expect(direct).toContain("★말하려면 직접 보내세요. 안 보내면 아무 말도 안 한 것입니다.★");
    expect(direct).not.toContain("[NO_REPLY]");

    const toTeammate = buildPrompt(base); // 팀원에게 답하는 턴
    expect(envAttr(toTeammate, "kind")).toBe("teammate"); // ★고를 여지를 주지 않는다 — 사실 하나★
  });

  test("★답은 여전히 1회 terminal★ — 그러나 봉투는 '보내지 마세요/함수호출 문구' 를 더 이상 싣지 않는다", () => {
    const p = buildPrompt(base);
    // ★[A] 잔재★: "브릿지가 보내니 너는 다시 보내지 마라" = 이중발송 가드였다 → 사라졌다.
    expect(p).not.toContain("다시 보내지 마세요");
    // ★함수호출/수집 계약은 이제 AGENTS.md(룰) 소유★ — 봉투에서 빠졌다(중복 계약 방지).
    expect(p).not.toContain("요청 1개 → 답 1개 → 끝");
    expect(p).not.toContain("팀버스 = 함수 호출");
    // [B] 불변식은 봉투에 남는다: 말하려면 직접 보낸다
    expect(p).toContain("★말하려면 직접 보내세요. 안 보내면 아무 말도 안 한 것입니다.★");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ★수집(collection) 계약은 봉투에서 빠지고 AGENTS.md(룰 9039834)로 이관됐다★ (2026-07-15)
//   예전엔 봉투가 "각 팀원에게 한 번씩 … / 다 모이면 종합 1개: send.sh --to …" 를 직접 렌더했다.
//   그 계약은 ★룰에 더 강하게 있으므로★(AGENTS.md) 봉투에서 제거한다 — 계약이 두 군데면 갈라진다.
//   ★없는 기능(--collect·"서버가 모아준다")을 시키지 않는다★ 는 여전히 봉투에서 지킨다.
// ═══════════════════════════════════════════════════════════════════════════════
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

  // ★없는 기능을 시키지 않는다★ — 이 불변식은 봉투에서 계속 지킨다 (collectRemoved.test.ts 와 대칭)
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

// ═══════════════════════════════════════════════════════════════════════════════
// ★보안(codex 리뷰)★: threadId 는 서버생성 보장이 아니다(envelope 는 길이만 검사) → 외부가 백틱·
//   따옴표·개행·공백·선행하이픈이 든 thread_id 를 POST 가능. 그 값을 모델이 복사·실행할 argv 에
//   보간하면 command/prompt injection. 브릿지 allowlist 로 unsafe 면 리터럴을 아예 안 넣는다.
//   ★이 describe 는 절대 약화하지 않는다★ — kind 전환 후에도 그대로 통과해야 한다.
// ═══════════════════════════════════════════════════════════════════════════════
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
  // ★핵심 assertion★: prompt ★전체★에 원문이 없어야 한다. 태그 속성(thread="...")으로도 새면 안 된다.
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

// ═══════════════════════════════════════════════════════════════════════════════
// ★답 주소는 호출부가 준다 (추측 금지)★ — 이제 봉투 kind 로 표현된다.
//   예전엔 꼬리말이 "팀장께 답하라" 라 hermes 가 1:1 질문에도 방에 답했다(30일 87건).
//   ★hermes 잘못이 아니라 우리가 그렇게 시킨 것이다.★ 이제 호출부가 kind 를 넘기고 봉투가 싣는다.
// ═══════════════════════════════════════════════════════════════════════════════
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
    // 팀장님이 단톡방에서 부른 경우. fromLabel 은 사람이 읽는 이름표라 팀원 id 가 아니다.
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
    // from= 속성에 슬랙 유저가 보이는 건 맞다(누가 보냈는지). ★send.sh --to 명령 자체가 봉투에 없다★
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

// ★hermes 텍스트 전송이 Bot API sendMessage 직접인지★ (2026-07-15, CLI spawn 제거)
//   뮤테이션 증명: 이 경로를 다시 CLI spawn 으로 되돌리면 fetch 가 안 불려 capturedUrl 이 비어 red.
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

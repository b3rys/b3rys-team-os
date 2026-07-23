/**
 * ★수집 룰 — 변종이 사라졌다. 이제 한 문장이다: "말하려면 보내라."★
 * ([B] 전환 — GD 2026-07-13 "팀원한테 맡겨. 다 빼.")
 *
 * ═══ 이 파일이 지키던 예전 계약 [A] ═══
 * 런타임마다 ★배송 문장이 달랐다★:
 *   · 브릿지(hermes·openclaw) → `BRIDGE_DELIVERY` ("서버가 네 턴 본문을 대신 전달한다")
 *   · claude               → "네 telegram reply 도구로 직접 보내라"
 * 그래서 이 테스트는 ★소스를 grep 해서 "모든 COLLECT_BULLET_* 변종이 배송처를 말하는가"★ 를 검사했다.
 * 이유가 있었다 — ★같은 병을 한 변종에서 고치고 옆 변종엔 안 옮기는 사고가 반복★됐기 때문이다.
 *
 * ═══ 왜 [A] 가 통째로 사라졌나 ═══
 * ★서버가 턴 본문을 대신 게시하니 "아무 말도 안 하기" 가 불가능했다★ → `[NO_REPLY]` 라는 우회로가 생겼고
 * → 발행 지점마다 가드를 달았고 → ★하나를 놓쳤고★ → ★"GD CSO HERMES : [NO_REPLY]" 가 팀장 단톡방에
 * 문자 그대로 찍혔다★ (2026-07-13 라이브, 팀장 스크린샷).
 * 게다가 서버는 "이 답을 누구에게?" 를 ★추측★ 해야 했다 → 종합이 ★나를 깨운 기여자★ 에게 갔다(7회 중 3회).
 * → 런타임 분기의 존재 이유는 단 하나 ★"누가 대신 보내주느냐"★ 였다.
 *   ★이제 아무도 대신 안 보낸다 → 분기가 통째로 없어졌다.★ (`applyCollectMode` = 항등)
 *
 * ═══ 이 파일이 지금 지키는 계약 [B] ═══
 * ① ★전 런타임이 ★똑같은★ 룰을 읽는다★ (변종 0 — 한쪽만 고치는 사고가 구조적으로 불가능해진다)
 * ② 그 룰은 ★여전히 "어디로·어떻게 보내는지" 를 말한다★ — 원본 테스트의 정신은 그대로 유효하다.
 *    ★룰이 배송처를 침묵하면 LLM 은 기본값(턴 본문)을 쓴다★ 는 사실은 [B] 에서도 변하지 않는다.
 *    다만 [B] 에선 턴 본문이 ★아무 데도 안 가므로★ 결과가 "오배송" 이 아니라 "실종" 일 뿐이다.
 * ③ ★서버가 대신 말해준다는 문장이 어디에도 없다★ · ★`[NO_REPLY]` 같은 우회 토큰이 없다★
 *
 * ★검사 대상이 바뀌었다: 소스 grep(상수 이름) → ★렌더된 룰(팀원이 실제로 읽는 글)★.★
 * 상수 이름은 계약이 아니다. ★팀원 눈에 들어가는 문장이 계약이다.★
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCollectMode,
  buildAgentsMd,
  buildPersona,
  coreRuleFor,
  type Runtime,
} from "./personaTemplates";

const SRC = readFileSync(join(import.meta.dir, "personaTemplates.ts"), "utf8");

/** 팀의 모든 런타임. 새 런타임이 생기면 ★여기에 추가★ — 그러면 아래 전부가 그 런타임에도 강제된다. */
const ALL_RUNTIMES: Runtime[] = ["claude_channel", "openclaw", "hermes_agent", "b3os_native", "codex"];

/** 그 런타임의 팀원이 ★실제로 읽는★ 핵심룰. */
const ruleFor = (runtime: Runtime) => coreRuleFor("member", "GD", "b3rys", true, runtime);

/** 전 런타임의 렌더된 룰에 대해 단언 — 한 통로만 고치고 옆 통로를 빼먹는 사고를 구조적으로 막는다. */
function forEveryRuntime(probe: (rule: string, runtime: Runtime) => void): void {
  for (const runtime of ALL_RUNTIMES) probe(ruleFor(runtime), runtime);
}

describe("★수집 룰 — 런타임 변종이 없다★ ([B])", () => {
  it("★전 런타임이 바이트 단위로 같은 룰을 읽는다★ — 변종이 생기면 즉시 빨개진다", () => {
    const rendered = ALL_RUNTIMES.map((r) => ruleFor(r));
    for (const [i, rule] of rendered.entries()) {
      expect(
        rule,
        `★${ALL_RUNTIMES[i]} 의 룰이 다른 런타임과 다르다★ — [A] 의 런타임 분기가 되살아났다.\n` +
          `  분기의 존재 이유는 "누가 대신 보내주느냐" 뿐이었다. [B] 에선 아무도 대신 안 보낸다 → 분기도 없다.`,
      ).toBe(rendered[0]!);
    }
  });

  it("★applyCollectMode 는 항등★ — 런타임을 보고 룰을 갈아끼우던 자리다 (지금은 아무것도 안 한다)", () => {
    const sample = "## ⭐ Core Rules\n- 아무 룰\n";
    for (const runtime of [...ALL_RUNTIMES, undefined]) {
      expect(applyCollectMode(sample, runtime)).toBe(sample);
    }
  });

  it("★소스에도 런타임 분기가 없다★ — COLLECT_BULLET_* 는 전부 한 상수를 가리킨다", () => {
    // 예전엔 `BRIDGE_SEND_RUNTIMES` 목록을 보고 변종을 골라 끼웠다. 그 배선이 되살아나면 잡는다.
    expect(SRC).toContain("const COLLECT_BULLET_ON = COLLECT_BULLET_OFF;");
    expect(SRC).toContain("const COLLECT_BULLET_CLAUDE = COLLECT_BULLET_OFF;");
    // 이름만 남은 게 아니라 ★실제로 갈라지지 않는지★ 는 위 두 테스트(렌더 동일 + 항등)가 증명한다.
  });
});

/**
 * ★배송 지시 — 원본 테스트의 정신은 그대로다.★
 * 룰이 ★"어디로 보내라" 를 말하지 않으면★ LLM 은 기본값을 쓴다 = 턴 본문. [A] 에선 그게 엉뚱한 사람에게
 * 배달됐고(오배송 3/7), [B] 에선 ★아무 데도 안 간다★(실종). ★어느 쪽이든 팀장은 답을 못 받는다.★
 * → 배송처는 ★여전히 명시돼야 한다★. 달라진 건 "누가 보내느냐"(서버 → 팀원) 뿐이다.
 */
describe("★모든 런타임이 '어디로·어떻게 보내는지' 를 읽는다★", () => {
  it("★불변식: 말하려면 보내라. 안 보내면 아무 말도 안 한 것★", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}: 자가발신 불변식이 룰에 없다`).toContain(
        "To speak, you must send. If you do not send, you have said nothing.",
      );
    });
  });

  it("★세 배송처가 전부 명시된다★ — 팀원에게 · 단톡방에 · 팀장께 (하나라도 빠지면 그 경로가 조용히 죽는다)", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}: 종합 배달이 '요청 발원지로' 라는 지시가 없다`).toContain(
        "Deliver the synthesis to where the request came from",
      );
      // ★배송처 origin-mapping (2026-07-17 codex·hermes 리뷰가 잡음)★: 압축 때 이걸 뺐더니 그룹방 발 수집을
      //   --direct-to-gd(DM) 로 오배송할 여지가 생겼다. 발원지→목적지 매핑을 복원.
      expect(rule, `${runtime}: 1:1발 수집을 broadcast 금지하는 가드가 없다`).toContain(
        "never broadcast a 1:1/DM-originated collection",
      );
      // ① 요청자(팀원)에게 — 같은 thread 로
      expect(rule, `${runtime}: 요청자 배송 경로(send.sh --to)가 없다`).toContain(
        "`send.sh --to <requester> --thread <the same thread>`",
      );
      // ② 단톡방(그룹) — broadcast. [A] 에선 서버가 대신 올려줬다 → 이제 팀원이 직접 올려야 한다.
      expect(rule, `${runtime}: 그룹방 배송 경로(--to broadcast)가 없다`).toContain(
        "`send.sh --to broadcast --thread <that room's thread>`",
      );
      // ③ 팀장께 직보
      expect(rule, `${runtime}: 팀장 직보 경로(1:1/DM → --direct-to-gd)가 없다`).toContain(
        "**lead's 1:1/DM** → `--direct-to-gd`",
      );
      // claude 는 브릿지가 없다 → 1:1 DM 의 유일한 도달 경로는 자기 reply 도구. 룰이 그걸 말해준다.
      expect(rule, `${runtime}: claude 의 1:1 도달 경로(reply 도구)가 없다`).toContain(
        "reply tool for the lead's 1:1 DM",
      );
    });
  });

  it("★배송 지시에는 '왜' 가 함께 있다★ — 이유 없는 지시는 LLM 이 재해석한다 (원본 테스트의 핵심)", () => {
    forEveryRuntime((rule, runtime) => {
      // [A] 의 '왜' = "턴 본문은 나를 깨운 사람에게 라우팅된다".
      // [B] 의 '왜' = ★"턴 본문은 아무 데도 안 간다"★ — 더 단순하고 더 강하다.
      expect(rule, `${runtime}: 턴 본문이 메모라는 설명이 없다`).toContain("your own scratchpad");
      expect(rule, `${runtime}: 턴 본문이 아무에게도 안 닿는다는 설명이 없다`).toContain("it reaches no one");
    });
  });

  it("★침묵할 수단이 있다 — 그리고 그건 '그냥 안 보내는 것' 이다★ (토큰 없음)", () => {
    // ★2026-07-17: 이 보장을 ★핵심룰★ 기준으로 옮겼다.★ (GD: '중복만 제거하자')
    //   옛 테스트는 Collection 룰의 "If you have nothing to say, simply do not send" 를 잡았는데,
    //   그건 핵심룰의 "If you do not send, you have said nothing" + "Silence needs no marker" 와
    //   ★같은 말을 같은 파일에서 두 번★ 하는 것이었다. 문장을 지우되 ★보장은 그대로 강제한다★ —
    //   침묵하는 법(안 보내면 됨) + 토큰 불필요, 둘 다 여전히 모든 런타임 룰에 있어야 통과한다.
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}: 침묵 방법(안 보내면 말 안 한 것)을 안 알려준다`).toContain(
        "If you do not send, you have said nothing",
      );
      expect(rule, `${runtime}: 침묵에 마커가 필요없다는 말이 없다`).toContain("Silence needs no marker");
    });
  });
});

/**
 * ★[A] 회귀 가드 — 서버가 다시 대신 말하기 시작하면 여기서 잡는다.★
 * ★이게 이 파일의 존재 이유다.★ [A] 로 돌아가는 순간: 침묵 불가 → 우회 토큰 → 가드 누락 →
 * ★팀장 단톡방에 토큰 노출★ (2026-07-13 실제로 일어난 일).
 */
describe("★★룰이 [A] 로 돌아가면 빨개진다★★", () => {
  it("★`[NO_REPLY]` 같은 우회 토큰을 룰이 요구하지 않는다★ — 침묵은 토큰이 아니라 '안 보내기' 다", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}: 침묵 토큰이 룰에 돌아왔다 — 그 토큰은 팀장 단톡방에 찍힌다`).not.toContain(
        "[NO_REPLY]",
      );
      expect(rule).not.toContain("NO_REPLY");
    });
  });

  it("★'서버·브릿지가 네 턴 본문을 대신 게시한다' 는 문장이 어디에도 없다★", () => {
    const BANNED = [
      "auto-posted",                     // "your turn text is auto-posted to the room" ([A] 의 대표 문장)
      "automatically posted",
      "the bridge delivers",
      "the bridge will deliver",
      "the server posts it for you",
      "wakes you ONCE with the full bundle", // 삭제된 수집 오케스트레이션(gdCollect)의 약속 — 오지 않을 번들
    ];
    forEveryRuntime((rule, runtime) => {
      for (const phrase of BANNED) {
        expect(
          rule.toLowerCase(),
          `★${runtime} 룰에 "[A] = 서버가 대신 말한다" 문장이 돌아왔다: "${phrase}"★\n` +
            `  그 순간 침묵이 불가능해지고 → 우회 토큰이 필요해지고 → 팀장 단톡방에 그 토큰이 찍힌다.`,
        ).not.toContain(phrase.toLowerCase());
      }
      // 브릿지가 '전달자' 로 등장하는 어떤 변형도 금지 (문구를 바꿔 우회하는 것까지 잡는다)
      expect(rule, `${runtime}: 브릿지가 배달자로 다시 등장했다`).not.toMatch(
        /bridge\s+(?:\w+\s+){0,2}(?:deliver|post|send|relay)/i,
      );
    });
  });

  it("★서버가 답을 모아준다고 약속하지 않는다★ — 그 코드(gdCollect)는 삭제됐다. 약속하면 팀원이 영원히 기다린다", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}: 팀원이 직접 모은다는 사실이 룰에 없다`).toContain(
        "You gather the answers yourself",
      );
      expect(rule, `${runtime}: 서버가 답을 번들로 준다는 거짓 약속이 돌아왔다`).not.toContain(
        "will bundle the answers and will wake you",
      );
    });
  });
});

/**
 * ★언제 보고하나 (REPORT_WHEN) — 이제 ★전 런타임★ 이 받는다.★
 *
 * ═══ 예전 결함 ═══
 * REPORT_WHEN 을 ★브릿지 전용 문장(BRIDGE_DELIVERY)에만★ 붙여놨었다 → ★claude collector 는 못 받았다.★
 * (bill·steve·dbak·lui·demis 가 collector 일 때 '언제 보내나·재팬아웃 금지·거짓 미응답 금지' 가 없었다)
 * ★'언제 보고하나' 는 수송 방식과 무관하다.★ 통로별로 룰이 갈리면 ★그 통로만 조용히 깨진다.★
 * → [B] 는 변종이 없으므로 구조적으로 전원이 받는다. ★그 사실을 런타임마다 못 박는다.★
 */
describe("★보고 시점 룰(REPORT_WHEN)은 런타임 무관 — 전원이 받는다★", () => {
  it("★전원 답하기 전엔 종합을 보내지 않는다★ (실측: 반쪽 보고가 나갔다 — 중복보다 나쁘다)", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("Until everyone has answered, do not send a synthesis");
    });
  });

  it("★마지막 답/마감 때 완전한 종합을 요청자에게 한 번만 보낸다★", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("send ONE complete synthesis");
      expect(rule, `${runtime}`).toContain("Do not re-report a request you already reported");
      // ★late-fold reconcile 가드 (GD 2026-07-17 결정 + codex r2 권장)★: '재보고 금지' 와 TEAM-OS §5
      //   '무응답자 늦은 답 나중에 반영' 충돌을 addendum 예외로 해소. 문구가 압축서 재손실되지 않게 고정.
      expect(rule, `${runtime}`).toContain("add it in a short follow-up");
    });
  });

  it("★끝내 침묵하는 사람이 있으면 그를 밝힌다★ (무한 대기 금지)", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("name anyone who never answered");
    });
  });

  it("★한 스레드에 수집이 두 개면 각각 따로 종합한다★ — 수집을 가르는 건 스레드가 아니라 '그 요청' 이다", () => {
    // 실측(2026-07-13): 팀장이 같은 방에 위임을 연달아 둘 보냈다 → hermes 가 "이 스레드엔 이미 종합을 냈다" 로
    //   읽고 ★두 번째 과제를 통째로 증발시켰다.★ 압축 룰: '늦은 답=이미 보낸 질문의 답, 새 과제 아님 + 각 답을 그 요청에 맞춰라'.
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("match each answer to its own request");
      expect(rule, `${runtime}`).toContain("two separate syntheses");
      // ★회귀 가드 (이 문장은 2번 죽고 2번 살아났다)★: fce0ddd 압축이 삭제 → hermes 라이브 오판 →
      //   e9a9c35(64분 뒤) '두-수집 회귀 복원'. 2026-07-17 압축이 또 삭제 → steve 리뷰가 잡음 → 재복원.
      //   ★교훈(steve): '원칙문이 의미를 담는다'는 e9a9c35가 이미 반증한 가설이다. 금지문(Do not re-report)과
      //   허용문(report it) 을 ★둘 다★ 명시해야 표면이 '보고하지 마라'로 비대칭되지 않는다.★
      //   이 assertion 은 회귀-복원 커밋 소유 → 압축 편의로 삭제 금지.
      expect(rule, `${runtime}`).toContain("a collection is identified by the request, not the thread or topic");
      expect(rule, `${runtime}`).toContain("a new ask is a new collection even if the topic repeats");
    });
  });

  it("★[마감] 개념이 전 런타임에 있고, 이미 보고한 요청은 재보고하지 않는다(일반 가드로 커버)★", () => {
    // steve 지적(2026-07-17): 제목이 '마감-이미보고' 만 검증하는 것처럼 읽히면 거짓 보증. 실제로 검증하는 건
    //   ① [마감] 개념 존재 ② 재보고 금지 일반 가드 존재 — 마감-이미보고는 이 일반 가드가 포괄한다.
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("[마감]");
      expect(rule, `${runtime}`).toContain("Do not re-report a request you already reported");
    });
  });
});

/**
 * ★재팬아웃 금지 — 무한 루프의 씨앗.★ (Steve 실측 2026-07-13)
 * 종합을 보낸 뒤 미뤄둔 wake 가 도착하자 hermes 가 ★기여자에게 다시 물었다.★
 * 기여자가 다시 답하면 → 또 wake → 또 팬아웃 → ★돈다.★
 * 지금은 "답은 1회로 terminal" 이라는 ★기여자의 규율★ 이 끊고 있다 — ★구조적 방어가 아니다.★
 */
describe("★재팬아웃 금지 — 전 런타임★", () => {
  it("★기여자의 답으로 깨어난 것은 '새 과제' 가 아니다 → 다시 팬아웃하지 않는다★", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("not a new task");
      expect(rule, `${runtime}`).toContain("do not re-fan-out");
    });
  });

  it("★팬아웃에 --direct-to-gd 를 붙이지 않는다★ — 붙이면 팀장이 종합 1개 대신 N개 보고를 받는다", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("Never put `--direct-to-gd` on the fan-out asks");
    });
  });
});

/**
 * ★룰이 존재하는 것과 ★팀원 파일에 실리는 것★ 은 다르다.★
 * 상수가 아무리 옳아도 ★렌더 경로가 그 런타임을 빠뜨리면 그 팀원은 못 읽는다★ — 그게 REPORT_WHEN 이
 * claude 에게 안 갔던 방식이다. ★실제 산출물(CLAUDE.md · AGENTS.md)까지 따라가서 확인한다.★
 */
describe("★실제 팀원 파일에 자가발신 룰이 실린다★ (렌더 경로 회귀 가드)", () => {
  it("claude 팀원의 CLAUDE.md(buildPersona)에 자가발신 룰 + 자기 reply 도구 경로", () => {
    const p = buildPersona({
      id: "steve", display_name: "Steve", role: "dev", runtime: "claude_channel",
      owner_name: "GD", team_name: "b3rys",
    });
    expect(p).toContain("To speak, you must send. If you do not send, you have said nothing.");
    expect(p).toContain("reply tool for the lead's 1:1 DM");
    expect(p).not.toContain("[NO_REPLY]");
  });

  it("브릿지·native 팀원의 AGENTS.md(buildAgentsMd)에 자가발신 룰 + send.sh 세 경로", () => {
    for (const runtime of ["openclaw", "hermes_agent", "codex", "b3os_native"] as const) {
      const md = buildAgentsMd({
        id: "x", display_name: "X", role: "dev", runtime,
        owner_name: "GD", team_name: "b3rys",
      });
      expect(md, `${runtime}: AGENTS.md 에 자가발신 불변식이 없다`).toContain(
        "To speak, you must send. If you do not send, you have said nothing.",
      );
      expect(md, `${runtime}: AGENTS.md 에 그룹방 경로가 없다`).toContain("`send.sh --to broadcast");
      expect(md, `${runtime}: AGENTS.md 에 침묵 토큰이 돌아왔다`).not.toContain("[NO_REPLY]");
    }
  });
});

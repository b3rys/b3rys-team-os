// 턴 본문은 발행물이 아니므로, 모든 런타임의 렌더된 룰에 직접 발신 방법과 목적지가 있어야 한다.
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

/** 팀의 모든 런타임. 새 런타임이 생기면 여기에 추가 — 그러면 아래 전부가 그 런타임에도 강제된다. */
const ALL_RUNTIMES: Runtime[] = ["claude_channel", "openclaw", "hermes_agent", "b3os_native", "codex"];

/** 그 런타임의 팀원이 실제로 읽는 핵심룰. */
const ruleFor = (runtime: Runtime) => coreRuleFor("member", "GD", "b3rys", true, runtime);

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
    expect(SRC).toContain("const COLLECT_BULLET_ON = COLLECT_BULLET_OFF;");
    expect(SRC).toContain("const COLLECT_BULLET_CLAUDE = COLLECT_BULLET_OFF;");
    // 이름만 남은 게 아니라 실제로 갈라지지 않는지 는 위 두 테스트(렌더 동일 + 항등)가 증명한다.
  });
});

/**
 * 배송 지시 — 원본 테스트의 정신은 그대로다.
 * 룰이 "어디로 보내라" 를 말하지 않으면 LLM 은 기본값을 쓴다 = 턴 본문. [A] 에선 그게 엉뚱한 사람에게
 * 배달됐고(오배송 3/7), [B] 에선 아무 데도 안 간다(실종). 어느 쪽이든 팀장은 답을 못 받는다.
 * → 배송처는 여전히 명시돼야 한다. 달라진 건 "누가 보내느냐"(서버 → 팀원) 뿐이다.
 */
describe("★모든 런타임이 '어디로·어떻게 보내는지' 를 읽는다★", () => {
  it("★불변식: 말하려면 보내라. 안 보내면 아무 말도 안 한 것★", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}: 자가발신 불변식이 룰에 없다`).toContain(
        "보내지 않으면 말한 것이 아니다",
      );
    });
  });

  it("★세 배송처가 전부 명시된다★ — 팀원에게 · 단톡방에 · 팀장께 (하나라도 빠지면 그 경로가 조용히 죽는다)", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}: 종합 배달이 '요청 발원지로' 라는 지시가 없다`).toContain(
        "종합은 요청이 온 곳으로",
      );
      // 종합은 기여자가 아니라 원 요청이 온 곳으로 전달해야 하므로 발원지별 목적지를 검증한다.
      expect(rule, `${runtime}: 1:1발 수집을 broadcast 금지하는 가드가 없다`).toContain(
        "DM 에서 시작한 수집을 broadcast 하지 않는다",
      );
      // ① 요청자(팀원)에게 — 같은 thread 로
      expect(rule, `${runtime}: 요청자 배송 경로(send.sh --to)가 없다`).toContain(
        "`send.sh --to <requester> --thread <같은 스레드>`",
      );
      // ② 단톡방(그룹) — broadcast. [A] 에선 서버가 대신 올려줬다 → 이제 팀원이 직접 올려야 한다.
      expect(rule, `${runtime}: 그룹방 배송 경로(--to broadcast)가 없다`).toContain(
        "`send.sh --to broadcast --thread <그 방 스레드>`",
      );
      // ③ 팀장께 직보
      expect(rule, `${runtime}: 팀장 직보 경로(1:1/DM → --direct-to-gd)가 없다`).toContain(
        "팀장 1:1 → `--direct-to-gd`",
      );
      // claude 는 브릿지가 없다 → 1:1 DM 의 유일한 도달 경로는 자기 reply 도구. 룰이 그걸 말해준다.
      expect(rule, `${runtime}: claude 의 1:1 도달 경로(reply 도구)가 없다`).toContain(
        "claude 는 reply 도구",
      );
    });
  });

  it("★배송 지시에는 '왜' 가 함께 있다★ — 이유 없는 지시는 LLM 이 재해석한다 (원본 테스트의 핵심)", () => {
    forEveryRuntime((rule, runtime) => {
      // [A] 의 '왜' = "턴 본문은 나를 깨운 사람에게 라우팅된다".
      // [B] 의 '왜' = "턴 본문은 아무 데도 안 간다" — 더 단순하고 더 강하다.
      expect(rule, `${runtime}: 턴 본문이 메모라는 설명이 없다`).toContain("내 메모장");
      expect(rule, `${runtime}: 턴 본문이 아무에게도 안 닿는다는 설명이 없다`).toContain("아무에게도 가지 않는다");
    });
  });

  it("★침묵할 수단이 있다 — 그리고 그건 '그냥 안 보내는 것' 이다★ (토큰 없음)", () => {
    // 침묵 방법과 표식 불필요 지시는 모든 런타임 핵심룰에 있어야 한다.
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}: 침묵 방법(안 보내면 말 안 한 것)을 안 알려준다`).toContain(
        "보내지 않으면 말한 것이 아니다",
      );
      expect(rule, `${runtime}: 침묵에 마커가 필요없다는 말이 없다`).toContain("침묵에는 표시가 필요 없다");
    });
  });
});

// 턴 본문 자동 게시가 생기면 침묵 표식이 실제 메시지로 노출될 수 있어 금지한다.
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
      "wakes you ONCE with the full bundle", // 서버 번들은 지원하지 않으므로 기다리도록 지시하면 안 된다.
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
        "답은 내가 직접 모은다",
      );
      expect(rule, `${runtime}: 서버가 답을 번들로 준다는 거짓 약속이 돌아왔다`).not.toContain(
        "will bundle the answers and will wake you",
      );
    });
  });
});

// 수집 보고 시점은 런타임의 전송 방식과 무관하므로 모든 런타임에서 검증한다.
describe("★보고 시점 룰(REPORT_WHEN)은 런타임 무관 — 전원이 받는다★", () => {
  it("★전원 답하기 전엔 종합을 보내지 않는다★ (실측: 반쪽 보고가 나갔다 — 중복보다 나쁘다)", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("전원이 답하기 전에는 종합을 보내지 않는다");
    });
  });

  it("★마지막 답/마감 때 완전한 종합을 요청자에게 한 번만 보낸다★", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("종합 하나를 보내고");
      expect(rule, `${runtime}`).toContain("이미 보고한 요청은 다시 보고하지 않는다");
      // late-fold reconcile 가드: '재보고 금지' 와 TEAM-OS §5
      //   '무응답자 늦은 답 나중에 반영' 충돌을 addendum 예외로 해소. 문구가 압축서 재손실되지 않게 고정.
      expect(rule, `${runtime}`).toContain("늦은 답은 짧은 후속으로");
    });
  });

  it("★끝내 침묵하는 사람이 있으면 그를 밝힌다★ (무한 대기 금지)", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("미응답자 이름을 적는다");
    });
  });

  it("★한 스레드에 수집이 두 개면 각각 따로 종합한다★ — 수집을 가르는 건 스레드가 아니라 '그 요청' 이다", () => {
    // 같은 스레드의 새 요청도 별도 수집이다. 늦은 답은 해당 요청에 맞춰 처리해야 한다.
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("각 요청에 맞춘다");
      expect(rule, `${runtime}`).toContain("종합도 둘");
      // 재보고 금지와 새 요청 보고 허용을 함께 명시해야 새 수집이 중복으로 억제되지 않는다.
      expect(rule, `${runtime}`).toContain("수집은 요청 단위다");
      expect(rule, `${runtime}`).toContain("같은 주제라도 새 요청은 새 수집이다");
    });
  });

  it("★[마감] 개념이 전 런타임에 있고, 이미 보고한 요청은 재보고하지 않는다(일반 가드로 커버)★", () => {
    // 마감 개념과 일반 재보고 금지 가드의 존재를 검사한다. 마감 후 이미 보고한 경우는 일반 가드가 포괄한다.
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("[마감]");
      expect(rule, `${runtime}`).toContain("이미 보고한 요청은 다시 보고하지 않는다");
    });
  });
});

// 종합 뒤 지연된 답을 새 요청으로 재전송하면 답→wake→재요청 루프가 생길 수 있어 재팬아웃을 금지한다.
describe("★재팬아웃 금지 — 전 런타임★", () => {
  it("★기여자의 답으로 깨어난 것은 '새 과제' 가 아니다 → 다시 팬아웃하지 않는다★", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("새 과제가 아니니");
      expect(rule, `${runtime}`).toContain("다시 fan-out 하지 않고");
    });
  });

  it("★팬아웃에 --direct-to-gd 를 붙이지 않는다★ — 붙이면 팀장이 종합 1개 대신 N개 보고를 받는다", () => {
    forEveryRuntime((rule, runtime) => {
      expect(rule, `${runtime}`).toContain("fan-out 에 `--direct-to-gd` 를 붙이지 않는다");
    });
  });
});

/**
 * 룰이 존재하는 것과 팀원 파일에 실리는 것 은 다르다.
 * 상수가 아무리 옳아도 렌더 경로가 그 런타임을 빠뜨리면 그 팀원은 못 읽는다 — 그게 REPORT_WHEN 이
 * claude 에게 안 갔던 방식이다. 실제 산출물(CLAUDE.md · AGENTS.md)까지 따라가서 확인한다.
 */
describe("★실제 팀원 파일에 자가발신 룰이 실린다★ (렌더 경로 회귀 가드)", () => {
  it("claude 팀원의 CLAUDE.md(buildPersona)에 자가발신 룰 + 자기 reply 도구 경로", () => {
    const p = buildPersona({
      id: "steve", display_name: "Steve", role: "dev", runtime: "claude_channel",
      owner_name: "GD", team_name: "b3rys",
    });
    expect(p).toContain("보내지 않으면 말한 것이 아니다");
    expect(p).toContain("claude 는 reply 도구");
    expect(p).not.toContain("[NO_REPLY]");
  });

  it("브릿지·native 팀원의 AGENTS.md(buildAgentsMd)에 자가발신 룰 + send.sh 세 경로", () => {
    for (const runtime of ["openclaw", "hermes_agent", "codex", "b3os_native"] as const) {
      const md = buildAgentsMd({
        id: "x", display_name: "X", role: "dev", runtime,
        owner_name: "GD", team_name: "b3rys",
      });
      expect(md, `${runtime}: AGENTS.md 에 자가발신 불변식이 없다`).toContain(
        "보내지 않으면 말한 것이 아니다",
      );
      expect(md, `${runtime}: AGENTS.md 에 그룹방 경로가 없다`).toContain("`send.sh --to broadcast");
      expect(md, `${runtime}: AGENTS.md 에 침묵 토큰이 돌아왔다`).not.toContain("[NO_REPLY]");
    }
  });
});

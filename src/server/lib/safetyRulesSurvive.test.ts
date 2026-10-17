// 각 룰 블록 안에서 필수 개념 보존을 검사한다. 표현 변경은 허용하지만 의미 반전은 잡지 못하므로 diff 리뷰가 별도로 필요하다.
import { describe, expect, test } from "bun:test";
import { buildPersona, buildAgentsMd, SECTION_CORE_RULE } from "./personaTemplates";

/** 요소 하나 = 이 표현들 중 아무거나 하나 라도 있으면 살아있는 것으로 본다. */
interface Element {
  name: string;
  any: string[];
}
interface SafetyRule {
  /** 어떤 룰인지 */ id: string;
  /** 사람이 읽을 설명 */ what: string;
  /** 룰이 실린 불릿 블록 을 찾는 표식. 만족하는 블록이 없으면 룰 자체가 사라진 것이다. */
  locate: Element[];
  /** 그 블록 안에서 전부 있어야 하는 요소. 문서 다른 데 있는 건 쳐주지 않는다. */
  within: Element[];
}

// DO-NOT-COMPACT 중 핵심룰 본문에 실린 항목만 검사한다. 별도 문서의 owner routing·규칙 변경 리뷰는 이 범위에 포함하지 않는다.
const SAFETY_RULES: SafetyRule[] = [
  {
    id: "승인 게이트 (§4)",
    what: "위험한 행동 전에 팀장 승인을 받는다",
    locate: [
      { name: "승인이라는 요구", any: ["approval", "approve", "authorization", "authorize", "승인", "허가"] },
      { name: "사전(FIRST)이라는 조건", any: ["first", "before", "prior", "먼저", "전에", "사전"] },
    ],
    // 방아쇠 목록 — 하나씩 조용히 빠지는 것을 막으려고 개별 요소로 둔다.
    //   반드시 승인 불릿과 같은 블록 이어야 한다. 다른 데 그 단어가 있는 건 승인 대상이라는 뜻이 아니다.
    within: [
      { name: "외부 발송", any: ["external send", "외부 발송", "외부발송"] },
      { name: "자기 수정", any: ["self-mod", "self mod", "자기수정", "자가 수정"] },
      { name: "재시작", any: ["restart", "재시작"] },
      { name: "결제", any: ["payment", "pay", "결제", "지불"] },
      { name: "크리덴셜", any: ["credential", "크리덴셜", "자격 증명"] },
      { name: "삭제", any: ["deletion", "delete", "삭제"] },
    ],
  },
  {
    id: "시크릿 금지 (§4)",
    what: "시크릿·토큰을 평문으로 출력하지 않는다",
    locate: [
      { name: "시크릿/토큰", any: ["secret", "token", "sensitive value", "시크릿", "토큰"] },
      { name: "금지", any: ["never", "not ", "no ", "금지", "안 "] },
    ],
    within: [
      // "대신 뭘 하라" 가 빠지면 지시가 아니라 감상이 된다.
      { name: "경로로만 참조", any: ["cite paths", "paths only", "by path", "경로", "path"] },
    ],
  },
  {
    id: "배포전 검증 (SECTION_CORE_RULE)",
    what: "배포·머지·공개 전에 검증한다 — 무검증 단독 배포 금지",
    locate: [
      { name: "검증", any: ["verify", "verification", "검증"] },
      { name: "배포/머지/공개", any: ["deploy", "merge", "publish", "배포", "머지", "공개"] },
    ],
    within: [
      // 수단이 빠지면 "잘 확인해라" 가 된다 — 무엇으로 검증할지가 이 룰의 알맹이다.
      {
        name: "검증 수단",
        any: ["harness", "member review", "peer review", "peer check", "리뷰", "하네스", "동료"],
      },
    ],
  },
  {
    id: "보내야 말한 것이다 (§2)",
    what: "발신하지 않으면 아무 말도 하지 않은 것이다",
    locate: [{ name: "발신 행위", any: ["send", "발신", "보내"] }],
    within: [
      // "쓰기만 해서는 아무에게도 안 간다" 가 이 룰의 실행 가능한 알맹이다.
      //   이게 빠지면 "보내라" 만 남아 그냥 평범한 지시가 된다.
      {
        name: "쓰는 것만으로는 도달 안 함",
        any: ["reaches no one", "reach no one", "said nothing", "아무에게도", "도달"],
      },
    ],
  },
];

/** 렌더 대상 — 런타임마다 담기는 방식이 달라 셋 다 본다. */
const TARGETS: { label: string; text: () => string }[] = [
  {
    label: "CLAUDE.md (claude_channel)",
    text: () => buildPersona({ id: "t", display_name: "T", role: "R", runtime: "claude_channel" }),
  },
  {
    label: "AGENTS.md (openclaw)",
    text: () => buildAgentsMd({ id: "t", display_name: "T", role: "R", runtime: "openclaw" }),
  },
  {
    label: "AGENTS.md (hermes_agent)",
    text: () => buildAgentsMd({ id: "t", display_name: "T", role: "R", runtime: "hermes_agent" }),
  },
];

// 순서 있는 목록을 별도 블록으로 나누지 않으면 무관한 앞 블록의 단어로 통과할 수 있다. 연속 인용줄은 한 블록으로 유지한다.
const STARTS_BLOCK = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\*\*)/;
const IS_QUOTE = /^>/;

/**
 * 마크다운 블록으로 쪼갠다.
 * 블록 = 시작 줄 + 다음 시작 줄이 나오기 전까지의 후속 줄들 (빈 줄에서 끊는다).
 * 이래야 "불릿 한 줄 → 다음 줄에 목록" 같은 정상 압축이 한 덩어리로 묶여 통과한다.
 */
function bulletBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let prevWasQuote = false;
  const flush = () => {
    if (cur.length) blocks.push(cur.join("\n").toLowerCase());
    cur = [];
  };
  for (const line of text.split("\n")) {
    const quote = IS_QUOTE.test(line);
    if (line.trim() === "") flush();
    else if (quote) {
      if (!prevWasQuote) flush(); // 인용문의 첫 줄 에서만 끊는다 — 이어지는 `>` 는 같은 블록
      cur.push(line);
    } else if (STARTS_BLOCK.test(line)) {
      flush();
      cur.push(line);
    } else cur.push(line); // 후속 줄 — 현재 블록에 붙인다
    prevWasQuote = quote;
  }
  flush();
  return blocks;
}

const has = (block: string, e: Element) => e.any.some((v) => block.includes(v.toLowerCase()));

describe("★안전 룰의 필수 요소는 렌더 결과에서 사라질 수 없다★", () => {
  for (const target of TARGETS) {
    for (const rule of SAFETY_RULES) {
      test(`${target.label} — ${rule.id}`, () => {
        const blocks = bulletBlocks(target.text()).filter((b) =>
          rule.locate.every((e) => has(b, e)),
        );

        // ① 룰을 담은 블록 자체가 없다 = 룰이 통째로 사라졌다.
        expect(
          blocks.length,
          `★${rule.id} (${rule.what}) 이 통째로 사라졌다.★\n` +
            `찾는 표식: ${rule.locate.map((e) => e.name).join(" + ")} 를 모두 담은 불릿 블록\n` +
            `→ 표현만 바꾼 것이면 locate 의 any 목록에 새 표현을 추가하라.\n` +
            `→ 룰을 뺀 것이면 ★안전 룰 삭제다.★ 테스트가 아니라 변경을 되돌려라.`,
        ).toBeGreaterThan(0);

        // ② 블록은 있는데 알맹이가 빠졌다 = 주제만 남고 실행 가능한 형태가 사라졌다.
        //    가장 적게 빠진 블록 을 기준으로 보고한다 — 사람이 고칠 곳을 바로 찾도록.
        const best = blocks
          .map((b) => rule.within.filter((e) => !has(b, e)).map((e) => e.name))
          .sort((a, b) => a.length - b.length)[0]!;

        expect(
          best,
          `★${rule.id} (${rule.what}) 의 룰은 남았는데 필수 요소가 빠졌다.★\n` +
            `빠진 것: ${best.join(", ")}\n` +
            `※ 문서 다른 데 그 단어가 있어도 쳐주지 않는다 — ★같은 불릿 블록에 있어야★ 실제로 적용되는 룰이다.\n` +
            `→ 표현만 바꾼 것이면 within 의 any 목록에 새 표현을 추가하라.\n` +
            `→ 요소 자체를 뺀 것이면 ★안전 룰 삭제다.★ 테스트가 아니라 변경을 되돌려라.`,
        ).toEqual([]);
      });
    }
  }

  test("★핵심룰 블록 자체가 비어있지 않다★ — 통째로 날아가면 위 검사도 의미가 없다", () => {
    expect(SECTION_CORE_RULE.length).toBeGreaterThan(500);
  });
});

// 필수 요소 누락을 잡으면서 정상 줄바꿈·목록화는 허용하는지 함께 검사한다.
describe("★그물 자체의 회귀 케이스★", () => {
  const APPROVAL = SAFETY_RULES[0]!;
  const check = (doc: string) => {
    const blocks = bulletBlocks(doc).filter((b) => APPROVAL.locate.every((e) => has(b, e)));
    if (!blocks.length) return ["<룰 자체가 없음>"];
    return blocks
      .map((b) => APPROVAL.within.filter((e) => !has(b, e)).map((e) => e.name))
      .sort((a, b) => a.length - b.length)[0]!;
  };

  const FULL =
    "- Announce scope+reason and get the team lead's approval FIRST for: a big change · service restart · self-mod · external send · public post · payment · deletion · credential handling.";

  test("(a) ★방아쇠 하나(결제)만 빠져도 빨간불★ — 조용한 누락이 이 그물의 존재 이유다", () => {
    expect(check(FULL.replace(" · payment", ""))).toEqual(["결제"]);
  });

  test("(b) ★불릿을 2줄로 쪼갠 정상 압축은 초록불★ — 그물이 압축을 막으면 사람이 그물을 지운다", () => {
    const twoLine = [
      "- Announce scope+reason and get the team lead's approval FIRST for these actions:",
      "  - a big change · service restart · self-mod · external send · public post · payment · deletion · credential handling",
    ].join("\n");
    expect(check(twoLine)).toEqual([]);
  });

  test("(c) ★룰이 통째로 없으면 빨간불★", () => {
    expect(check("- Be careful with risky actions.")).toEqual(["<룰 자체가 없음>"]);
  });

  test("(e) ★번호 목록이 앞 블록에 들러붙어 단어를 빌려오면 안 된다★ (codex 리뷰 실증)", () => {
    // `1.` 을 블록 시작으로 못 보면, 앞 불릿의 무관한 payment 를 빌려서 결제 누락이 통과한다.
    const numbered = [
      "- Unrelated accounting note: payment records are retained.",
      "1. Get approval FIRST for restart · self-mod · external send · public post · deletion · credential handling.",
    ].join("\n");
    expect(check(numbered)).toEqual(["결제"]);
  });

  test("(f) ★2줄로 이어 쓴 인용문 압축은 초록불★ — 연속 `>` 는 한 블록이다 (codex 리뷰 실증)", () => {
    const quoted = [
      "> Announce scope+reason and get the team lead's approval FIRST for these actions:",
      "> restart · self-mod · external send · public post · payment · deletion · credential handling",
    ].join("\n");
    expect(check(quoted)).toEqual([]);
  });

  test("(d) ★의미 반전은 잡지 못한다★ — 이 그물의 한계를 문서가 아니라 코드로 고정한다", () => {
    // 정상 승인 룰에도 no approval이 있어 부정어 일괄 금지는 불가능하다. 이 검사는 의미 반전을 잡지 못한다.
    expect(check(`- No need to get ${FULL.slice(FULL.indexOf("the team lead's"))}`)).toEqual([]);
  });
});

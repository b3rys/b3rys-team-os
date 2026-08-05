/**
 * ★안전 룰의 필수 요소가 렌더 결과에서 사라지면 빨간불★ — 룰 압축용 그물.
 *
 * ═══ 왜 필요한가 (2026-08-05 실측) ═══
 *   룰 압축을 준비하며 steve 가 룰 라인 56개를 하나씩 지워보는 스윕을 돌렸다.
 *   ★TEAM-OS §9 가 "삭제 금지" 로 못 박은 안전 룰이 전부 '지워도 초록불' 이었다.★
 *   bill 이 그 3줄을 실제로 지우고 ★전체 수트 2,369건★ 을 돌렸다 —
 *     지우기 전 2368 pass / 1 fail  ·  지운 후 ★2368 pass / 1 fail (동일)★
 *   즉 승인 게이트·시크릿 금지·배포전 검증이 통째로 사라져도 ★아무 테스트도 몰랐다.★
 *
 *   압축 작업은 "테스트 통과" 를 완료 기준으로 삼는다. 그 기준이 안전 룰을 안 보면
 *   ★제일 지우면 안 되는 것부터 지워진다 — 초록불이니까.★ 이 파일이 그 구멍을 막는다.
 *
 * ═══ ★이 파일이 보장하는 것과 보장하지 않는 것★ (과대주장 금지) ═══
 *   보장한다 → ★누락·삭제★. 룰이 통째로 빠지거나, 승인 방아쇠 같은 필수 항목이
 *              조용히 하나 빠지면 잡는다. ★압축이 실제로 내는 사고가 이것이다.★
 *   보장하지 않는다 → ★의미 반전★. "approval FIRST" 를 "No need to get approval FIRST"
 *              로 뒤집으면 ★단어가 그대로라 이 검사는 통과한다.★ (codex 리뷰 2026-08-05 실증)
 *              부정어 블랙리스트로 막으려 했으나 ★불가★ — 진짜 승인 룰 자체가
 *              "team-bus messaging ... it needs **no approval**" 이라는 정당한 부정문을
 *              품고 있어, 부정어를 금지하면 ★현행 룰이 먼저 빨개진다.★
 *              반전은 이 그물이 아니라 ★룰 diff 사람 리뷰★ 로 막는다.
 *   즉 이 파일의 보장 수준은 ★"필수 요소 보존"★ 이지 "의미 보존" 이 아니다.
 *
 * ═══ ★문구를 못 박지 않는다★ (설계 핵심) ═══
 *   `toContain("정확한 문장")` 으로 고정하면 ★압축 자체가 막힌다.★ 한 글자만 다듬어도 빨간불이라
 *   결국 사람이 테스트를 지우고 간다. 그러면 그물이 없느니만 못하다.
 *   대신 룰마다 ★필수 개념★ 을 두고, 개념마다 ★여러 표현을 허용★ 한다.
 *
 * ═══ ★"문서 어딘가" 가 아니라 "그 룰 덩어리 안" 에서 찾는다★ ═══
 *   문서 전체에서 찾으면 이런 변조를 못 잡는다 —
 *     승인 방아쇠 목록에서 `external send` 를 빼도, 그 단어가 문서 다른 데 한 번이라도
 *     남아 있으면 ★그대로 초록불.★ 주제는 남고 실행 가능한 형태만 사라진다.
 *   그렇다고 ★한 줄★ 로 좁히면 반대 사고가 난다 — 불릿을 2줄로 쪼개는 ★정상 압축★ 을
 *     막아버린다(codex 리뷰에서 실증: 목록을 다음 줄로 내리자 3 runtime 전부 fail).
 *   그래서 단위는 ★마크다운 불릿 블록★ 이다 = 불릿 한 줄 + 그에 딸린 후속 줄들.
 *     줄바꿈·목록화 같은 정상 압축은 통과하고, 항목이 빠지는 것만 잡힌다.
 *
 * ═══ 고칠 때 ═══
 *   룰 문구를 바꿔서 여기가 빨개지면 ★먼저 "요소가 정말 남아 있나" 를 보라.★
 *   남아 있는데 표현만 다르면 `any` 목록에 표현을 추가한다.
 *   요소 자체를 뺀 것이면 ★그건 안전 룰 삭제다 — 테스트가 아니라 변경을 되돌려야 한다.★
 */
import { describe, expect, test } from "bun:test";
import { buildPersona, buildAgentsMd, SECTION_CORE_RULE } from "./personaTemplates";

/** 요소 하나 = 이 표현들 중 ★아무거나 하나★ 라도 있으면 살아있는 것으로 본다. */
interface Element {
  name: string;
  any: string[];
}
interface SafetyRule {
  /** 어떤 룰인지 */ id: string;
  /** 사람이 읽을 설명 */ what: string;
  /** ★룰이 실린 불릿 블록★ 을 찾는 표식. 만족하는 블록이 없으면 룰 자체가 사라진 것이다. */
  locate: Element[];
  /** ★그 블록 안에서★ 전부 있어야 하는 요소. 문서 다른 데 있는 건 쳐주지 않는다. */
  within: Element[];
}

/**
 * ★이 목록의 범위★ — TEAM-OS §9 DO-NOT-COMPACT 중 ★핵심룰 본문에 실려 있는 것★ 만 담는다.
 * §9 는 owner routing·rule-change review 등도 삭제 금지로 지정하지만 그건 별도 문서라
 * 여기서 다루지 않는다. ★"§9 전부" 라고 주장하지 않는다★ (codex 리뷰 2026-08-05 지적).
 * §9 나 핵심룰을 고치면 여기도 같이 봐야 한다 — 한쪽만 바꾸면 그물이 실제와 어긋난다.
 */
const SAFETY_RULES: SafetyRule[] = [
  {
    id: "승인 게이트 (§4)",
    what: "위험한 행동 전에 팀장 승인을 받는다",
    locate: [
      { name: "승인이라는 요구", any: ["approval", "approve", "authorization", "authorize", "승인", "허가"] },
      { name: "사전(FIRST)이라는 조건", any: ["first", "before", "prior", "먼저", "전에", "사전"] },
    ],
    // ★방아쇠 목록★ — 하나씩 조용히 빠지는 것을 막으려고 개별 요소로 둔다.
    //   ★반드시 승인 불릿과 같은 블록★ 이어야 한다. 다른 데 그 단어가 있는 건 승인 대상이라는 뜻이 아니다.
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
      // ★"대신 뭘 하라" 가 빠지면 지시가 아니라 감상이 된다.
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
      // ★수단이 빠지면 "잘 확인해라" 가 된다 — 무엇으로 검증할지가 이 룰의 알맹이다.
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
      // ★"쓰기만 해서는 아무에게도 안 간다" 가 이 룰의 실행 가능한 알맹이다.
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

/**
 * ★지원하는 마크다운 부분집합★ — AST 파서가 아니라 손으로 만든 것이라 경계를 여기 적어둔다.
 * 블록을 ★시작하는★ 것: 순서없는 목록 `- * +` · ★순서있는 목록 `1.` `1)`★ · 제목 `#` ·
 *   굵은 소제목 `**` · 인용 `>` (단 ★연속된 `>` 줄은 한 덩어리★)
 * 블록을 ★끊는★ 것: 빈 줄
 * 그 외 모든 줄 = ★앞 블록의 후속 줄★
 *
 * ★순서있는 목록을 빠뜨리면 미탐이 난다★ (codex 리뷰 2026-08-05 실증) —
 *   `1.` 을 시작으로 못 보면 그 항목이 ★앞의 무관한 불릿에 들러붙어★, 앞 줄에 우연히 있던
 *   단어(예: 회계 안내문의 payment)를 ★빌려서★ 통과해버린다.
 * ★연속 인용줄을 쪼개면 오탐이 난다★ (같은 리뷰 실증) —
 *   `> 문장:` / `> 목록` 2줄로 나눠 쓴 ★정상 인용문 압축★ 이 두 블록으로 갈라져 전부 빨개진다.
 */
const STARTS_BLOCK = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\*\*)/;
const IS_QUOTE = /^>/;

/**
 * ★마크다운 블록으로 쪼갠다.★
 * 블록 = 시작 줄 + ★다음 시작 줄이 나오기 전까지의 후속 줄들★ (빈 줄에서 끊는다).
 * 이래야 "불릿 한 줄 → 다음 줄에 목록" 같은 ★정상 압축이 한 덩어리로 묶여★ 통과한다.
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
      if (!prevWasQuote) flush(); // 인용문의 ★첫 줄★ 에서만 끊는다 — 이어지는 `>` 는 같은 블록
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
        //    ★가장 적게 빠진 블록★ 을 기준으로 보고한다 — 사람이 고칠 곳을 바로 찾도록.
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

/**
 * ★그물이 실제로 잡는지·정상 압축을 막지 않는지★ 를 고정한다.
 * 이 회귀 케이스가 없으면 위 검사를 나중에 느슨하게 고쳐도 아무도 모른다.
 * (a)(b) 는 codex 리뷰 2026-08-05 가 요구한 케이스다.
 */
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
    // 진짜 승인 룰이 "it needs **no approval**" 이라는 정당한 부정문을 품고 있어
    // 부정어 블랙리스트를 쓸 수 없다. 반전은 ★룰 diff 사람 리뷰★ 의 몫이다.
    // 이 케이스가 초록불인 것은 ★버그가 아니라 명시된 한계★ 다. 나중에 막게 되면 이 테스트를 뒤집어라.
    expect(check(`- No need to get ${FULL.slice(FULL.indexOf("the team lead's"))}`)).toEqual([]);
  });
});

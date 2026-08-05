/**
 * ★안전 룰이 렌더 결과에서 사라지면 빨간불★ — TEAM-OS §9 DO-NOT-COMPACT 의 코드측 그물.
 *
 * ═══ 왜 필요한가 (2026-08-05 실측) ═══
 *   룰 압축을 준비하며 steve 가 룰 라인 56개를 하나씩 지워보는 스윕을 돌렸다.
 *   ★TEAM-OS §9 가 "삭제 금지" 로 명시한 안전 3개가 전부 '지워도 초록불' 이었다.★
 *   bill 이 그 3줄을 실제로 지우고 ★전체 수트 2,369건★ 을 돌렸다 —
 *     지우기 전 2368 pass / 1 fail  ·  지운 후 ★2368 pass / 1 fail (동일)★
 *   즉 승인 게이트·시크릿 금지·배포전 검증이 통째로 사라져도 ★아무 테스트도 몰랐다.★
 *
 *   압축 작업은 "테스트 통과" 를 기준으로 삼는다. 그 기준이 안전 룰을 안 보면
 *   ★제일 지우면 안 되는 것부터 지워진다 — 초록불이니까.★ 이 파일이 그 구멍을 막는다.
 *
 * ═══ ★문구를 못 박지 않는다★ (이 파일의 설계 핵심) ═══
 *   `toContain("정확한 문장")` 으로 고정하면 ★압축 자체가 막힌다.★ 한 글자만 다듬어도 빨간불이라
 *   결국 사람이 테스트를 지우고 간다. 그러면 그물이 없느니만 못하다.
 *   대신 룰마다 ★필수 개념★ 을 두고, 개념마다 ★여러 표현을 허용★ 한다.
 *     · 말을 바꾸거나 짧게 줄이는 것 → ★통과★ (개념이 남아 있으므로)
 *     · 룰을 통째로 지우는 것        → ★실패★ (개념이 사라지므로)
 *   그래서 이 파일은 압축을 막지 않고 ★삭제만★ 막는다.
 *
 * ═══ ★왜 "문서 어딘가" 가 아니라 "같은 줄" 인가★ (이 파일 1차본의 실제 구멍) ═══
 *   1차본은 개념을 ★렌더 문서 전체★ 에서 찾았다. 그래서 이런 변조를 못 잡았다 —
 *     승인 게이트의 방아쇠 목록에서 "외부 발송" 을 빼도, 그 단어가 문서 다른 데
 *     (설명·예시·다른 섹션) 한 번이라도 남아 있으면 ★그대로 초록불★ 이었다.
 *   ★주제는 남고 실행 가능한 형태만 사라지는 것★ — 압축이 실제로 내는 사고가 정확히 이것이다.
 *   그래서 지금은 ★룰을 담은 줄을 먼저 찾고(locate), 그 줄 안에서만(within) 확인★ 한다.
 *   "승인을 먼저 받아라" 는 줄에 방아쇠가 없으면, 그 방아쇠는 ★승인 대상이 아니게 된 것★ 이다.
 *
 * ═══ 고칠 때 ═══
 *   룰 문구를 바꿔서 여기가 빨개지면 ★먼저 "개념이 정말 남아 있나" 를 보라.★
 *   남아 있는데 표현만 다르면 ANY 목록에 표현을 추가한다.
 *   개념 자체를 뺀 것이면 ★그건 §9 위반이다 — 테스트가 아니라 변경을 되돌려야 한다.★
 */
import { describe, expect, test } from "bun:test";
import { buildPersona, buildAgentsMd, SECTION_CORE_RULE } from "./personaTemplates";

/** 개념 하나 = 이 표현들 중 ★아무거나 하나★ 라도 있으면 살아있는 것으로 본다. */
interface Concept {
  name: string;
  any: string[];
}
interface SafetyRule {
  /** §9 어느 항목인지 */ id: string;
  /** 사람이 읽을 설명 */ what: string;
  /** ★룰이 실린 줄★ 을 찾는 표식. 이걸 만족하는 줄이 하나도 없으면 룰 자체가 사라진 것이다. */
  locate: Concept[];
  /** ★그 줄 안에서★ 전부 있어야 하는 개념. 문서 다른 데 있는 건 쳐주지 않는다. */
  within: Concept[];
}

/**
 * ★TEAM-OS §9 DO-NOT-COMPACT 를 코드로 옮긴 것.★
 * §9 를 고치면 여기도 같이 고쳐야 한다 — 한쪽만 바꾸면 그물이 실제와 어긋난다.
 */
const SAFETY_RULES: SafetyRule[] = [
  {
    id: "§4 승인 게이트",
    what: "위험한 행동 전에 팀장 승인을 받는다",
    locate: [
      { name: "승인이라는 요구", any: ["approval", "approve", "승인"] },
      { name: "사전(FIRST)이라는 조건", any: ["FIRST", "before", "먼저", "전에"] },
    ],
    // ★방아쇠 목록★ — 하나씩 조용히 빠지는 것을 막으려고 개별 개념으로 둔다.
    //   ★반드시 승인 문장과 같은 줄★ 이어야 한다. 다른 데 그 단어가 있는 건 승인 대상이라는 뜻이 아니다.
    within: [
      { name: "외부 발송", any: ["external send", "외부 발송", "외부발송"] },
      { name: "자기 수정", any: ["self-mod", "self mod", "자기수정", "자가 수정"] },
      { name: "재시작", any: ["restart", "재시작"] },
      { name: "크리덴셜", any: ["credential", "크리덴셜", "자격 증명"] },
      { name: "삭제", any: ["deletion", "delete", "삭제"] },
    ],
  },
  {
    id: "§4 시크릿 금지",
    what: "시크릿·토큰을 평문으로 출력하지 않는다",
    locate: [
      { name: "시크릿/토큰", any: ["secret", "token", "시크릿", "토큰"] },
      { name: "금지", any: ["never", "금지", "안 "] },
    ],
    within: [
      // ★"대신 뭘 하라" 가 빠지면 지시가 아니라 감상이 된다.
      { name: "경로로만 참조", any: ["cite paths", "paths only", "경로", "path"] },
    ],
  },
  {
    id: "SECTION_CORE_RULE 배포전 검증",
    what: "배포·머지·공개 전에 검증한다 — 무검증 단독 배포 금지",
    locate: [
      { name: "검증", any: ["verify", "verification", "검증"] },
      { name: "배포/머지/공개", any: ["deploy", "merge", "publish", "배포", "머지", "공개"] },
    ],
    within: [
      // ★수단이 빠지면 "잘 확인해라" 가 된다 — 무엇으로 검증할지가 이 룰의 알맹이다.
      { name: "검증 수단", any: ["harness", "member review", "리뷰", "하네스"] },
    ],
  },
  {
    id: "§2 보내야 말한 것이다",
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

const has = (line: string, c: Concept) => c.any.some((v) => line.includes(v.toLowerCase()));

/**
 * ★룰이 실린 줄들★ — locate 개념을 ★모두★ 담은 줄. 보통 1개지만 여러 개일 수 있다.
 * 여러 줄이 걸리면 ★그 중 하나라도★ within 을 만족하면 통과로 본다 (룰이 온전히 실린 줄이 존재).
 */
function locateLines(text: string, rule: SafetyRule): string[] {
  return text
    .split("\n")
    .map((l) => l.toLowerCase())
    .filter((l) => rule.locate.every((c) => has(l, c)));
}

describe("★안전 룰은 렌더 결과에서 사라질 수 없다★ (TEAM-OS §9 DO-NOT-COMPACT)", () => {
  for (const target of TARGETS) {
    for (const rule of SAFETY_RULES) {
      test(`${target.label} — ${rule.id}`, () => {
        const lines = locateLines(target.text(), rule);

        // ① 룰을 담은 줄 자체가 없다 = 룰이 통째로 사라졌다.
        expect(
          lines.length,
          `★${rule.id} (${rule.what}) 이 통째로 사라졌다.★\n` +
            `찾는 표식: ${rule.locate.map((c) => c.name).join(" + ")} 를 모두 담은 줄\n` +
            `→ 표현만 바꾼 것이면 locate 의 any 목록에 새 표현을 추가하라.\n` +
            `→ 룰을 뺀 것이면 ★TEAM-OS §9 위반★ 이다. 테스트가 아니라 변경을 되돌려라.`,
        ).toBeGreaterThan(0);

        // ② 줄은 있는데 알맹이가 빠졌다 = 주제만 남고 실행 가능한 형태가 사라졌다.
        //    ★가장 적게 빠진 줄★ 을 기준으로 보고한다 — 사람이 고칠 줄을 바로 찾도록.
        const best = lines
          .map((l) => rule.within.filter((c) => !has(l, c)).map((c) => c.name))
          .sort((a, b) => a.length - b.length)[0]!;

        expect(
          best,
          `★${rule.id} (${rule.what}) 의 줄은 남았는데 개념이 빠졌다.★\n` +
            `빠진 것: ${best.join(", ")}\n` +
            `※ 문서 다른 데 그 단어가 있어도 쳐주지 않는다 — ★같은 줄에 있어야★ 실제로 적용되는 룰이다.\n` +
            `→ 표현만 바꾼 것이면 within 의 any 목록에 새 표현을 추가하라.\n` +
            `→ 개념 자체를 뺀 것이면 ★TEAM-OS §9 위반★ 이다. 테스트가 아니라 변경을 되돌려라.`,
        ).toEqual([]);
      });
    }
  }

  test("★핵심룰 블록 자체가 비어있지 않다★ — 통째로 날아가면 위 검사도 의미가 없다", () => {
    expect(SECTION_CORE_RULE.length).toBeGreaterThan(500);
  });
});

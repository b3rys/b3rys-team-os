/**
 * ★합류 1회 절차가 사라지면 빨간불★
 *
 * 2026-08-05: 자기소개 절차(430자)를 페르소나에서 ★`.b3os-just-joined` 파일 본문★ 으로 옮겼다.
 * 평생 한 번 쓰는 절차가 ★매 턴★ 실려 있었기 때문이다.
 *
 * ★옮기면 새 구멍이 생긴다★ — 페르소나에서 지웠으므로, 파일 본문마저 비면
 *   ★신규 팀원은 자기소개 절차를 아예 못 받는다.★ 그런데 그건 ★영입해봐야 드러난다.★
 *   (오늘 확인한 것과 같은 계열: 안전 룰을 지워도 전체 수트가 초록불이었다.)
 * 그래서 옮긴 자리에 그물을 같이 둔다 — ★막힌 걸 열었으면 그 책임도 같이 진다.★
 */
import { expect, test } from "bun:test";
import { buildPersona, buildAgentsMd, JOIN_FLAG_FILE, joinInstructions, isLegacyJoinFlag } from "./personaTemplates";

const M = { id: "t", display_name: "Testy", role: "QA" };

test("★합류 지시서에 필수 4단계가 전부 있다★ — 하나라도 빠지면 신규 팀원이 그만큼 못 한다", () => {
  const body = joinInstructions(M.display_name, M.role);
  const need: [string, RegExp][] = [
    // ★인사는 Language 룰로 대체되지 않는다★ (codex 리뷰 2026-08-05) —
    //   `Language:` 는 답변의 언어·말투를 제한할 뿐 ★인사하라는 발화 행동★ 을 지시하지 않는다.
    //   이름·역할만 요구하면 "Codex — PM" 처럼 ★인사 없이도 충족★ 된다.
    ["① 한 줄 인사 + 자기소개(이름+역할)", /greet(ing)?.*Testy.*QA/is],
    ["①-b 사용자 언어로 인사", /in the user's language/i],
    ["② 온보딩(OT) 로드 확인", /onboarding|\bOT\b/i],
    ["③ 실제 질문에 답하기", /answer what the user/i],
    ["④ 이 파일 삭제", new RegExp(`rm\\s+${JOIN_FLAG_FILE.replace(".", "\\.")}`, "i")],
    ["⑤ 1회성이라는 조건", /ONE-TIME|not on every restart/i],
  ];
  const missing = need.filter(([, re]) => !re.test(body)).map(([name]) => name);
  expect(missing, `합류 지시서에서 빠진 단계: ${missing.join(", ")}`).toEqual([]);
});

test("★페르소나와 지시서가 같은 파일 이름을 본다★ — 어긋나면 지시서가 영영 안 읽힌다", () => {
  for (const doc of [
    buildPersona({ ...M, runtime: "claude_channel" }),
    buildAgentsMd({ ...M, runtime: "openclaw" }),
    buildAgentsMd({ ...M, runtime: "hermes_agent" }),
  ]) {
    expect(doc).toContain(JOIN_FLAG_FILE);
    // 파일을 ★읽고·따르고·지우라★ 는 세 지시가 다 있어야 절차가 끝까지 돈다.
    expect(doc).toMatch(/read it, follow it, then `rm` it/i);
  }
});

/**
 * ★옛 깃발 정리는 지시서를 지우면 안 된다.★
 * 부팅 정리(`index.ts`)가 `isLegacyJoinFlag` 로 판단한다 — 여기가 느슨해지면
 * ★방금 영입된 팀원의 지시서가 첫 발화 전에 지워진다★ (그러면 자기소개 절차를 영영 못 받는다).
 */
test("★옛 깃발만 지운다 — 새 지시서는 절대 아니다★", () => {
  expect(isLegacyJoinFlag("joined\n")).toBe(true);
  expect(isLegacyJoinFlag("  joined  ")).toBe(true);
  expect(isLegacyJoinFlag(joinInstructions("Testy", "QA"))).toBe(false);
  expect(isLegacyJoinFlag("")).toBe(false); // 빈 파일은 판단 보류 — 지우지 않는다
});

/**
 * ★톤 지시는 페르소나에 있어야 한다 — SOUL.md 를 믿을 수 없다.★
 *
 * 2026-08-05 압축 때 "SOUL.md 「톤」에 이미 있다" 며 이 지시를 뺐다가 codex 리뷰에서 반려됐다.
 *   ★SOUL.md 는 필수 파일이 아니다.★ persona 를 안 주면 만들어지지 않고, 사용자가 준 SOUL 도
 *   임의 내용이라 톤 문구를 보장하지 않는다.
 *   실측: 활성 12명 전원 SOUL.md 는 있었지만 ★톤 문구가 있는 건 5명뿐★ 이었다.
 * ★근거가 된 것은 내 SOUL.md 하나였다★ — 창단 팀은 가장 안 대표적인 표본이다.
 * 그래서 ★항상 실리는 곳(페르소나)에 있는지★ 를 코드로 고정한다.
 */
test("★톤 지시가 렌더본에 항상 있다★ — SOUL.md 는 선택 파일이라 근거가 못 된다", () => {
  for (const doc of [
    buildPersona({ ...M, runtime: "claude_channel" }),
    buildAgentsMd({ ...M, runtime: "openclaw" }),
    buildAgentsMd({ ...M, runtime: "hermes_agent" }),
  ]) {
    expect(doc).toMatch(/friendly but technically precise/i);
    expect(doc).toMatch(/short, clear answers/i);
    // 용어 풀이 — 이건 어디에도 중복이 없다.
    expect(doc).toMatch(/gloss jargon/i);
  }
});

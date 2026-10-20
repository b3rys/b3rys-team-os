// 자기소개 절차는 1회성 합류 파일에 있으므로 파일 본문이 비면 신규 팀원이 절차를 받지 못한다.
import { describe, expect, test } from "bun:test";
import { buildPersona, buildAgentsMd, JOIN_FLAG_FILE, joinInstructions, isLegacyJoinFlag } from "./personaTemplates";

describe("첫 접촉 — 새 팀원이 처음 받는 안내", () => {

const M = { id: "t", display_name: "Testy", role: "QA" };

test("★합류 지시서에 필수 4단계가 전부 있다★ — 하나라도 빠지면 신규 팀원이 그만큼 못 한다", () => {
  const body = joinInstructions(M.display_name, M.role);
  const need: [string, RegExp][] = [
    // Language는 언어·말투만 제한하므로 인사 행동은 별도로 요구해야 한다.
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
    // 파일을 읽고·따르고·지우라 는 세 지시가 다 있어야 절차가 끝까지 돈다.
    expect(doc).toMatch(/읽고 따른 뒤 `rm` 한다/);
  }
});

// 부팅 정리는 지시가 없는 깃발만 지워야 한다. 신규 합류 지시서를 지우면 첫 발화 절차를 받지 못한다.
test("★옛 깃발만 지운다 — 새 지시서는 절대 아니다★", () => {
  expect(isLegacyJoinFlag("joined\n")).toBe(true);
  expect(isLegacyJoinFlag("  joined  ")).toBe(true);
  expect(isLegacyJoinFlag(joinInstructions("Testy", "QA"))).toBe(false);
  expect(isLegacyJoinFlag("")).toBe(false); // 빈 파일은 판단 보류 — 지우지 않는다
});

// SOUL.md는 선택 파일이며 내용도 임의이므로 톤 지시는 항상 로드되는 페르소나에 있어야 한다.
test("★톤 지시가 렌더본에 항상 있다★ — SOUL.md 는 선택 파일이라 근거가 못 된다", () => {
  for (const doc of [
    buildPersona({ ...M, runtime: "claude_channel" }),
    buildAgentsMd({ ...M, runtime: "openclaw" }),
    buildAgentsMd({ ...M, runtime: "hermes_agent" }),
    buildAgentsMd({ ...M, runtime: "codex" }),
  ]) {
    expect(doc).toMatch(/친근하되 기술적으로 정확/);
    expect(doc).toMatch(/짧고 명확하게/);
    // 전문용어는 번역하지 않고 원문 뒤에 설명을 붙인다.
    expect(doc).toMatch(/옮기지 않는다/);
  }
});
});

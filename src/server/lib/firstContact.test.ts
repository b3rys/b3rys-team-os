/**
 * ★합류 1회 절차가 사라지면 빨간불★
 *
 * 2026-08-05: 자기소개 절차(430자)를 페르소나에서 ★`.b3os-just-joined` 파일 본문★ 으로 옮겼다.
 *   평생 한 번 쓰는 절차가 ★매 턴★ 실려 있었기 때문이다(GD 판단).
 *
 * ★옮기면 새 구멍이 생긴다★ — 페르소나에서 지웠으므로, 파일 본문마저 비면
 *   ★신규 팀원은 자기소개 절차를 아예 못 받는다.★ 그런데 그건 ★영입해봐야 드러난다.★
 *   (오늘 확인한 것과 같은 계열: 안전 룰을 지워도 전체 수트가 초록불이었다.)
 * 그래서 옮긴 자리에 그물을 같이 둔다 — ★막힌 걸 열었으면 그 책임도 같이 진다.★
 */
import { expect, test } from "bun:test";
import { buildPersona, buildAgentsMd, JOIN_FLAG_FILE, joinInstructions } from "./personaTemplates";

const M = { id: "t", display_name: "Testy", role: "QA" };

test("★합류 지시서에 필수 4단계가 전부 있다★ — 하나라도 빠지면 신규 팀원이 그만큼 못 한다", () => {
  const body = joinInstructions(M.display_name, M.role);
  const need: [string, RegExp][] = [
    ["① 한 줄 자기소개(이름+역할)", /intro.*Testy.*QA/is],
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

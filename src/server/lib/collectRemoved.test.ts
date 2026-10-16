// 수집 번들과 --collect는 지원하지 않는다. 지시문에 남으면 수집자가 존재하지 않는 결과를 기다리거나 명령 실행에 실패한다.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPrompt } from "./hermesBridge";

const ROOT = join(import.meta.dir, "../../..");

/** 팀원이 실제로 읽는 지시 출처. 새 출처가 생기면 여기 추가한다. */
const INSTRUCTION_SOURCES = [
  "skills/b3os-team-inbox/SKILL.md",
  "src/server/lib/personaTemplates.ts",
  "src/server/lib/hermesBridge.ts",
];

/** `--collect` 를 쓰라고 시키는 문장인가. (제거를 설명하는 문장은 통과 — 그건 지시가 아니다) */
function instructsCollect(line: string): boolean {
  if (!line.includes("--collect")) return false;
  const explains =
    /제거|삭제|removed|deprecat|no longer|더 이상|안 쓴다|쓰지 마|unknown arg|실패한다|\*\s|^\s*\/\/|^\s*\*/.test(line);
  return !explains;
}

describe("★수집 잔재 — 없는 기능을 시키지 않는다★", () => {
  for (const rel of INSTRUCTION_SOURCES) {
    it(`${rel} 는 ★--collect 를 쓰라고 시키지 않는다★ (send.sh 가 unknown arg 로 죽는다)`, () => {
      const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
      const offenders = lines
        .map((l, i) => ({ n: i + 1, l }))
        .filter(({ l }) => instructsCollect(l))
        .map(({ n, l }) => `${rel}:${n}  ${l.trim().slice(0, 90)}`);
      expect(offenders).toEqual([]);
    });
  }

  it("★send.sh 는 여전히 모르는 옵션에 죽는다★ — 그러니 지시문이 진실이어야 한다 (전제 고정)", () => {
    const sh = readFileSync(join(ROOT, "skills/b3os-team-inbox/scripts/send.sh"), "utf8");
    expect(sh).toContain('unknown arg: $1');
    expect(sh).not.toContain("--collect)"); // 파서에 collect 케이스가 없다
  });

  it("★hermes 프롬프트가 '서버가 모아준다' 고 거짓말하지 않는다★ (실제 렌더로 확인)", () => {
    const p = buildPrompt({
      agent: { id: "hermes", workspace_path: "", runtime: "hermes_agent" } as never,
      threadId: "th1",
      messageId: "m1",
      body: "steve랑 dbak한테 물어봐서 종합해줘",
      fromLabel: "bill",
      replyRoute: { kind: "teammate", to: "bill" }, // 수집 위임 = 버스 1:1 (종합은 위임자 bill 에게)
      locale: "ko",
    });
    expect(p).not.toContain("--collect");
    expect(p).not.toContain("서버가 모아"); // 수집 절차와 주소는 AGENTS.md가 정한다. 봉투에는 kind만 싣고 존재하지 않는 수집 기능을 안내하지 않는다.
    expect(p).not.toContain("다 모이면 종합 1개"); // 봉투에서 제거됨 (룰이 소유)
    expect(p).not.toContain("send.sh"); // 봉투는 어떤 send.sh 명령도 찍지 않는다
  });
});

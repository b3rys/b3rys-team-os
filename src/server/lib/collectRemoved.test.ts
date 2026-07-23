/**
 * ★없는 기능을 시키지 마라.★ (2026-07-13, GD "수집 잔재 다 걷어내라")
 *
 * ═══ 무슨 일이 있었나 ═══
 * 서버 수집 오케스트레이션(gdCollect.ts)과 `--collect` 플래그는 삭제됐다. ★그런데 지시문이 남았다.★
 *   · `hermesBridge.buildPrompt` → "모든 fan-out 에 `--collect` 를 붙여라. 서버가 답을 모아 종합 자료를 한 번에 넘겨준다"
 *   · `skills/b3os-team-inbox/SKILL.md` → 같은 지시 + 옵션 목록에 `--collect`
 * 그래서 라이브에서 hermes 가 이렇게 말했다:
 *   ★"서버 집계 번들이 오면 최종 종합 1개만 보고하겠습니다"★  ← ★영원히 안 오는 걸 기다린다★
 *
 * 게다가 `send.sh` 의 인자 파서는 모르는 옵션에 ★`unknown arg` + exit 1★ 로 죽는다:
 *   *) echo "unknown arg: $1" >&2; exit 1 ;;
 * → ★지시대로 따르면 팬아웃 자체가 실패한다.★ (같은 병으로 `--thread=X` 등호 형식도 죽는다 — ames 로그 7/08)
 *
 * ★교훈: 기능을 지웠으면 그걸 시키던 지시문도 같이 지워야 한다.★ 코드만 지우면 팀원은
 * 존재하지 않는 것을 기다리거나, 실패하는 명령을 실행한다. ★tsc 도 유닛도 이걸 못 잡는다.★
 *
 * 이 테스트는 ★문을 손으로 세지 않는다★ — 팀원이 실제로 읽는 출처를 스캔해서 스스로 찾는다.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPrompt } from "./hermesBridge";

const ROOT = join(import.meta.dir, "../../..");

/** 팀원이 ★실제로 읽는★ 지시 출처. 새 출처가 생기면 여기 추가한다. */
const INSTRUCTION_SOURCES = [
  "skills/b3os-team-inbox/SKILL.md",
  "src/server/lib/personaTemplates.ts",
  "src/server/lib/hermesBridge.ts",
];

/** `--collect` 를 ★쓰라고 시키는★ 문장인가. (제거를 ★설명하는★ 문장은 통과 — 그건 지시가 아니다) */
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
    expect(p).not.toContain("서버가 모아"); // ★없는 기능을 약속하지 않는다★
    // ★2026-07-15 kind 전환★: 수집 절차(팬아웃/종합) 문구는 봉투에서 빠지고 AGENTS.md(룰)로 이관됐다.
    //   봉투는 kind=teammate 만 싣고, 팀원이 룰로 수집 주소(각 팀원 / 종합=위임자)를 정한다.
    expect(p).not.toContain("다 모이면 종합 1개"); // 봉투에서 제거됨 (룰이 소유)
    expect(p).not.toContain("send.sh"); // 봉투는 어떤 send.sh 명령도 찍지 않는다
  });
});

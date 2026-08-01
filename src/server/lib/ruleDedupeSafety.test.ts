/**
 * ★핵심룰에서 뺀 절차 5개가 "주제만" 남고 실행 세부가 사라지는 것을 잡는다.★
 *
 * 2026-08-01, lui 실측: 5개를 핵심룰에서 빼고 "TEAM-OS 가 같은 말을 한다" 고 했는데,
 * TEAM-OS 쪽 문장은 ★요약본★ 이었다. 주제는 다 있었지만 ★실행 가능한 형태가 사라졌다★ —
 * "첫 응답에 산출물 금지" · "기준을 내가 만들어야 하나?(판별 테스트)" · 핸드오프 구성요소 · 한번에 묶어 짧게.
 *
 * ★있음/없음이 아니라 '그 결정이 실행 가능한가' 를 잰다.★ 그래서 주제어가 아니라 ★세부 문구★ 로 검사한다.
 * 이 테스트가 빨개지면: 핵심룰에서 뺀 것을 TEAM-OS 가 못 받고 있다는 뜻 → 되살리거나 되돌려라.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentsMd, buildPersona } from "./personaTemplates";

const rulesDir = join(import.meta.dir, "../../../rules");
const teamOs = readFileSync(join(rulesDir, "TEAM-OS.md"), "utf8");
const teamOsTemplate = readFileSync(join(rulesDir, "TEAM-OS.template.md"), "utf8");

/** 핵심룰에서 뺀 5개의 ★실행 세부★ — 주제어가 아니라 그 결정을 쓸 수 있게 만드는 문구다. */
const MOVED_DETAILS = [
  "respond before autonomous work",              // ① 자율 작업보다 팀장 메시지가 먼저
  "ack or react first",                          // ①
  "greeting/status/opinion/wording/simple lookup", // ② 가벼운 질문의 범위
  "no output, files, or external fetch in the first response", // ③ 첫 응답 금지
  "must you invent the criteria?",               // ③ 열린과제 판별 테스트
  "briefly, in one consolidated response",       // ④ 한 번에 묶어 짧게
  "who·context·task·done-criteria·deadline",     // ⑤ 핸드오프 구성요소
  "outside your role → PM and delegate",         // ⑤ 역할 밖이면 위임
];

describe("★핵심룰에서 뺀 절차는 TEAM-OS 가 '실행 가능한 형태로' 받아야 한다★", () => {
  it("TEAM-OS 정본에 세부가 전부 있다 — 하나라도 빠지면 claude 가 그 결정을 잃는다", () => {
    for (const d of MOVED_DETAILS) {
      expect(teamOs, `★TEAM-OS 에 없다: "${d}"★ — 핵심룰에서 뺐는데 받는 쪽에 없으면 그냥 사라진 것이다.`)
        .toContain(d);
    }
  });

  it("템플릿과 렌더본이 같다 — 한쪽만 고치면 다음 렌더에 되돌아간다", () => {
    expect(teamOsTemplate).toBe(teamOs);
  });

  it("★claude 는 @TEAM-OS.md 를 반드시 싣는다★ — 이게 이번 중복 제거의 전제다 (lui 지적: 단일 실패점)", () => {
    const claude = buildPersona({
      id: "tester", display_name: "Tester", role: "QA",
      runtime: "claude_channel", owner_name: "GD", team_name: "b3rys",
    } as never);
    // import 가 빠지면 claude 는 ★에러 없이 조용히★ 위 5개를 전부 잃는다.
    expect(claude, "★@TEAM-OS.md import 가 없다★ — 뺀 절차를 받을 통로가 사라졌다.")
      .toContain("@TEAM-OS.md");
  });

  it("★openclaw·hermes 는 TEAM-OS 를 자동 로딩하지 않는다 → 자기 파일에 세부를 받는다★", () => {
    for (const runtime of ["openclaw", "hermes"]) {
      const agents = buildAgentsMd({
        id: "tester", display_name: "Tester", role: "QA",
        runtime, owner_name: "GD", team_name: "b3rys",
      } as never);
      for (const d of ["respond before autonomous work", "must you invent the criteria?",
                       "who·context·task·done-criteria·deadline", "outside your role → PM and delegate"]) {
        expect(agents, `★${runtime} 파일에 없다: "${d}"★ — 이 런타임은 TEAM-OS 를 안 싣는다.`)
          .toContain(d);
      }
    }
  });
});

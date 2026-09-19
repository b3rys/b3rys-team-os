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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentsMd, buildPersona } from "./personaTemplates";

const rulesDir = join(import.meta.dir, "../../../rules");

/**
 * ★룰 내용은 추적본(template)으로 잰다.★
 *
 * `TEAM-OS.md` 는 gitignore 된 ★렌더 산출물★ 이라 새 클론·워크트리에는 없다.
 * 이 파일을 최상단에서 읽으면 그런 환경에서 ★모듈 로드가 ENOENT 로 실패해 이 파일의 검사가
 * 하나도 돌지 않는다★ — 검사가 있는데 아무것도 지키지 않는 상태가 된다.
 *
 * 렌더는 `{{OWNER}}` 치환뿐이므로(`teamOsRender.renderTeamOs`) ★룰 문장 검사에는 템플릿으로 충분하다.★
 * 렌더본이 필요한 검사는 아래 `teamOsRendered` 를 쓰고, 없으면 ★조건 미성립으로 건너뛴다★ —
 * "검사했는데 통과" 와 "잴 수 없었다" 를 같은 초록으로 뭉개지 않기 위해 사유를 남긴다.
 */
const teamOsTemplate = readFileSync(join(rulesDir, "TEAM-OS.template.md"), "utf8");
const teamOs = teamOsTemplate; // 룰 문장 검사의 기준 — 치환 전/후가 같은 문장을 본다
const renderedPath = join(rulesDir, "TEAM-OS.md");
/** 렌더 산출물. 이 환경에 없으면 null — 있을 때만 재는 검사가 있다. */
const teamOsRendered: string | null = existsSync(renderedPath) ? readFileSync(renderedPath, "utf8") : null;

/** 핵심룰에서 뺀 5개의 ★실행 세부★ — 주제어가 아니라 그 결정을 쓸 수 있게 만드는 문구다. */
const MOVED_DETAILS = [
  "자율 작업보다 먼저 답한다",                    // ① 자율 작업보다 팀장 메시지가 먼저
  "먼저 ack",                                     // ①
  "인사·상태·의견·표현·간단 조회",                 // ② 가벼운 질문의 범위
  "첫 응답에 산출물·파일·외부 조회 없음",          // ③ 첫 응답 금지
  "기준을 내가 지어내야 하나",                     // ③ 열린과제 판별 테스트
  "한 번에",                                      // ④ 한 번에 묶어 짧게
  "누가·맥락·과제·완료기준·기한",                  // ⑤ 핸드오프 구성요소
  "내 역할 밖이면 PM 이 위임",                     // ⑤ 역할 밖이면 위임
];

describe("★핵심룰에서 뺀 절차는 각 런타임의 규칙 파일이 '실행 가능한 형태로' 받아야 한다★", () => {
  // 2026-09-19: TEAM-OS 는 어느 런타임도 인라인하지 않는다(팀장 결정) → 세부는 ★규칙 파일 자체★(규칙 로딩 절)에 있어야 한다.
  //   TEAM-OS 쪽 같은 문장은 뺐다(겹침 제거). 그래서 이 검사의 대상이 TEAM-OS 템플릿에서 네 런타임 파일로 바뀌었다.
  const member = { id: "tester", display_name: "Tester", role: "QA", owner_name: "GD", team_name: "b3rys" };
  const files: Array<[string, string]> = [
    ["claude_channel", buildPersona({ ...member, runtime: "claude_channel" } as never)],
    ...["openclaw", "hermes_agent", "codex"].map((runtime): [string, string] => [runtime, buildAgentsMd({ ...member, runtime } as never)]),
  ];
  it("네 런타임 규칙 파일 전부에 세부가 있다 — 하나라도 빠지면 그 런타임이 그 결정을 잃는다", () => {
    for (const [runtime, text] of files) {
      for (const d of MOVED_DETAILS) {
        expect(text, `★${runtime} 규칙 파일에 없다: "${d}"★ — 핵심룰에서 뺐는데 받는 쪽에 없으면 그냥 사라진 것이다.`)
          .toContain(d);
      }
    }
  });
  it("TEAM-OS 는 그 세부를 되풀이하지 않는다 — 같은 룰이 두 군데면 한쪽만 고치고 '완료' 가 된다", () => {
    for (const d of ["첫 응답에 산출물·파일·외부 조회 없음", "기준을 내가 지어내야 하나", "누가·맥락·과제·완료기준·기한"]) {
      expect(teamOs, `★TEAM-OS 에 다시 들어왔다: "${d}"★`).not.toContain(d);
    }
    expect(teamOs).toContain("규칙 로딩 절에 있다"); // 대신 어디 있는지 가리킨다
  });

  // ★'외부 전송' 판별 축 검사는 personaTemplates.test.ts 에 있다.★
  //   이 파일은 최상단에서 `rules/TEAM-OS.md` 를 읽는데 그 파일은 gitignore 된 렌더 산출물이라
  //   워크트리·새 클론·CI 에는 없다 — 모듈 로드가 통째로 실패해 ★이 파일의 검사가 하나도 안 돈다.★
  //   여기 두면 검사가 있는 것처럼 보이지만 실제로는 아무것도 지키지 않는다. 별건으로 고칠 자리다.

  /**
   * ★이 검사만 렌더 산출물이 필요하다★ — 없는 환경에서는 ★건너뛴다(skip)★.
   * 통과로 세면 "잴 수 없었다" 가 "확인했다" 로 읽힌다. skip 은 결과에 그대로 남는다.
   * (렌더본이 없다는 것 자체는 결함이 아니다 — gitignore 산출물이라 새 클론에는 원래 없다.)
   */
  it.skipIf(teamOsRendered === null)("템플릿과 렌더본이 같다 — 한쪽만 고치면 다음 렌더에 되돌아간다", () => {
    expect(teamOsRendered).toBe(teamOsTemplate);
  });

  it("★claude 도 TEAM-OS 를 인라인하지 않는다★ — 대신 정본 경로와 '언제 읽는가' 가 있다 (2026-09-19)", () => {
    const [, claude] = files[0]!;
    expect(claude, "★@TEAM-OS.md 인라인이 되살아났다★ — 매 턴 2,500 토큰이 다시 실린다.").not.toContain("@TEAM-OS.md");
    expect(claude).toContain("rules/TEAM-OS.md");
    expect(claude).toContain("팀 운영·라우팅·과제 관리 일을 할 때 읽는다");
    expect(claude).toContain("## 📚 규칙 로딩");
    expect(claude, "SKILLS.md 인라인은 그대로다").toContain("\n@SKILLS.md\n");
  });
});

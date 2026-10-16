// 워크트리에서 렌더해도 팀원 파일은 정본 저장소를 가리켜야 한다. 실행 위치가 산출물 경로에 섞이는지 검사한다.
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { buildAgentsMd, buildPersona, REPO_ROOT } from "./personaTemplates";
import { buildSkillsMd } from "./skillsRender";

const RUNTIMES = ["claude_channel", "openclaw", "hermes"] as const;

function render(runtime: string): string {
  const i = {
    id: "tester", display_name: "Tester", role: "QA",
    runtime, owner_name: "GD", team_name: "b3rys",
  } as never;
  return runtime === "claude_channel" ? buildPersona(i) : buildAgentsMd(i);
}

describe("★렌더 산출물에 워크트리 경로·미치환 플레이스홀더가 남으면 안 된다★", () => {
  it("REPO_ROOT 는 워크트리가 아니라 메인 트리를 가리킨다 — 이 테스트는 워크트리에서도 돈다", () => {
    expect(REPO_ROOT, `★REPO_ROOT 가 워크트리다: ${REPO_ROOT}★ — 이대로 렌더하면 팀원 파일이 워크트리를 가리킨다.`)
      .not.toContain("/.worktrees/");
    expect(existsSync(`${REPO_ROOT}/rules`)).toBe(true);
  });

  for (const runtime of RUNTIMES) {
    it(`${runtime}: 워크트리 경로가 한 건도 없다`, () => {
      const out = render(runtime);
      const hits = out.split("\n").filter((l) => l.includes("/.worktrees/"));
      expect(hits, `★워크트리 경로가 박혔다★\n${hits.slice(0, 3).join("\n")}`).toHaveLength(0);
    });

    it(`${runtime}: 미치환 플레이스홀더가 없다 — 팀·팀장 이름이 빈 채 나가면 안 된다`, () => {
      const out = render(runtime);
      for (const ph of ["{{TEAM}}", "{{OWNER}}"]) {
        expect(out, `★${ph} 가 치환되지 않았다★ — 팀원이 자기 팀·팀장 이름을 못 읽는다.`).not.toContain(ph);
      }
    });

    it(`${runtime}: 경로 기준(b3os=)을 선언한 뒤에만 상대경로를 쓴다`, () => {
      const out = render(runtime);
      // 기준 선언이 없으면 b3os/... 상대경로를 어디에서 해석할지 알 수 없다.
      if (out.includes("`b3os/")) {
        expect(out, "★상대경로를 쓰면서 기준(b3os=)을 선언하지 않았다★").toContain("**Paths**: `b3os` = `");
      }
    });
  }
});

describe("★스킬 목록은 디렉터리에서 생성된다 — 손으로 나열하지 않는다★", () => {
  // "스킬이 추가될 때마다 고쳐야 되나?" → 아니오. 이 테스트가 그걸 보증한다.
  const skillNames = existsSync(`${REPO_ROOT}/skills`)
    ? readdirSync(`${REPO_ROOT}/skills`).filter(
        (n) => existsSync(`${REPO_ROOT}/skills/${n}/SKILL.md`),
      )
    : [];

  // 계약: trigger: 를 선언한 스킬만 나간다. 선언 안 한 것이 새어나가면 그것도 결함이다.
  const declared = skillNames.filter((n) =>
    /^trigger:/m.test(readFileSync(`${REPO_ROOT}/skills/${n}/SKILL.md`, "utf8").slice(0, 4000)));
  const undeclared = skillNames.filter((n) => !declared.includes(n));

  it("trigger 를 선언한 스킬은 전부 나온다 (선언 0개면 목록도 비어야 한다 — 머지 전 상태)", () => {
    const md = buildSkillsMd();  // 목록은 규칙 파일이 아니라 rules/SKILLS.md 렌더본에 있다
    const missing = declared.filter((n) => !md.includes(n));
    expect(missing, `★SKILLS.md 에 빠진 스킬★: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("★은퇴(deprecated)한 스킬은 목록에 나가지 않는다★ — trigger 가 붙어 있어도", () => {
    const dep = skillNames.filter((n) =>
      /deprecat/i.test(readFileSync(`${REPO_ROOT}/skills/${n}/SKILL.md`, "utf8").slice(0, 800)));
    const line = buildSkillsMd().split("\n").find((l) => l.includes("→ `b3os-")) ?? "";
    const leaked = dep.filter((n) => line.includes(n));
    expect(leaked, `★은퇴한 스킬을 안내한다★: ${leaked.join(", ")}`).toHaveLength(0);
  });

  it("★trigger 를 선언하지 않은 스킬은 새어나가지 않는다★ — 기본값은 비공개다", () => {
    const line = buildSkillsMd().split("\n").find((l) => l.includes("→ `b3os-")) ?? "";
    const leaked = undeclared.filter((n) => line.includes(n));
    expect(leaked, `★선언 안 한 스킬이 나갔다★: ${leaked.join(", ")}`).toHaveLength(0);
  });

  it("룰에 없는 스킬 이름을 지어내지 않는다 — 존재하지 않는 스킬로 안내하면 팀원이 헤맨다", () => {
    const out = render("claude_channel");
    const named = [...new Set((out.match(/`(b3os-[a-z0-9-]+)`/g) ?? []).map((m) => m.slice(1, -1)))]
      .filter((n) => !["b3os-team-os", "b3os-just-joined"].includes(n) && !n.endsWith("-"));
    const ghosts = named.filter(
      (n) => !skillNames.includes(n) && !existsSync(`${REPO_ROOT}/skills/${n}`),
    );
    expect(ghosts, `★존재하지 않는 스킬을 안내한다★: ${ghosts.join(", ")}`).toHaveLength(0);
  });
});

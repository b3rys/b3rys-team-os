// rules/SKILLS.md 렌더 — 목록은 규칙 파일 밖, 파일은 원자적으로, 같으면 안 건드린다.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsMd, renderSkillsMd } from "./skillsRender";
import { SKILLS_MD_PATH, buildSkillTable } from "./personaTemplates";

describe("rules/SKILLS.md 렌더", () => {
  it("본문 = 헤더 + 자동 생성 표. 표는 personaTemplates 의 것과 같은 함수에서 나온다", () => {
    const md = buildSkillsMd();
    expect(md.startsWith("# SKILLS")).toBe(true);
    expect(md).toContain(buildSkillTable());
    expect(md).toContain("손으로 고치지 않는다");
    // 겹쳐 쓰기 규칙은 Core Rules 에서 뺐다(팀장 09-18) — 목록 파일이 대신 품는다. 순서까지 고정(codex 리뷰 #435).
    expect(md).toContain("여러 trigger 가 맞으면 전부 적용한다");
    expect(md).toMatch(/`b3os-infra-safety`[^\n]*→[^\n]*`b3os-github-workflow`/);
  });
  it("renderSkillsMd 는 파일을 만들고, 두 번째 호출은 changed=false (내용 동일이면 안 건드림) — 시험은 라이브 rules/ 를 건드리지 않는다", () => {
    const target = join(mkdtempSync(join(tmpdir(), "skills-md-")), "SKILLS.md");
    const first = renderSkillsMd(target);
    expect(first.ok, first.error).toBe(true);
    expect(existsSync(target)).toBe(true);
    const mtime = statSync(target).mtimeMs;
    const second = renderSkillsMd(target);
    expect(second).toEqual({ ok: true, changed: false });
    expect(statSync(target).mtimeMs).toBe(mtime);
    expect(readFileSync(target, "utf-8")).toBe(buildSkillsMd());
    expect(SKILLS_MD_PATH.endsWith("/rules/SKILLS.md")).toBe(true);  // 기본 타깃은 라이브 렌더 경로
  });
});
